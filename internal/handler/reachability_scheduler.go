package handler

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"strconv"
	"strings"
	"time"

	"miaomiaowux/internal/license"
	"miaomiaowux/internal/storage"
)

// 节点可达性(被墙)探测:周期性从「探测源」(优先国内 agent)TCP 拨测每个节点的 server:port。
// 连续 K 次失败 → 判被墙 → 按 node_blocked 模板产公告(bot + miniapp);恢复 → node_recovered。
// 只在状态翻转时产公告(announced_blocked 去抖),不刷屏。探测源为空则从主控本机拨测(只能发现彻底挂,探不准被墙)。

const (
	reachabilityInterval = 5 * time.Minute
	reachabilityFailK    = 2 // 连续 K 次失败才判被墙(去抖瞬断)
)

// StartReachabilityScheduler 启动节点被墙探测后台循环。
func StartReachabilityScheduler(ctx context.Context, repo *storage.TrafficRepository, st *SpeedTesterWSHandler, ah *AnnouncementHandler) {
	go func() {
		select {
		case <-ctx.Done():
			return
		case <-time.After(30 * time.Second): // 启动后缓一会,避开启动风暴
		}
		runReachabilityCycle(ctx, repo, st, ah)
		ticker := time.NewTicker(reachabilityInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				runReachabilityCycle(ctx, repo, st, ah)
			}
		}
	}()
}

func runReachabilityCycle(ctx context.Context, repo *storage.TrafficRepository, st *SpeedTesterWSHandler, ah *AnnouncementHandler) {
	cfg := ah.mergedAnnounceConfig(ctx)
	blockedCfg := cfg.Types[AnnounceTypeNodeBlocked]
	recoveredCfg := cfg.Types[AnnounceTypeNodeRecovered]
	if !blockedCfg.Enabled { // node_blocked 关 = 整个被墙探测停用
		return
	}
	// 未配置任何探测源 → 不探。主控和 agent 都在机房,探不准「被墙」(还会把外部/落地节点
	// 误判被墙),必须有国内观测点(自建家用测速端,或 PRO 的官方探测)才启用,避免误报。
	if len(ah.probeTesterIDs(ctx)) == 0 && !ah.officialProbeEnabled(ctx) {
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
	reachable, probed := probeTargets(ctx, st, ah, targets)
	if !probed {
		return // 无可用探测源,本轮不判定(否则会把所有节点误报成被墙)
	}
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

// probeTargets 返回每个 target(host:port)是否可达。第二个返回值为 false 表示
// **本轮没有任何探测源可用**,结果不可信,调用方必须整轮跳过而不是当成"全部不可达"。
//
// 探测源是**家用测速端**(部署在国内家庭网络),不再是机房 agent —— 从机房拨测探不出
// 「被墙」,反而会把落地节点误判成被墙。判定沿用「任一源可达即可达」,最小化误判。
//
// 只有「在线 且 上报了 probe 能力」的测速端才会被派发:老版本收到未知消息会静默丢弃,
// 派给它只会白等一个超时。全部不可用时**不做主控本机兜底** —— 主控同样在机房,
// 拿它的结论去判被墙比不判更糟(会产生误报公告)。
//
// PRO 用户还可以叠加「官方探测」(许可证服务派发到官方部署的国内探测端),
// 与本地测速端的结果取并集,语义仍是「任一源可达即可达」。
func probeTargets(ctx context.Context, st *SpeedTesterWSHandler, ah *AnnouncementHandler, targets []string) (map[string]bool, bool) {
	res := make(map[string]bool, len(targets))
	for _, t := range targets {
		res[t] = false
	}

	localSrc, officialSrc := 0, 0
	if st != nil {
		if testerIDs := st.ProbeCapableTesterIDs(ctx, ah.probeTesterIDs(ctx)); len(testerIDs) > 0 {
			localSrc = len(testerIDs)
			for tgt, ok := range st.ProbeTargets(ctx, testerIDs, targets) {
				if ok {
					res[tgt] = true
				}
			}
		}
	}

	// 官方探测源不可用(无 PRO / 服务端未开放)时静默跳过 —— 它只是一个可选的额外视角,
	// 不该让整轮探测失败。真出错才记日志,便于排查配额用尽这类问题。
	if ah.officialProbeEnabled(ctx) && ah.license != nil {
		official, err := ah.license.ProbeReachability(ctx, targets)
		switch {
		case errors.Is(err, license.ErrOfficialProbeUnavailable):
			// 静默
		case err != nil:
			log.Printf("[reachability] 官方探测源本轮不可用: %v", err)
		default:
			officialSrc = 1
			for tgt, ok := range official {
				if ok {
					res[tgt] = true
				}
			}
		}
	}

	// 一个源都没跑成 → 这一轮**没有结论**,不能当成"全部不可达"。
	// 家用测速端离线是常态(断电、重启、宽带掉线),照全 false 记下去两轮就会把
	// 所有节点误报成被墙 —— 宁可这一轮不判,也不能给出错误结论。
	if localSrc == 0 && officialSrc == 0 {
		log.Printf("[reachability] 本轮无可用探测源(测速端离线或版本过旧,官方探测未启用/不可用),跳过 %d 个目标", len(targets))
		return nil, false
	}

	// 每轮一行汇总:没有这行就无法判断"探测到底在不在跑、哪个源在起作用"——
	// 被墙判定只在状态翻转时才打日志,一切正常时日志里什么都看不到。
	okN := 0
	for _, ok := range res {
		if ok {
			okN++
		}
	}
	log.Printf("[reachability] 本轮探测 %d 个目标,可达 %d(测速端 %d 个 + 官方探测 %v)",
		len(targets), okN, localSrc, officialSrc == 1)
	return res, true
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
