package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"miaomiaowux/internal/storage"
)

// NewUserTrafficLimitHandler 处理 PUT /api/admin/users/traffic-limit — 设置用户级流量上限覆写。
// payload:{ username, traffic_limit_override_gb: number|null }
//
// 三态语义(与 storage.User.TrafficLimitOverride 一致):
//
//	null → 清除覆写,继承套餐流量
//	0    → 显式不限流量
//	>0   → 覆写为该值
//
// 单位:入参 GB(跟随套餐 traffic_limit_gb 的用户可见单位),落库 bytes(跟随 packages.traffic_limit_bytes)。
//
// 不收 pusher:limiter 下发的 WSUserLimitInfo 只带 speed/device,不带流量 —— 流量断流由
// TrafficLimitEnforcer 在主控侧摘除 inbound 实现,推 limiter 对它无意义。
// 不收 licenseManager:流量限制是基础功能,套餐流量限制本身就不 gate。
func NewUserTrafficLimitHandler(repo *storage.TrafficRepository) http.Handler {
	type req struct {
		Username string `json:"username"`
		// 指针必需:0(显式不限流量)与缺省/null(继承套餐)是两种不同语义,值类型区分不了。
		TrafficLimitOverrideGB *float64 `json:"traffic_limit_override_gb"`
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

		var limitBytes *int64
		if body.TrafficLimitOverrideGB != nil {
			if *body.TrafficLimitOverrideGB < 0 {
				writeError(w, http.StatusBadRequest, errors.New("traffic_limit_override_gb 不能为负"))
				return
			}
			b := int64(*body.TrafficLimitOverrideGB * 1024 * 1024 * 1024)
			limitBytes = &b
		}

		if err := repo.UpdateUserTrafficLimitOverride(r.Context(), username, limitBytes); err != nil {
			if errors.Is(err, storage.ErrUserNotFound) {
				writeError(w, http.StatusNotFound, err)
				return
			}
			writeError(w, http.StatusInternalServerError, err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"success": true,
			"message": "User traffic limit updated",
		})
	})
}
