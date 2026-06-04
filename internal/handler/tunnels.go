package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"miaomiaowux/internal/storage"
)

// Tunnel(dokodemo-door 转发入站)聚合管理:tunnel 不进节点表,这里跨所有远程/分享服务器
// 列出 protocol=="tunnel" 的入站,供节点管理页的「Tunnel 管理」弹窗 + 节点行「被转发」标识使用。
// 仅管理员;删除复用 /api/admin/remote/inbounds {action:remove}。

type TunnelsHandler struct {
	repo         *storage.TrafficRepository
	remoteManage *RemoteManageHandler
}

func NewTunnelsHandler(repo *storage.TrafficRepository, rm *RemoteManageHandler) *TunnelsHandler {
	return &TunnelsHandler{repo: repo, remoteManage: rm}
}

type tunnelInfo struct {
	ServerID      int64  `json:"server_id"`
	ServerName    string `json:"server_name"`
	IsFederated   bool   `json:"is_federated"`
	Tag           string `json:"tag"`
	ListenPort    int    `json:"listen_port"`
	TargetAddress string `json:"target_address"`
	TargetPort    int    `json:"target_port"`
	Network       string `json:"network"`
}

func (h *TunnelsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, errors.New("only GET is supported"))
		return
	}
	servers, err := h.repo.ListRemoteServers(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	tunnels := make([]tunnelInfo, 0)
	for _, s := range servers {
		if s.Status != "connected" {
			continue
		}
		ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
		result, ferr := h.remoteManage.ForwardToServer(ctx, s.ID, "GET", "/api/child/inbounds", nil)
		cancel()
		if ferr != nil {
			continue // 单台失败不影响整体
		}
		var resp struct {
			Inbounds []map[string]any `json:"inbounds"`
		}
		if json.Unmarshal(result, &resp) != nil {
			continue
		}
		_, fedErr := h.repo.GetFederatedServer(r.Context(), s.ID)
		isFed := fedErr == nil
		for _, ib := range resp.Inbounds {
			if p, _ := ib["protocol"].(string); p != "tunnel" {
				continue
			}
			tag, _ := ib["tag"].(string)
			if tag == "tunnel-in" {
				continue // 内部管理用(reality 自盗端口回源),不对外展示
			}
			ti := tunnelInfo{ServerID: s.ID, ServerName: s.Name, IsFederated: isFed, Tag: tag}
			ti.ListenPort = toInt(ib["port"])
			if settings, ok := ib["settings"].(map[string]any); ok {
				ti.TargetAddress, _ = settings["address"].(string)
				ti.TargetPort = toInt(settings["port"])
				ti.Network, _ = settings["network"].(string)
			}
			tunnels = append(tunnels, ti)
		}
	}
	respondJSON(w, http.StatusOK, map[string]any{"success": true, "tunnels": tunnels})
}

func toInt(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case int64:
		return int(n)
	}
	return 0
}
