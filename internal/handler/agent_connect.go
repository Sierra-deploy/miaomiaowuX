package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"miaomiaowux/internal/child"
	"miaomiaowux/internal/storage"
	"miaomiaowux/internal/version"
)

// ChildAPIHandler 处理来自主服务器的 API 请求（对于pull模式）
type ChildAPIHandler struct {
	client      *child.Client
	configToken string // 用于身份验证的令牌
}

// 创建一个新的子 API 处理程序
func NewChildAPIHandler(client *child.Client, configToken string) *ChildAPIHandler {
	return &ChildAPIHandler{
		client:      client,
		configToken: configToken,
	}
}

// 处理流量数据的 HTTP 请求
func (h *ChildAPIHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// 只允许 GET 方法
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// 验证请求
	if !h.authenticate(r) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success": false,
			"error":   "Unauthorized",
		})
		return
	}

	// 获取流量统计
	stats, err := h.client.GetStats()
	if err != nil {
		log.Printf("[Child API] Failed to get stats: %v", err)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success": false,
			"error":   "Failed to collect stats",
		})
		return
	}

	// 返回统计数据
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"stats":   stats,
	})
}

// 处理速度数据的 HTTP 请求
func (h *ChildAPIHandler) ServeSpeedHTTP(w http.ResponseWriter, r *http.Request) {
	// 只允许 GET 方法
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// 验证请求
	if !h.authenticate(r) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success": false,
			"error":   "Unauthorized",
		})
		return
	}

	// 获取速度数据
	uploadSpeed, downloadSpeed := h.client.GetSpeed()

	// 返回速度数据
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":        true,
		"upload_speed":   uploadSpeed,
		"download_speed": downloadSpeed,
	})
}

// 验证检查请求是否被授权
func (h *ChildAPIHandler) authenticate(r *http.Request) bool {
	if h.configToken == "" {
		// 如果未配置令牌，则允许所有请求（不建议用于生产）
		return true
	}

	// 检查授权标头
	auth := r.Header.Get("Authorization")
	if auth == "" {
		return false
	}

	// 支持“Bearer <token>”格式
	if strings.HasPrefix(auth, "Bearer ") {
		token := strings.TrimPrefix(auth, "Bearer ")
		return token == h.configToken
	}

	// 还支持普通令牌
	return auth == h.configToken
}

// RemoteHeartbeatRequest代表来自远程服务器的心跳请求
type RemoteHeartbeatRequest struct {
	BootTime     int64 `json:"boot_time"`      // MMWX进程启动时间（Unix时间戳）
	XrayBootTime int64 `json:"xray_boot_time"` // Xray 进程开始时间（Unix 时间戳）
	XrayPID      int   `json:"xray_pid"`       // 当前 X 射线进程 ID
	ListenPort   int   `json:"listen_port"`    // 代理HTTP监听端口
	LocalTime    int64 `json:"local_time"`     // agent 本地 Unix 时间戳，用于时钟偏差检测
}

// RemoteHeartbeatResponse 表示心跳响应
type RemoteHeartbeatResponse struct {
	Success          bool   `json:"success"`
	Message          string `json:"message"`
	MmwxRestarted    bool   `json:"mmwx_restarted,omitempty"`     // 检测到 MMWX 重启
	XrayRestarted    bool   `json:"xray_restarted,omitempty"`     // 检测到 X 射线重新启动
	TokenExpiresSoon bool   `json:"token_expires_soon,omitempty"` // 令牌将在 24 小时内过期
	TokenExpiresAt   int64  `json:"token_expires_at,omitempty"`   // 令牌过期时间戳
	ServerTime       int64  `json:"server_time"`                  // 当前服务器时间
}

