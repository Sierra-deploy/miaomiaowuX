package handler

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"miaomiaowux/internal/notify"
	"miaomiaowux/internal/storage"
)

type notifyConfigResponse struct {
	NotifyEnabled               bool   `json:"notify_enabled"`
	TelegramBotToken            string `json:"telegram_bot_token"`
	TelegramChatID              string `json:"telegram_chat_id"`
	NotifyLogin                 bool   `json:"notify_login"`
	NotifySubscribeFetch        bool   `json:"notify_subscribe_fetch"`
	NotifyDailyTraffic          bool   `json:"notify_daily_traffic"`
	NotifyServerOffline         bool   `json:"notify_server_offline"`
	NotifyServerOnline          bool   `json:"notify_server_online"`
	NotifyTrafficThreshold      bool   `json:"notify_traffic_threshold"`
	NotifyDailyTrafficTime      string `json:"notify_daily_traffic_time"`
	NotifyTrafficThresholdPct   int    `json:"notify_traffic_threshold_percent"`
	// Phase 2 新增 9 个通知开关 + 2 个参数
	NotifyTrafficThreshold80      bool `json:"notify_traffic_threshold_80"`
	NotifyOverLimit               bool `json:"notify_over_limit"`
	NotifyPackageExpiring         bool `json:"notify_package_expiring"`
	NotifyPackageExpiringDays     int  `json:"notify_package_expiring_days"`
	NotifyPackageExpired          bool `json:"notify_package_expired"`
	NotifyUserRegistered          bool `json:"notify_user_registered"`
	NotifyTelegramBound           bool `json:"notify_telegram_bound"`
	NotifyCertResult              bool `json:"notify_cert_result"`
	NotifyAgentLongOffline        bool `json:"notify_agent_long_offline"`
	NotifyAgentLongOfflineMinutes int  `json:"notify_agent_long_offline_minutes"`
	NotifyDeviceLimitExceeded     bool `json:"notify_device_limit_exceeded"`
	NotifyIPBan                   bool `json:"notify_ip_ban"`
	// 服务器上下线通知容忍阈值(秒):离线满该秒数才发下线通知,阈值内又上线则不发(压抖动+主控重启误报)。0=关闭。
	NotifyServerToleranceSeconds int `json:"notify_server_tolerance_seconds"`
	// 每日推送文案模板。空 = 未自定义,渲染时用默认模板。
	NotifyDailyTrafficTemplate string `json:"notify_daily_traffic_template"`
	// 默认模板正文,只读:前端拿它做「恢复默认」和首次填充,避免前端另抄一份导致两边漂移。
	NotifyDailyTrafficTemplateDefault string `json:"notify_daily_traffic_template_default"`
	// 可用占位符说明,只读。同样由后端下发:前端硬编码一份的话,
	// 后端加/改占位符时 UI 会教管理员写一个不生效的占位符。
	NotifyDailyTrafficPlaceholders any `json:"notify_daily_traffic_placeholders"`
}

