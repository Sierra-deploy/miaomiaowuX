package handler

import (
	"errors"
	"net/http"
	"strconv"

	"miaomiaowux/internal/util"
)

// agent 侧的网卡枚举路由(mmw-agent constants.PathChildSystemNICs)。
const pathChildSystemNICs = "/api/child/system/nics"

// ServerNICsHandler 提供 GET /api/admin/server-nics?server_id=N —— 列出某台服务器上
// 可用于 xray 出站 sendThrough 绑定的网卡地址,供前端在出站编辑里做下拉选择。
//
// server_id 省略或 <=0 时枚举主控本机。注意这里**不能**走 /api/child 回环:
// 那批路由只在 child 模式下注册(main.go),普通主控上根本不存在。
type ServerNICsHandler struct {
	rm *RemoteManageHandler
}

func NewServerNICsHandler(rm *RemoteManageHandler) *ServerNICsHandler {
	return &ServerNICsHandler{rm: rm}
}

func (h *ServerNICsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondJSON(w, http.StatusMethodNotAllowed, map[string]any{"success": false, "message": "方法不允许"})
		return
	}

	var id int64
	if raw := r.URL.Query().Get("server_id"); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			respondJSON(w, http.StatusBadRequest, map[string]any{"success": false, "message": "server_id 无效"})
			return
		}
		id = parsed
	}

	// 主控本机:进程内直接枚举。容器化部署时拿到的是容器内地址,这是对的 ——
	// 本机 xray 与主控同 netns,能绑的就是这些地址。
	if id <= 0 {
		nics, err := util.ListNICs()
		if err != nil {
			respondJSON(w, http.StatusOK, map[string]any{
				"success": false, "reason": "error", "message": "列举本机网卡失败: " + err.Error(),
			})
			return
		}
		respondJSON(w, http.StatusOK, map[string]any{"success": true, "local": true, "nics": nics})
		return
	}

	if h.rm == nil {
		respondJSON(w, http.StatusOK, map[string]any{
			"success": false, "reason": "error", "message": "远程管理未启用",
		})
		return
	}

	body, err := h.rm.ForwardToServer(r.Context(), id, http.MethodGet, pathChildSystemNICs, nil)
	if err != nil {
		// 老 agent 没注册这条路由,net/http 的 ServeMux 回 404 —— 用类型断言判断,
		// 别去匹配错误字符串:forwardToRemoteServer 对无效 server_id 返回的
		// "server not found" 也含 "not found",会被误判成"版本过低"。
		var he *HTTPLikeError
		if errors.As(err, &he) && he.Status == http.StatusNotFound {
			respondJSON(w, http.StatusOK, map[string]any{
				"success": false,
				"reason":  "unsupported",
				"message": "该服务器的 agent 版本过低,不支持读取网卡列表,请升级 agent 或手动填写出站 IP",
			})
			return
		}
		respondJSON(w, http.StatusOK, map[string]any{
			"success": false, "reason": "error", "message": err.Error(),
		})
		return
	}

	// agent 的响应已是 {success, nics:[...]},原样透传。
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write(body)
}