// RemoteHeartbeat 处理来自远程服务器的心跳请求
// 该端点不需要管理员身份验证，只需要远程令牌验证
func (h *XrayServerHandler) RemoteHeartbeat(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if r.Header.Get("User-Agent") != version.AgentUserAgent {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(RemoteHeartbeatResponse{
			Success:    false,
			Message:    "Forbidden",
			ServerTime: time.Now().Unix(),
		})
		return
	}

	// 加密中间件处理
	crypto, cryptoErr := handleHTTPCrypto(r, w, h.crypto)
	if crypto == nil {
		return
	}
	_ = cryptoErr

	token := crypto.Token
	if token == "" {
		token = r.Header.Get("MM-Remote-Token")
	}
	if token == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(RemoteHeartbeatResponse{
			Success:    false,
			Message:    "缺少认证Token",
			ServerTime: time.Now().Unix(),
		})
		return
	}

	// 解析请求体
	var req RemoteHeartbeatRequest
	json.Unmarshal(crypto.Body, &req)

	// 获取客户端IP
	clientIP := r.RemoteAddr
	if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
		// 从逗号分隔列表中获取第一个 IP
		clientIP = strings.Split(forwarded, ",")[0]
		clientIP = strings.TrimSpace(clientIP)
	} else if realIP := r.Header.Get("X-Real-IP"); realIP != "" {
		clientIP = realIP
	}
	// 删除端口（如果存在）
	if idx := strings.LastIndex(clientIP, ":"); idx != -1 {
		// 检查是否是带括号的 IPv6
		if !strings.Contains(clientIP, "[") {
			clientIP = clientIP[:idx]
		}
	}

	ctx := r.Context()

	// 构建心跳更新
	update := storage.HeartbeatUpdate{
		Token:      token,
		IPAddress:  clientIP,
		ListenPort: req.ListenPort,
	}

	// 从 Unix 时间戳转换启动时间
	if req.BootTime > 0 {
		bootTime := time.Unix(req.BootTime, 0)
		update.BootTime = &bootTime
	}
	if req.XrayBootTime > 0 {
		xrayBootTime := time.Unix(req.XrayBootTime, 0)
		update.XrayBootTime = &xrayBootTime
	}
	if req.LocalTime > 0 {
		offset := req.LocalTime - time.Now().Unix()
		update.TimeOffsetSeconds = &offset
	}

	// 通过重启检测更新心跳
	result, err := h.repo.UpdateRemoteServerHeartbeatWithRestart(ctx, update)
	if err != nil {
		if err == storage.ErrRemoteServerNotFound {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(RemoteHeartbeatResponse{
				Success:    false,
				Message:    "无效的Token",
				ServerTime: time.Now().Unix(),
			})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(RemoteHeartbeatResponse{
			Success:    false,
			Message:    fmt.Sprintf("更新心跳失败: %s", err.Error()),
			ServerTime: time.Now().Unix(),
		})
		return
	}

	// 记录重启事件
	if result.MmwxRestarted {
		log.Printf("[RemoteHeartbeat] Detected MMWX restart for token %s... (boot count: %d)", token[:8], result.BootCount)
	}
	if result.XrayRestarted {
		log.Printf("[RemoteHeartbeat] Detected Xray restart for token %s... (xray boot count: %d)", token[:8], result.XrayBootCount)
	}

	if result.PreviousStatus != "connected" {
		SendServerOnlineNotification(ctx, result.ServerName, clientIP)
	}

	// 首次连接或 Xray 重启时推送限速配置（非 WebSocket 模式的补偿）
	if result.ServerID > 0 && h.limiterPusher != nil {
		if result.PreviousStatus != "connected" || result.XrayRestarted {
			go h.limiterPusher.PushToServer(context.Background(), result.ServerID)
		}
	}

	// 重置成功心跳时的推送失败计数（连接正常）
	if result.ServerID > 0 {
		if err := h.repo.ResetRemoteServerPushFailCount(ctx, result.ServerID); err != nil {
			log.Printf("[RemoteHeartbeat] Failed to reset push fail count for server %d: %v", result.ServerID, err)
		}
	}

	resp := RemoteHeartbeatResponse{
		Success:          true,
		Message:          "心跳成功",
		MmwxRestarted:    result.MmwxRestarted,
		XrayRestarted:    result.XrayRestarted,
		TokenExpiresSoon: result.TokenExpiresSoon,
		ServerTime:       time.Now().Unix(),
	}

	if result.TokenExpiresAt != nil {
		resp.TokenExpiresAt = result.TokenExpiresAt.Unix()
	}

	respData, _ := json.Marshal(resp)
	writeHTTPCryptoResponse(w, crypto.Session, respData)
}

// RefreshRemoteTokenResponse 是令牌刷新端点的响应
type RefreshRemoteTokenResponse struct {
	Success   bool   `json:"success"`
	Message   string `json:"message"`
	NewToken  string `json:"new_token,omitempty"`
	ExpiresAt int64  `json:"expires_at,omitempty"` // Unix时间戳
}

