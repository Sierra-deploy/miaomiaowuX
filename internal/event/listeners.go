package event

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"

	"miaomiaowux/internal/storage"
)

// InboundToClashFunc 入站转 Clash 配置的函数类型
type InboundToClashFunc func(serverID int64, inbound map[string]any) (string, error)

// NodeSyncListener 节点同步监听器
type NodeSyncListener struct {
	repo           *storage.TrafficRepository
	inboundToClash InboundToClashFunc
}

// 创建节点同步监听器
func NewNodeSyncListener(repo *storage.TrafficRepository, converter InboundToClashFunc) *NodeSyncListener {
	return &NodeSyncListener{
		repo:           repo,
		inboundToClash: converter,
	}
}

// 处理入站事件
func (l *NodeSyncListener) Handle(event InboundEvent) {
	ctx := context.Background()

	switch event.Type {
	case EventInboundAdded:
		l.handleAdded(ctx, event)
	case EventInboundRemoved:
		l.handleRemoved(ctx, event)
	case EventInboundUpdated:
		l.handleUpdated(ctx, event)
	}
}

func (l *NodeSyncListener) handleAdded(ctx context.Context, event InboundEvent) {
	// 获取服务器信息
	server, err := l.repo.GetRemoteServer(ctx, event.ServerID)
	if err != nil {
		log.Printf("[NodeSync] Failed to get server %d: %v", event.ServerID, err)
		return
	}

	if event.Tag == "api" {
		return
	}
	// tunnel:默认跳过(不进节点表);但「转发已有节点」(ForwardNodeID>0)时,克隆源节点生成配套节点
	if event.Protocol == "tunnel" {
		if event.ForwardNodeID > 0 {
			l.createForwardTunnelNode(ctx, event, server)
		}
		return
	}

	// 生成节点名称：优先使用自定义名称，否则使用 tag 或 protocol:port
	var nodeName string
	if event.NodeName != "" {
		nodeName = event.NodeName
	} else if event.Tag != "" {
		nodeName = fmt.Sprintf("[%s] %s", server.Name, event.Tag)
	} else {
		nodeName = fmt.Sprintf("[%s] %s:%d", server.Name, event.Protocol, event.Port)
	}

	// 系统节点归属的 username(真实 admin,不是字面值 "admin")
	sysOwner := l.repo.GetSystemNodeOwner(ctx)

	// 转换为 Clash 配置
	clashConfig, err := l.inboundToClash(event.ServerID, event.Inbound)
	if err != nil {
		log.Printf("[NodeSync] Failed to convert inbound to clash: %v", err)
		return
	}

	// 先扫所有"外部节点"(从 mmw 迁移过来的、original_server='' 的节点),
	// 按 server 地址(可能是 IP / Domain / PullAddress 之一)+ port + protocol 匹配,
	// 命中即把外部节点"升级"为受管节点(填上 original_server + inbound_tag),
	// 而不是新建一条重复节点。
	if matched := l.tryClaimExternalNode(ctx, server, event, clashConfig); matched {
		return
	}

	// 检查是否已存在（按名称）
	exists, _ := l.repo.CheckNodeNameExists(ctx, nodeName, sysOwner, 0)
	if exists {
		log.Printf("[NodeSync] Node already exists: %s", nodeName)
		return
	}

	// 检查是否已存在（按 server + protocol + port）— admin 自己之前同步过的同 server 节点
	existingNodes, _ := l.repo.ListNodes(ctx, sysOwner)
	for _, n := range existingNodes {
		if n.OriginalServer == server.Name {
			var config map[string]any
			if err := json.Unmarshal([]byte(n.ClashConfig), &config); err == nil {
				if proto, ok := config["type"].(string); ok {
					if port, ok := config["port"].(float64); ok {
						if proto == event.Protocol && int(port) == event.Port {
							log.Printf("[NodeSync] Node with same server/protocol/port already exists: %s", n.NodeName)
							return
						}
					}
				}
			}
		}
	}

	// 用实际节点名称覆盖 Clash 配置中的 name 字段
	var clashMap map[string]any
	if json.Unmarshal([]byte(clashConfig), &clashMap) == nil {
		clashMap["name"] = nodeName
		if updated, err := json.Marshal(clashMap); err == nil {
			clashConfig = string(updated)
		}
	}

	// 创建节点
	node := storage.Node{
		Username:       sysOwner,
		NodeName:       nodeName,
		Protocol:       event.Protocol,
		ClashConfig:    clashConfig,
		ParsedConfig:   clashConfig,
		Enabled:        true,
		Tag:            fmt.Sprintf("远程:%s", server.Name),
		OriginalServer: server.Name,
		InboundTag:     event.Tag,
	}

	if _, err := l.repo.CreateNode(ctx, node); err != nil {
		log.Printf("[NodeSync] Failed to create node: %v", err)
	} else {
		log.Printf("[NodeSync] Created node: %s", nodeName)
	}
}

