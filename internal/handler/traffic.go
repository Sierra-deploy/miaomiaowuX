package handler

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"miaomiaowux/internal/storage"
	"miaomiaowux/internal/traffic"
	"miaomiaowux/internal/version"
)

// TrafficHandler 处理与流量相关的 API 请求
type TrafficHandler struct {
	repo      *storage.TrafficRepository
	collector *traffic.Collector
}

// 创建一个新的流量处理程序
func NewTrafficHandler(repo *storage.TrafficRepository, collector *traffic.Collector) *TrafficHandler {
	return &TrafficHandler{
		repo:      repo,
		collector: collector,
	}
}

// SerHTTP 路由流量 API 请求
func (h *TrafficHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/admin/traffic")
	path = strings.TrimPrefix(path, "/")

	switch {
	case path == "" || path == "servers":
		h.handleServers(w, r)
	case strings.HasPrefix(path, "servers/"):
		h.handleServerDetail(w, r, strings.TrimPrefix(path, "servers/"))
	case path == "users":
		h.handleUsers(w, r)
	case strings.HasPrefix(path, "users/"):
		h.handleUserDetail(w, r, strings.TrimPrefix(path, "users/"))
	case path == "snapshots":
		h.handleSnapshots(w, r)
	case path == "node-snapshots":
		h.handleNodeSnapshots(w, r)
	case path == "user-snapshots":
		h.handleUserSnapshots(w, r)
	case path == "user-nodes":
		h.handleUserNodes(w, r)
	case path == "node-users":
		h.handleNodeUsers(w, r)
	default:
		http.NotFound(w, r)
	}
}

