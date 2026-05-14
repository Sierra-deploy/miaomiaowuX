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
