package handler

import (
	"context"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"miaomiaowux/internal/storage"
)

// 节点可达性(被墙)探测:周期性从「探测源」(优先国内 agent)TCP 拨测每个节点的 server:port。
// 连续 K 次失败 → 判被墙 → 按 node_blocked 模板产公告(bot + miniapp);恢复 → node_recovered。
// 只在状态翻转时产公告(announced_blocked 去抖),不刷屏。探测源为空则从主控本机拨测(只能发现彻底挂,探不准被墙)。

const (
	reachabilityInterval  = 5 * time.Minute
	reachabilityFailK     = 2 // 连续 K 次失败才判被墙(去抖瞬断)
	reachabilityTimeoutMS = 5000
)

// StartReachabilityScheduler 启动节点被墙探测后台循环。
func StartReachabilityScheduler(ctx context.Context, repo *storage.TrafficRepository, rm *RemoteManageHandler, ah *AnnouncementHandler) {
	go func() {
		select {
		case <-ctx.Done():
			return
		case <-time.After(30 * time.Second): // 启动后缓一会,避开启动风暴
		}
		runReachabilityCycle(ctx, repo, rm, ah)
		ticker := time.NewTicker(reachabilityInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				runReachabilityCycle(ctx, repo, rm, ah)
			}
		}
	}()
}

func runReachabilityCycle(ctx context.Context, repo *storage.TrafficRepository, rm *RemoteManageHandler, ah *AnnouncementHandler) {
	cfg := ah.mergedAnnounceConfig(ctx)
	blockedCfg := cfg.Types[AnnounceTypeNodeBlocked]
	recoveredCfg := cfg.Types[AnnounceTypeNodeRecovered]
	if !blockedCfg.Enabled { // node_blocked 关 = 整个被墙探测停用
		return
	}
	// 未配置探测源 → 不探。主控在机房,探不准「被墙」(还会把外部/落地节点误判被墙),
	// 必须配国内 agent 作探测源才启用被墙探测,避免误报。
	if len(ah.probeServerIDs(ctx)) == 0 {
		return
	}
	// 只探「主控管理的节点」——original_server 匹配某个远程服务器。外部导入节点(original_server 为空
	// 或不对应任何服务器)主控管不到、探不准,直接跳过,不产被墙公告。
	serverNames := map[string]bool{}
	if servers, serr := repo.ListRemoteServers(ctx); serr == nil {
		for _, s := range servers {
			serverNames[s.Name] = true
		}
	}
	nodes, err := repo.ListAllNodes(ctx)
	if err != nil {
		return
	}
	nodeTarget := map[int64]string{}
	nodeName := map[int64]string{}
	targetSet := map[string]bool{}
	for _, n := range nodes {
		if n.NodeType == "routed" || !n.Enabled {
			continue
		}
		if strings.TrimSpace(n.OriginalServer) == "" || !serverNames[n.OriginalServer] {
			continue // 外部/无归属节点,主控不探
		}
		tgt := parseNodeTarget(n.ClashConfig)
		if tgt == "" {
			continue
		}
		nodeTarget[n.ID] = tgt
		nodeName[n.ID] = n.NodeName
		targetSet[tgt] = true
	}
	if len(targetSet) == 0 {
		return
	}
	targets := make([]string, 0, len(targetSet))
	for t := range targetSet {
		targets = append(targets, t)
	}
	reachable := probeTargets(ctx, rm, ah, targets)
	now := time.Now().Format("2006-01-02 15:04")

	for nodeID, tgt := range nodeTarget {
		ok := reachable[tgt]
		prev, _, _ := repo.GetNodeReachability(ctx, nodeID)
		if ok {
			if prev.AnnouncedBlocked {
				// 恢复:清掉旧被墙横幅 + 发恢复公告
				_ = repo.DeleteAnnouncementsByNode(ctx, nodeID, AnnounceTypeNodeBlocked)
				if recoveredCfg.Enabled {
					publishNodeAnnouncement(ctx, repo, recoveredCfg, AnnounceTypeNodeRecovered, nodeID, nodeName[nodeID], now)
				}
				log.Printf("[reachability] 节点 #%d(%s)已恢复", nodeID, nodeName[nodeID])
			}
			_ = repo.SetNodeReachability(ctx, storage.NodeReachability{NodeID: nodeID, Reachable: true, ConsecutiveFail: 0, AnnouncedBlocked: false})
		} else {
			fails := prev.ConsecutiveFail + 1
			announced := prev.AnnouncedBlocked
			if fails >= reachabilityFailK && !announced {
				publishNodeAnnouncement(ctx, repo, blockedCfg, AnnounceTypeNodeBlocked, nodeID, nodeName[nodeID], now)
				announced = true
				log.Printf("[reachability] 节点 #%d(%s)疑似被墙,已发布公告", nodeID, nodeName[nodeID])
			}
			_ = repo.SetNodeReachability(ctx, storage.NodeReachability{NodeID: nodeID, Reachable: false, ConsecutiveFail: fails, AnnouncedBlocked: announced})
		}
	}
}

