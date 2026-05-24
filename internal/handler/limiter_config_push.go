package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"miaomiaowux/internal/storage"
	"miaomiaowux/internal/version"
)

type LimiterConfigPusher struct {
	repo       *storage.TrafficRepository
	wsHandler  *RemoteWSHandler
	httpClient *http.Client
}

func NewLimiterConfigPusher(repo *storage.TrafficRepository, wsHandler *RemoteWSHandler) *LimiterConfigPusher {
	return &LimiterConfigPusher{
		repo:      repo,
		wsHandler: wsHandler,
		httpClient: &http.Client{
			Timeout: 15 * time.Second,
		},
	}
}

func (p *LimiterConfigPusher) BuildLimiterConfigForServer(ctx context.Context, serverID int64) ([]WSLimiterConfigPayload, error) {
	configs, err := p.repo.GetUserInboundConfigsByServer(ctx, serverID)
	if err != nil {
		return nil, err
	}

	// 查 server name,用于反查子账号(子账号通过 routed_node 的 original_server 关联)
	var serverName string
	if servers, err := p.repo.ListRemoteServers(ctx); err == nil {
		for _, s := range servers {
			if s.ID == serverID {
				serverName = s.Name
				break
			}
		}
	}

	// routed 节点的 active 子账号:也要为它们下发限速规则,key 是子账号 email
	var subaccs []storage.ActiveSubaccountForLimiter
	if serverName != "" {
		subaccs, _ = p.repo.ListActiveSubaccountsByServerName(ctx, serverName)
	}

	if len(configs) == 0 && len(subaccs) == 0 {
		return nil, nil
	}

	usernames := make(map[string]bool)
	for _, c := range configs {
		usernames[c.Username] = true
	}
	for _, sa := range subaccs {
		usernames[sa.Username] = true
	}

	type userLimits struct {
		email       string
		speedMbps   float64
		deviceLimit int
		packageID   int64
	}
	userLimitMap := make(map[string]userLimits)

	pkgCache := make(map[int64]*storage.Package)

	for username := range usernames {
		user, err := p.repo.GetUser(ctx, username)
		if err != nil {
			continue
		}
		if !user.IsActive {
			continue
		}

		var speedMbps float64
		var deviceLimit int

		if user.PackageID > 0 {
			pkg, ok := pkgCache[user.PackageID]
			if !ok {
				pkg, err = p.repo.GetPackage(ctx, user.PackageID)
				if err == nil {
					pkgCache[user.PackageID] = pkg
				}
			}
			if pkg != nil {
				speedMbps = pkg.SpeedLimitMbps
				deviceLimit = pkg.DeviceLimit
			}
		}

		if user.SpeedLimitOverride != nil {
			speedMbps = *user.SpeedLimitOverride
		}
		if user.DeviceLimitOverride != nil {
			deviceLimit = *user.DeviceLimitOverride
		}

		userLimitMap[username] = userLimits{
			email:       username,
			speedMbps:   speedMbps,
			deviceLimit: deviceLimit,
			packageID:   user.PackageID,
		}
	}

	tagUsers := make(map[string][]WSUserLimitInfo)
	tagPkgIDs := make(map[string]map[int64]bool)
	for _, c := range configs {
		ul, ok := userLimitMap[c.Username]
		if !ok {
			continue
		}
		var speedBytes uint64
		if ul.speedMbps > 0 {
			speedBytes = uint64(ul.speedMbps * 1000000 / 8)
		}
		tagUsers[c.InboundTag] = append(tagUsers[c.InboundTag], WSUserLimitInfo{
			Email:       ul.email,
			SpeedLimit:  speedBytes,
			DeviceLimit: ul.deviceLimit,
		})
		if ul.packageID > 0 {
			if tagPkgIDs[c.InboundTag] == nil {
				tagPkgIDs[c.InboundTag] = make(map[int64]bool)
			}
			tagPkgIDs[c.InboundTag][ul.packageID] = true
		}
	}
	// 子账号:为每个 active 子账号 emit 一条 rule,继承所属 username 的 speed/device 阈值。
	// 同 email 写一份独立 rule(子账号不共享限速桶,跟主账号语义一致)。
	for _, sa := range subaccs {
		ul, ok := userLimitMap[sa.Username]
		if !ok {
			continue
		}
		var speedBytes uint64
		if ul.speedMbps > 0 {
			speedBytes = uint64(ul.speedMbps * 1000000 / 8)
		}
		tagUsers[sa.InboundTag] = append(tagUsers[sa.InboundTag], WSUserLimitInfo{
			Email:       sa.Email,
			SpeedLimit:  speedBytes,
			DeviceLimit: ul.deviceLimit,
		})
		if ul.packageID > 0 {
			if tagPkgIDs[sa.InboundTag] == nil {
				tagPkgIDs[sa.InboundTag] = make(map[int64]bool)
			}
			tagPkgIDs[sa.InboundTag][ul.packageID] = true
		}
	}

	var payloads []WSLimiterConfigPayload
	for tag, users := range tagUsers {
		var rules []storage.AutoSpeedLimitRule
		for pkgID := range tagPkgIDs[tag] {
			if pkg, ok := pkgCache[pkgID]; ok && len(pkg.AutoSpeedRules) > 0 {
				rules = append(rules, pkg.AutoSpeedRules...)
			}
		}
		payloads = append(payloads, WSLimiterConfigPayload{
			InboundTag:     tag,
			Users:          users,
			AutoSpeedRules: rules,
		})
	}

	return payloads, nil
}