// handleUserNodes 返回某用户在每个节点上的流量(细分到 routed 子账号 / 普通 inbound),
// 数据来源: user_email_traffic + user_subaccounts 反查 routed_node_id + user_inbound_configs 反查
// 该用户在某 server 上的 inbound 节点。
//
// GET /api/admin/traffic/user-nodes?username=share
//
// 响应: { items: [ { node_id, node_name, server_name, uplink, downlink, last_uplink, last_downlink } ] }
func (h *TrafficHandler) handleUserNodes(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	username := strings.TrimSpace(r.URL.Query().Get("username"))
	if username == "" {
		http.Error(w, "username is required", http.StatusBadRequest)
		return
	}

	ctx := r.Context()

	// 1. routed 子账号 email → routed_node_id(只算 is_active)
	subaccounts, err := h.repo.ListUserSubaccounts(ctx, username)
	if err != nil {
		log.Printf("[Traffic API] user-nodes: list subaccounts failed: %v", err)
		h.writeJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "error": "list subaccounts failed"})
		return
	}
	emailToRoutedNodeID := make(map[string]int64, len(subaccounts))
	for _, sa := range subaccounts {
		if sa.IsActive {
			emailToRoutedNodeID[sa.Email] = sa.RoutedNodeID
		}
	}

	// 2. 用户在每台 server 上的 inbound 配置(用于把"email=username"那行映射到对应 inbound 节点)
	inbConfigs, err := h.repo.GetUserInboundConfigs(ctx, username)
	if err != nil {
		log.Printf("[Traffic API] user-nodes: list inbound configs failed: %v", err)
		inbConfigs = nil
	}
	// (server_id) → []inbound_tag — 通常一 server 一 inbound,多 inbound 也存
	serverToInboundTags := make(map[int64][]string)
	for _, c := range inbConfigs {
		serverToInboundTags[c.ServerID] = append(serverToInboundTags[c.ServerID], c.InboundTag)
	}

	// 3. 节点表反查:routed_node_id → Node;(server_name, inbound_tag) → Node
	allNodes, err := h.repo.ListAllNodes(ctx)
	if err != nil {
		log.Printf("[Traffic API] user-nodes: list nodes failed: %v", err)
		h.writeJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "error": "list nodes failed"})
		return
	}
	routedNodeByID := make(map[int64]storage.Node)
	inboundNodeByKey := make(map[string]storage.Node) // "serverName::tag"
	for _, n := range allNodes {
		if n.NodeType == "routed" {
			routedNodeByID[n.ID] = n
		} else if n.InboundTag != "" {
			inboundNodeByKey[n.OriginalServer+"::"+n.InboundTag] = n
		}
	}

	// 4. server_id → server_name 映射(给 inbound 反查 + 输出标注)
	servers, err := h.repo.ListRemoteServers(ctx)
	if err != nil {
		log.Printf("[Traffic API] user-nodes: list servers failed: %v", err)
	}
	serverNameByID := make(map[int64]string, len(servers))
	for _, s := range servers {
		serverNameByID[s.ID] = s.Name
	}

	// 5. 拉所有 user_email_traffic,过滤命中本 username 的行
	allEmailTraffic, err := h.repo.ListUserEmailTraffic(ctx)
	if err != nil {
		log.Printf("[Traffic API] user-nodes: list user_email_traffic failed: %v", err)
		h.writeJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "error": "list email traffic failed"})
		return
	}

	type item struct {
		NodeID       int64  `json:"node_id"`
		NodeName     string `json:"node_name"`
		ServerName   string `json:"server_name"`
		Uplink       int64  `json:"uplink"`
		Downlink     int64  `json:"downlink"`
		LastUplink   int64  `json:"last_uplink"`
		LastDownlink int64  `json:"last_downlink"`
	}
	byNode := make(map[int64]*item)

	addToNode := func(n storage.Node, srvName string, uet storage.UserEmailTraffic) {
		if existing, ok := byNode[n.ID]; ok {
			existing.Uplink += uet.Uplink
			existing.Downlink += uet.Downlink
			existing.LastUplink += uet.LastUplink
			existing.LastDownlink += uet.LastDownlink
			return
		}
		byNode[n.ID] = &item{
			NodeID:       n.ID,
			NodeName:     n.NodeName,
			ServerName:   srvName,
			Uplink:       uet.Uplink,
			Downlink:     uet.Downlink,
			LastUplink:   uet.LastUplink,
			LastDownlink: uet.LastDownlink,
		}
	}

	for _, uet := range allEmailTraffic {
		// 优先 routed 路径:email 命中本 user 的子账号
		if rid, ok := emailToRoutedNodeID[uet.Email]; ok {
			if n, ok := routedNodeByID[rid]; ok {
				srvName := serverNameByID[uet.ServerID]
				if srvName == "" {
					srvName = n.OriginalServer
				}
				addToNode(n, srvName, uet)
			}
			continue
		}
		// 普通 inbound 路径:email == username 且本 user 在该 server 有 inbound 配置
		if uet.Email != username {
			// 是别的 user 的 email,过滤掉
			if h.repo.ResolveUsernameByEmail(ctx, uet.Email) != username {
				continue
			}
		}
		tags := serverToInboundTags[uet.ServerID]
		if len(tags) == 0 {
			continue
		}
		srvName := serverNameByID[uet.ServerID]
		// 一般一 server 一个 inbound;若多 inbound,流量平均分(Xray stats 上 user 维度本身就是 across inbounds 的合计,没法精确拆)
		share := uet
		if len(tags) > 1 {
			share.Uplink = uet.Uplink / int64(len(tags))
			share.Downlink = uet.Downlink / int64(len(tags))
			share.LastUplink = uet.LastUplink / int64(len(tags))
			share.LastDownlink = uet.LastDownlink / int64(len(tags))
		}
		for _, tag := range tags {
			if n, ok := inboundNodeByKey[srvName+"::"+tag]; ok {
				addToNode(n, srvName, share)
			}
		}
	}

	out := make([]item, 0, len(byNode))
	for _, it := range byNode {
		out = append(out, *it)
	}
	// 按总流量降序
	sort.Slice(out, func(i, j int) bool {
		return (out[i].Uplink + out[i].Downlink) > (out[j].Uplink + out[j].Downlink)
	})

	h.writeJSON(w, http.StatusOK, map[string]any{"success": true, "items": out})
}

