package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"

	"miaomiaowux/internal/storage"
)

// SecuritySettingsHandler 处理 /api/admin/security-settings 的 GET/PUT。
//
// 9 个 system_settings KV(snake_case,跟现有 `notify_traffic_threshold_percent` 同款风格):
//   - 登录限流:login_rate_max_attempts / login_rate_window_minutes / login_rate_lock_minutes
//   - 暴力防护:brute_force_enabled / brute_force_max_failures / brute_force_window_minutes / brute_force_block_minutes
//   - 订阅频率:sub_rate_enabled / sub_rate_limit / sub_rate_window_minutes
//
// PUT 写完后调 GetLoginRateLimiter().UpdateConfig / GetBruteForceProtector().UpdateConfig /
// GetSubscriptionRateLimiter().UpdateConfig 热更新,无需重启主控。

type securitySettingsResponse struct {
	LoginRateMaxAttempts    int  `json:"login_rate_max_attempts"`
	LoginRateWindowMinutes  int  `json:"login_rate_window_minutes"`
	LoginRateLockMinutes    int  `json:"login_rate_lock_minutes"`
	BruteForceEnabled       bool `json:"brute_force_enabled"`
	BruteForceMaxFailures   int  `json:"brute_force_max_failures"`
	BruteForceWindowMinutes int  `json:"brute_force_window_minutes"`
	BruteForceBlockMinutes  int  `json:"brute_force_block_minutes"`
	SubRateEnabled          bool `json:"sub_rate_enabled"`
	SubRateLimit            int  `json:"sub_rate_limit"`
	SubRateWindowMinutes    int  `json:"sub_rate_window_minutes"`
}

// 默认值 — 跟 NewXxxProtector hardcoded 默认值一致,KV 缺失时返回这套。
var securityDefaults = securitySettingsResponse{
	LoginRateMaxAttempts:    5,
	LoginRateWindowMinutes:  60,
	LoginRateLockMinutes:    60,
	BruteForceEnabled:       true,
	BruteForceMaxFailures:   5,
	BruteForceWindowMinutes: 1440,
	BruteForceBlockMinutes:  1440,
	SubRateEnabled:          true,
	SubRateLimit:            60,
	SubRateWindowMinutes:    1,
}

type SecuritySettingsHandler struct {
	repo *storage.TrafficRepository
}

func NewSecuritySettingsHandler(repo *storage.TrafficRepository) *SecuritySettingsHandler {
	return &SecuritySettingsHandler{repo: repo}
}

func (h *SecuritySettingsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.handleGet(w, r)
	case http.MethodPut, http.MethodPost:
		h.handlePut(w, r)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (h *SecuritySettingsHandler) handleGet(w http.ResponseWriter, r *http.Request) {
	resp := LoadSecuritySettings(r.Context(), h.repo)
	respondJSON(w, http.StatusOK, resp)
}

func (h *SecuritySettingsHandler) handlePut(w http.ResponseWriter, r *http.Request) {
	var payload securitySettingsResponse
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if msg := validateSecurityPayload(&payload); msg != "" {
		writeJSONError(w, http.StatusBadRequest, msg)
		return
	}

	// 批量写 KV(任一失败就回 500,前端会重试)
	if err := writeSecurityKVs(r.Context(), h.repo, &payload); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "save: "+err.Error())
		return
	}

	// 热更新 3 个单例 — 立即生效不需要重启
	if rl := GetLoginRateLimiter(); rl != nil {
		rl.UpdateConfig(payload.LoginRateMaxAttempts, payload.LoginRateWindowMinutes, payload.LoginRateLockMinutes)
	}
	if bfp := GetBruteForceProtector(); bfp != nil {
		bfp.UpdateConfig(payload.BruteForceEnabled, payload.BruteForceMaxFailures, payload.BruteForceWindowMinutes, payload.BruteForceBlockMinutes)
	}
	if srl := GetSubscriptionRateLimiter(); srl != nil {
		srl.UpdateConfig(payload.SubRateEnabled, payload.SubRateLimit, payload.SubRateWindowMinutes)
	}
	log.Printf("[SecuritySettings] thresholds updated: login=%d/%dmin/%dmin brute=%v/%d/%dmin/%dmin sub=%v/%d/%dmin",
		payload.LoginRateMaxAttempts, payload.LoginRateWindowMinutes, payload.LoginRateLockMinutes,
		payload.BruteForceEnabled, payload.BruteForceMaxFailures, payload.BruteForceWindowMinutes, payload.BruteForceBlockMinutes,
		payload.SubRateEnabled, payload.SubRateLimit, payload.SubRateWindowMinutes)

	respondJSON(w, http.StatusOK, payload)
}

