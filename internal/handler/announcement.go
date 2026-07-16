package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"miaomiaowux/internal/storage"
)

// 公告系统:
//   - 模板配置(KV announcement_config):每类型 enabled/标题/文案模板/是否发 bot/是否显示 miniapp。
//   - 公告实例(announcements 表):手动发布或节点被墙自动触发,miniapp 横幅 + bot 广播读它。
//   - 探测源(KV announce_probe_server_ids):被墙探测从哪些远程服务器视角探(见 Step2)。

const (
	AnnouncementConfigKey     = "announcement_config"
	AnnounceProbeServerIDsKey = "announce_probe_server_ids"
)

// 公告类型
const (
	AnnounceTypeNodeBlocked   = "node_blocked"
	AnnounceTypeNodeRecovered = "node_recovered"
	AnnounceTypeMaintenance   = "maintenance"
	AnnounceTypeSubUpdate     = "sub_update"
	AnnounceTypeGeneral       = "general"
)

type announceTypeConfig struct {
	Enabled    bool   `json:"enabled"`
	Title      string `json:"title"`
	Template   string `json:"template"`
	ViaBot     bool   `json:"via_bot"`
	ViaMiniapp bool   `json:"via_miniapp"`
}

type announceConfig struct {
	Types map[string]announceTypeConfig `json:"types"`
}

// defaultAnnounceConfig 默认模板文案(未配置时生效)。{node}/{time} 运行时替换。
func defaultAnnounceConfig() announceConfig {
	return announceConfig{Types: map[string]announceTypeConfig{
		AnnounceTypeNodeBlocked:   {Enabled: true, Title: "节点异常", Template: "⚠️ 节点【{node}】疑似被墙,暂时无法连接,请先切换其他节点,我们正在处理。", ViaBot: true, ViaMiniapp: true},
		AnnounceTypeNodeRecovered: {Enabled: true, Title: "节点恢复", Template: "✅ 节点【{node}】已恢复,可正常使用。", ViaBot: true, ViaMiniapp: true},
		AnnounceTypeMaintenance:   {Enabled: true, Title: "系统维护", Template: "🛠 系统将于 {time} 维护,期间可能短暂不可用,敬请谅解。", ViaBot: true, ViaMiniapp: true},
		AnnounceTypeSubUpdate:     {Enabled: true, Title: "订阅更新", Template: "🔄 节点有更新,请重新拉取订阅以获取最新节点。", ViaBot: true, ViaMiniapp: true},
		AnnounceTypeGeneral:       {Enabled: true, Title: "公告", Template: "", ViaBot: true, ViaMiniapp: true},
	}}
}

// mergedAnnounceConfig 读 KV 配置,缺失的类型用默认补齐。
func (h *AnnouncementHandler) mergedAnnounceConfig(ctx context.Context) announceConfig {
	cfg := defaultAnnounceConfig()
	raw, _ := h.repo.GetSystemSetting(ctx, AnnouncementConfigKey)
	if strings.TrimSpace(raw) != "" {
		var stored announceConfig
		if json.Unmarshal([]byte(raw), &stored) == nil {
			for k, v := range stored.Types {
				cfg.Types[k] = v
			}
		}
	}
	return cfg
}

type AnnouncementHandler struct {
	repo *storage.TrafficRepository
}

func NewAnnouncementHandler(repo *storage.TrafficRepository) *AnnouncementHandler {
	return &AnnouncementHandler{repo: repo}
}

// ===== 模板配置(admin) GET/PUT /api/admin/system-settings/announcements =====

func (h *AnnouncementHandler) GetConfig(w http.ResponseWriter, r *http.Request) {
	cfg := h.mergedAnnounceConfig(r.Context())
	probeIDs := h.probeServerIDs(r.Context())
	respondJSON(w, http.StatusOK, map[string]any{"success": true, "config": cfg, "probe_server_ids": probeIDs})
}