// createForwardTunnelNode 为「转发已有节点」生成的 tunnel 创建配套节点:
// 配置克隆源节点,但 name 拼接 " | Tunnel"、server 改为 tunnel 服务器 IP、port 改为 tunnel 监听端口、
// inbound_tag = tunnel tag、original_server = tunnel 服务器名(便于管理/删除时定位)。
func (l *NodeSyncListener) createForwardTunnelNode(ctx context.Context, event InboundEvent, server *storage.RemoteServer) {
	src, err := l.repo.GetNodeByID(ctx, event.ForwardNodeID)
	if err != nil {
		log.Printf("[NodeSync] forward-tunnel: 源节点 %d 不存在: %v", event.ForwardNodeID, err)
		return
	}
	if server.IPAddress == "" {
		log.Printf("[NodeSync] forward-tunnel: 服务器 %s 无 IP,跳过", server.Name)
		return
	}

	sysOwner := l.repo.GetSystemNodeOwner(ctx)
	nodeName := src.NodeName + " | Tunnel"
	if exists, _ := l.repo.CheckNodeNameExists(ctx, nodeName, sysOwner, 0); exists {
		log.Printf("[NodeSync] forward-tunnel: 节点已存在: %s", nodeName)
		return
	}

	// 克隆源节点 clash 配置,改 name/server/port(端口取 tunnel 监听端口)
	var clashMap map[string]any
	if err := json.Unmarshal([]byte(src.ClashConfig), &clashMap); err != nil {
		log.Printf("[NodeSync] forward-tunnel: 解析源节点 clash 配置失败: %v", err)
		return
	}
	clashMap["name"] = nodeName
	clashMap["server"] = server.IPAddress
	clashMap["port"] = event.Port
	clashJSON, err := json.Marshal(clashMap)
	if err != nil {
		log.Printf("[NodeSync] forward-tunnel: 序列化 clash 配置失败: %v", err)
		return
	}

	node := storage.Node{
		Username:       sysOwner,
		NodeName:       nodeName,
		Protocol:       src.Protocol,
		ClashConfig:    string(clashJSON),
		ParsedConfig:   string(clashJSON),
		Enabled:        true,
		Tag:            fmt.Sprintf("远程:%s", server.Name),
		OriginalServer: server.Name,
		InboundTag:     event.Tag,
	}
	if _, err := l.repo.CreateNode(ctx, node); err != nil {
		log.Printf("[NodeSync] forward-tunnel: 创建配套节点失败: %v", err)
	} else {
		log.Printf("[NodeSync] forward-tunnel: 已创建配套节点: %s (-> %s:%d)", nodeName, server.IPAddress, event.Port)
	}
}

// protocolEquivalent 判断 clash type 与 xray protocol 是否同一种协议。
// clash 用 `type: ss`,xray 用 `protocol: shadowsocks`,其他名字一致。
func protocolEquivalent(clashType, xrayProtocol string) bool {
	a := strings.ToLower(strings.TrimSpace(clashType))
	b := strings.ToLower(strings.TrimSpace(xrayProtocol))
	if a == b {
		return true
	}
	norm := func(s string) string {
		if s == "ss" {
			return "shadowsocks"
		}
		return s
	}
	return norm(a) == norm(b)
}