// handleNodeUsers 返回某节点上各用户的流量(节点视图 drilldown 反向用)。
// 走 user_email_traffic + user_subaccounts/user_inbound_configs 反查,与 handleUserNodes 对称。
//
// GET /api/admin/traffic/node-users?node_id=42
//
// 响应: { items: [ { username, uplink, downlink, last_uplink, last_downlink } ] }
func (h *TrafficHandler) handleNodeUsers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	nodeIDStr := strings.TrimSpace(r.URL.Query().Get("node_id"))
	nodeID, err := strconv.ParseInt(nodeIDStr, 10, 64)
	if err != nil || nodeID <= 0 {
		http.Error(w, "node_id is required", http.StatusBadRequest)
		return
	}

	ctx := r.Context()

	node, err := h.repo.GetNodeByID(ctx, nodeID)
	if err != nil {
		h.writeJSON(w, http.StatusNotFound, map[string]any{"success": false, "error": "node not found"})
		return
	}
	isRouted := node.NodeType == "routed"

	// server_name → server_id 反查(普通 inbound 路径要的)
	servers, err := h.repo.ListRemoteServers(ctx)
	if err != nil {
		log.Printf("[Traffic API] node-users: list servers failed: %v", err)
	}
	serverIDByName := make(map[string]int64, len(servers))
	for _, s := range servers {
		serverIDByName[s.Name] = s.ID
	}
	var nodeServerID int64
	if !isRouted {
		nodeServerID = serverIDByName[node.OriginalServer]
	}

	// routed 节点:本节点的所有 active 子账号 email → username
	routedEmailToUsername := make(map[string]string)
	if isRouted {
		subs, err := h.repo.ListSubaccountsByRoutedNode(ctx, nodeID)
		if err != nil {
			log.Printf("[Traffic API] node-users: list subaccounts by routed node failed: %v", err)
		}
		for _, sa := range subs {
			if sa.IsActive {
				routedEmailToUsername[sa.Email] = sa.Username
			}
		}
	}

	// 普通 inbound 节点:本 (server_id, inbound_tag) 上有 user_inbound_configs 的所有 username,作为白名单。
	// 同时拿本 server 的所有 active 子账号 email 作为排除集 — 子账号 email 走 routed 节点,
	// 即使流量落在本 server 的统计里也不该归到本 inbound。
	inboundUsernames := make(map[string]bool)
	serverSubaccountEmails := make(map[string]bool)
	if !isRouted && nodeServerID > 0 && node.InboundTag != "" {
		cfgs, err := h.repo.ListAllUserInboundConfigs(ctx)
		if err != nil {
			log.Printf("[Traffic API] node-users: list user inbound configs failed: %v", err)
		}
		for _, c := range cfgs {
			if c.ServerID == nodeServerID && c.InboundTag == node.InboundTag {
				inboundUsernames[c.Username] = true
			}
		}
		if node.OriginalServer != "" {
			subs, err := h.repo.ListActiveSubaccountsByServerName(ctx, node.OriginalServer)
			if err != nil {
				log.Printf("[Traffic API] node-users: list server subaccounts failed: %v", err)
			}
			for _, sa := range subs {
				serverSubaccountEmails[sa.Email] = true
			}
		}
	}

	allEmailTraffic, err := h.repo.ListUserEmailTraffic(ctx)
	if err != nil {
		log.Printf("[Traffic API] node-users: list user_email_traffic failed: %v", err)
		h.writeJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "error": "list email traffic failed"})
		return
	}

	type item struct {
		Username     string `json:"username"`
		Uplink       int64  `json:"uplink"`
		Downlink     int64  `json:"downlink"`
		LastUplink   int64  `json:"last_uplink"`
		LastDownlink int64  `json:"last_downlink"`
	}
	byUser := make(map[string]*item)
	addUser := func(username string, uet storage.UserEmailTraffic) {
		if existing, ok := byUser[username]; ok {
			existing.Uplink += uet.Uplink
			existing.Downlink += uet.Downlink
			existing.LastUplink += uet.LastUplink
			existing.LastDownlink += uet.LastDownlink
			return
		}
		byUser[username] = &item{
			Username:     username,
			Uplink:       uet.Uplink,
			Downlink:     uet.Downlink,
			LastUplink:   uet.LastUplink,
			LastDownlink: uet.LastDownlink,
		}
	}

	for _, uet := range allEmailTraffic {
		if isRouted {
			if username, ok := routedEmailToUsername[uet.Email]; ok {
				addUser(username, uet)
			}
			continue
		}
		// 普通 inbound:必须是本 server
		if uet.ServerID != nodeServerID {
			continue
		}
		// 排除本 server 上的子账号 email(归 routed 节点)
		if serverSubaccountEmails[uet.Email] {
			continue
		}
		username := h.repo.ResolveUsernameByEmail(ctx, uet.Email)
		if username == "" {
			continue
		}
		// 必须确实在本 inbound 有配置才算 — 这同时滤掉了 ResolveUsernameByEmail
		// fallback 把 outbound tag 当 username 返回的脏数据。
		if !inboundUsernames[username] {
			continue
		}
		addUser(username, uet)
	}

	out := make([]item, 0, len(byUser))
	for _, it := range byUser {
		out = append(out, *it)
	}
	sort.Slice(out, func(i, j int) bool {
		return (out[i].Uplink + out[i].Downlink) > (out[j].Uplink + out[j].Downlink)
	})

	h.writeJSON(w, http.StatusOK, map[string]any{"success": true, "items": out})
}

