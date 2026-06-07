package handler

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"miaomiaowux/internal/license"
	"miaomiaowux/internal/storage"
	"miaomiaowux/internal/substore"

	"github.com/google/uuid"
)

// PackageListHandler 处理列出所有包模板
type PackageListHandler struct {
	repo *storage.TrafficRepository
}

func NewPackageListHandler(repo *storage.TrafficRepository) *PackageListHandler {
	return &PackageListHandler{repo: repo}
}

func (h *PackageListHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	packages, err := h.repo.ListPackages(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"packages": packages,
	})
}

// PackageCreateHandler 处理创建新的包模板
type PackageCreateHandler struct {
	repo           *storage.TrafficRepository
	licenseManager *license.Manager
}

func NewPackageCreateHandler(repo *storage.TrafficRepository) *PackageCreateHandler {
	return &PackageCreateHandler{repo: repo}
}

// SetLicenseManager 注入许可证管理器 — limiter PRO feature gate 需要。
func (h *PackageCreateHandler) SetLicenseManager(mgr *license.Manager) {
	h.licenseManager = mgr
}

// hasNonZeroLimit 任何一项 > 0 都算"启用限速"。0 表示显式不限速,不算"启用"。
func hasNonZeroLimit(m map[int64]float64) bool {
	for _, v := range m {
		if v > 0 {
			return true
		}
	}
	return false
}

func hasNonZeroIntLimit(m map[int64]int) bool {
	for _, v := range m {
		if v > 0 {
			return true
		}
	}
	return false
}

type createPackageRequest struct {
	Name             string                       `json:"name"`
	Description      string                       `json:"description"`
	TrafficLimitGB   float64                      `json:"traffic_limit_gb"`
	CycleDays        int                          `json:"cycle_days"`
	IsReset          bool                         `json:"is_reset"`
	ResetDay         int                          `json:"reset_day"`
	Nodes            []int64                      `json:"nodes"`
	NodeMultipliers  map[int64]float64            `json:"node_multipliers"` // node_id → 倍率
	NodeSpeedLimits  map[int64]float64            `json:"node_speed_limits"`  // 套餐 per-node 限速覆盖 (Mbps);0=显式不限速,缺省=继承 SpeedLimitMbps
	NodeDeviceLimits map[int64]int                `json:"node_device_limits"` // 套餐 per-node 客户端数覆盖;0=显式不限,缺省=继承 DeviceLimit
	SpeedLimitMbps   float64                      `json:"speed_limit_mbps"`
	DeviceLimit      int                          `json:"device_limit"`
	AutoSpeedRules   []storage.AutoSpeedLimitRule `json:"auto_speed_rules"`
	TrafficMode      string                       `json:"traffic_mode"`
	TemplateFilename string                       `json:"template_filename"` // 空 = 走系统默认
}

// validatePackageTemplateFilename 非空时校验 rule_templates 下文件存在。空字符串直接通过(表示用系统默认)。
func validatePackageTemplateFilename(name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil
	}
	// 防目录穿越
	if strings.Contains(name, "..") || strings.ContainsAny(name, "/\\") {
		return fmt.Errorf("invalid template filename")
	}
	if _, err := os.Stat(filepath.Join("rule_templates", name)); err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("template file not found: %s", name)
		}
		return fmt.Errorf("stat template: %w", err)
	}
	return nil
}

func (h *PackageCreateHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req createPackageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	// 验证必填字段
	if req.Name == "" {
		http.Error(w, "Package name is required", http.StatusBadRequest)
		return
	}

	if req.TrafficLimitGB <= 0 {
		http.Error(w, "Traffic limit must be greater than 0", http.StatusBadRequest)
		return
	}

	// limiter 是 PRO feature — SpeedLimitMbps > 0 / AutoSpeedRules 非空 / 任何 per-node 限速值 > 0 都视为启用限速。
	if (req.SpeedLimitMbps > 0 || len(req.AutoSpeedRules) > 0 || hasNonZeroLimit(req.NodeSpeedLimits) || hasNonZeroIntLimit(req.NodeDeviceLimits)) && h.licenseManager != nil && !h.licenseManager.HasFeature("limiter") {
		http.Error(w, "限速器是 PRO 功能,需要许可证", http.StatusForbidden)
		return
	}

	if req.CycleDays <= 0 {
		http.Error(w, "Duration days must be greater than 0", http.StatusBadRequest)
		return
	}

	if req.IsReset && (req.ResetDay < 1 || req.ResetDay > 31) {
		http.Error(w, "Reset day must be between 1 and 31", http.StatusBadRequest)
		return
	}

	if err := validatePackageTemplateFilename(req.TemplateFilename); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// 如果 nil 则初始化空节点数组
	nodes := req.Nodes
	if nodes == nil {
		nodes = []int64{}
	}

	trafficMode := req.TrafficMode
	if trafficMode == "" {
		trafficMode = "oneway"
	}

	pkg := storage.Package{
		Name:              req.Name,
		Description:       req.Description,
		TrafficLimitGB:    req.TrafficLimitGB,
		TrafficLimitBytes: int64(req.TrafficLimitGB * 1024 * 1024 * 1024),
		CycleDays:         req.CycleDays,
		IsReset:           req.IsReset,
		ResetDay:          req.ResetDay,
		Nodes:             nodes,
		NodeMultipliers:   req.NodeMultipliers,
		NodeSpeedLimits:   req.NodeSpeedLimits,
		NodeDeviceLimits:  req.NodeDeviceLimits,
		SpeedLimitMbps:    req.SpeedLimitMbps,
		DeviceLimit:       req.DeviceLimit,
		AutoSpeedRules:    req.AutoSpeedRules,
		TrafficMode:       trafficMode,
		TemplateFilename:  strings.TrimSpace(req.TemplateFilename),
	}

	id, err := h.repo.CreatePackage(r.Context(), pkg)
	if err != nil {
		if err == storage.ErrPackageExists {
			http.Error(w, "Package with this name already exists", http.StatusConflict)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"id":      id,
		"message": "Package created successfully",
	})
}

// PackageUpdateHandler 处理更新现有包模板
type PackageUpdateHandler struct {
	repo           *storage.TrafficRepository
	remoteManage   *RemoteManageHandler
	pusher         *LimiterConfigPusher
	licenseManager *license.Manager
}

