package handler

import (
	"encoding/json"
	"net/http"

	"miaomiaowux/internal/license"
	"miaomiaowux/internal/storage"
)

type LicenseHandler struct {
	repo    *storage.TrafficRepository
	manager *license.Manager
}

func NewLicenseHandler(repo *storage.TrafficRepository, mgr *license.Manager) *LicenseHandler {
	return &LicenseHandler{repo: repo, manager: mgr}
}

func (h *LicenseHandler) GetStatus(w http.ResponseWriter, r *http.Request) {
	status := h.manager.GetStatus()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"success": true,
		"license": status,
	})
}

func (h *LicenseHandler) GetSettings(w http.ResponseWriter, r *http.Request) {
	key, _ := h.repo.GetSystemSetting(r.Context(), "license_key")

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"success":     true,
		"license_key": key,
	})
}

func (h *LicenseHandler) UpdateSettings(w http.ResponseWriter, r *http.Request) {
	var req struct {
		LicenseKey string `json:"license_key"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request")
		return
	}

	ctx := r.Context()
	if req.LicenseKey != "" {
		_ = h.repo.SetSystemSetting(ctx, "license_key", req.LicenseKey)
	}

	h.manager.Refresh(ctx)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

func (h *LicenseHandler) UserGetStatus(w http.ResponseWriter, r *http.Request) {
	status := h.manager.GetStatus()
	resp := map[string]any{
		"success": true,
		"valid":   status.Valid,
	}
	if status.Plan != nil {
		resp["plan"] = map[string]any{
			"name":         status.Plan.Name,
			"display_name": status.Plan.DisplayName,
			"description":  status.Plan.Description,
			"max_servers":  status.Plan.MaxServers,
			"max_nodes":    status.Plan.MaxNodes,
			"max_users":    status.Plan.MaxUsers,
			"features":     status.Plan.Features,
		}
	}
	if status.ExpiresAt != "" {
		resp["expires_at"] = status.ExpiresAt
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func (h *LicenseHandler) GetUsage(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	status := h.manager.GetStatus()

	serverCount, _ := h.repo.CountRemoteServers(ctx)
	// 跟实际限制点(routed_outbound.go)一致 — 只计 admin 平台创建的 routed 出站节点。
	// 用户手动导入 / 外部订阅 / 用户私有路由出站都不计 license 配额。
	nodeCount, _ := h.repo.CountLicensedNodes(ctx)
	userCount, _ := h.repo.CountUsers(ctx)

	maxServers, maxNodes, maxUsers := 5, 20, 10
	if status.Plan != nil {
		maxServers = status.Plan.MaxServers
		maxNodes = status.Plan.MaxNodes
		maxUsers = status.Plan.MaxUsers
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"success": true,
		"usage": map[string]any{
			"servers": map[string]any{"current": serverCount, "max": maxServers},
			"nodes":   map[string]any{"current": nodeCount, "max": maxNodes},
			"users":   map[string]any{"current": userCount, "max": maxUsers},
		},
	})
}