func validateSecurityPayload(p *securitySettingsResponse) string {
	checks := map[string]int{
		"login_rate_max_attempts":    p.LoginRateMaxAttempts,
		"login_rate_window_minutes":  p.LoginRateWindowMinutes,
		"login_rate_lock_minutes":    p.LoginRateLockMinutes,
		"brute_force_max_failures":   p.BruteForceMaxFailures,
		"brute_force_window_minutes": p.BruteForceWindowMinutes,
		"brute_force_block_minutes":  p.BruteForceBlockMinutes,
		"sub_rate_limit":             p.SubRateLimit,
		"sub_rate_window_minutes":    p.SubRateWindowMinutes,
	}
	for name, v := range checks {
		if v <= 0 {
			return fmt.Sprintf("%s must be > 0", name)
		}
	}
	return ""
}

// LoadSecuritySettings 从 system_settings 读 9 个 KV,缺失/非法值 fallback 到 securityDefaults。
// 启动时 main.go 也调它来初始化限流器。
func LoadSecuritySettings(ctx context.Context, repo *storage.TrafficRepository) securitySettingsResponse {
	resp := securityDefaults
	if repo == nil {
		return resp
	}

	resp.LoginRateMaxAttempts = readIntSetting(ctx, repo, "login_rate_max_attempts", resp.LoginRateMaxAttempts)
	resp.LoginRateWindowMinutes = readIntSetting(ctx, repo, "login_rate_window_minutes", resp.LoginRateWindowMinutes)
	resp.LoginRateLockMinutes = readIntSetting(ctx, repo, "login_rate_lock_minutes", resp.LoginRateLockMinutes)
	resp.BruteForceEnabled = readBoolSetting(ctx, repo, "brute_force_enabled", resp.BruteForceEnabled)
	resp.BruteForceMaxFailures = readIntSetting(ctx, repo, "brute_force_max_failures", resp.BruteForceMaxFailures)
	resp.BruteForceWindowMinutes = readIntSetting(ctx, repo, "brute_force_window_minutes", resp.BruteForceWindowMinutes)
	resp.BruteForceBlockMinutes = readIntSetting(ctx, repo, "brute_force_block_minutes", resp.BruteForceBlockMinutes)
	resp.SubRateEnabled = readBoolSetting(ctx, repo, "sub_rate_enabled", resp.SubRateEnabled)
	resp.SubRateLimit = readIntSetting(ctx, repo, "sub_rate_limit", resp.SubRateLimit)
	resp.SubRateWindowMinutes = readIntSetting(ctx, repo, "sub_rate_window_minutes", resp.SubRateWindowMinutes)
	return resp
}

func writeSecurityKVs(ctx context.Context, repo *storage.TrafficRepository, p *securitySettingsResponse) error {
	pairs := map[string]string{
		"login_rate_max_attempts":    strconv.Itoa(p.LoginRateMaxAttempts),
		"login_rate_window_minutes":  strconv.Itoa(p.LoginRateWindowMinutes),
		"login_rate_lock_minutes":    strconv.Itoa(p.LoginRateLockMinutes),
		"brute_force_enabled":        strconv.FormatBool(p.BruteForceEnabled),
		"brute_force_max_failures":   strconv.Itoa(p.BruteForceMaxFailures),
		"brute_force_window_minutes": strconv.Itoa(p.BruteForceWindowMinutes),
		"brute_force_block_minutes":  strconv.Itoa(p.BruteForceBlockMinutes),
		"sub_rate_enabled":           strconv.FormatBool(p.SubRateEnabled),
		"sub_rate_limit":             strconv.Itoa(p.SubRateLimit),
		"sub_rate_window_minutes":    strconv.Itoa(p.SubRateWindowMinutes),
	}
	for k, v := range pairs {
		if err := repo.SetSystemSetting(ctx, k, v); err != nil {
			return fmt.Errorf("set %s: %w", k, err)
		}
	}
	return nil
}

func readIntSetting(ctx context.Context, repo *storage.TrafficRepository, key string, fallback int) int {
	v, err := repo.GetSystemSetting(ctx, key)
	if err != nil || v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return fallback
	}
	return n
}

func readBoolSetting(ctx context.Context, repo *storage.TrafficRepository, key string, fallback bool) bool {
	v, err := repo.GetSystemSetting(ctx, key)
	if err != nil || v == "" {
		return fallback
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return fallback
	}
	return b
}