func (p *LimiterConfigPusher) PushToServer(ctx context.Context, serverID int64) {
	server, err := p.repo.GetRemoteServer(ctx, serverID)
	if err != nil {
		return
	}
	if server.XrayMode != "embedded" {
		return
	}

	configs, err := p.BuildLimiterConfigForServer(ctx, serverID)
	if err != nil {
		log.Printf("[LimiterPush] Failed to build config for server %d: %v", serverID, err)
		return
	}
	if len(configs) == 0 {
		return
	}

	if _, ok := p.wsHandler.GetConnectionByServerID(serverID); ok {
		if err := p.wsHandler.SendLimiterConfig(serverID, configs); err != nil {
			log.Printf("[LimiterPush] WebSocket send failed for server %d: %v", serverID, err)
		}
		return
	}

	p.pushViaHTTP(ctx, server, configs)
}

func (p *LimiterConfigPusher) pushViaHTTP(ctx context.Context, server *storage.RemoteServer, configs []WSLimiterConfigPayload) {
	ip := server.IPAddress
	if idx := strings.LastIndex(ip, ":"); idx != -1 {
		if !strings.Contains(ip, "[") {
			ip = ip[:idx]
		}
	}
	port := 23889
	if server.ListenPort > 0 {
		port = server.ListenPort
	}

	for _, cfg := range configs {
		body, err := json.Marshal(cfg)
		if err != nil {
			log.Printf("[LimiterPush] Failed to marshal config for server %s: %v", server.Name, err)
			continue
		}

		url := fmt.Sprintf("http://%s:%d/api/child/limiter", ip, port)
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
		if err != nil {
			log.Printf("[LimiterPush] Failed to create request for server %s: %v", server.Name, err)
			continue
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+server.Token)
		req.Header.Set("User-Agent", version.AgentUserAgent)

		resp, err := p.httpClient.Do(req)
		if err != nil {
			log.Printf("[LimiterPush] HTTP push failed for server %s: %v", server.Name, err)
			continue
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			log.Printf("[LimiterPush] HTTP push returned %d for server %s", resp.StatusCode, server.Name)
		}
	}
}

func (p *LimiterConfigPusher) PushToAllServersForPackage(ctx context.Context, packageID int64) {
	users, err := p.repo.ListUsersWithPackage(ctx)
	if err != nil {
		return
	}

	serverIDs := make(map[int64]bool)
	for _, u := range users {
		if u.PackageID != packageID {
			continue
		}
		configs, err := p.repo.GetUserInboundConfigs(ctx, u.Username)
		if err != nil {
			continue
		}
		for _, c := range configs {
			serverIDs[c.ServerID] = true
		}
	}

	for sid := range serverIDs {
		p.PushToServer(ctx, sid)
	}
}

func (p *LimiterConfigPusher) PushToAllServersForUser(ctx context.Context, username string) {
	configs, err := p.repo.GetUserInboundConfigs(ctx, username)
	if err != nil {
		return
	}

	serverIDs := make(map[int64]bool)
	for _, c := range configs {
		serverIDs[c.ServerID] = true
	}

	for sid := range serverIDs {
		p.PushToServer(ctx, sid)
	}
}
