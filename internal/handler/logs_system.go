package handler

import (
	"net/http"
	"strconv"
	"strings"

	"miaomiaowux/internal/storage"
)

// SystemLogHandler 提供主控自身日志（data/logs/mmwx.log）的只读查询，admin 专用。
//
// 为什么不复用 /api/user/debug/：那套是 per-user token 鉴权、且是「全局单例伪装成 per-user」
// （debugUsername/autoCloseTimer 是单槽字段，第二个用户 enable 会冲掉第一个）。系统日志是
// admin 级只读，不涉及会话状态，独立成一个干净的 handler。
type SystemLogHandler struct {
	repo *storage.TrafficRepository
}

func NewSystemLogHandler(repo *storage.TrafficRepository) *SystemLogHandler {
	return &SystemLogHandler{repo: repo}
}

// systemLogPath 与 logger.Init() 里的 lumberjack Filename 保持一致。
const systemLogPath = "data/logs/mmwx.log"

// logRow 是解析后的一行结构化日志。解析失败时 Time/Level 为空、Raw 保留原文（不吞行）。
type logRow struct {
	Time  string `json:"time"`
	Level string `json:"level"`
	Msg   string `json:"msg"`
	Raw   string `json:"raw,omitempty"`
}

func (h *SystemLogHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	lines := 500
	if v := r.URL.Query().Get("lines"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 2000 {
			lines = n
		}
	}
	levelFilter := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("level")))
	q := strings.TrimSpace(r.URL.Query().Get("q"))

	// tailFile 多读一些，给筛选留余量：级别/关键字过滤会砍掉一部分行，
	// 直接按 lines tail 再过滤会导致返回远少于 lines。上限 2000×4 仍在 8KB 反向分块的舒适区。
	rawTail, err := tailFile(systemLogPath, lines*4)
	if err != nil {
		// 文件不存在（全新部署还没写日志）不算错误，返回空列表
		respondJSON(w, http.StatusOK, map[string]any{"rows": []logRow{}})
		return
	}

	rows := make([]logRow, 0, lines)
	for _, line := range strings.Split(rawTail, "\n") {
		if line == "" {
			continue
		}
		row := parseLogfmtLine(line)
		if levelFilter != "" && strings.TrimSpace(row.Level) != levelFilter {
			continue
		}
		if q != "" && !strings.Contains(line, q) {
			continue
		}
		rows = append(rows, row)
	}
	// 只保留最后 lines 行（过滤后可能仍超量）
	if len(rows) > lines {
		rows = rows[len(rows)-lines:]
	}

	respondJSON(w, http.StatusOK, map[string]any{"rows": rows})
}

// parseLogfmtLine 解析一行 logfmt 日志，抽出 time / level / msg。纯函数，可单测。
//
// 格式来自 logger.newTextHandler：time="2006-01-02 15:04:05" level="INFO " msg=... 后跟任意 k=v。
// msg 只在含空格时才带引号（slog logfmt 规则），故不能按空格 split。这里做最小化解析：
// 只认 time= / level= / msg= 三个前缀键，取到 msg= 后把剩余整段当消息（含后续 k=v，
// 对展示够用，避免实现完整 logfmt 状态机）。
//
// 解析不出 time/level（如接管前的历史行、或非本格式的行）→ Level/Time 空、Raw=整行原文，
// 让前端原样显示，绝不吞行。
func parseLogfmtLine(line string) logRow {
	time, rest, okT := cutLogfmtValue(line, "time=")
	level, rest2, okL := cutLogfmtValue(rest, "level=")
	if !okT || !okL {
		return logRow{Raw: line}
	}
	// msg 走同一套引号配对逻辑（cutLogfmtValue）：带引号时正确识别右引号边界，
	// 不能简单「取到行尾再 unquote」—— 那样 `msg="x" k=v` 会把整段当引号值。
	msg, _, _ := cutLogfmtValue(rest2, "msg=")
	return logRow{Time: time, Level: strings.TrimSpace(level), Msg: msg}
}

// cutLogfmtValue 从 s 中定位 key（形如 "time="），取其后的一个 logfmt 值，
// 返回 (值, 该值之后的剩余串, 是否找到)。值可能带引号也可能是裸 token。
func cutLogfmtValue(s, key string) (string, string, bool) {
	idx := strings.Index(s, key)
	if idx < 0 {
		return "", s, false
	}
	after := s[idx+len(key):]
	if strings.HasPrefix(after, `"`) {
		// 引号值：找配对的未转义右引号
		end := 1
		for end < len(after) {
			if after[end] == '\\' {
				end += 2
				continue
			}
			if after[end] == '"' {
				break
			}
			end++
		}
		// end 可能因引号未闭合(tailFile 切出的半行常见)或反斜杠结尾而 >= len(after);
		// 必须夹到 len(after),否则 after[:end+1] 越界 panic → handler 崩 → nginx 502。
		val := unquoteLogfmt(after[:min(end+1, len(after))])
		return val, after[min(end+1, len(after)):], true
	}
	// 裸值：到下一个空格
	sp := strings.IndexByte(after, ' ')
	if sp < 0 {
		return after, "", true
	}
	return after[:sp], after[sp:], true
}

// unquoteLogfmt 去掉外层引号并还原 \" \\ 转义。非引号串原样返回。
func unquoteLogfmt(s string) string {
	s = strings.TrimSpace(s)
	if len(s) < 2 || s[0] != '"' || s[len(s)-1] != '"' {
		return s
	}
	inner := s[1 : len(s)-1]
	inner = strings.ReplaceAll(inner, `\"`, `"`)
	inner = strings.ReplaceAll(inner, `\\`, `\`)
	return inner
}