// publishNodeAnnouncement 按模板(填 {node}/{time})产一条节点相关公告。
func publishNodeAnnouncement(ctx context.Context, repo *storage.TrafficRepository, tcfg announceTypeConfig, annType string, nodeID int64, name, now string) {
	body := strings.ReplaceAll(tcfg.Template, "{node}", name)
	body = strings.ReplaceAll(body, "{time}", now)
	var expires *time.Time
	if annType == AnnounceTypeNodeRecovered {
		t := time.Now().Add(6 * time.Hour) // 恢复公告 6 小时后自动消失
		expires = &t
	}
	_, _ = repo.CreateAnnouncement(ctx, storage.Announcement{
		Type: annType, Title: tcfg.Title, Body: body, NodeID: nodeID,
		ViaBot: tcfg.ViaBot, ViaMiniapp: tcfg.ViaMiniapp, ExpiresAt: expires,
	})
}

// probeTargets 返回每个 target(host:port)是否可达。探测源为空则主控本机拨测;
// 否则从每个探测源 agent 拨测,任一可达即视为可达(最小化误判被墙)。
func probeTargets(ctx context.Context, rm *RemoteManageHandler, ah *AnnouncementHandler, targets []string) map[string]bool {
	res := make(map[string]bool, len(targets))
	probeIDs := ah.probeServerIDs(ctx)
	if len(probeIDs) == 0 {
		for _, t := range targets {
			res[t] = masterDial(t)
		}
		return res
	}
	for _, t := range targets {
		res[t] = false
	}
	body, _ := json.Marshal(map[string]any{"domains": targets, "timeout_ms": reachabilityTimeoutMS})
	for _, sid := range probeIDs {
		cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		out, err := rm.ForwardToServer(cctx, sid, http.MethodPost, "/api/child/domains/latency", body)
		cancel()
		if err != nil {
			continue
		}
		var resp struct {
			Results []struct {
				Domain  string `json:"domain"`
				Target  string `json:"target"`
				Success bool   `json:"success"`
			} `json:"results"`
		}
		if json.Unmarshal(out, &resp) != nil {
			continue
		}
		okSet := map[string]bool{}
		for _, r := range resp.Results {
			if r.Success {
				okSet[r.Target] = true
				okSet[r.Domain] = true
			}
		}
		for _, t := range targets {
			if res[t] {
				continue
			}
			host := t
			if h, _, err := net.SplitHostPort(t); err == nil {
				host = h
			}
			if okSet[t] || okSet[host] {
				res[t] = true
			}
		}
	}
	return res
}

func masterDial(target string) bool {
	conn, err := net.DialTimeout("tcp", target, time.Duration(reachabilityTimeoutMS)*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// parseNodeTarget 从节点 clash_config 取 server:port(有效的连接目标;中转节点取中转地址)。
func parseNodeTarget(clashJSON string) string {
	if strings.TrimSpace(clashJSON) == "" {
		return ""
	}
	var m map[string]any
	if json.Unmarshal([]byte(clashJSON), &m) != nil {
		return ""
	}
	server, _ := m["server"].(string)
	if strings.TrimSpace(server) == "" {
		return ""
	}
	port := toInt(m["port"])
	if port <= 0 || port > 65535 {
		return ""
	}
	return net.JoinHostPort(server, strconv.Itoa(port))
}
