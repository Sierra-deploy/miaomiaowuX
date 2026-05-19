package handler

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"

	"golang.org/x/crypto/bcrypt"

	"miaomiaowux/internal/license"
	"miaomiaowux/internal/storage"
)

type userEntry struct {
	Username            string   `json:"username"`
	Email               string   `json:"email"`
	Nickname            string   `json:"nickname"`
	Avatar              string   `json:"avatar_url"`
	Role                string   `json:"role"`
	IsActive            bool     `json:"is_active"`
	Remark              string   `json:"remark"`
	PackageID           *int64   `json:"package_id"`
	PackageName         string   `json:"package_name,omitempty"`
	TrafficLimitGB      float64  `json:"traffic_limit_gb,omitempty"`
	TrafficUsed         int64    `json:"traffic_used,omitempty"`
	TrafficLimit        int64    `json:"traffic_limit,omitempty"`
	IsOverLimit         bool     `json:"is_over_limit"`
	IsReset             bool     `json:"is_reset"`
	ResetDay            int      `json:"reset_day"`
	PackageEndDate      *string  `json:"package_end_date,omitempty"`
	SpeedLimitMbps      float64  `json:"speed_limit_mbps"`
	DeviceLimit         int      `json:"device_limit"`
	SpeedLimitOverride  *float64 `json:"speed_limit_override"`
	DeviceLimitOverride *int     `json:"device_limit_override"`
}

type userStatusRequest struct {
	Username string `json:"username"`
	IsActive bool   `json:"is_active"`
}

type userResetRequest struct {
	Username    string `json:"username"`
	NewPassword string `json:"new_password"`
}

type userResetResponse struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type userCreateRequest struct {
	Username string `json:"username"`
	Email    string `json:"email"`
	Nickname string `json:"nickname"`
	Password string `json:"password"`
	Remark   string `json:"remark"`
}

type userCreateResponse struct {
	Username string `json:"username"`
	Email    string `json:"email"`
	Nickname string `json:"nickname"`
	Role     string `json:"role"`
	Password string `json:"password"`
}

func NewUserListHandler(repo *storage.TrafficRepository) http.Handler {
	if repo == nil {
		panic("user list handler requires repository")
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		users, err := repo.ListUsers(r.Context(), 1000)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}

		pkgMap := make(map[int64]storage.Package)
		packages, _ := repo.ListPackages(r.Context())
		for _, p := range packages {
			pkgMap[p.ID] = p
		}

		allTraffic, _ := repo.GetAllUserTraffic(r.Context())
		trafficMap := make(map[string]int64)
		for _, t := range allTraffic {
			trafficMap[t.Username] += t.Uplink + t.Downlink
		}

		entries := make([]userEntry, 0, len(users))
		for _, user := range users {
			entry := userEntry{
				Username: user.Username,
				Email:    user.Email,
				Nickname: user.Nickname,
				Avatar:   user.AvatarURL,
				Role:     user.Role,
				IsActive: user.IsActive,
				Remark:   user.Remark,
			}
			entry.SpeedLimitOverride = user.SpeedLimitOverride
			entry.DeviceLimitOverride = user.DeviceLimitOverride
			if user.PackageID > 0 {
				pid := user.PackageID
				entry.PackageID = &pid
				if pkg, ok := pkgMap[pid]; ok {
					entry.PackageName = pkg.Name
					entry.TrafficLimitGB = pkg.TrafficLimitGB
					entry.TrafficLimit = pkg.TrafficLimitBytes
					entry.SpeedLimitMbps = pkg.SpeedLimitMbps
					entry.DeviceLimit = pkg.DeviceLimit
				}
				used := trafficMap[user.Username]
				if pkg, ok := pkgMap[pid]; ok {
					used *= pkg.TrafficMultiplier()
				}
				entry.TrafficUsed = used
				if entry.TrafficLimit > 0 && entry.TrafficUsed >= entry.TrafficLimit {
					entry.IsOverLimit = true
				}
				entry.IsReset = user.IsReset
				entry.ResetDay = user.ResetDay
				if user.PackageEndDate != nil {
					s := user.PackageEndDate.Format("2006-01-02")
					entry.PackageEndDate = &s
				}
			}
			entries = append(entries, entry)
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"users": entries})
	})
}

