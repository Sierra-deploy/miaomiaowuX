package handler

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	stdhttp "net/http"
	"net/url"
	"strings"
	"time"

	"miaomiaowux/internal/license"
	"miaomiaowux/internal/storage"
	"miaomiaowux/internal/traffic"
)

// randReader 是用于生成安全令牌的加密读取器
var randReader io.Reader = rand.Reader

// base64URLEncoding 用于 URL 安全的 base64 编码
var base64URLEncoding = base64.URLEncoding

type XrayServerHandler struct {
	repo           *storage.TrafficRepository
	collector      *traffic.Collector
	limiterPusher  *LimiterConfigPusher
	remoteManager  *RemoteManageHandler
	wsHandler      *RemoteWSHandler
	crypto         *CryptoConfig
	licenseManager *license.Manager
}

func (h *XrayServerHandler) SetWSHandler(ws *RemoteWSHandler) {
	h.wsHandler = ws
}

func NewXrayServerHandler(repo *storage.TrafficRepository, collector *traffic.Collector, crypto *CryptoConfig) *XrayServerHandler {
	return &XrayServerHandler{
		repo:      repo,
		collector: collector,
		crypto:    crypto,
	}
}

func (h *XrayServerHandler) SetLimiterPusher(p *LimiterConfigPusher) {
	h.limiterPusher = p
}

func (h *XrayServerHandler) SetRemoteManager(rm *RemoteManageHandler) {
	h.remoteManager = rm
}

func (h *XrayServerHandler) SetLicenseManager(mgr *license.Manager) {
	h.licenseManager = mgr
}


// 远程服务器管理API

// RemoteServerCreateRequest代表创建远程服务器的请求
type RemoteServerCreateRequest struct {
	Name              string `json:"name"`
	TrafficLimit      int64  `json:"traffic_limit"`       // 流量限制（以字节为单位）
	TrafficUsedOffset int64  `json:"traffic_used_offset"` // 手动偏移校准
	TrafficResetDay   int    `json:"traffic_reset_day"`   // 要重置的月份日期 (1-31)
	IPAddress         string `json:"ip_address"`          // 子服务器 IP 地址
	ConnectionMode    string `json:"connection_mode"`     // push | pull | websocket
	ListenPort        int    `json:"listen_port"`         // Agent HTTP 监听端口(0 = 用默认 23889);通过 install 脚本注入 MMWX_LISTEN_PORT
	PullAddress       string `json:"pull_address"`        // 对于pull模式
	PullPort          int    `json:"pull_port"`           // 对于pull模式
	PullToken         string `json:"pull_token"`          // 对于pull模式
	StealSelf         bool   `json:"steal_self"`          // 代理安装后自动安装xray+nginx
	FrontService      string `json:"front_service"`       // xray | nginx 使用nginx还是xray做443前置（nginx 保留，尚未启用）
	Domain            string `json:"domain"`              // 服务器域（443模式）
	Use443            bool   `json:"use_443"`             // 使用 443 端口与 nginx 隧道
	StealMode         string `json:"steal_mode"`          // "tunnel" | "fallback"，默认 tunnel
	SiteType          string `json:"site_type"`           // "static" | "proxy"
	SiteValue         string `json:"site_value"`          // 静态路径或反向代理地址
	XrayMode          string `json:"xray_mode"`           // "external" 或 "embedded"，默认 "external"
	TrafficStatsMode  string `json:"traffic_stats_mode"`  // "both"(默认) | "upload" | "download" — 节点流量统计方向
}

// RemoteServerResponse 表示带有远程服务器数据的响应
type RemoteServerResponse struct {
	Success        bool                  `json:"success"`
	Message        string                `json:"message"`
	Server         *storage.RemoteServer `json:"server,omitempty"`
	InstallCommand string                `json:"install_command,omitempty"`
	IsLocal        bool                  `json:"is_local,omitempty"`
}

// RemoteServerInboundInfo 表示远程服务器的入站信息
type RemoteServerInboundInfo struct {
	Tag      string `json:"tag"`
	Protocol string `json:"protocol"`
	Port     int    `json:"port"`
	Uplink   int64  `json:"uplink"`
	Downlink int64  `json:"downlink"`
}

// RemoteServerExtended 表示具有附加流量和入站信息的远程服务器
type RemoteServerExtended struct {
	storage.RemoteServer
	TrafficUsed int64                     `json:"traffic_used"`
	Inbounds    []RemoteServerInboundInfo `json:"inbounds"`
	Encrypted   bool                      `json:"encrypted"`
	WsConnected bool                      `json:"ws_connected"`
}