// SetLicenseManager 注入许可证管理器 — limiter PRO feature gate 需要。
func (h *PackageUpdateHandler) SetLicenseManager(mgr *license.Manager) {
	h.licenseManager = mgr
}

func NewPackageUpdateHandler(repo *storage.TrafficRepository, remoteManage *RemoteManageHandler, pusher *LimiterConfigPusher) *PackageUpdateHandler {
	return &PackageUpdateHandler{repo: repo, remoteManage: remoteManage, pusher: pusher}
}

type updatePackageRequest struct {
	ID               int64                        `json:"id"`
	Name             string                       `json:"name"`
	Description      string                       `json:"description"`
	TrafficLimitGB   float64                      `json:"traffic_limit_gb"`
	CycleDays        int                          `json:"cycle_days"`
	IsReset          bool                         `json:"is_reset"`
	ResetDay         int                          `json:"reset_day"`
	Nodes            []int64                      `json:"nodes"`
	NodeMultipliers  map[int64]float64            `json:"node_multipliers"` // node_id → 倍率
	NodeSpeedLimits  map[int64]float64            `json:"node_speed_limits"`  // 套餐 per-node 限速覆盖 (Mbps);0=显式不限速,缺省=继承 SpeedLimitMbps
	NodeDeviceLimits map[int64]int                `json:"node_device_limits"` // 套餐 per-node 客户端数覆盖;0=显式不限,缺省=继承 DeviceLimit
	SpeedLimitMbps   float64                      `json:"speed_limit_mbps"`
	DeviceLimit      int                          `json:"device_limit"`
	AutoSpeedRules   []storage.AutoSpeedLimitRule `json:"auto_speed_rules"`
	TrafficMode      string                       `json:"traffic_mode"`
	TemplateFilename string                       `json:"template_filename"` // 空 = 走系统默认
}