func (h *AnnouncementHandler) SetConfig(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Config         announceConfig `json:"config"`
		ProbeServerIDs *[]int64       `json:"probe_server_ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, errors.New("请求格式错误"))
		return
	}
	b, _ := json.Marshal(req.Config)
	if err := h.repo.SetSystemSetting(r.Context(), AnnouncementConfigKey, string(b)); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if req.ProbeServerIDs != nil {
		ids, _ := json.Marshal(*req.ProbeServerIDs)
		_ = h.repo.SetSystemSetting(r.Context(), AnnounceProbeServerIDsKey, string(ids))
	}
	respondJSON(w, http.StatusOK, map[string]any{"success": true, "message": "公告配置已更新"})
}

func (h *AnnouncementHandler) probeServerIDs(ctx context.Context) []int64 {
	raw, _ := h.repo.GetSystemSetting(ctx, AnnounceProbeServerIDsKey)
	out := []int64{}
	if strings.TrimSpace(raw) != "" {
		_ = json.Unmarshal([]byte(raw), &out)
	}
	return out
}

// ===== 公告实例(admin) /api/admin/announcements =====

func (h *AnnouncementHandler) ServeAdmin(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.listInstances(w, r)
	case http.MethodPost:
		h.createInstance(w, r)
	case http.MethodDelete:
		h.deleteInstance(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, errors.New("方法不允许"))
	}
}

func (h *AnnouncementHandler) listInstances(w http.ResponseWriter, r *http.Request) {
	items, err := h.repo.ListActiveAnnouncements(r.Context(), false)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{"success": true, "announcements": items})
}

func (h *AnnouncementHandler) createInstance(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Type           string `json:"type"`
		Title          string `json:"title"`
		Body           string `json:"body"`
		ExpiresMinutes int    `json:"expires_minutes"` // 0 = 永不过期
		ViaBot         bool   `json:"via_bot"`
		ViaMiniapp     bool   `json:"via_miniapp"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, errors.New("请求格式错误"))
		return
	}
	if strings.TrimSpace(req.Body) == "" {
		writeError(w, http.StatusBadRequest, errors.New("公告正文不能为空"))
		return
	}
	if req.Type == "" {
		req.Type = AnnounceTypeGeneral
	}
	var expiresAt *time.Time
	if req.ExpiresMinutes > 0 {
		t := time.Now().Add(time.Duration(req.ExpiresMinutes) * time.Minute)
		expiresAt = &t
	}
	id, err := h.PublishAnnouncement(r.Context(), storage.Announcement{
		Type: req.Type, Title: strings.TrimSpace(req.Title), Body: strings.TrimSpace(req.Body),
		ViaBot: req.ViaBot, ViaMiniapp: req.ViaMiniapp, ExpiresAt: expiresAt,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{"success": true, "id": id})
}

func (h *AnnouncementHandler) deleteInstance(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(r.URL.Query().Get("id"), 10, 64)
	if id <= 0 {
		writeError(w, http.StatusBadRequest, errors.New("无效的公告 id"))
		return
	}
	if err := h.repo.DeleteAnnouncement(r.Context(), id); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{"success": true})
}

// PublishAnnouncement 插入一条公告实例(手动 / 自动触发 / tgbot 命令共用)。
func (h *AnnouncementHandler) PublishAnnouncement(ctx context.Context, a storage.Announcement) (int64, error) {
	return h.repo.CreateAnnouncement(ctx, a)
}

// ===== 生效公告(authenticated) GET /api/announcements/active =====
// 供 Web 前端横幅;miniapp 走 tgbot 转发的只读版。

func (h *AnnouncementHandler) GetActive(w http.ResponseWriter, r *http.Request) {
	items, err := h.repo.ListActiveAnnouncements(r.Context(), true)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{"success": true, "announcements": items})
}

// filterAnnouncementsForUser 按用户过滤公告(miniapp 横幅用):
//   - 无生效套餐的用户 → 一条都不显示(公告只面向有套餐用户);
//   - 节点相关公告(node_id!=0)→ 仅当用户套餐内含该节点才显示。
func filterAnnouncementsForUser(ctx context.Context, repo *storage.TrafficRepository, username string, items []storage.Announcement) []storage.Announcement {
	empty := []storage.Announcement{}
	if strings.TrimSpace(username) == "" {
		return empty
	}
	user, err := repo.GetUser(ctx, username)
	if err != nil || user.PackageID <= 0 {
		return empty
	}
	if user.PackageEndDate != nil && !user.PackageEndDate.After(time.Now()) {
		return empty // 套餐已过期
	}
	nodeSet := map[int64]bool{}
	if pkg, perr := repo.GetPackage(ctx, user.PackageID); perr == nil && pkg != nil {
		for _, nid := range pkg.Nodes {
			nodeSet[nid] = true
		}
	}
	out := make([]storage.Announcement, 0, len(items))
	for _, a := range items {
		if a.NodeID != 0 && !nodeSet[a.NodeID] {
			continue
		}
		out = append(out, a)
	}
	return out
}

// GetBlockedNodes GET /api/admin/announcements/blocked-nodes:被墙节点 id 列表(供节点列表徽章)。
func (h *AnnouncementHandler) GetBlockedNodes(w http.ResponseWriter, r *http.Request) {
	set, err := h.repo.ListBlockedNodeIDs(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	ids := make([]int64, 0, len(set))
	for id := range set {
		ids = append(ids, id)
	}
	respondJSON(w, http.StatusOK, map[string]any{"success": true, "node_ids": ids})
}