type notifyConfigRequest struct {
	NotifyEnabled               bool   `json:"notify_enabled"`
	TelegramBotToken            string `json:"telegram_bot_token"`
	TelegramChatID              string `json:"telegram_chat_id"`
	NotifyLogin                 bool   `json:"notify_login"`
	NotifySubscribeFetch        bool   `json:"notify_subscribe_fetch"`
	NotifyDailyTraffic          bool   `json:"notify_daily_traffic"`
	NotifyServerOffline         bool   `json:"notify_server_offline"`
	NotifyServerOnline          bool   `json:"notify_server_online"`
	NotifyTrafficThreshold      bool   `json:"notify_traffic_threshold"`
	NotifyDailyTrafficTime      string `json:"notify_daily_traffic_time"`
	NotifyTrafficThresholdPct   int    `json:"notify_traffic_threshold_percent"`
	NotifyTrafficThreshold80      bool `json:"notify_traffic_threshold_80"`
	NotifyOverLimit               bool `json:"notify_over_limit"`
	NotifyPackageExpiring         bool `json:"notify_package_expiring"`
	NotifyPackageExpiringDays     int  `json:"notify_package_expiring_days"`
	NotifyPackageExpired          bool `json:"notify_package_expired"`
	NotifyUserRegistered          bool `json:"notify_user_registered"`
	NotifyTelegramBound           bool `json:"notify_telegram_bound"`
	NotifyCertResult              bool `json:"notify_cert_result"`
	NotifyAgentLongOffline        bool `json:"notify_agent_long_offline"`
	NotifyAgentLongOfflineMinutes int  `json:"notify_agent_long_offline_minutes"`
	NotifyDeviceLimitExceeded     bool `json:"notify_device_limit_exceeded"`
	NotifyIPBan                   bool `json:"notify_ip_ban"`
	// 指针:nil=不改;非 nil=写入(0 合法,表示关闭容忍)。
	NotifyServerToleranceSeconds *int `json:"notify_server_tolerance_seconds"`
	// 指针:nil=不改;非 nil=写入(空字符串合法,表示恢复默认模板)。
	// 必须是指针 —— 前端每次改开关都 PUT 整个对象,若用值类型,任何一次开关操作
	// 都会把管理员写的文案冲成空。
	NotifyDailyTrafficTemplate *string `json:"notify_daily_traffic_template"`
}

type NotifyConfigHandler struct {
	repo *storage.TrafficRepository
}

func NewNotifyConfigHandler(repo *storage.TrafficRepository) *NotifyConfigHandler {
	return &NotifyConfigHandler{repo: repo}
}

