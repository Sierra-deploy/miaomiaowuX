package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"miaomiaowux/internal/auth"
	"miaomiaowux/internal/storage"
)

// userHasTemplatePermission 判断用户是否有「模板管理权限」:管理员,或全局权限白名单含 "templates" 页。
// 权限是全局策略(非 per-user),与侧边栏/菜单同一口径。供本端点与 package_subscribe.loadTemplate 复用。
func userHasTemplatePermission(ctx context.Context, repo *storage.TrafficRepository, username string) bool {
	if userIsAdmin(ctx, repo, username) {
		return true
	}
	for _, p := range loadUserPermConfig(ctx, repo).Pages {
		if p == "templates" {
			return true
		}
	}
	return false
}

// userDefaultTemplateHandler 维护「用户个人默认模板」(user_settings.default_template_filename)。
// 独立端点,不走 /api/user/config —— 那条是整对象覆盖,partial PUT 会重置其它偏好。
type userDefaultTemplateHandler struct {
	repo *storage.TrafficRepository
}

// NewUserDefaultTemplateHandler GET/PUT /api/user/default-template
func NewUserDefaultTemplateHandler(repo *storage.TrafficRepository) http.Handler {
	if repo == nil {
		panic("user default template handler requires repository")
	}
	return &userDefaultTemplateHandler{repo: repo}
}

type userDefaultTemplateBody struct {
	DefaultTemplateFilename string `json:"default_template_filename"`
}

func (h *userDefaultTemplateHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	username := strings.TrimSpace(auth.UsernameFromContext(r.Context()))
	if username == "" {
		writeError(w, http.StatusUnauthorized, errors.New("unauthorized"))
		return
	}
	switch r.Method {
	case http.MethodGet:
		h.handleGet(w, r, username)
	case http.MethodPut:
		h.handlePut(w, r, username)
	default:
		writeError(w, http.StatusMethodNotAllowed, errors.New("only GET and PUT are supported"))
	}
}

func (h *userDefaultTemplateHandler) handleGet(w http.ResponseWriter, r *http.Request, username string) {
	filename := ""
	if s, err := h.repo.GetUserSettings(r.Context(), username); err == nil {
		filename = s.DefaultTemplateFilename
	}
	respondJSON(w, http.StatusOK, map[string]string{"default_template_filename": filename})
}

func (h *userDefaultTemplateHandler) handlePut(w http.ResponseWriter, r *http.Request, username string) {
	var body userDefaultTemplateBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	filename := strings.TrimSpace(body.DefaultTemplateFilename)
	if filename != "" {
		// 权限:必须有模板管理权限
		if !userHasTemplatePermission(r.Context(), h.repo, username) {
			writeError(w, http.StatusForbidden, errors.New("no template management permission"))
			return
		}
		// 文件名净化:禁止路径穿越,必须是 rule_templates/ 下的 .yaml 文件
		base := filepath.Base(filename)
		if base != filename || !strings.HasSuffix(base, ".yaml") {
			writeBadRequest(w, "invalid template filename")
			return
		}
		if _, err := os.Stat(filepath.Join("rule_templates", base)); err != nil {
			writeBadRequest(w, "template not found")
			return
		}
		// 归属:只能设自己拥有的模板为个人默认
		if owner, _ := h.repo.GetRuleTemplateOwner(r.Context(), base); owner != username {
			writeError(w, http.StatusForbidden, errors.New("not your template"))
			return
		}
		filename = base
	}

	// 读改写:仅改 DefaultTemplateFilename,保留其它偏好。无记录时用与 handleGetUserConfig 一致的默认值。
	settings, err := h.repo.GetUserSettings(r.Context(), username)
	if err != nil {
		if !errors.Is(err, storage.ErrUserSettingsNotFound) {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		settings = storage.UserSettings{
			Username:             username,
			MatchRule:            "node_name",
			SyncScope:            "saved_only",
			KeepNodeName:         true,
			NodeNameFilter:       "剩余|流量|到期|订阅|时间|重置",
			CustomRulesEnabled:   true,
			UseNewTemplateSystem: true,
		}
	}
	settings.DefaultTemplateFilename = filename
	if err := h.repo.UpsertUserSettings(r.Context(), settings); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	respondJSON(w, http.StatusOK, map[string]string{"default_template_filename": filename})
}