func NewUserStatusHandler(repo *storage.TrafficRepository) http.Handler {
	if repo == nil {
		panic("user status handler requires repository")
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, errors.New("only POST is supported"))
			return
		}

		var payload userStatusRequest
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}

		username := strings.TrimSpace(payload.Username)
		if username == "" {
			writeError(w, http.StatusBadRequest, errors.New("username is required"))
			return
		}

		// 检查目标用户是否是admin
		targetUser, err := repo.GetUser(r.Context(), username)
		if err != nil {
			if errors.Is(err, storage.ErrUserNotFound) {
				writeError(w, http.StatusNotFound, errors.New("user not found"))
				return
			}
			writeError(w, http.StatusInternalServerError, err)
			return
		}

		if targetUser.Role == storage.RoleAdmin {
			writeError(w, http.StatusBadRequest, errors.New("不能修改管理员状态"))
			return
		}

		if err := repo.UpdateUserStatus(r.Context(), username, payload.IsActive); err != nil {
			if errors.Is(err, storage.ErrUserNotFound) {
				writeError(w, http.StatusNotFound, errors.New("user not found"))
				return
			}
			writeError(w, http.StatusInternalServerError, err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "updated"})
	})
}

func NewUserResetPasswordHandler(repo *storage.TrafficRepository) http.Handler {
	if repo == nil {
		panic("user reset handler requires repository")
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, errors.New("only POST is supported"))
			return
		}

		var payload userResetRequest
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}

		username := strings.TrimSpace(payload.Username)
		if username == "" {
			writeError(w, http.StatusBadRequest, errors.New("username is required"))
			return
		}

		// 检查目标用户是否是admin
		targetUser, err := repo.GetUser(r.Context(), username)
		if err != nil {
			if errors.Is(err, storage.ErrUserNotFound) {
				writeError(w, http.StatusNotFound, errors.New("user not found"))
				return
			}
			writeError(w, http.StatusInternalServerError, err)
			return
		}

		if targetUser.Role == storage.RoleAdmin {
			writeError(w, http.StatusBadRequest, errors.New("不能重置管理员密码"))
			return
		}

		newPassword := strings.TrimSpace(payload.NewPassword)
		if newPassword == "" {
			generated, err := generateRandomPassword(12)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err)
				return
			}
			newPassword = generated
		}

		hash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}

		if err := repo.UpdateUserPassword(r.Context(), username, string(hash)); err != nil {
			if errors.Is(err, storage.ErrUserNotFound) {
				writeError(w, http.StatusNotFound, errors.New("user not found"))
				return
			}
			writeError(w, http.StatusInternalServerError, err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(userResetResponse{Username: username, Password: newPassword})
	})
}

type userCreateHandler struct {
	repo           *storage.TrafficRepository
	licenseManager *license.Manager
}

func NewUserCreateHandler(repo *storage.TrafficRepository) *userCreateHandler {
	if repo == nil {
		panic("user create handler requires repository")
	}
	return &userCreateHandler{repo: repo}
}

func (h *userCreateHandler) SetLicenseManager(mgr *license.Manager) {
	h.licenseManager = mgr
}