func (h *NotifyConfigHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if strings.HasSuffix(r.URL.Path, "/test") && r.Method == http.MethodPost {
		h.handleTest(w, r)
		return
	}
	if strings.HasSuffix(r.URL.Path, "/preview") && r.Method == http.MethodPost {
		h.handlePreview(w, r)
		return
	}

	switch r.Method {
	case http.MethodGet:
		h.handleGet(w, r)
	case http.MethodPut:
		h.handleUpdate(w, r)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (h *NotifyConfigHandler) handleGet(w http.ResponseWriter, r *http.Request) {
	sysCfg, err := h.repo.GetSystemConfig(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	maskedToken := sysCfg.TelegramBotToken
	if len(maskedToken) > 4 {
		maskedToken = strings.Repeat("*", len(maskedToken)-4) + maskedToken[len(maskedToken)-4:]
	}

	// 读不出(键不存在是正常的"未自定义")→ 空,前端展示默认模板
	tpl, _ := h.repo.GetSystemSetting(r.Context(), notifyDailyTemplateKey)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(notifyConfigResponse{
		NotifyEnabled:                 sysCfg.NotifyEnabled,
		TelegramBotToken:              maskedToken,
		TelegramChatID:                sysCfg.TelegramChatID,
		NotifyLogin:                   sysCfg.NotifyLogin,
		NotifySubscribeFetch:          sysCfg.NotifySubscribeFetch,
		NotifyDailyTraffic:            sysCfg.NotifyDailyTraffic,
		NotifyServerOffline:           sysCfg.NotifyServerOffline,
		NotifyServerOnline:            sysCfg.NotifyServerOnline,
		NotifyTrafficThreshold:        sysCfg.NotifyTrafficThreshold,
		NotifyDailyTrafficTime:        sysCfg.NotifyDailyTrafficTime,
		NotifyTrafficThresholdPct:     sysCfg.NotifyTrafficThresholdPercent,
		NotifyTrafficThreshold80:      sysCfg.NotifyTrafficThreshold80,
		NotifyOverLimit:               sysCfg.NotifyOverLimit,
		NotifyPackageExpiring:         sysCfg.NotifyPackageExpiring,
		NotifyPackageExpiringDays:     sysCfg.NotifyPackageExpiringDays,
		NotifyPackageExpired:          sysCfg.NotifyPackageExpired,
		NotifyUserRegistered:          sysCfg.NotifyUserRegistered,
		NotifyTelegramBound:           sysCfg.NotifyTelegramBound,
		NotifyCertResult:              sysCfg.NotifyCertResult,
		NotifyAgentLongOffline:        sysCfg.NotifyAgentLongOffline,
		NotifyAgentLongOfflineMinutes: sysCfg.NotifyAgentLongOfflineMinutes,
		NotifyDeviceLimitExceeded:     sysCfg.NotifyDeviceLimitExceeded,
		NotifyIPBan:                   sysCfg.NotifyIPBan,
		NotifyServerToleranceSeconds:  h.repo.GetServerNotifyToleranceSeconds(r.Context()),
		// 返回**存的原值**(未自定义时为空),不替换成默认 —— 前端据此区分「用默认」与
		// 「自定义成了跟默认一样」,后者会把文案冻在旧默认上,以后改默认推不下去。
		NotifyDailyTrafficTemplate:        tpl,
		NotifyDailyTrafficTemplateDefault: defaultDailyTrafficTemplate,
		NotifyDailyTrafficPlaceholders:    dailyTrafficPlaceholders,
	})
}

func (h *NotifyConfigHandler) handleUpdate(w http.ResponseWriter, r *http.Request) {
	var req notifyConfigRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	sysCfg, err := h.repo.GetSystemConfig(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	if req.TelegramBotToken != "" && !strings.Contains(req.TelegramBotToken, "*") {
		sysCfg.TelegramBotToken = req.TelegramBotToken
	}

	sysCfg.NotifyEnabled = req.NotifyEnabled
	sysCfg.TelegramChatID = req.TelegramChatID
	sysCfg.NotifyLogin = req.NotifyLogin
	sysCfg.NotifySubscribeFetch = req.NotifySubscribeFetch
	sysCfg.NotifyDailyTraffic = req.NotifyDailyTraffic
	sysCfg.NotifyServerOffline = req.NotifyServerOffline
	sysCfg.NotifyServerOnline = req.NotifyServerOnline
	sysCfg.NotifyTrafficThreshold = req.NotifyTrafficThreshold
	if req.NotifyDailyTrafficTime != "" {
		sysCfg.NotifyDailyTrafficTime = req.NotifyDailyTrafficTime
	}
	if req.NotifyTrafficThresholdPct > 0 && req.NotifyTrafficThresholdPct <= 100 {
		sysCfg.NotifyTrafficThresholdPercent = req.NotifyTrafficThresholdPct
	}

	// Phase 2 新增 9 个开关 + 2 个参数
	sysCfg.NotifyTrafficThreshold80 = req.NotifyTrafficThreshold80
	sysCfg.NotifyOverLimit = req.NotifyOverLimit
	sysCfg.NotifyPackageExpiring = req.NotifyPackageExpiring
	if req.NotifyPackageExpiringDays > 0 && req.NotifyPackageExpiringDays <= 365 {
		sysCfg.NotifyPackageExpiringDays = req.NotifyPackageExpiringDays
	}
	sysCfg.NotifyPackageExpired = req.NotifyPackageExpired
	sysCfg.NotifyUserRegistered = req.NotifyUserRegistered
	sysCfg.NotifyTelegramBound = req.NotifyTelegramBound
	sysCfg.NotifyCertResult = req.NotifyCertResult
	sysCfg.NotifyAgentLongOffline = req.NotifyAgentLongOffline
	if req.NotifyAgentLongOfflineMinutes > 0 && req.NotifyAgentLongOfflineMinutes <= 1440 {
		sysCfg.NotifyAgentLongOfflineMinutes = req.NotifyAgentLongOfflineMinutes
	}
	sysCfg.NotifyDeviceLimitExceeded = req.NotifyDeviceLimitExceeded
	sysCfg.NotifyIPBan = req.NotifyIPBan

	if err := h.repo.UpdateSystemConfig(r.Context(), sysCfg); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	// 上下线通知容忍阈值单独存在 system_settings(与其它 notify 开关的 system_config 列解耦)。
	// 指针非 nil 才写(0 合法=关闭)。
	if req.NotifyServerToleranceSeconds != nil {
		if err := h.repo.SetServerNotifyToleranceSeconds(r.Context(), *req.NotifyServerToleranceSeconds); err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
	}

	// 每日推送文案模板,同样存 system_settings。指针非 nil 才写(空串合法=恢复默认)。
	// 与默认逐字相同 → 存空,这样以后改了默认模板能自动跟上,不会被冻在旧文案。
	if req.NotifyDailyTrafficTemplate != nil {
		tpl := *req.NotifyDailyTrafficTemplate
		if strings.TrimSpace(tpl) == "" || tpl == defaultDailyTrafficTemplate {
			tpl = ""
		}
		if err := h.repo.SetSystemSetting(r.Context(), notifyDailyTemplateKey, tpl); err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
	}

	if n := GetNotifier(); n != nil {
		n.UpdateConfig(notify.Config{
			Enabled:                       sysCfg.NotifyEnabled,
			BotToken:                      sysCfg.TelegramBotToken,
			ChatID:                        sysCfg.TelegramChatID,
			NotifyLogin:                   sysCfg.NotifyLogin,
			NotifySubscribeFetch:          sysCfg.NotifySubscribeFetch,
			NotifyDailyTraffic:            sysCfg.NotifyDailyTraffic,
			NotifyServerOffline:           sysCfg.NotifyServerOffline,
			NotifyServerOnline:            sysCfg.NotifyServerOnline,
			NotifyTrafficThreshold:        sysCfg.NotifyTrafficThreshold,
			DailyTrafficTime:              sysCfg.NotifyDailyTrafficTime,
			TrafficThresholdPercent:       sysCfg.NotifyTrafficThresholdPercent,
			NotifyTrafficThreshold80:      sysCfg.NotifyTrafficThreshold80,
			NotifyOverLimit:               sysCfg.NotifyOverLimit,
			NotifyPackageExpiring:         sysCfg.NotifyPackageExpiring,
			PackageExpiringDaysAhead:      sysCfg.NotifyPackageExpiringDays,
			NotifyPackageExpired:          sysCfg.NotifyPackageExpired,
			NotifyUserRegistered:          sysCfg.NotifyUserRegistered,
			NotifyTelegramBound:           sysCfg.NotifyTelegramBound,
			NotifyCertResult:              sysCfg.NotifyCertResult,
			NotifyAgentLongOffline:        sysCfg.NotifyAgentLongOffline,
			AgentLongOfflineMinutes:       sysCfg.NotifyAgentLongOfflineMinutes,
			NotifyDeviceLimitExceeded:     sysCfg.NotifyDeviceLimitExceeded,
			NotifyIPBan:                   sysCfg.NotifyIPBan,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// handlePreview 用**当前真实数据**渲染传入的模板并回显,不发送、不落库。
// 走后端渲染而不是前端本地替换:预览与真正发出去的用同一个 renderDailyTrafficTemplate,
// 前端另抄一份 TS 实现迟早会和 Go 这边漂移。
func (h *NotifyConfigHandler) handlePreview(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Template string `json:"template"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	data, ok := buildDailyTrafficData(r.Context(), h.repo)
	// 没有真实数据(没服务器、也没用户流量)也要能预览 —— 给一份示例数据,
	// 否则新部署的管理员打开预览是空白,会以为模板坏了。
	if !ok {
		data = dailyTrafficData{
			Date:    time.Now().Format("2006-01-02"),
			TotalGB: "12.34",
			ServerLines: []string{
				"• 示例服务器 A: 8.2GB/100GB (8%)",
				"• 示例服务器 B: 4.1GB",
			},
			UserLines: []string{"• alice: 7.20GB", "• bob: 5.14GB"},
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"preview":      renderDailyTrafficTemplate(req.Template, data),
		"sample":       !ok,
		"placeholders": dailyTrafficPlaceholders,
	})
}

func (h *NotifyConfigHandler) handleTest(w http.ResponseWriter, r *http.Request) {
	n := GetNotifier()
	if n == nil {
		writeError(w, http.StatusInternalServerError, nil)
		return
	}

	if err := n.SendTest(r.Context()); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}