// 处理远程服务器的令牌刷新
func (h *XrayServerHandler) RefreshRemoteToken(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if r.Header.Get("User-Agent") != version.AgentUserAgent {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(RefreshRemoteTokenResponse{
			Success: false,
			Message: "Forbidden",
		})
		return
	}

	// 从标头获取令牌
	token := r.Header.Get("MM-Remote-Token")
	if token == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(RefreshRemoteTokenResponse{
			Success: false,
			Message: "Missing MM-Remote-Token header",
		})
		return
	}

	// 尝试刷新令牌
	ctx := r.Context()
	newToken, expiresAt, err := h.repo.RefreshRemoteServerToken(ctx, token)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")

		// 检查具体错误
		if err.Error() == "token can only be refreshed within 24 hours of expiration" {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(RefreshRemoteTokenResponse{
				Success: false,
				Message: err.Error(),
			})
			return
		}

		if errors.Is(err, storage.ErrRemoteServerNotFound) {
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(RefreshRemoteTokenResponse{
				Success: false,
				Message: "Invalid token",
			})
			return
		}

		log.Printf("[Remote] Failed to refresh token: %v", err)
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(RefreshRemoteTokenResponse{
			Success: false,
			Message: "Failed to refresh token",
		})
		return
	}

	log.Printf("[Remote] Token refreshed successfully, new expiration: %s", expiresAt.Format(time.RFC3339))

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(RefreshRemoteTokenResponse{
		Success:   true,
		Message:   "Token refreshed successfully",
		NewToken:  newToken,
		ExpiresAt: expiresAt.Unix(),
	})
}

func (h *XrayServerHandler) getMasterPort() string {
	if port := os.Getenv("PORT"); port != "" {
		return port
	}
	return "12889"
}

func (h *XrayServerHandler) masterPublicKeyBase64() string {
	if h.crypto != nil && h.crypto.Identity != nil {
		return h.crypto.Identity.PublicKeyBase64()
	}
	return ""
}

