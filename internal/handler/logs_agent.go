package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// AgentLogHandler 转发「拉取远程机器日志」请求到指定 agent，admin 专用。
//   GET /api/admin/logs/agent?server_id=&service=&lines=
//
// service: agent（读 agent 自身日志文件）/ xray / nginx（journalctl）。
// 旧版 agent 没有 /api/child/logs 路由 → 返回 404，本 handler 据此给出「版本过低」的明确提示，
// 而不是把一个看不懂的转发错误直接抛给前端。
type AgentLogHandler struct {
	rm *RemoteManageHandler
}

func NewAgentLogHandler(rm *RemoteManageHandler) *AgentLogHandler {
	return &AgentLogHandler{rm: rm}
}

func (h *AgentLogHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	serverIDStr := strings.TrimSpace(r.URL.Query().Get("server_id"))
	serverID, err := strconv.ParseInt(serverIDStr, 10, 64)
	if err != nil || serverID <= 0 {
		writeBadRequest(w, "server_id is required")
		return
	}
	service := strings.TrimSpace(r.URL.Query().Get("service"))
	if service == "" {
		service = "agent"
	}
	lines := atoiDefault(r.URL.Query().Get("lines"), 200)

	// 拼 agent 端路径
	childPath := "/api/child/logs?service=" + service + "&lines=" + strconv.Itoa(lines)

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	body, err := h.rm.forwardToRemoteServer(ctx, serverID, http.MethodGet, childPath, nil)
	if err != nil {
		// 旧版 agent 无此路由 → 404;或 agent 离线。分类成前端可读的提示。
		reason, msg := classifyAgentLogError(err.Error())
		respondJSON(w, http.StatusOK, map[string]any{"success": false, "reason": reason, "message": msg})
		return
	}

	// agent 返回的 JSON 直接透传（{success, service, logs} 或 journalctl 不可用时的 {success:false,message}）。
	// 若解析失败也原样包一层，不吞内容。
	var parsed map[string]any
	if json.Unmarshal(body, &parsed) == nil {
		respondJSON(w, http.StatusOK, parsed)
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{"success": true, "logs": string(body)})
}

// classifyAgentLogError 把 forwardToRemoteServer 的错误分类成 (reason, 面向用户的消息)。
// 纯函数，可单测。旧版 agent 无 /api/child/logs 路由 → 404 → unsupported（提示升级）;
// agent 离线 → offline;其余 → error 透传原文。
func classifyAgentLogError(msg string) (reason, message string) {
	lower := strings.ToLower(msg)
	switch {
	case strings.Contains(msg, "404") || strings.Contains(lower, "not found"):
		return "unsupported", "该 agent 版本过低，不支持日志拉取，请升级 agent"
	case strings.Contains(lower, "not connected") || strings.Contains(lower, "offline"):
		return "offline", "agent 离线，无法拉取日志"
	default:
		return "error", msg
	}
}