// ServerTrafficResponse 表示服务器的流量数据
type ServerTrafficResponse struct {
	ServerID   int64                 `json:"server_id"`
	ServerName string                `json:"server_name"`
	Inbounds   []storage.NodeTraffic `json:"inbounds"`
	Outbounds  []storage.NodeTraffic `json:"outbounds"`
	Users      []storage.UserTraffic `json:"users"`
}

// ServersTrafficResponse 表示所有服务器的流量数据
type ServersTrafficResponse struct {
	Success bool                    `json:"success"`
	Servers []ServerTrafficResponse `json:"servers"`
}

func (h *TrafficHandler) handleServers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	ctx := r.Context()

	servers, err := h.repo.ListRemoteServers(ctx)
	if err != nil {
		log.Printf("[Traffic API] Failed to list servers: %v", err)
		h.writeJSON(w, http.StatusInternalServerError, map[string]interface{}{
			"success": false,
			"error":   "Failed to list servers",
		})
		return
	}

	// 获取所有节点流量
	allNodeTraffic, err := h.repo.GetAllNodeTraffic(ctx)
	if err != nil {
		log.Printf("[Traffic API] Failed to get node traffic: %v", err)
		h.writeJSON(w, http.StatusInternalServerError, map[string]interface{}{
			"success": false,
			"error":   "Failed to get node traffic",
		})
		return
	}

	allUserTraffic, err := h.repo.GetAllUserTraffic(ctx)
	if err != nil {
		log.Printf("[Traffic API] Failed to get user traffic: %v", err)
		h.writeJSON(w, http.StatusInternalServerError, map[string]interface{}{
			"success": false,
			"error":   "Failed to get user traffic",
		})
		return
	}

	// 按服务器分组
	nodeByServer := make(map[int64][]storage.NodeTraffic)
	userByServer := make(map[int64][]storage.UserTraffic)

	for _, t := range allNodeTraffic {
		nodeByServer[t.ServerID] = append(nodeByServer[t.ServerID], t)
	}
	for _, t := range allUserTraffic {
		userByServer[t.ServerID] = append(userByServer[t.ServerID], t)
	}

	// 建立服务器 ID → 名称 / 流量统计规则映射
	serverNameMap := make(map[int64]string)
	serverStatsModeMap := make(map[int64]string)
	for _, server := range servers {
		serverNameMap[server.ID] = server.Name
		mode := server.TrafficStatsMode
		if mode != "upload" && mode != "download" {
			mode = "both"
		}
		serverStatsModeMap[server.ID] = mode
	}

	// 收集所有出现过的 server_id
	allServerIDs := make(map[int64]bool)
	for sid := range nodeByServer {
		allServerIDs[sid] = true
	}
	for sid := range userByServer {
		allServerIDs[sid] = true
	}

	// 建立响应
	var result []ServerTrafficResponse
	for sid := range allServerIDs {
		name, ok := serverNameMap[sid]
		if !ok {
			name = fmt.Sprintf("未知服务器-%d", sid)
		}
		nodeTraffic := nodeByServer[sid]
		mode := serverStatsModeMap[sid]
		if mode == "" {
			mode = "both"
		}
		var inbounds, outbounds []storage.NodeTraffic
		for _, t := range nodeTraffic {
			// 应用服务器层 traffic_stats_mode 到节点 inbound/outbound 流量:
			// 仅上行/仅下行模式下把对侧字段置 0,前端 `(uplink+downlink)` 计算自动遵循规则。
			// 用户流量(下方 userByServer)保持原样,按套餐 traffic_mode 走。
			switch mode {
			case "upload":
				t.Downlink = 0
				t.LastDownlink = 0
				t.TotalDownlink = 0
			case "download":
				t.Uplink = 0
				t.LastUplink = 0
				t.TotalUplink = 0
			}
			if t.Type == "inbound" {
				inbounds = append(inbounds, t)
			} else {
				outbounds = append(outbounds, t)
			}
		}

		result = append(result, ServerTrafficResponse{
			ServerID:   sid,
			ServerName: name,
			Inbounds:   inbounds,
			Outbounds:  outbounds,
			Users:      userByServer[sid],
		})
	}

	h.writeJSON(w, http.StatusOK, ServersTrafficResponse{
		Success: true,
		Servers: result,
	})
}

