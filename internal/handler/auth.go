package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"miaomiaowux/internal/auth"
	"miaomiaowux/internal/captcha"
	"miaomiaowux/internal/logger"
	"miaomiaowux/internal/storage"
)

type loginRequest struct {
	Username       string `json:"username"`
	Password       string `json:"password"`
	RememberMe     bool   `json:"remember_me"`
	TurnstileToken string `json:"turnstile_token"`
}

type loginResponse struct {
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expires_at"`
	Username  string    `json:"username"`
	Email     string    `json:"email"`
	Nickname  string    `json:"nickname"`
	Avatar    string    `json:"avatar_url"`
	Role      string    `json:"role"`
	IsAdmin   bool      `json:"is_admin"`
}

type credentialsRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// GetClientIP extracts the client IP address from the request.
// 优先级:CF-Connecting-IP > X-Forwarded-For[0] > X-Real-IP > RemoteAddr。
// Cloudflare 头单独优先 — 套 CF 的反代往往同时设置 XFF,但 CF 头是 Cloudflare 注入的、最可信。
func GetClientIP(r *http.Request) string {
	// Cloudflare 专属头
	if cf := strings.TrimSpace(r.Header.Get("CF-Connecting-IP")); cf != "" {
		return cf
	}

	// 首先检查 X-Forwarded-For 标头（对于代理请求）
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		ips := strings.Split(xff, ",")
		if len(ips) > 0 {
			return strings.TrimSpace(ips[0])
		}
	}

	// 检查 X-Real-IP 标头
	if xri := r.Header.Get("X-Real-IP"); xri != "" {
		return strings.TrimSpace(xri)
	}

	// 回退到 RemoteAddr
	ip := r.RemoteAddr
	if idx := strings.LastIndex(ip, ":"); idx != -1 {
		ip = ip[:idx]
	}
	return ip
}

func NewLoginHandler(manager *auth.Manager, tokens *auth.TokenStore, repo *storage.TrafficRepository, rateLimiter *LoginRateLimiter, twoFactorStore *auth.TwoFactorPendingStore, turnstile *captcha.Turnstile) http.Handler {
	if manager == nil || tokens == nil {
		panic("login handler requires manager and token store")
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, errors.New("only POST is supported"))
			return
		}

		var payload loginRequest
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}

		if strings.TrimSpace(payload.Username) == "" || payload.Password == "" {
			writeError(w, http.StatusBadRequest, errors.New("username and password are required"))
			return
		}

		username := strings.TrimSpace(payload.Username)
		clientIP := GetClientIP(r)

		if rateLimiter != nil {
			if err := rateLimiter.Check(clientIP, username); err != nil {
				writeError(w, http.StatusTooManyRequests, errors.New("too many login attempts, please try again later"))
				return
			}
		}

		// Turnstile 人机验证:Enabled 内部已查 DB 看两 key 是否都填,未填则放行。
		// 失败按 plan 用 400 — 跟 mmwx-license 一致(不混淆 401 invalid credentials 的语义)。
		if turnstile != nil && !turnstile.Verify(r.Context(), payload.TurnstileToken, clientIP) {
			writeError(w, http.StatusBadRequest, errors.New("captcha verification failed"))
			return
		}

		ok, err := manager.Authenticate(r.Context(), username, payload.Password)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}

		if !ok {
			locked := false
			if rateLimiter != nil {
				rateLimiter.RecordFailure(clientIP, username)
				// Check 在已达锁定阈值时返回 ErrRateLimited —— 用它区分 login_fail / login_locked
				locked = errors.Is(rateLimiter.Check(clientIP, username), ErrRateLimited)
			}
			// 不手动传 "time" —— slog 已自动加 time=,重复会污染日志解析。
			logger.Warn("🔐 [LOGIN_FAIL] 登录失败",
				"username", username,
				"client_ip", clientIP)
			// 登录暴破进安全事件流（与 brute_force 的封禁体系独立：只记事件、不进 ip_bans，
			// 因为限流锁定 ≠ 封禁，生命周期不同）。best-effort，失败静默。
			if repo != nil {
				kind := "login_fail"
				if locked {
					kind = "login_locked"
				}
				_ = repo.InsertSecurityEvent(r.Context(), storage.SecurityEvent{
					IP: clientIP, Kind: kind, Username: username, Path: r.URL.Path,
				})
			}
			writeError(w, http.StatusUnauthorized, errors.New("invalid credentials"))
			return
		}

		if rateLimiter != nil {
			rateLimiter.RecordSuccess(clientIP, username)
		}

		user, err := manager.User(r.Context(), username)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}

		if user.TOTPEnabled && twoFactorStore != nil {
			tfToken, err := twoFactorStore.Issue(username, payload.RememberMe)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"requires_2fa":     true,
				"two_factor_token": tfToken,
			})
			return
		}

		if repo != nil {
			if _, err := repo.GetOrCreateUserToken(r.Context(), username); err != nil {
				writeError(w, http.StatusInternalServerError, err)
				return
			}
		}

		issueLoginSession(w, r, tokens, repo, user, payload.RememberMe)
	})
}

func NewCredentialsHandler(manager *auth.Manager, tokens *auth.TokenStore) http.Handler {
	if manager == nil || tokens == nil {
		panic("credentials handler requires manager and token store")
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			writeError(w, http.StatusMethodNotAllowed, errors.New("only PUT is supported"))
			return
		}

		var payload credentialsRequest
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}

		trimmedUsername := strings.TrimSpace(payload.Username)

		if trimmedUsername == "" && payload.Password == "" {
			writeError(w, http.StatusBadRequest, errors.New("username or password must be provided"))
			return
		}

		if err := manager.Update(r.Context(), trimmedUsername, payload.Password); err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}

		tokens.RevokeAll()

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "updated"})
	})
}