func (h *userCreateHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, errors.New("only POST is supported"))
		return
	}

	if h.licenseManager != nil {
		status := h.licenseManager.GetStatus()
		maxUsers := 10
		if status.Plan != nil {
			maxUsers = status.Plan.MaxUsers
		}
		count, err := h.repo.CountUsers(r.Context())
		if err == nil && count >= int64(maxUsers) {
			writeJSONError(w, http.StatusForbidden, fmt.Sprintf("已达到用户数量上限 (%d/%d)，请升级许可证", count, maxUsers))
			return
		}
	}

	var payload userCreateRequest
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	username := strings.TrimSpace(payload.Username)
	email := strings.TrimSpace(payload.Email)
	nickname := strings.TrimSpace(payload.Nickname)
	password := strings.TrimSpace(payload.Password)
	remark := strings.TrimSpace(payload.Remark)

	if username == "" {
		writeError(w, http.StatusBadRequest, errors.New("username is required"))
		return
	}

	if password == "" {
		random, err := generateRandomPassword(12)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		password = random
	}
	if nickname == "" {
		nickname = username
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	role := storage.RoleUser

	if err := h.repo.CreateUser(r.Context(), username, email, nickname, string(hash), role, remark); err != nil {
		if errors.Is(err, storage.ErrUserExists) {
			writeError(w, http.StatusConflict, errors.New("用户已存在"))
			return
		}
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(userCreateResponse{
		Username: username,
		Email:    email,
		Nickname: nickname,
		Role:     role,
		Password: password,
	})
}

type userDeleteRequest struct {
	Username string `json:"username"`
}

func NewUserDeleteHandler(repo *storage.TrafficRepository, remoteManage *RemoteManageHandler, pusher *LimiterConfigPusher) http.Handler {
	if repo == nil {
		panic("user delete handler requires repository")
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, errors.New("only POST is supported"))
			return
		}

		var payload userDeleteRequest
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}

		username := strings.TrimSpace(payload.Username)
		if username == "" {
			writeError(w, http.StatusBadRequest, errors.New("username is required"))
			return
		}

		ctx := r.Context()

		// 检查目标用户是否是admin
		targetUser, err := repo.GetUser(ctx, username)
		if err != nil {
			if errors.Is(err, storage.ErrUserNotFound) {
				writeError(w, http.StatusNotFound, errors.New("user not found"))
				return
			}
			writeError(w, http.StatusInternalServerError, err)
			return
		}

		if targetUser.Role == storage.RoleAdmin {
			writeError(w, http.StatusBadRequest, errors.New("不能删除管理员账号"))
			return
		}

		// 删除前从所有 xray inbound 里清掉该用户的 client，
		// 否则节点上还残留着该用户的 uuid/password，套餐节点上会出现"幽灵用户"。
		// 这里复用 packages.go 里的 removeUserFromInbound 路径，跟 PackageUnassign 行为一致。
		if remoteManage != nil {
			configs, cfgErr := repo.GetUserInboundConfigs(ctx, username)
			if cfgErr != nil {
				log.Printf("[UserDelete] get inbound configs for %s failed: %v", username, cfgErr)
			}
			for _, cfg := range configs {
				if err := removeUserFromInbound(ctx, remoteManage, cfg); err != nil {
					log.Printf("[UserDelete] remove %s from inbound %s on server %d failed: %v",
						username, cfg.InboundTag, cfg.ServerID, err)
				}
			}
			if err := repo.DeleteUserInboundConfigs(ctx, username); err != nil {
				log.Printf("[UserDelete] delete inbound config records for %s failed: %v", username, err)
			}
		}

		if err := repo.DeleteUser(ctx, username); err != nil {
			if errors.Is(err, storage.ErrUserNotFound) {
				writeError(w, http.StatusNotFound, errors.New("user not found"))
				return
			}
			writeError(w, http.StatusInternalServerError, err)
			return
		}

		// 通知 agent limiter 移除该用户
		if pusher != nil {
			go pusher.PushToAllServersForUser(context.Background(), username)
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
	})
}

func generateRandomPassword(length int) (string, error) {
	const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	if length <= 0 {
		length = 12
	}
	bytes := make([]byte, length)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	for i, b := range bytes {
		bytes[i] = alphabet[int(b)%len(alphabet)]
	}
	return string(bytes), nil
}

type userRemarkRequest struct {
	Username string `json:"username"`
	Remark   string `json:"remark"`
}

func NewUserRemarkHandler(repo *storage.TrafficRepository) http.Handler {
	if repo == nil {
		panic("user remark handler requires repository")
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, errors.New("only POST is supported"))
			return
		}

		var payload userRemarkRequest
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}

		username := strings.TrimSpace(payload.Username)
		if username == "" {
			writeError(w, http.StatusBadRequest, errors.New("username is required"))
			return
		}

		if err := repo.UpdateUserRemark(r.Context(), username, payload.Remark); err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "updated"})
	})
}

// 创建用于更新用户电子邮件的处理程序
func NewUserUpdateEmailHandler(repo *storage.TrafficRepository) http.Handler {
	if repo == nil {
		panic("user update email handler requires repository")
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, errors.New("only POST is supported"))
			return
		}

		var req struct {
			Username string `json:"username"`
			Email    string `json:"email"`
		}

		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}

		if req.Username == "" {
			writeError(w, http.StatusBadRequest, errors.New("username is required"))
			return
		}

		ctx := r.Context()
		if err := repo.UpdateUserEmail(ctx, req.Username, req.Email); err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success": true,
			"message": "Email updated successfully",
		})
	})
}

func NewUserLimitsHandler(repo *storage.TrafficRepository, pusher *LimiterConfigPusher) http.Handler {
	type req struct {
		Username            string   `json:"username"`
		SpeedLimitOverride  *float64 `json:"speed_limit_override"`
		DeviceLimitOverride *int     `json:"device_limit_override"`
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

		if strings.TrimSpace(body.Username) == "" {
			writeError(w, http.StatusBadRequest, errors.New("username is required"))
			return
		}

		if err := repo.UpdateUserLimitOverrides(r.Context(), body.Username, body.SpeedLimitOverride, body.DeviceLimitOverride); err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}

		if pusher != nil {
			go pusher.PushToAllServersForUser(r.Context(), body.Username)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"success": true,
			"message": "User limits updated",
		})
	})
}