// 返回远程服务器的安装脚本
func (h *XrayServerHandler) GetRemoteInstallScript(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// 从查询参数中获取令牌
	token := r.URL.Query().Get("token")
	stealSelf := r.URL.Query().Get("steal_self") == "1"
	xrayMode := r.URL.Query().Get("xray_mode")
	if xrayMode != "embedded" {
		xrayMode = "external"
	}
	// 自定义 Agent 监听端口(由主控创建服务器时透传过来),非法/缺省值用 agent 内置默认 23889
	listenPortParam := strings.TrimSpace(r.URL.Query().Get("listen_port"))
	if p, perr := strconv.Atoi(listenPortParam); perr != nil || p < 1024 || p > 65535 {
		listenPortParam = ""
	}
	frontService := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("front_service")))
	if frontService != "xray" && frontService != "nginx" {
		frontService = "xray"
	}
	// nginx 前置暂未支持，先固定为 xray
	if frontService == "nginx" {
		frontService = "xray"
	}

	// 计算 install 脚本里写入的 SERVER:
	// 优先用系统设置 master_url 里的 host(用户配置的对外可达域名),
	// 这是 agent 真正访问主控的地址。仅在 master_url 未配置时回退到 r.Host(可能是 nginx upstream 名,如 miaomiaowu_web,不可对外访问)。
	// 若 master_url 已显式配置,EXPLICIT_MASTER=1 在脚本里禁用"同机部署"自动覆盖
	// (避免在主控本机上安装 agent 时把 master_url 改写成 127.0.0.1)。
	scriptServer := strings.TrimSpace(r.Host)
	scriptProtocol := ""
	explicitMaster := "0"
	if mu, err := h.repo.GetSystemSetting(r.Context(), "master_url"); err == nil {
		mu = strings.TrimSpace(mu)
		if mu != "" {
			explicitMaster = "1"
			s := strings.TrimRight(mu, "/")
			if strings.HasPrefix(s, "https://") {
				scriptProtocol = "https"
				s = strings.TrimPrefix(s, "https://")
			} else if strings.HasPrefix(s, "http://") {
				scriptProtocol = "http"
				s = strings.TrimPrefix(s, "http://")
			}
			if i := strings.Index(s, "/"); i >= 0 {
				s = s[:i]
			}
			if s != "" {
				scriptServer = s
			}
		}
	}

	// 返回安装脚本内容
	script := `#!/bin/bash
# MMWX Remote Server Installation Script
# This script installs MMWX from GitHub and configures it as a remote server

set -e

TOKEN="` + token + `"
SERVER="` + scriptServer + `"
SCRIPT_PROTOCOL="` + scriptProtocol + `"
EXPLICIT_MASTER="` + explicitMaster + `"
AUTO_STEAL_SELF="` + map[bool]string{true: "1", false: "0"}[stealSelf] + `"
FRONT_SERVICE="` + frontService + `"
XRAY_MODE="` + xrayMode + `"
MASTER_PUBLIC_KEY="` + h.masterPublicKeyBase64() + `"
MASTER_PORT="` + h.getMasterPort() + `"
LISTEN_PORT="` + listenPortParam + `"

# 协议:优先用主控注入的 SCRIPT_PROTOCOL(来自系统设置 master_url 的 scheme),
# 否则按 SERVER 是否带端口启发判断(开发场景常见 http)。
if [ -n "$SCRIPT_PROTOCOL" ]; then
    PROTOCOL="$SCRIPT_PROTOCOL"
elif [[ "$SERVER" == *":"* ]]; then
    PROTOCOL="http"
else
    PROTOCOL="https"
fi

# 允许通过环境变量强制覆盖协议
if [ -n "$MMWX_PROTOCOL" ]; then
    PROTOCOL="$MMWX_PROTOCOL"
fi

MASTER_URL="${PROTOCOL}://${SERVER}"

# 同机部署检测:只有在主控"没有显式配置 master_url"时才允许把 master_url 自动改成 127.0.0.1;
# 用户配置了对外域名(EXPLICIT_MASTER=1)就必须用用户的域名,不让自动改写。
if [ "$EXPLICIT_MASTER" != "1" ] && curl -sf "http://127.0.0.1:${MASTER_PORT}/api/setup/status" >/dev/null 2>&1; then
    MASTER_URL="http://127.0.0.1:${MASTER_PORT}"
    echo "Detected same-machine deployment, using ${MASTER_URL}"
fi

echo "=========================================="
echo "  MMWX Remote Server Installation"
echo "=========================================="
echo ""
echo "Master Server: $MASTER_URL"
echo ""

# Step 1: Stop existing service if running
echo "[1/6] Stopping existing service (if any)..."
systemctl stop mmw-agent 2>/dev/null || true
systemctl disable mmw-agent 2>/dev/null || true

# Step 2: Create config directory first
echo ""
echo "[2/6] Creating configuration..."
mkdir -p /etc/mmw-agent
mkdir -p /var/lib/mmw-agent

# 端口探测:从 LISTEN_PORT(或默认 23889)起,被占用就 +1,最多试 20 次。
# 用 ss 看任意接口的 LISTEN socket,避免 agent 启动后 bind 失败造成"WS 活/HTTP 死"的死锁状态。
REQUESTED_PORT="${LISTEN_PORT:-23889}"
ACTUAL_PORT=""
for i in $(seq 0 19); do
    TRY_PORT=$((REQUESTED_PORT + i))
    if ss -tln 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${TRY_PORT}\$"; then
        echo "  端口 ${TRY_PORT} 已被占用,尝试下一个..."
        continue
    fi
    ACTUAL_PORT="$TRY_PORT"
    break
done
if [ -z "$ACTUAL_PORT" ]; then
    echo "ERROR: 从 ${REQUESTED_PORT} 起的 20 个端口全部被占用,安装中止" >&2
    exit 1
fi
if [ "$ACTUAL_PORT" != "$REQUESTED_PORT" ]; then
    echo "⚠ 端口 ${REQUESTED_PORT} 被占用,自动改用 ${ACTUAL_PORT}"
fi
LISTEN_PORT="$ACTUAL_PORT"

cat > /etc/mmw-agent/config.yaml << EOF
# MMWX Remote Server Configuration
# Generated by install script

mode: remote
master_url: ${MASTER_URL}
token: ${TOKEN}
connection_mode: websocket
xray_mode: ${XRAY_MODE}
steal_mode: $([ "$AUTO_STEAL_SELF" = "1" ] && echo "tunnel" || echo "")
master_public_key: ${MASTER_PUBLIC_KEY}
listen_port: "${LISTEN_PORT}"
EOF

echo "Configuration saved to /etc/mmw-agent/config.yaml"

# Step 3: Create systemd service file (before install.sh runs)
echo ""
echo "[3/6] Creating systemd service..."

cat > /etc/systemd/system/mmw-agent.service << EOF
[Unit]
Description=MMW Agent Remote Server
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/mmw-agent -c /etc/mmw-agent/config.yaml
Restart=always
RestartSec=5
WorkingDirectory=/var/lib/mmw-agent

[Install]
WantedBy=multi-user.target
EOF

# Reload systemd to pick up new service file
systemctl daemon-reload

# Step 4: Download and install binary only (without starting)
echo ""
echo "[4/6] Downloading MMWX binary..."

# Detect architecture
ARCH=$(uname -m)
case $ARCH in
    x86_64)
        ARCH_NAME="amd64"
        ;;
    aarch64|arm64)
        ARCH_NAME="arm64"
        ;;
    *)
        echo "Unsupported architecture: $ARCH"
        exit 1
        ;;
esac

# Get latest release URL
RELEASE_URL="https://github.com/iluobei/mmw-agent/releases/latest/download/mmw-agent-linux-${ARCH_NAME}"

# Download binary — 优先用 curl(更普遍),没有就用 wget;两者都没就按发行版包管理器装一个,
# 杜绝 "wget: command not found" 噪声 / "ERROR: 都没装" 卡死。
ensure_downloader() {
    if command -v curl >/dev/null 2>&1; then return 0; fi
    if command -v wget >/dev/null 2>&1; then return 0; fi
    echo "未检测到 curl/wget,尝试自动安装 curl..."
    if command -v apt-get >/dev/null 2>&1; then
        apt-get update -qq >/dev/null 2>&1 || true
        DEBIAN_FRONTEND=noninteractive apt-get install -y curl
    elif command -v dnf >/dev/null 2>&1; then
        dnf install -y curl
    elif command -v yum >/dev/null 2>&1; then
        yum install -y curl
    elif command -v apk >/dev/null 2>&1; then
        apk add --no-cache curl
    elif command -v pacman >/dev/null 2>&1; then
        pacman -Sy --noconfirm curl
    elif command -v zypper >/dev/null 2>&1; then
        zypper -n install curl
    else
        echo "ERROR: 无法识别系统包管理器,请手动安装 curl 或 wget 后重试" >&2
        return 1
    fi
}
echo "Downloading from $RELEASE_URL..."
ensure_downloader || exit 1
if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o /tmp/mmw-agent "$RELEASE_URL"
else
    wget -q --show-progress -O /tmp/mmw-agent "$RELEASE_URL"
fi

# Install binary
chmod +x /tmp/mmw-agent
mv /tmp/mmw-agent /usr/local/bin/mmw-agent

echo "Binary installed to /usr/local/bin/mmw-agent"

# Step 5: Enable and start service
echo ""
echo "[5/6] Starting service..."
systemctl enable mmw-agent
systemctl start mmw-agent

# Wait a moment for service to start
sleep 3

# Step 6: Verify installation
echo ""
echo "[6/6] Verifying installation..."

echo ""
echo "=========================================="
echo "  Installation Complete!"
echo "=========================================="
echo ""
echo "Service status:"
systemctl status mmw-agent --no-pager -l 2>/dev/null | head -15 || echo "Service started"
echo ""
echo "To check status:"
echo "  systemctl status mmw-agent"
echo ""
echo "To view logs:"
echo "  journalctl -u mmw-agent -f"
echo ""

# Auto-install Xray (unless embedded mode)
if [ "$XRAY_MODE" != "embedded" ]; then
    XRAY_INSTALLED=0
    if command -v xray >/dev/null 2>&1 || [ -x /usr/local/bin/xray ] || [ -x /usr/bin/xray ] || [ -x /opt/xray/xray ]; then
        XRAY_INSTALLED=1
    fi

    if [ "$XRAY_INSTALLED" = "1" ]; then
        echo "[Auto] Xray already installed, skip."
    else
        echo "[Auto] Installing Xray..."
        bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install
    fi
fi

if [ "$AUTO_STEAL_SELF" = "1" ]; then
    echo "=========================================="
    echo "  Auto Install: Nginx"
    echo "=========================================="
    echo ""

    NGINX_INSTALLED=0
    if command -v nginx >/dev/null 2>&1 || [ -x /usr/local/nginx/sbin/nginx ]; then
        NGINX_INSTALLED=1
    fi

    if [ "$NGINX_INSTALLED" = "1" ]; then
        echo "[Auto] Nginx already installed, skip."
    else
        echo "[Auto] Installing Nginx..."
        curl -fsSL https://raw.githubusercontent.com/iluobei/miaomiaowuX/main/install-nginx.sh | bash
    fi
    echo ""
    echo "Auto install complete (front service: ${FRONT_SERVICE}, xray mode: ${XRAY_MODE})"
fi
echo ""
`

	w.Header().Set("Content-Type", "text/plain")
	w.Header().Set("Content-Disposition", "attachment; filename=install.sh")
	w.Write([]byte(script))
}