func (h *TrafficHandler) handleServerDetail(w http.ResponseWriter, r *http.Request, serverIDStr string) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	serverID, err := strconv.ParseInt(serverIDStr, 10, 64)
	if err != nil {
		h.writeJSON(w, http.StatusBadRequest, map[string]interface{}{
			"success": false,
			"error":   "Invalid server ID",
		})
		return
	}

	ctx := r.Context()

	// 获取服务器信息
	server, err := h.repo.GetRemoteServer(ctx, serverID)
	if err != nil {
		h.writeJSON(w, http.StatusNotFound, map[string]interface{}{
			"success": false,
			"error":   "Server not found",
		})
		return
	}

	// 获取节点流量
	nodeTraffic, err := h.repo.GetNodeTrafficByServer(ctx, serverID)
	if err != nil {
		log.Printf("[Traffic API] Failed to get node traffic for server %d: %v", serverID, err)
		nodeTraffic = []storage.NodeTraffic{}
	}

	var inbounds, outbounds []storage.NodeTraffic
	for _, t := range nodeTraffic {
		if t.Type == "inbound" {
			inbounds = append(inbounds, t)
		} else {
			outbounds = append(outbounds, t)
		}
	}

	// 获取用户流量
	userTraffic, err := h.repo.GetUserTrafficByServer(ctx, serverID)
	if err != nil {
		log.Printf("[Traffic API] Failed to get user traffic for server %d: %v", serverID, err)
		userTraffic = []storage.UserTraffic{}
	}

	h.writeJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"server": ServerTrafficResponse{
			ServerID:   server.ID,
			ServerName: server.Name,
			Inbounds:   inbounds,
			Outbounds:  outbounds,
			Users:      userTraffic,
		},
	})
}

// UserTrafficSummary 表示用户在所有服务器上的聚合流量
type UserTrafficSummary struct {
	Username      string                `json:"username"`
	TotalUplink   int64                 `json:"total_uplink"`
	TotalDownlink int64                 `json:"total_downlink"`
	CycleUplink   int64                 `json:"cycle_uplink"`
	CycleDownlink int64                 `json:"cycle_downlink"`
	Servers       []storage.UserTraffic `json:"servers"`
}

func (h *TrafficHandler) handleUsers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	ctx := r.Context()

	allUserTraffic, err := h.repo.GetAllUserTraffic(ctx)
	if err != nil {
		log.Printf("[Traffic API] Failed to get user traffic: %v", err)
		h.writeJSON(w, http.StatusInternalServerError, map[string]interface{}{
			"success": false,
			"error":   "Failed to get user traffic",
		})
		return
	}

	// 按用户名聚合
	userMap := make(map[string]*UserTrafficSummary)
	for _, t := range allUserTraffic {
		if _, ok := userMap[t.Username]; !ok {
			userMap[t.Username] = &UserTrafficSummary{
				Username: t.Username,
			}
		}
		summary := userMap[t.Username]
		summary.TotalUplink += t.TotalUplink + t.Uplink
		summary.TotalDownlink += t.TotalDownlink + t.Downlink
		summary.CycleUplink += t.Uplink
		summary.CycleDownlink += t.Downlink
		summary.Servers = append(summary.Servers, t)
	}

	// 转换为切片
	var result []UserTrafficSummary
	for _, summary := range userMap {
		result = append(result, *summary)
	}

	h.writeJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"users":   result,
	})
}