// RemoteServersListResponse 表示所有远程服务器的响应
type RemoteServersListResponse struct {
	Success bool                   `json:"success"`
	Message string                 `json:"message"`
	Servers []RemoteServerExtended `json:"servers,omitempty"`
}

// RemoteServerDeleteRequest 表示删除远程服务器的请求
type RemoteServerDeleteRequest struct {
	ID int64 `json:"id"`
}

// RemoteServerUpdateRequest 表示更新远程服务器的请求
type RemoteServerUpdateRequest struct {
	ID              int64  `json:"id"`
	Name            string `json:"name"`
	Domain          string `json:"domain"`
	TrafficLimit    int64  `json:"traffic_limit"`
	TrafficResetDay int    `json:"traffic_reset_day"`
	TrafficUsed     *int64 `json:"traffic_used"`
	ConnectionMode  string `json:"connection_mode"`
	ListenPort      int    `json:"listen_port"`     // Agent HTTP 监听端口;变更时主控会通知 agent 改配置+重启
	PullAddress     string `json:"pull_address"`
	PullPort        int    `json:"pull_port"`
	PullToken       string `json:"pull_token"`
	XrayMode         string `json:"xray_mode"`
	TrafficStatsMode string `json:"traffic_stats_mode"` // both | upload | download
}

// 生成加密安全令牌
func generateSecureToken() (string, error) {
	b := make([]byte, 32)
	if _, err := randRead(b); err != nil {
		return "", fmt.Errorf("failed to generate token: %w", err)
	}
	return base64Encode(b), nil
}

// randRead 是一个允许在测试中进行模拟的变量
var randRead = func(b []byte) (int, error) {
	return randReader.Read(b)
}

// base64Encode 将字节编码为 Base64 URL 安全字符串
var base64Encode = func(b []byte) string {
	return base64URLEncoding.EncodeToString(b)
}

// 返回所有远程服务器
func (h *XrayServerHandler) ListRemoteServers(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	if r.Method != "GET" {
		stdhttp.Error(w, "Method not allowed", stdhttp.StatusMethodNotAllowed)
		return
	}

	ctx := r.Context()
	servers, err := h.repo.ListRemoteServers(ctx)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(RemoteServersListResponse{
			Success: false,
			Message: fmt.Sprintf("获取服务器列表失败: %s", err.Error()),
		})
		return
	}

	// 使用流量和入站信息构建扩展服务器列表
	extendedServers := make([]RemoteServerExtended, 0, len(servers))
	for _, server := range servers {
		extended := RemoteServerExtended{
			RemoteServer: server,
			Inbounds:     []RemoteServerInboundInfo{},
		}
		if h.wsHandler != nil {
			extended.Encrypted = h.wsHandler.IsConnectionEncrypted(server.Token)
			extended.WsConnected = h.wsHandler.IsConnected(server.Token)
		}

		trafficUsed, _ := h.repo.GetServerTrafficUsed(ctx, server.ID)
		extended.TrafficUsed = trafficUsed + server.TrafficUsedOffset

		nodeTraffic, err := h.repo.GetNodeTrafficByServer(ctx, server.ID)
		if err == nil {
			for _, nt := range nodeTraffic {
				if nt.Type == "inbound" && nt.Tag != "api" {
					extended.Inbounds = append(extended.Inbounds, RemoteServerInboundInfo{
						Tag:      nt.Tag,
						Protocol: "",
						Port:     0,
						Uplink:   nt.TotalUplink,
						Downlink: nt.TotalDownlink,
					})
				}
			}
		}

		extendedServers = append(extendedServers, extended)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(RemoteServersListResponse{
		Success: true,
		Servers: extendedServers,
	})
}