func (h *PackageUpdateHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodPut {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req updatePackageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	// 验证必填字段
	if req.ID <= 0 {
		http.Error(w, "Invalid package ID", http.StatusBadRequest)
		return
	}

	if req.Name == "" {
		http.Error(w, "Package name is required", http.StatusBadRequest)
		return
	}

	if req.TrafficLimitGB <= 0 {
		http.Error(w, "Traffic limit must be greater than 0", http.StatusBadRequest)
		return
	}

	// limiter 是 PRO feature — SpeedLimitMbps > 0 / AutoSpeedRules 非空 / 任何 per-node 限速值 > 0 都视为启用限速。
	if (req.SpeedLimitMbps > 0 || len(req.AutoSpeedRules) > 0 || hasNonZeroLimit(req.NodeSpeedLimits) || hasNonZeroIntLimit(req.NodeDeviceLimits)) && h.licenseManager != nil && !h.licenseManager.HasFeature("limiter") {
		http.Error(w, "限速器是 PRO 功能,需要许可证", http.StatusForbidden)
		return
	}

	if req.CycleDays <= 0 {
		http.Error(w, "Duration days must be greater than 0", http.StatusBadRequest)
		return
	}

	if req.IsReset && (req.ResetDay < 1 || req.ResetDay > 31) {
		http.Error(w, "Reset day must be between 1 and 31", http.StatusBadRequest)
		return
	}

	if err := validatePackageTemplateFilename(req.TemplateFilename); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// 如果 nil 则初始化空节点数组
	nodes := req.Nodes
	if nodes == nil {
		nodes = []int64{}
	}

	// 获取旧套餐的节点列表，用于后续计算差异
	var oldNodes []int64
	if oldPkg, err := h.repo.GetPackage(r.Context(), req.ID); err == nil {
		oldNodes = oldPkg.Nodes
	}

	trafficMode := req.TrafficMode
	if trafficMode == "" {
		trafficMode = "oneway"
	}

	pkg := storage.Package{
		ID:                req.ID,
		Name:              req.Name,
		Description:       req.Description,
		TrafficLimitGB:    req.TrafficLimitGB,
		TrafficLimitBytes: int64(req.TrafficLimitGB * 1024 * 1024 * 1024),
		CycleDays:         req.CycleDays,
		IsReset:           req.IsReset,
		ResetDay:          req.ResetDay,
		Nodes:             nodes,
		NodeMultipliers:   req.NodeMultipliers,
		NodeSpeedLimits:   req.NodeSpeedLimits,
		NodeDeviceLimits:  req.NodeDeviceLimits,
		SpeedLimitMbps:    req.SpeedLimitMbps,
		DeviceLimit:       req.DeviceLimit,
		AutoSpeedRules:    req.AutoSpeedRules,
		TrafficMode:       trafficMode,
		TemplateFilename:  strings.TrimSpace(req.TemplateFilename),
	}

	if err := h.repo.UpdatePackage(r.Context(), pkg); err != nil {
		if err == storage.ErrPackageNotFound {
			http.Error(w, "Package not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if h.pusher != nil {
		go h.pusher.PushToAllServersForPackage(context.Background(), req.ID)
	}

	// 异步同步 xray 用户凭据：对比新旧节点差异，为绑定此套餐的用户添加/移除入站配置
	go h.syncInboundUsersAfterNodeChange(context.Background(), req.ID, oldNodes, nodes)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"message": "Package updated successfully",
	})
}

func (h *PackageUpdateHandler) syncInboundUsersAfterNodeChange(ctx context.Context, packageID int64, oldNodes, newNodes []int64) {
	oldSet := make(map[int64]bool, len(oldNodes))
	for _, id := range oldNodes {
		oldSet[id] = true
	}
	newSet := make(map[int64]bool, len(newNodes))
	for _, id := range newNodes {
		newSet[id] = true
	}

	var addedNodes, removedNodes []int64
	for _, id := range newNodes {
		if !oldSet[id] {
			addedNodes = append(addedNodes, id)
		}
	}
	for _, id := range oldNodes {
		if !newSet[id] {
			removedNodes = append(removedNodes, id)
		}
	}

	if len(addedNodes) == 0 && len(removedNodes) == 0 {
		return
	}

	users, err := h.repo.ListUsersWithPackage(ctx)
	if err != nil {
		log.Printf("[PackageUpdate] Failed to list users with package: %v", err)
		return
	}

	var targetUsers []storage.User
	for _, u := range users {
		if u.PackageID == packageID {
			targetUsers = append(targetUsers, u)
		}
	}
	if len(targetUsers) == 0 {
		return
	}

	log.Printf("[PackageUpdate] Syncing inbound users for package %d: %d added nodes, %d removed nodes, %d users",
		packageID, len(addedNodes), len(removedNodes), len(targetUsers))

	// 只 routed 节点改 routing rules 才需要重启 xray;非 routed 的 add-client / remove-client
	// 由 agent 走 HandlerService 热更新,运行态立即生效。同步路径上每台少 ~3s。
	var mu sync.Mutex
	restartNeeded := map[int64]bool{}
	// per-server 收集 routed batch items + inbound add-client items,阶段二 per-server 一次 batch-apply 提交。
	routedBatch := map[int64][]routedBatchItem{}
	inboundBatch := map[int64][]InboundClientAddItem{}
	type inboundFallbackItem struct {
		Username   string
		ServerID   int64
		InboundTag string
		NodeName   string
	}
	var inboundFallbacks []inboundFallbackItem
	// 用户间互不影响 + 节点间互不影响 → 全部并发跑。
	// agent 端 inboundsMu 自动同服务器顺序化,master 这边不需要 per-server 锁。
	var bindWg sync.WaitGroup
	for _, user := range targetUsers {
		for _, nodeID := range addedNodes {
			bindWg.Add(1)
			go func(user storage.User, nodeID int64) {
				defer bindWg.Done()
				node, err := h.repo.GetNodeByID(ctx, nodeID)
				if err != nil {
					log.Printf("[PackageUpdate] Failed to get node %d: %v", nodeID, err)
					return
				}
				if node.NodeType == "routed" {
					if srv, err := h.repo.GetRemoteServerByName(ctx, node.OriginalServer); err == nil {
						mu.Lock()
						restartNeeded[srv.ID] = true
						mu.Unlock()
					}
					item, err := collectRoutedBatchItem(ctx, h.remoteManage, h.repo, user, node.ID)
					if err != nil {
						log.Printf("[PackageUpdate] collect routed item user=%s node=%d failed: %v", user.Username, node.ID, err)
						return
					}
					if item != nil {
						mu.Lock()
						routedBatch[item.ServerID] = append(routedBatch[item.ServerID], *item)
						mu.Unlock()
					}
					return
				}
				if node.InboundTag == "" || node.OriginalServer == "" {
					return
				}
				server, err := h.repo.GetRemoteServerByName(ctx, node.OriginalServer)
				if err != nil {
					log.Printf("[PackageUpdate] Failed to find server %s: %v", node.OriginalServer, err)
					return
				}
				// 阶段一:从 InboundCache 算 cred,收集成 batch item;cache miss / 续费 → fallback 逐项。
				item, collected, cerr := collectInboundClientAddItem(ctx, h.remoteManage.inboundCache, h.repo, user, server.ID, node.InboundTag)
				if cerr != nil {
					mu.Lock()
					inboundFallbacks = append(inboundFallbacks, inboundFallbackItem{Username: user.Username, ServerID: server.ID, InboundTag: node.InboundTag, NodeName: node.NodeName})
					mu.Unlock()
					return
				}
				if collected && item != nil {
					mu.Lock()
					inboundBatch[item.ServerID] = append(inboundBatch[item.ServerID], *item)
					mu.Unlock()
				}
			}(user, nodeID)
		}

		for _, nodeID := range removedNodes {
			bindWg.Add(1)
			go func(user storage.User, nodeID int64) {
				defer bindWg.Done()
				node, err := h.repo.GetNodeByID(ctx, nodeID)
				if err != nil {
					return
				}
				if node.NodeType == "routed" {
					if srv, err := h.repo.GetRemoteServerByName(ctx, node.OriginalServer); err == nil {
						mu.Lock()
						restartNeeded[srv.ID] = true
						mu.Unlock()
					}
					if err := removeUserFromRoutedNode(ctx, h.remoteManage, h.repo, user.Username, node.ID); err != nil {
						log.Printf("[PackageUpdate] remove user %s from routed node %d failed: %v", user.Username, node.ID, err)
					}
					return
				}
				if node.InboundTag == "" || node.OriginalServer == "" {
					return
				}
				server, err := h.repo.GetRemoteServerByName(ctx, node.OriginalServer)
				if err != nil {
					return
				}
				cfg, err := h.repo.GetUserInboundConfig(ctx, user.Username, server.ID, node.InboundTag)
				if err != nil {
					return
				}
				if err := removeUserFromInbound(ctx, h.remoteManage, *cfg); err != nil {
					log.Printf("[PackageUpdate] Failed to remove user %s from inbound %s on server %d: %v",
						user.Username, cfg.InboundTag, cfg.ServerID, err)
				}
				_ = h.repo.DeleteUserInboundConfig(ctx, user.Username, server.ID, node.InboundTag)
			}(user, nodeID)
		}
	}
	bindWg.Wait()

	// 阶段二 — per-server 并行调 batch-apply。routed + inbound 各自一批,跨 server 并行。
	var routeWg sync.WaitGroup
	for serverID, items := range routedBatch {
		routeWg.Add(1)
		go func(sid int64, list []routedBatchItem) {
			defer routeWg.Done()
			_ = applyRoutedBatchOrFallback(ctx, h.remoteManage, h.repo, sid, list, "PackageUpdate")
		}(serverID, items)
	}
	for serverID, items := range inboundBatch {
		routeWg.Add(1)
		go func(sid int64, list []InboundClientAddItem) {
			defer routeWg.Done()
			_ = applyInboundBatchOrFallback(ctx, h.remoteManage, h.repo, sid, list, "PackageUpdate")
		}(serverID, items)
	}
	routeWg.Wait()

	// 阶段三 — cache miss 类 fallback:并发跑逐项 addUserToInbound(老路径)。
	if len(inboundFallbacks) > 0 {
		log.Printf("[PackageUpdate] %d inbound items fell back to per-item add (cache miss / no batch)", len(inboundFallbacks))
		var fbWg sync.WaitGroup
		for _, fb := range inboundFallbacks {
			fbWg.Add(1)
			go func(fb inboundFallbackItem) {
				defer fbWg.Done()
				user := storage.User{Username: fb.Username}
				if err := addUserToInbound(ctx, h.remoteManage, h.repo, user, fb.ServerID, fb.InboundTag); err != nil {
					log.Printf("[PackageUpdate] fallback addUserToInbound user=%s server=%d tag=%s: %v",
						fb.Username, fb.ServerID, fb.InboundTag, err)
				}
			}(fb)
		}
		fbWg.Wait()
	}

	// limiter push 后台异步,不阻塞响应
	if h.pusher != nil {
		for _, user := range targetUsers {
			go h.pusher.PushToAllServersForUser(context.Background(), user.Username)
		}
	}

	restartXrayInParallel(ctx, h.remoteManage, restartNeeded, "PackageUpdate")
}

// PackageDeleteHandler 处理删除包模板
type PackageDeleteHandler struct {
	repo         *storage.TrafficRepository
	remoteManage *RemoteManageHandler
	pusher       *LimiterConfigPusher
}

func NewPackageDeleteHandler(repo *storage.TrafficRepository, remoteManage *RemoteManageHandler, pusher *LimiterConfigPusher) *PackageDeleteHandler {
	return &PackageDeleteHandler{repo: repo, remoteManage: remoteManage, pusher: pusher}
}

// unbindUserPackage 解除单个用户的套餐绑定:从入站移除凭据、删本地入站配置、推送 limiter、
// 清空 package_id,并删除该用户残留的套餐订阅(历史 auto-gen)。best-effort,只记日志。
func unbindUserPackage(ctx context.Context, repo *storage.TrafficRepository, remoteManage *RemoteManageHandler, pusher *LimiterConfigPusher, username string) {
	var mu sync.Mutex
	// 只 routed 路径(改 routing rules)需要重启;普通 inbound remove-client 由 agent 热更新。
	restartNeeded := map[int64]bool{}

	// inbound 移除 + routed 下线并发执行 — 每条目独立,失败只 log。
	var wg sync.WaitGroup

	configs, err := repo.GetUserInboundConfigs(ctx, username)
	if err != nil {
		log.Printf("[PackageUnbind] 获取用户 %s 入站配置失败: %v", username, err)
	}
	for _, cfg := range configs {
		wg.Add(1)
		go func(cfg storage.UserInboundConfig) {
			defer wg.Done()
			if err := removeUserFromInbound(ctx, remoteManage, cfg); err != nil {
				log.Printf("[PackageUnbind] 从入站 %s(server %d)移除用户 %s 失败: %v", cfg.InboundTag, cfg.ServerID, username, err)
			}
		}(cfg)
	}

	// 子账号路径:从所有 active routed 节点下线(凭据保留,续费可恢复)
	subaccs, _ := repo.ListUserSubaccounts(ctx, username)
	for _, sa := range subaccs {
		if !sa.IsActive {
			continue
		}
		wg.Add(1)
		go func(routedNodeID int64) {
			defer wg.Done()
			if node, err := repo.GetNodeByID(ctx, routedNodeID); err == nil && node.OriginalServer != "" {
				if srv, err := repo.GetRemoteServerByName(ctx, node.OriginalServer); err == nil {
					mu.Lock()
					restartNeeded[srv.ID] = true
					mu.Unlock()
				}
			}
			if err := removeUserFromRoutedNode(ctx, remoteManage, repo, username, routedNodeID); err != nil {
				log.Printf("[PackageUnbind] routed node %d 下线用户 %s 失败: %v", routedNodeID, username, err)
			}
		}(sa.RoutedNodeID)
	}
	wg.Wait()

	if err := repo.DeleteUserInboundConfigs(ctx, username); err != nil {
		log.Printf("[PackageUnbind] 删除用户 %s 入站配置记录失败: %v", username, err)
	}

	restartXrayInParallel(ctx, remoteManage, restartNeeded, "PackageUnbind")
	if pusher != nil {
		go pusher.PushToAllServersForUser(context.Background(), username)
	}
	if err := repo.RemovePackageFromUser(ctx, username); err != nil && err != storage.ErrUserNotFound {
		log.Printf("[PackageUnbind] 解绑用户 %s 套餐失败: %v", username, err)
	}
	// 删除该用户残留的套餐订阅(历史 auto-gen 文件)
	if sf, err := repo.GetUserPackageSubscription(ctx, username); err == nil && sf.ID > 0 {
		if derr := repo.DeleteSubscribeFile(ctx, sf.ID); derr != nil {
			log.Printf("[PackageUnbind] 删除用户 %s 套餐订阅记录失败: %v", username, derr)
		}
		if sf.Filename != "" {
			_ = os.Remove(filepath.Join("subscribes", sf.Filename))
		}
	}
}

func (h *PackageDeleteHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete && r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// 从 URL 路径或请求正文中提取 ID
	var id int64
	var err error

	if r.Method == http.MethodDelete {
		// 从 URL 路径提取：/api/admin/packages/123
		pathParts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/admin/packages/"), "/")
		if len(pathParts) > 0 && pathParts[0] != "" {
			id, err = strconv.ParseInt(pathParts[0], 10, 64)
			if err != nil {
				http.Error(w, "Invalid package ID", http.StatusBadRequest)
				return
			}
		}
	} else {
		// 从 JSON 正文中提取
		var req struct {
			ID int64 `json:"id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid request body", http.StatusBadRequest)
			return
		}
		id = req.ID
	}

	if id <= 0 {
		http.Error(w, "Invalid package ID", http.StatusBadRequest)
		return
	}

	ctx := r.Context()

	// 删除套餐前,先把绑定该套餐的所有用户解绑(移除入站凭据 + 清 package_id + 删套餐订阅),
	// 否则会残留无效绑定和孤立订阅。
	unbound := 0
	if users, err := h.repo.ListUsersWithPackage(ctx); err == nil {
		for _, u := range users {
			if u.PackageID == id {
				unbindUserPackage(ctx, h.repo, h.remoteManage, h.pusher, u.Username)
				unbound++
			}
		}
	} else {
		log.Printf("[PackageDelete] 获取绑定用户列表失败: %v", err)
	}

	if err := h.repo.DeletePackage(ctx, id); err != nil {
		if err == storage.ErrPackageNotFound {
			http.Error(w, "Package not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"message":       "Package deleted successfully",
		"unbound_users": unbound,
	})
}

// PackageUnassignHandler 处理从用户删除包分配
type PackageUnassignHandler struct {
	repo         *storage.TrafficRepository
	remoteManage *RemoteManageHandler
	pusher       *LimiterConfigPusher
}

func NewPackageUnassignHandler(repo *storage.TrafficRepository, remoteManage *RemoteManageHandler, pusher *LimiterConfigPusher) *PackageUnassignHandler {
	return &PackageUnassignHandler{repo: repo, remoteManage: remoteManage, pusher: pusher}
}

func (h *PackageUnassignHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Username string `json:"username"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if req.Username == "" {
		http.Error(w, "Username is required", http.StatusBadRequest)
		return
	}

	ctx := r.Context()

	// 先从入站中移除用户凭据
	configs, err := h.repo.GetUserInboundConfigs(ctx, req.Username)
	if err != nil {
		log.Printf("[PackageUnassign] Failed to get user inbound configs: %v", err)
	}
	for _, cfg := range configs {
		if err := removeUserFromInbound(ctx, h.remoteManage, cfg); err != nil {
			log.Printf("[PackageUnassign] Failed to remove user %s from inbound %s on server %d: %v",
				req.Username, cfg.InboundTag, cfg.ServerID, err)
		}
	}
	if err := h.repo.DeleteUserInboundConfigs(ctx, req.Username); err != nil {
		log.Printf("[PackageUnassign] Failed to delete user inbound config records: %v", err)
	}

	// 路由出站子账号:从 active 状态下线,凭据保留供续费恢复。
	subaccs, _ := h.repo.ListUserSubaccounts(ctx, req.Username)
	for _, sa := range subaccs {
		if !sa.IsActive {
			continue
		}
		if err := removeUserFromRoutedNode(ctx, h.remoteManage, h.repo, req.Username, sa.RoutedNodeID); err != nil {
			log.Printf("[PackageUnassign] routed node %d 下线用户 %s 失败: %v", sa.RoutedNodeID, req.Username, err)
		}
	}

	if h.pusher != nil {
		go h.pusher.PushToAllServersForUser(context.Background(), req.Username)
	}

	if err := h.repo.RemovePackageFromUser(ctx, req.Username); err != nil {
		if err == storage.ErrUserNotFound {
			http.Error(w, "User not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"message": "Package removed successfully",
	})
}

// PackageAssignHandler 处理将包分配给用户的操作
type PackageAssignHandler struct {
	repo         *storage.TrafficRepository
	remoteManage *RemoteManageHandler
	pusher       *LimiterConfigPusher
}

func NewPackageAssignHandler(repo *storage.TrafficRepository, remoteManage *RemoteManageHandler, pusher *LimiterConfigPusher) *PackageAssignHandler {
	return &PackageAssignHandler{repo: repo, remoteManage: remoteManage, pusher: pusher}
}

type assignPackageRequest struct {
	Username   string `json:"username"`
	PackageID  int64  `json:"package_id"`
	StartDate  string `json:"start_date"`
	ExpireDate string `json:"expire_date"`
	IsReset    bool   `json:"is_reset"`
	ResetDay   int    `json:"reset_day"`
}

func (h *PackageAssignHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req assignPackageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if req.Username == "" {
		http.Error(w, "Username is required", http.StatusBadRequest)
		return
	}
	if req.PackageID <= 0 {
		http.Error(w, "Package ID is required", http.StatusBadRequest)
		return
	}

	var startDate time.Time
	if req.StartDate != "" {
		parsed, err := time.Parse("2006-01-02", req.StartDate)
		if err != nil {
			http.Error(w, "Invalid start_date format, expected YYYY-MM-DD", http.StatusBadRequest)
			return
		}
		startDate = parsed
	} else {
		startDate = time.Now()
	}

	// 计算到期时间：优先使用前端传入的 expire_date，否则默认 start + 30 天
	ctx := r.Context()
	var endDate time.Time
	if req.ExpireDate != "" {
		parsed, err := time.Parse("2006-01-02", req.ExpireDate)
		if err != nil {
			http.Error(w, "Invalid expire_date format, expected YYYY-MM-DD", http.StatusBadRequest)
			return
		}
		endDate = parsed
	} else {
		pkg, err := h.repo.GetPackage(ctx, req.PackageID)
		if err == nil && pkg.CycleDays > 0 {
			endDate = startDate.AddDate(0, 0, pkg.CycleDays)
		} else {
			endDate = startDate.AddDate(0, 1, 0)
		}
	}

	warnings, perr := h.AssignAndProvision(ctx, req.Username, req.PackageID, startDate, endDate, req.IsReset, req.ResetDay)
	if perr != nil {
		if perr == storage.ErrPackageNotFound {
			http.Error(w, "Package not found", http.StatusNotFound)
			return
		}
		if perr == storage.ErrUserNotFound {
			http.Error(w, "User not found", http.StatusNotFound)
			return
		}
		http.Error(w, perr.Error(), http.StatusInternalServerError)
		return
	}
	if len(warnings) > 0 {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"message": "Package assigned with warnings", "warnings": warnings})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"message": "Package assigned successfully"})
}

// AssignAndProvision 绑定套餐并真正下发(给套餐节点 inbound 加用户凭据 + 批量推服务器 + 重启 xray + 推限速)。
// 抽自 ServeHTTP,供 web /api/admin/packages/assign 与 TGBOT 注册/兑换共用,确保两条路都生效。
func (h *PackageAssignHandler) AssignAndProvision(ctx context.Context, username string, packageID int64, startDate, endDate time.Time, isReset bool, resetDay int) ([]string, error) {
	var warnings []string
	if err := h.repo.AssignPackageToUser(ctx, username, packageID, startDate, endDate, isReset, resetDay); err != nil {
		return nil, err
	}

	// 获取套餐关联的节点，为每个节点的入站添加用户凭据
	pkg, err := h.repo.GetPackage(ctx, packageID)
	if err != nil {
		log.Printf("[PackageAssign] Failed to get package: %v", err)
	} else {
		user, err := h.repo.GetUser(ctx, username)
		if err != nil {
			log.Printf("[PackageAssign] Failed to get user: %v", err)
		} else {
			var mu sync.Mutex
			// 只收集"必须重启 xray 才能让改动生效"的服务器:
			//   - routed 节点:改了 routing rules → 必须重启
			//   - 非 routed 节点:add-client 已由 agent 走 HandlerService 热更新(replaceRuntimeInbound)→ 不需要重启
			// 早先的版本无差别对所有受影响服务器重启,跨 5 台机器串行能多花 15s。
			restartNeeded := map[int64]bool{}
			// per-server 收集 routed 节点的 batch items + 普通 inbound 加 client items。
			// 新 agent 支持 /api/child/batch-apply → 同 server 所有 client + routing 改动一次 round-trip;
			// 老 agent 不支持 → applyRoutedBatchOrFallback / applyInboundBatchOrFallback 内部 fallback 逐项。
			routedBatch := map[int64][]routedBatchItem{}
			inboundBatch := map[int64][]InboundClientAddItem{}
			// 普通 inbound 节点 cache miss / 续费跳过时,fallback 直接走逐项 addUserToInbound。
			type inboundFallbackItem struct {
				ServerID   int64
				InboundTag string
				NodeName   string
			}
			var inboundFallbacks []inboundFallbackItem

			// 节点绑定并发跑 — routed / inbound 都只在阶段一收集,阶段二 per-server batch 一次性提交。
			var bindWg sync.WaitGroup
			for _, nodeID := range pkg.Nodes {
				bindWg.Add(1)
				go func(nodeID int64) {
					defer bindWg.Done()
					node, err := h.repo.GetNodeByID(ctx, nodeID)
					if err != nil {
						log.Printf("[PackageAssign] Failed to get node %d: %v", nodeID, err)
						return
					}
					if node.NodeType == "routed" {
						if srv, err := h.repo.GetRemoteServerByName(ctx, node.OriginalServer); err == nil {
							mu.Lock()
							restartNeeded[srv.ID] = true
							mu.Unlock()
						}
						item, err := collectRoutedBatchItem(ctx, h.remoteManage, h.repo, user, node.ID)
						if err != nil {
							log.Printf("[PackageAssign] routed node %d collect failed for user %s: %v", node.ID, username, err)
							mu.Lock()
							warnings = append(warnings, fmt.Sprintf("路由出站 %s 添加用户失败", node.NodeName))
							mu.Unlock()
							return
						}
						if item != nil {
							mu.Lock()
							routedBatch[item.ServerID] = append(routedBatch[item.ServerID], *item)
							mu.Unlock()
						}
						return
					}
					if node.InboundTag == "" || node.OriginalServer == "" {
						return
					}
					server, err := h.repo.GetRemoteServerByName(ctx, node.OriginalServer)
					if err != nil {
						log.Printf("[PackageAssign] Failed to find server %s: %v", node.OriginalServer, err)
						return
					}
					// 阶段一:从 InboundCache 算 cred,收集成 batch item;cache miss / 续费 → fallback 逐项。
					item, collected, cerr := collectInboundClientAddItem(ctx, h.remoteManage.inboundCache, h.repo, user, server.ID, node.InboundTag)
					if cerr != nil {
						mu.Lock()
						inboundFallbacks = append(inboundFallbacks, inboundFallbackItem{ServerID: server.ID, InboundTag: node.InboundTag, NodeName: node.NodeName})
						mu.Unlock()
						return
					}
					if collected && item != nil {
						mu.Lock()
						inboundBatch[item.ServerID] = append(inboundBatch[item.ServerID], *item)
						mu.Unlock()
					}
				}(nodeID)
			}
			bindWg.Wait()

			// 阶段二 — per-server 并行调 batch-apply。
			// routed + inbound 各自一批,跨 server 并行;同 server 内 inbound 与 routed 分别一次 round-trip(不合并避免 routed 重启把 inbound 加 client 也"等"上)。
			var routeWg sync.WaitGroup
			for serverID, items := range routedBatch {
				routeWg.Add(1)
				go func(sid int64, list []routedBatchItem) {
					defer routeWg.Done()
					ws := applyRoutedBatchOrFallback(ctx, h.remoteManage, h.repo, sid, list, "PackageAssign")
					if len(ws) > 0 {
						mu.Lock()
						warnings = append(warnings, ws...)
						mu.Unlock()
					}
				}(serverID, items)
			}
			for serverID, items := range inboundBatch {
				routeWg.Add(1)
				go func(sid int64, list []InboundClientAddItem) {
					defer routeWg.Done()
					ws := applyInboundBatchOrFallback(ctx, h.remoteManage, h.repo, sid, list, "PackageAssign")
					if len(ws) > 0 {
						mu.Lock()
						warnings = append(warnings, ws...)
						mu.Unlock()
					}
				}(serverID, items)
			}
			routeWg.Wait()

			// 阶段三 — cache miss 类 fallback:并发跑逐项 addUserToInbound(老路径)。
			if len(inboundFallbacks) > 0 {
				log.Printf("[PackageAssign] %d inbound items fell back to per-item add (cache miss / no batch)", len(inboundFallbacks))
				var fbWg sync.WaitGroup
				for _, fb := range inboundFallbacks {
					fbWg.Add(1)
					go func(fb inboundFallbackItem) {
						defer fbWg.Done()
						if err := addUserToInbound(ctx, h.remoteManage, h.repo, user, fb.ServerID, fb.InboundTag); err != nil {
							log.Printf("[PackageAssign] fallback addUserToInbound user=%s server=%d tag=%s: %v",
								username, fb.ServerID, fb.InboundTag, err)
							mu.Lock()
							warnings = append(warnings, fmt.Sprintf("节点 %s 添加用户失败", fb.NodeName))
							mu.Unlock()
						}
					}(fb)
				}
				fbWg.Wait()
			}

			restartXrayInParallel(ctx, h.remoteManage, restartNeeded, "PackageAssign")
		}
	}

	if h.pusher != nil {
		go h.pusher.PushToAllServersForUser(context.Background(), username)
	}
	return warnings, nil
}

func (h *PackageAssignHandler) autoGenerateSubscription(ctx context.Context, username string, packageID int64) {
	pkg, err := h.repo.GetPackage(ctx, packageID)
	if err != nil {
		log.Printf("[PackageAssign] 自动生成订阅失败: 获取套餐错误: %v", err)
		return
	}

	var proxies []map[string]any
	for _, nodeID := range pkg.Nodes {
		node, err := h.repo.GetNodeByID(ctx, nodeID)
		if err != nil || !node.Enabled || node.ClashConfig == "" {
			continue
		}
		var proxyConfig map[string]any
		if err := json.Unmarshal([]byte(node.ClashConfig), &proxyConfig); err != nil {
			continue
		}
		proxies = append(proxies, proxyConfig)
	}

	if len(proxies) == 0 {
		log.Printf("[PackageAssign] 自动生成订阅跳过: 套餐 %d 无可用节点", packageID)
		return
	}

	templateContent, err := h.loadDefaultTemplate(ctx)
	if err != nil {
		log.Printf("[PackageAssign] 自动生成订阅失败: %v", err)
		return
	}

	processor := substore.NewTemplateV3Processor(nil, nil)
	result, err := processor.ProcessTemplate(templateContent, proxies)
	if err != nil {
		log.Printf("[PackageAssign] 自动生成订阅失败: 处理模板错误: %v", err)
		return
	}

	result, err = injectProxiesIntoTemplate(result, proxies)
	if err != nil {
		log.Printf("[PackageAssign] 自动生成订阅失败: 注入代理错误: %v", err)
		return
	}

	os.MkdirAll("subscribes", 0755)

	existing, err := h.repo.GetUserPackageSubscription(ctx, username)
	if err == nil {
		filePath := filepath.Join("subscribes", existing.Filename)
		if err := os.WriteFile(filePath, []byte(result), 0644); err != nil {
			log.Printf("[PackageAssign] 自动生成订阅失败: 写入文件错误: %v", err)
			return
		}
		existing.Name = fmt.Sprintf("%s - %s", username, pkg.Name)
		existing.Description = "套餐自动生成"
		h.repo.UpdateSubscribeFile(ctx, existing)
		log.Printf("[PackageAssign] 已更新用户 %s 的套餐订阅文件", username)
		return
	}

	filename := fmt.Sprintf("pkg_%s.yaml", username)
	filePath := filepath.Join("subscribes", filename)
	if err := os.WriteFile(filePath, []byte(result), 0644); err != nil {
		log.Printf("[PackageAssign] 自动生成订阅失败: 写入文件错误: %v", err)
		return
	}

	file := storage.SubscribeFile{
		Name:        fmt.Sprintf("%s - %s", username, pkg.Name),
		Description: "套餐自动生成",
		Type:        storage.SubscribeTypePackage,
		Filename:    filename,
		CreatedBy:   username, // 套餐自动生成的订阅归属到该用户，否则后续 GetSubscribeFileByShortCode 拿不到归属用户
	}
	created, err := h.repo.CreateSubscribeFile(ctx, file)
	if err != nil {
		log.Printf("[PackageAssign] 自动生成订阅失败: 创建记录错误: %v", err)
		return
	}
	if err := h.repo.AssignSubscriptionToUser(ctx, username, created.ID); err != nil {
		log.Printf("[PackageAssign] 自动生成订阅失败: 关联用户错误: %v", err)
		return
	}
	log.Printf("[PackageAssign] 已为用户 %s 创建套餐订阅文件", username)
}

func (h *PackageAssignHandler) loadDefaultTemplate(ctx context.Context) (string, error) {
	templatesDir := "rule_templates"
	var candidates []string

	cfg, err := h.repo.GetSystemConfig(ctx)
	if err == nil && cfg.DefaultTemplateFilename != "" {
		candidates = append(candidates, cfg.DefaultTemplateFilename)
	}
	candidates = append(candidates, "default.yaml", "redirhost__v3.yaml")

	for _, name := range candidates {
		content, err := os.ReadFile(filepath.Join(templatesDir, name))
		if err == nil {
			return string(content), nil
		}
	}
	return "", fmt.Errorf("未找到可用模板")
}

// addUserToInbound 获取远程入站配置，添加用户凭据，然后重新提交
// restartXrayInParallel 并发对多台服务器做 xray restart-with-recovery,等全部完成后返回。
// 单台 restartXrayWithRecovery 至少 2s(verify wait),5 台串行 ≥10s;并发后整体只看最慢一台。
// 失败只记日志,不打断 —— 调用方语义里"重启 best-effort",和原顺序版本一致。
func restartXrayInParallel(ctx context.Context, rm *RemoteManageHandler, serverIDs map[int64]bool, logPrefix string) {
	if len(serverIDs) == 0 {
		return
	}
	var wg sync.WaitGroup
	for sid := range serverIDs {
		wg.Add(1)
		go func(sid int64) {
			defer wg.Done()
			if err := rm.restartXrayWithRecovery(ctx, sid, logPrefix); err != nil {
				log.Printf("[%s] restart xray on server %d failed: %v", logPrefix, sid, err)
			}
		}(sid)
	}
	wg.Wait()
}

func addUserToInbound(ctx context.Context, rm *RemoteManageHandler, repo *storage.TrafficRepository, user storage.User, serverID int64, inboundTag string) error {
	// 只读 inbound 列表,目的是拿到 protocol/method/flow 这些构造 credential 必需的字段。
	// 不再在主控这边修改 inbound:实际的"加 client"由 agent 在 inboundsMu 锁内原子完成,
	// 避免多用户并发绑套餐时主控基于同一份快照各自 append → 后写覆盖先写 → 丢 client。
	result, err := rm.forwardToRemoteServer(ctx, serverID, "GET", "/api/child/inbounds", nil)
	if err != nil {
		return fmt.Errorf("get inbounds: %w", err)
	}

	var resp struct {
		Success  bool                     `json:"success"`
		Inbounds []map[string]interface{} `json:"inbounds"`
	}
	if err := json.Unmarshal(result, &resp); err != nil || !resp.Success {
		return fmt.Errorf("parse inbounds response: %v", err)
	}

	var targetInbound map[string]interface{}
	for _, ib := range resp.Inbounds {
		if tag, _ := ib["tag"].(string); tag == inboundTag {
			targetInbound = ib
			break
		}
	}
	if targetInbound == nil {
		return fmt.Errorf("inbound %s not found", inboundTag)
	}

	protocol, _ := targetInbound["protocol"].(string)
	settings, _ := targetInbound["settings"].(map[string]interface{})

	// 尝试复用已保存的凭据(续费场景);否则生成新的。
	var credential map[string]interface{}
	var credJSON string
	existing, _ := repo.GetUserInboundConfig(ctx, user.Username, serverID, inboundTag)
	if existing != nil && existing.Protocol == protocol {
		json.Unmarshal([]byte(existing.CredentialJSON), &credential)
		credJSON = existing.CredentialJSON
	}
	if credential == nil {
		// shadowsocks 需要 settings.method 决定 key 长度(SS2022 各档不同)
		var method string
		if settings != nil {
			method, _ = settings["method"].(string)
		}
		var err error
		credential, credJSON, err = generateCredential(protocol, user, method, inboundTag)
		if err != nil {
			return fmt.Errorf("generate credential: %w", err)
		}
	}

	// 从现有 client 继承 flow 字段(VLESS Reality 需要)
	if strings.EqualFold(protocol, "vless") {
		if _, hasFlow := credential["flow"]; !hasFlow && settings != nil {
			if clients, ok := settings["clients"].([]interface{}); ok && len(clients) > 0 {
				if first, ok := clients[0].(map[string]interface{}); ok {
					if flow, ok := first["flow"].(string); ok && flow != "" {
						credential["flow"] = flow
						if b, err := json.Marshal(credential); err == nil {
							credJSON = string(b)
						}
					}
				}
			}
		}
	}

	// 原子 add-client:agent 端在 inboundsMu 内做 read-modify-write,自带幂等(已存在则 no-op)。
	body, _ := json.Marshal(map[string]interface{}{
		"action": "add-client",
		"tag":    inboundTag,
		"client": credential,
	})
	if _, err := rm.forwardToRemoteServer(ctx, serverID, "POST", "/api/child/inbounds", body); err != nil {
		return fmt.Errorf("add-client: %w", err)
	}

	// 仅在没有已保存记录时写入新记录
	if existing == nil {
		repo.SaveUserInboundConfig(ctx, storage.UserInboundConfig{
			Username:       user.Username,
			ServerID:       serverID,
			InboundTag:     inboundTag,
			Protocol:       protocol,
			CredentialJSON: credJSON,
		})
	}

	return nil
}

// removeUserFromInbound 通过 agent 原子 remove-client 移除用户凭据。
// 主控不再持有 inbound 副本,所以也不存在并发解绑时彼此覆盖的可能。
func removeUserFromInbound(ctx context.Context, rm *RemoteManageHandler, cfg storage.UserInboundConfig) error {
	var savedCred map[string]interface{}
	if err := json.Unmarshal([]byte(cfg.CredentialJSON), &savedCred); err != nil || savedCred == nil {
		return fmt.Errorf("parse saved credential: %v", err)
	}
	body, _ := json.Marshal(map[string]interface{}{
		"action": "remove-client",
		"tag":    cfg.InboundTag,
		"client": savedCred,
	})
	if _, err := rm.forwardToRemoteServer(ctx, cfg.ServerID, "POST", "/api/child/inbounds", body); err != nil {
		return fmt.Errorf("remove-client: %w", err)
	}
	return nil
}

// shadowsocksKeyLength 根据 SS method 返回 password 应有的字节数（base64 解码后）。
func shadowsocksKeyLength(method string) int {
	switch strings.ToLower(strings.TrimSpace(method)) {
	case "2022-blake3-aes-128-gcm":
		return 16
	case "2022-blake3-aes-256-gcm", "2022-blake3-chacha20-poly1305":
		return 32
	}
	// 老 SS 算法对 key 长度宽松,16 字节够大多数场景。
	return 16
}

// generateCredential 生成单用户在指定 inbound 上的认证凭据。
// shadowsocks 协议要求 password 与 method 的 key length 严格匹配,否则 xray reload 会失败。
// SS2022 :
//
//	2022-blake3-aes-128-gcm           → 16 bytes (base64 24 chars)
//	2022-blake3-aes-256-gcm           → 32 bytes
//	2022-blake3-chacha20-poly1305     → 32 bytes
//
// 老 SS / 非 2022 method → 任意长度都接受,默认给 16 bytes 即可。
//
// email 强制使用 `<username>__<inboundTag>` 格式,保证同一 user 在同一 server 多 inbound 时
// 每条 client 的 email 唯一 — Xray stats 才能按 inbound 拆开 per-user 流量,前端 drilldown
// 无需"多 inbound 平均分"近似。反查走 ResolveUsernameByEmail 的 `__` split 规则,
// 跟 routed 子账户 `<username>__<id>__<label>` 命名兼容(都取首段当 username)。
func generateCredential(protocol string, user storage.User, method, inboundTag string) (map[string]interface{}, string, error) {
	cred := make(map[string]interface{})
	email := user.Username + "__" + inboundTag

	switch strings.ToLower(protocol) {
	case "vless", "vmess":
		id := uuid.New().String()
		cred["id"] = id
		cred["email"] = email
		cred["level"] = 0
	case "trojan":
		cred["password"] = uuid.New().String()
		cred["email"] = email
		cred["level"] = 0
	case "anytls":
		cred["password"] = uuid.New().String()
		cred["email"] = email
		cred["level"] = 0
	case "hysteria":
		// HY2 客户端凭据:auth(密码) + email(用于 per-user 流量统计,接入套餐限额)。
		cred["auth"] = uuid.New().String()
		cred["email"] = email
		cred["level"] = 0
	case "shadowsocks":
		keyLen := shadowsocksKeyLength(method)
		key := make([]byte, keyLen)
		rand.Read(key)
		cred["password"] = base64.StdEncoding.EncodeToString(key)
		cred["email"] = email
		cred["level"] = 0
	case "socks", "http":
		cred["user"] = user.Username
		cred["pass"] = uuid.New().String()[:16]
	default:
		return nil, "", fmt.Errorf("unsupported protocol: %s", protocol)
	}

	credJSON, _ := json.Marshal(cred)
	return cred, string(credJSON), nil
}

// filterCredentials 从凭据列表中移除匹配的凭据
func filterCredentials(items []interface{}, savedCred map[string]interface{}, protocol string) []interface{} {
	var result []interface{}
	for _, item := range items {
		m, ok := item.(map[string]interface{})
		if !ok {
			result = append(result, item)
			continue
		}
		if matchCredential(m, savedCred, protocol) {
			continue
		}
		result = append(result, item)
	}
	return result
}

func matchCredential(a, b map[string]interface{}, protocol string) bool {
	switch strings.ToLower(protocol) {
	case "vless", "vmess":
		return fmt.Sprint(a["id"]) == fmt.Sprint(b["id"])
	case "trojan", "anytls":
		return fmt.Sprint(a["password"]) == fmt.Sprint(b["password"])
	case "hysteria":
		return fmt.Sprint(a["auth"]) == fmt.Sprint(b["auth"])
	case "shadowsocks":
		return fmt.Sprint(a["password"]) == fmt.Sprint(b["password"])
	case "socks", "http":
		return fmt.Sprint(a["user"]) == fmt.Sprint(b["user"])
	}
	return false
}