func (h *TrafficHandler) handleUserDetail(w http.ResponseWriter, r *http.Request, username string) {
	if r.Method == http.MethodDelete {
		// 重置用户流量周期
		h.handleResetUserCycle(w, r, username)
		return
	}

	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	ctx := r.Context()

	// 获取该用户的所有用户流量
	allUserTraffic, err := h.repo.GetAllUserTraffic(ctx)
	if err != nil {
		log.Printf("[Traffic API] Failed to get user traffic: %v", err)
		h.writeJSON(w, http.StatusInternalServerError, map[string]interface{}{
			"success": false,
			"error":   "Failed to get user traffic",
		})
		return
	}

	// 按用户名过滤
	var userTraffic []storage.UserTraffic
	for _, t := range allUserTraffic {
		if t.Username == username {
			userTraffic = append(userTraffic, t)
		}
	}

	if len(userTraffic) == 0 {
		h.writeJSON(w, http.StatusNotFound, map[string]interface{}{
			"success": false,
			"error":   "User traffic not found",
		})
		return
	}

	// 计算总结
	var totalUplink, totalDownlink, cycleUplink, cycleDownlink int64
	for _, t := range userTraffic {
		totalUplink += t.TotalUplink + t.Uplink
		totalDownlink += t.TotalDownlink + t.Downlink
		cycleUplink += t.Uplink
		cycleDownlink += t.Downlink
	}

	h.writeJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"user": UserTrafficSummary{
			Username:      username,
			TotalUplink:   totalUplink,
			TotalDownlink: totalDownlink,
			CycleUplink:   cycleUplink,
			CycleDownlink: cycleDownlink,
			Servers:       userTraffic,
		},
	})
}

func (h *TrafficHandler) handleResetUserCycle(w http.ResponseWriter, r *http.Request, username string) {
	ctx := r.Context()

	if err := h.repo.ResetUserTrafficCycle(ctx, username); err != nil {
		log.Printf("[Traffic API] Failed to reset user cycle for %s: %v", username, err)
		h.writeJSON(w, http.StatusInternalServerError, map[string]interface{}{
			"success": false,
			"error":   "Failed to reset user cycle",
		})
		return
	}

	h.writeJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"message": "User cycle reset successfully",
	})
}

func (h *TrafficHandler) handleSnapshots(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	ctx := r.Context()

	// 解析查询参数
	serverIDStr := r.URL.Query().Get("server_id")
	daysStr := r.URL.Query().Get("days")

	var serverID int64
	if serverIDStr != "" {
		var err error
		serverID, err = strconv.ParseInt(serverIDStr, 10, 64)
		if err != nil {
			serverID = 0
		}
	}

	days := 30
	if daysStr != "" {
		if d, err := strconv.Atoi(daysStr); err == nil && d > 0 {
			days = d
		}
	}

	snapshots, err := h.repo.GetTrafficSnapshots(ctx, serverID, days)
	if err != nil {
		log.Printf("[Traffic API] Failed to get snapshots: %v", err)
		h.writeJSON(w, http.StatusInternalServerError, map[string]interface{}{
			"success": false,
			"error":   "Failed to get snapshots",
		})
		return
	}

	h.writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":   true,
		"snapshots": snapshots,
	})
}

func (h *TrafficHandler) writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

// RemoteTrafficHandler 处理来自远程服务器的流量报告
type RemoteTrafficHandler struct {
	repo      *storage.TrafficRepository
	collector *traffic.Collector
	crypto    *CryptoConfig
}

// 创建一个新的远程流量处理程序
func NewRemoteTrafficHandler(repo *storage.TrafficRepository, collector *traffic.Collector, crypto *CryptoConfig) *RemoteTrafficHandler {
	return &RemoteTrafficHandler{
		repo:      repo,
		collector: collector,
		crypto:    crypto,
	}
}

// RemoteTrafficRequest 表示来自远程服务器的流量报告
type RemoteTrafficRequest struct {
	Stats *traffic.XrayStats `json:"stats,omitempty"`
}