// tryClaimExternalNode 扫所有"外部节点"(original_server='' 且 inbound_tag=''),
// 看是否有节点的 clash_config 指向 (server 的 IP/Domain/PullAddress 之一) + 同 port + 同 protocol,
// 命中即把该节点 UPDATE 为受管节点(填上 original_server + inbound_tag),返回 true。
// 这避免迁移场景下:mmw 原有节点 + agent 扫描新创建节点 → 重复 2 条节点的问题。
func (l *NodeSyncListener) tryClaimExternalNode(ctx context.Context, server *storage.RemoteServer, event InboundEvent, agentClashConfig string) bool {
	// 候选地址:能让外部节点 server 字段命中该 remote_server 的所有可能形式
	candidates := map[string]bool{}
	for _, a := range []string{server.IPAddress, server.Domain, server.PullAddress} {
		if strings.TrimSpace(a) != "" {
			candidates[a] = true
		}
	}
	if len(candidates) == 0 {
		return false
	}

	allNodes, err := l.repo.ListAllNodes(ctx)
	if err != nil {
		log.Printf("[NodeSync] tryClaimExternalNode: list all nodes failed: %v", err)
		return false
	}
	for _, n := range allNodes {
		// 只看"外部节点":没关联 server / inbound,且不是 routed 子节点
		if strings.TrimSpace(n.OriginalServer) != "" || strings.TrimSpace(n.InboundTag) != "" {
			continue
		}
		if n.NodeType == "routed" {
			continue
		}
		var cfg map[string]any
		if err := json.Unmarshal([]byte(n.ClashConfig), &cfg); err != nil {
			continue
		}
		srv, _ := cfg["server"].(string)
		if !candidates[srv] {
			continue
		}
		var port int
		switch p := cfg["port"].(type) {
		case float64:
			port = int(p)
		case int:
			port = p
		}
		if port != event.Port {
			continue
		}
		proto, _ := cfg["type"].(string)
		if !protocolEquivalent(proto, event.Protocol) {
			continue
		}

		// 命中:更新该节点
		log.Printf("[NodeSync] Claim external node id=%d name=%q for %s/%s:%d", n.ID, n.NodeName, server.Name, event.Protocol, event.Port)
		// 用 agent 转出来的 clash_config 替换,但保留原节点名(用户可能改过中文名)
		var newCfg map[string]any
		if err := json.Unmarshal([]byte(agentClashConfig), &newCfg); err == nil {
			if name, _ := cfg["name"].(string); name != "" {
				newCfg["name"] = name
			}
			if updated, err := json.Marshal(newCfg); err == nil {
				agentClashConfig = string(updated)
			}
		}
		if err := l.repo.ClaimExternalNode(ctx, n.ID, server.Name, event.Tag, fmt.Sprintf("远程:%s", server.Name), agentClashConfig); err != nil {
			log.Printf("[NodeSync] ClaimExternalNode failed: %v", err)
			return false
		}
		return true
	}
	return false
}

func (l *NodeSyncListener) handleRemoved(ctx context.Context, event InboundEvent) {
	server, err := l.repo.GetRemoteServer(ctx, event.ServerID)
	if err != nil {
		log.Printf("[NodeSync] Failed to get server %d: %v", event.ServerID, err)
		return
	}

	// 删除对应节点
	if _, err := l.repo.DeleteNodesByInboundTag(ctx, server.Name, event.Tag); err != nil {
		log.Printf("[NodeSync] Failed to delete nodes: %v", err)
	} else {
		log.Printf("[NodeSync] Deleted nodes for inbound: %s/%s", server.Name, event.Tag)
	}
}

func (l *NodeSyncListener) handleUpdated(ctx context.Context, event InboundEvent) {
	server, err := l.repo.GetRemoteServer(ctx, event.ServerID)
	if err != nil {
		log.Printf("[NodeSync] Failed to get server %d: %v", event.ServerID, err)
		return
	}

	clashConfig, err := l.inboundToClash(event.ServerID, event.Inbound)
	if err != nil {
		log.Printf("[NodeSync] Failed to convert inbound to clash: %v", err)
		return
	}

	// 更新匹配的节点
	if err := l.repo.UpdateNodeByInboundTag(ctx, server.Name, event.Tag, clashConfig); err != nil {
		log.Printf("[NodeSync] Failed to update node: %v", err)
	} else {
		log.Printf("[NodeSync] Updated node for inbound: %s/%s", server.Name, event.Tag)
	}
}
