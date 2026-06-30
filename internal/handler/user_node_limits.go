package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"miaomiaowux/internal/license"
	"miaomiaowux/internal/storage"
)

// NewUserNodeLimitsHandler 处理 PUT /api/admin/users/node-limits — 设置用户级 per-node 限速 / 客户端数覆盖。
// payload:{ username, node_speed_overrides: {id: mbps}, node_device_overrides: {id: count} }。
// 任一 map 含 > 0 的值都视为启用 limiter,触发 PRO gate。0 表示显式不限速,不触发。
// 保存后调 PushToAllServersForUser 推下发,Agent 收到新一轮 limiter config。
func NewUserNodeLimitsHandler(repo *storage.TrafficRepository, pusher *LimiterConfigPusher, licenseManager *license.Manager) http.Handler {
	type req struct {
		Username            string             `json:"username"`
		NodeSpeedOverrides  map[int64]float64  `json:"node_speed_overrides"`
		NodeDeviceOverrides map[int64]int      `json:"node_device_overrides"`
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut && r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var body req
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, errors.New("invalid request body"))
			return
		}

		username := strings.TrimSpace(body.Username)
		if username == "" {
			writeError(w, http.StatusBadRequest, errors.New("username is required"))
			return
		}

		// 校验:不允许负数
		for id, v := range body.NodeSpeedOverrides {
			if v < 0 {
				writeError(w, http.StatusBadRequest, errors.New("node_speed_overrides 不能为负"))
				_ = id
				return
			}
		}
		for id, v := range body.NodeDeviceOverrides {
			if v < 0 {
				writeError(w, http.StatusBadRequest, errors.New("node_device_overrides 不能为负"))
				_ = id
				return
			}
		}

		// PRO gate:任何 per-node 限速 > 0 都视为启用 limiter(0 = 显式不限速,不算启用)
		if (hasNonZeroLimit(body.NodeSpeedOverrides) || hasNonZeroIntLimit(body.NodeDeviceOverrides)) &&
			licenseManager != nil && !licenseManager.HasFeature("limiter") {
			http.Error(w, "限速器是 PRO 功能,需要许可证", http.StatusForbidden)
			return
		}

		if err := repo.UpdateUserNodeLimits(r.Context(), username, body.NodeSpeedOverrides, body.NodeDeviceOverrides); err != nil {
			if errors.Is(err, storage.ErrUserNotFound) {
				writeError(w, http.StatusNotFound, err)
				return
			}
			writeError(w, http.StatusInternalServerError, err)
			return
		}

		if pusher != nil {
			// Background 而非 r.Context():goroutine 异步,handler 返回后 r.Context() 即被 net/http cancel,
			// 否则下发的 DB 查询会 context canceled → 限速静默不下发。
			go pusher.PushToAllServersForUser(context.Background(), username)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"success": true,
			"message": "User node limits updated",
		})
	})
}