// 处理来自远程服务器的 POST 请求
func (h *RemoteTrafficHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if r.Header.Get("User-Agent") != version.AgentUserAgent {
		h.writeJSON(w, http.StatusForbidden, map[string]interface{}{
			"success": false,
			"error":   "Forbidden",
		})
		return
	}

	ctx := r.Context()

	// 加密中间件处理
	crypto, err := handleHTTPCrypto(r, w, h.crypto)
	if crypto == nil {
		return
	}
	_ = err

	token := crypto.Token
	if token == "" {
		h.writeJSON(w, http.StatusUnauthorized, map[string]interface{}{
			"success": false,
			"error":   "Missing authentication token",
		})
		return
	}

	// 验证令牌并获取远程服务器
	remoteServer, err := h.repo.GetRemoteServerByToken(ctx, token)
	if err != nil {
		h.writeJSON(w, http.StatusUnauthorized, map[string]interface{}{
			"success": false,
			"error":   "Invalid token",
		})
		return
	}

	// 解析请求体
	var req RemoteTrafficRequest
	if err := json.Unmarshal(crypto.Body, &req); err != nil {
		h.writeJSON(w, http.StatusBadRequest, map[string]interface{}{
			"success": false,
			"error":   "Invalid request body",
		})
		return
	}

	if req.Stats == nil {
		h.writeJSON(w, http.StatusOK, map[string]interface{}{
			"success": true,
			"message": "No stats to process",
		})
		return
	}

	// 为该远程查找或创建相应的 XrayServer
	// 现在，我们使用远程服务器 ID 作为伪服务器 ID
	// 在实际实现中，您可能希望将远程服务器与 xray_servers 相关联
	serverID := remoteServer.ID

	// 更新流量报告上的 last_heartbeat — 这取代了单独心跳的需要;
	// 同时检测离线→在线翻转,补发 TG 上线通知(WS 模式 auth 已经发过,
	// HTTP push 模式以前只在这里悄悄翻状态,所以下线通知有、上线通知没有)。
	prevStatus, serverName, serverIP, uErr := h.repo.UpdateRemoteServerLastActivity(ctx, serverID)
	if uErr != nil {
		log.Printf("[Remote Traffic] Failed to update last activity for %s: %v", remoteServer.Name, uErr)
	} else if prevStatus == storage.RemoteServerStatusOffline {
		SendServerOnlineNotification(ctx, serverName, serverIP)
	}

	// 处理指标
	if err := h.collector.ProcessRemoteMetrics(ctx, serverID, req.Stats); err != nil {
		log.Printf("[Remote Traffic] Failed to process metrics from %s: %v", remoteServer.Name, err)
		h.writeJSON(w, http.StatusInternalServerError, map[string]interface{}{
			"success": false,
			"error":   "Failed to process metrics",
		})
		return
	}

	// 在 traffic 上报响应里捎带最新的 config 更新(HTTP-mode agent 没有持久连接,
	// 走 traffic POST 的 response 把变化推回去,agent 收到后调 handleConfigUpdate 应用)。
	configUpdates := map[string]string{}
	if val, _ := h.repo.GetSystemSetting(ctx, "dashboard_refresh_interval_ms"); val != "" {
		configUpdates["traffic_report_interval_ms"] = val
	}
	respData, _ := json.Marshal(map[string]interface{}{
		"success":        true,
		"message":        "Traffic data received",
		"config_updates": configUpdates,
	})
	writeHTTPCryptoResponse(w, crypto.Session, respData)
}

func (h *RemoteTrafficHandler) writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func (h *TrafficHandler) handleNodeSnapshots(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	date := r.URL.Query().Get("date")
	if date == "" {
		h.writeJSON(w, http.StatusBadRequest, map[string]interface{}{"success": false, "error": "date is required"})
		return
	}
	snapshots, err := h.repo.GetNodeTrafficSnapshots(r.Context(), date)
	if err != nil {
		h.writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"success": false, "error": err.Error()})
		return
	}
	h.writeJSON(w, http.StatusOK, map[string]interface{}{"success": true, "snapshots": snapshots})
}

func (h *TrafficHandler) handleUserSnapshots(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	date := r.URL.Query().Get("date")
	if date == "" {
		h.writeJSON(w, http.StatusBadRequest, map[string]interface{}{"success": false, "error": "date is required"})
		return
	}
	snapshots, err := h.repo.GetUserTrafficSnapshots(r.Context(), date)
	if err != nil {
		h.writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"success": false, "error": err.Error()})
		return
	}
	h.writeJSON(w, http.StatusOK, map[string]interface{}{"success": true, "snapshots": snapshots})
}
