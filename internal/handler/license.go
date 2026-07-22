package handler

import (
	"context"
	"encoding/json"
	"fmt"
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

// licenseUserQuotaExceeded 判断「再建一个用户」是否会超出许可证的用户数配额。
// 返回面向用户的提示语和是否超限;lm 为 nil(未接许可证)时一律放行。
//
// **每一条创建普通用户的路径都必须先过这里** —— 目前是管理员建号(users.go)和
// Telegram 邀请码注册(tgbot_admin.go)。TG 注册曾经完全绕过配额检查,
// 因为它是另一条 handler 链路,加限额时漏掉了;抽成函数就是为了下次新增入口时不再漏。
//
// 口径与面板展示、上报 license 服务器一致:CountLicensedUsers = 启用中的非管理员。
func licenseUserQuotaExceeded(ctx context.Context, repo *storage.TrafficRepository, lm *license.Manager) (string, bool) {
	if lm == nil || repo == nil {
		return "", false
	}
	maxUsers := 10
	if status := lm.GetStatus(); status.Plan != nil {
		maxUsers = status.Plan.MaxUsers
	}
	count, err := repo.CountLicensedUsers(ctx)
	if err != nil {
		// 统计失败不阻断创建 —— 宁可漏挡一次,也不因为一次 DB 抖动把注册整个卡死。
		return "", false
	}
	if count >= maxUsers {
		return fmt.Sprintf("已达到用户数量上限 (%d/%d)，请升级许可证", count, maxUsers), true
	}
	return "", false
}

func (h *LicenseHandler) GetUsage(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	status := h.manager.GetStatus()

	serverCount, _ := h.repo.CountRemoteServers(ctx)
	// 跟实际限制点(routed_outbound.go)一致 — 只计 admin 平台创建的 routed 出站节点。
	// 用户手动导入 / 外部订阅 / 用户私有路由出站都不计 license 配额。
	nodeCount, _ := h.repo.CountLicensedNodes(ctx)
	// 与上报 license 服务器、创建用户限额同一口径(启用中的非管理员),
	// 否则面板显示的 current 会比许可证后台大,且和实际能创建的数量对不上。
	userCount, _ := h.repo.CountLicensedUsers(ctx)

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