// 使用生成的令牌创建一个新的远程服务器
func (h *XrayServerHandler) CreateRemoteServer(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	if r.Method != "POST" {
		stdhttp.Error(w, "Method not allowed", stdhttp.StatusMethodNotAllowed)
		return
	}

	if h.licenseManager != nil {
		status := h.licenseManager.GetStatus()
		maxServers := 5
		if status.Plan != nil {
			maxServers = status.Plan.MaxServers
		}
		count, err := h.repo.CountRemoteServers(r.Context())
		if err == nil && count >= int64(maxServers) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(stdhttp.StatusForbidden)
			json.NewEncoder(w).Encode(RemoteServerResponse{
				Success: false,
				Message: fmt.Sprintf("已达到服务器数量上限 (%d/%d)，请升级许可证", count, maxServers),
			})
			return
		}
	}

	var req RemoteServerCreateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(RemoteServerResponse{
			Success: false,
			Message: "无效的请求参数",
		})
		return
	}

	if strings.TrimSpace(req.Name) == "" {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(RemoteServerResponse{
			Success: false,
			Message: "服务器名称不能为空",
		})
		return
	}

	ctx := r.Context()
	reqDomain := strings.ToLower(strings.TrimSpace(req.Domain))
	mmwxDomain := getDomainFromMasterURL(h.repo, ctx)

	isLocalByAddr := false
	mmwxIPs := resolveIPs(mmwxDomain)
	mmwxIPSet := make(map[string]struct{})
	for _, ip := range mmwxIPs {
		mmwxIPSet[ip] = struct{}{}
	}
	checkAddrLocal := func(addr string) bool {
		for _, ip := range resolveIPs(addr) {
			if _, ok := mmwxIPSet[ip]; ok {
				return true
			}
		}
		return false
	}
	if mmwxDomain != "" {
		if req.IPAddress != "" {
			isLocalByAddr = checkAddrLocal(req.IPAddress)
		}
		if !isLocalByAddr && req.PullAddress != "" {
			isLocalByAddr = checkAddrLocal(req.PullAddress)
		}
	}

	if reqDomain != "" && mmwxDomain != "" && reqDomain == mmwxDomain && !isLocalByAddr {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(RemoteServerResponse{
			Success: false,
			Message: "域名不能与 MMWX 安装域名相同",
		})
		return
	}

	// 生成安全令牌
	token, err := generateSecureToken()
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(RemoteServerResponse{
			Success: false,
			Message: fmt.Sprintf("生成Token失败: %s", err.Error()),
		})
		return
	}

	// 生成用于拉取/API 身份验证的代理令牌
	agentToken := req.PullToken
	if agentToken == "" {
		agentToken, err = generateSecureToken()
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(RemoteServerResponse{
				Success: false,
				Message: fmt.Sprintf("生成Agent Token失败: %s", err.Error()),
			})
			return
		}
	}

	// 如果没有指定则设置默认连接模式
	connectionMode := req.ConnectionMode
	if connectionMode == "" {
		connectionMode = storage.ConnectionModePush
	}

	// steal_mode 三种值:tunnel / fallback / default。
	// 历史 BUG:这里曾"非 fallback 就强制 tunnel",导致没勾偷自己的服务器实际也存 tunnel,
	// 用户在编辑 dialog 看到默认选中 tunnel,语义混淆。
	// 现在:
	//   - 显式 fallback / tunnel / default → 原样保留
	//   - 其它值(包括空)→ 偷自己时默认 tunnel,否则默认 default
	stealMode := req.StealMode
	switch stealMode {
	case "tunnel", "fallback", "default":
		// ok
	default:
		if req.StealSelf {
			stealMode = "tunnel"
		} else {
			stealMode = "default"
		}
	}

	xrayMode := req.XrayMode
	if xrayMode != "embedded" {
		xrayMode = "external"
	}

	// Agent 监听端口:有效范围 1024-65535;0 表示用 agent 内置默认 23889
	listenPort := req.ListenPort
	if listenPort < 0 || listenPort > 65535 {
		listenPort = 0
	}

	resetDay := req.TrafficResetDay
	if resetDay < 0 || resetDay > 31 {
		resetDay = 0
	}
	trafficUsedOffset := req.TrafficUsedOffset
	if trafficUsedOffset < 0 {
		trafficUsedOffset = 0
	}
	trafficLimit := req.TrafficLimit
	if trafficLimit < 0 {
		trafficLimit = 0
	}
	trafficStatsMode := strings.TrimSpace(req.TrafficStatsMode)
	if trafficStatsMode != "upload" && trafficStatsMode != "download" {
		trafficStatsMode = "both"
	}

	server := &storage.RemoteServer{
		Name:              req.Name,
		Token:             token,
		Status:            storage.RemoteServerStatusPending,
		IPAddress:         req.IPAddress,
		ConnectionMode:    connectionMode,
		ListenPort:        listenPort,
		PullAddress:       req.PullAddress,
		PullPort:          req.PullPort,
		PullToken:         agentToken,
		Domain:            strings.TrimSpace(req.Domain),
		Use443:            req.Use443,
		StealMode:         stealMode,
		SiteType:          req.SiteType,
		SiteValue:         req.SiteValue,
		XrayMode:          xrayMode,
		TrafficLimit:      trafficLimit,
		TrafficUsedOffset: trafficUsedOffset,
		TrafficResetDay:   resetDay,
		TrafficStatsMode:  trafficStatsMode,
	}

	if err := h.repo.CreateRemoteServer(ctx, server); err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(RemoteServerResponse{
			Success: false,
			Message: fmt.Sprintf("创建服务器失败: %s", err.Error()),
		})
		return
	}

	// 构建安装命令 — 优先用系统设置里的 master_url(用户配置的对外域名),
	// 这是 agent 实际访问主控的地址,r.Host 可能是 nginx upstream 名(如 miaomiaowu_web),
	// 不可对外访问。仅在 master_url 未配置时回退到请求 Host。
	serverURL := ""
	if masterURL, err := h.repo.GetSystemSetting(ctx, "master_url"); err == nil {
		if mu := strings.TrimRight(strings.TrimSpace(masterURL), "/"); mu != "" {
			serverURL = mu
		}
	}
	if serverURL == "" {
		host := r.Host
		scheme := "http"
		if r.TLS != nil {
			scheme = "https"
		}
		if forwardedProto := r.Header.Get("X-Forwarded-Proto"); forwardedProto != "" {
			scheme = forwardedProto
		}
		if host != "" {
			serverURL = fmt.Sprintf("%s://%s", scheme, host)
		}
	}

	// 根据连接模式构建安装命令
	frontService := strings.ToLower(strings.TrimSpace(req.FrontService))
	if frontService != "xray" && frontService != "nginx" {
		frontService = "xray"
	}
	// nginx 前置暂未支持，先强制回退到 xray
	if frontService == "nginx" {
		frontService = "xray"
	}

	installQuery := url.Values{}
	installQuery.Set("token", token)
	if req.StealSelf {
		installQuery.Set("steal_self", "1")
		installQuery.Set("front_service", frontService)
	}
	if xrayMode == "embedded" {
		installQuery.Set("xray_mode", "embedded")
	}
	// 自定义 Agent 端口透传到安装脚本(脚本会写进 /etc/mmw-agent/config.yaml 的 listen_port 字段)
	if listenPort > 0 {
		installQuery.Set("listen_port", fmt.Sprintf("%d", listenPort))
	}
	installScriptURL := fmt.Sprintf("%s/api/remote/install.sh?%s", serverURL, installQuery.Encode())

	var installCommand string
	switch connectionMode {
	case storage.ConnectionModeWebSocket:
		installCommand = fmt.Sprintf("curl -fsSL '%s' | bash -s -- --mode=websocket", installScriptURL)
	case storage.ConnectionModePull:
		// 对于pull模式，子服务器只需要暴露一个API，不需要安装命令
		installCommand = fmt.Sprintf("# pull模式：主服务器将从 %s:%d 拉取流量数据\n# 请确保子服务器已配置 MMWX_MODE=child MMWX_CHILD_API_TOKEN=%s", req.PullAddress, req.PullPort, agentToken)
	default:
		installCommand = fmt.Sprintf("curl -fsSL '%s' | bash", installScriptURL)
	}

	// 本机检测：域名解析 IP 与 mmwx_domain 解析 IP 一致则为本机
	isLocal := isLocalByAddr
	if !isLocal && reqDomain != "" && mmwxDomain != "" {
		reqIPs, err1 := net.LookupHost(reqDomain)
		mmwxIPs, err2 := net.LookupHost(mmwxDomain)
		if err1 == nil && err2 == nil {
			mmwxIPSet := make(map[string]struct{})
			for _, ip := range mmwxIPs {
				mmwxIPSet[ip] = struct{}{}
			}
			for _, ip := range reqIPs {
				if _, ok := mmwxIPSet[ip]; ok {
					isLocal = true
					break
				}
			}
		}
	}

	if isLocal {
		if err := deployLocalNginx(reqDomain, h.repo); err != nil {
			log.Printf("[CreateRemoteServer] 本机 Nginx 部署失败: %v", err)
		} else {
			log.Printf("[CreateRemoteServer] 本机 Nginx 部署成功, domain=%s", reqDomain)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(RemoteServerResponse{
		Success:        true,
		Message:        "服务器创建成功",
		Server:         server,
		InstallCommand: installCommand,
		IsLocal:        isLocal,
	})
}

// 通过 ID 删除远程服务器
func (h *XrayServerHandler) DeleteRemoteServer(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	if r.Method != "POST" {
		stdhttp.Error(w, "Method not allowed", stdhttp.StatusMethodNotAllowed)
		return
	}

	var req RemoteServerDeleteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(RemoteServerResponse{
			Success: false,
			Message: "无效的请求参数",
		})
		return
	}

	if req.ID <= 0 {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(RemoteServerResponse{
			Success: false,
			Message: "无效的服务器ID",
		})
		return
	}

	ctx := r.Context()
	if err := h.repo.DeleteRemoteServer(ctx, req.ID); err != nil {
		msg := "删除服务器失败"
		if err == storage.ErrRemoteServerNotFound {
			msg = "服务器不存在"
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(RemoteServerResponse{
			Success: false,
			Message: msg,
		})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(RemoteServerResponse{
		Success: true,
		Message: "服务器已删除",
	})
}

// 更新远程服务器的基本信息
func (h *XrayServerHandler) UpdateRemoteServer(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	if r.Method != "PUT" && r.Method != "POST" {
		stdhttp.Error(w, "Method not allowed", stdhttp.StatusMethodNotAllowed)
		return
	}

	var req RemoteServerUpdateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(RemoteServerResponse{
			Success: false,
			Message: "无效的请求参数",
		})
		return
	}

	if req.ID <= 0 {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(RemoteServerResponse{
			Success: false,
			Message: "无效的服务器ID",
		})
		return
	}

	if strings.TrimSpace(req.Name) == "" {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(RemoteServerResponse{
			Success: false,
			Message: "服务器名称不能为空",
		})
		return
	}

	ctx := r.Context()

	// 获取旧的服务器信息，用于检查名称是否变更
	oldServer, err := h.repo.GetRemoteServer(ctx, req.ID)
	if err != nil {
		msg := "获取服务器信息失败"
		if err == storage.ErrRemoteServerNotFound {
			msg = "服务器不存在"
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(RemoteServerResponse{
			Success: false,
			Message: msg,
		})
		return
	}

	if err := h.repo.UpdateRemoteServer(ctx, req.ID, req.Name, req.Domain, req.TrafficLimit, req.TrafficResetDay, req.ConnectionMode, req.XrayMode, req.TrafficStatsMode); err != nil {
		msg := "更新服务器失败"
		if err == storage.ErrRemoteServerNotFound {
			msg = "服务器不存在"
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(RemoteServerResponse{
			Success: false,
			Message: msg,
		})
		return
	}

	// 更新拉取配置（如果提供）
	if req.PullAddress != "" || req.PullPort > 0 || req.PullToken != "" {
		connMode := req.ConnectionMode
		if connMode == "" {
			connMode = oldServer.ConnectionMode
		}
		if err := h.repo.UpdateRemoteServerConfig(ctx, req.ID, connMode, req.PullAddress, req.PullPort, req.PullToken); err != nil {
			log.Printf("[Remote Server] Failed to update pull config for server %d: %v", req.ID, err)
		}
	}

	// 如果服务器名称变更，同步更新关联的节点
	if oldServer.Name != req.Name {
		if updated, err := h.repo.UpdateNodesByServerName(ctx, oldServer.Name, req.Name); err != nil {
			log.Printf("[Remote Server] Failed to update nodes for server name change: %v", err)
		} else if updated > 0 {
			log.Printf("[Remote Server] Updated %d nodes for server name change: %s -> %s", updated, oldServer.Name, req.Name)
		}
	}

	// 更新已用流量偏移量
	if req.TrafficUsed != nil {
		aggregated, _ := h.repo.GetServerTrafficUsed(ctx, req.ID)
		offset := *req.TrafficUsed - aggregated
		if err := h.repo.UpdateRemoteServerTrafficOffset(ctx, req.ID, offset); err != nil {
			log.Printf("[Remote Server] Failed to update traffic offset for server %d: %v", req.ID, err)
		}
	}

	// xray_mode 变更：异步通知 Agent 切换模式
	newXrayMode := req.XrayMode
	if newXrayMode == "" {
		newXrayMode = oldServer.XrayMode
	}
	if newXrayMode != oldServer.XrayMode && h.remoteManager != nil {
		go h.switchRemoteXrayMode(req.ID, newXrayMode)
	}

	// listen_port 变更:**必须先用旧端口通知 agent**(此刻 DB 仍是旧值,ForwardToServer 能连上 agent),
	// 等 agent 收到并自重启后,**它会用新端口上报心跳给主控,主控收到心跳时会更新 listen_port**。
	// 这里若立刻落库,会导致 ForwardToServer 读到新端口去连旧 agent 实例,connection refused。
	// 同步调用是因为 agent 端会先 net.Listen 预检新端口能否 bind,
	// 失败(被 xray 等占用)会立刻回 409,主控把错误透传给前端,避免重启后死锁。
	respMsg := "服务器信息已更新"
	newListenPort := req.ListenPort
	if newListenPort < 0 || newListenPort > 65535 {
		newListenPort = oldServer.ListenPort
	}
	if newListenPort != oldServer.ListenPort && h.remoteManager != nil {
		if err := h.switchRemoteListenPort(req.ID, newListenPort); err != nil {
			respMsg = fmt.Sprintf("服务器信息已更新,但端口切换失败: %v", err)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(RemoteServerResponse{
		Success: true,
		Message: respMsg,
	})
}

// switchRemoteXrayMode 通知远程 Agent 切换 xray_mode 并重启。
func (h *XrayServerHandler) switchRemoteXrayMode(serverID int64, newMode string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	body, _ := json.Marshal(map[string]string{"xray_mode": newMode})
	result, err := h.remoteManager.ForwardToServer(ctx, serverID, "POST", "/api/child/agent/switch-xray-mode", body)
	if err != nil {
		log.Printf("[Remote Server] Failed to switch xray_mode to %s for server %d: %v", newMode, serverID, err)
		return
	}
	log.Printf("[Remote Server] Xray mode switch to %s for server %d: %s", newMode, serverID, string(result))
}

// switchRemoteListenPort 通知远程 Agent 改自身监听端口并重启。Agent 重启会短暂断连(~5–15s),
// 重启后用新端口监听,主控下次重连读 server.ListenPort 自动用新端口。
// agent 端会先 net.Listen 预检新端口能否 bind,失败立刻回 409 — 这里 error 不为 nil 即代表
// 切换被 agent 拒绝(端口被占用),DB 不需要回滚因为 agent 也没改 config 也没重启。
func (h *XrayServerHandler) switchRemoteListenPort(serverID int64, newPort int) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	body, _ := json.Marshal(map[string]int{"listen_port": newPort})
	result, err := h.remoteManager.ForwardToServer(ctx, serverID, "POST", "/api/child/agent/switch-listen-port", body)
	if err != nil {
		log.Printf("[Remote Server] Failed to switch listen_port to %d for server %d: %v", newPort, serverID, err)
		return err
	}
	log.Printf("[Remote Server] Listen port switch to %d for server %d: %s", newPort, serverID, string(result))
	return nil
}

func resolveIPs(address string) []string {
	if ip := net.ParseIP(address); ip != nil {
		return []string{ip.String()}
	}
	ips, err := net.LookupHost(address)
	if err != nil {
		return nil
	}
	return ips
}

func (h *XrayServerHandler) CheckSameIP(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	if r.Method != stdhttp.MethodGet {
		stdhttp.Error(w, "Method not allowed", stdhttp.StatusMethodNotAllowed)
		return
	}

	address := strings.TrimSpace(r.URL.Query().Get("address"))
	if address == "" {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"success": false, "message": "address 参数不能为空"})
		return
	}

	ctx := r.Context()
	mmwxDomain := getDomainFromMasterURL(h.repo, ctx)
	masterURL, _ := h.repo.GetSystemSetting(ctx, "master_url")
	httpsEnabled := strings.HasPrefix(masterURL, "https://")

	sameIP := false
	if mmwxDomain != "" {
		addrIPs := resolveIPs(address)
		mmwxIPs := resolveIPs(mmwxDomain)
		mmwxIPSet := make(map[string]struct{})
		for _, ip := range mmwxIPs {
			mmwxIPSet[ip] = struct{}{}
		}
		for _, ip := range addrIPs {
			if _, ok := mmwxIPSet[ip]; ok {
				sameIP = true
				break
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"success":       true,
		"same_ip":       sameIP,
		"master_domain": mmwxDomain,
		"https_enabled": httpsEnabled,
	})
}
