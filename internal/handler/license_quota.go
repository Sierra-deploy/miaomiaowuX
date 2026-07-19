package handler

import (
	"context"
	"log"
)

// license_quota.go:许可证「服务器配额」运行时执行。
//
// 付费许可证到期 / 降级后,可用服务器数回落(以 license server 返回为准)。超出配额的服务器
// 由主控下发 xray_authorized=0,agent 停掉 xray;拿到名额的下发 =1,agent 启 xray。
// 名额按 ListRemoteServers 的 sort_order ASC, id ASC —— 先注册在前,admin 可拖动调优先级。
//
// 容错:
//   - 无 license key(开源自建)→ QuotaEnforced()==false → 完全不介入(否则 defaultStatus
//     MaxServers=1 会把自建砍到只剩 1 台)。
//   - 主控临时拿不到 license(429/网络)→ EffectiveServerQuota 走 IsValid()(24h grace)→
//     配额保持不变 → 不会重算出「变少」误停。
//   - SendConfigUpdate 对离线 agent 自动 no-op → 天然「只推在线」;离线 agent 靠自身持久化的
//     上次授权值冻结,主控不下发就维持原状。
//   - agent 侧幂等:值没变不重复启停 xray,所以主控可安全重复推(含 5min 定期兜底)。

// authorizedServerIDs 计算每台 server 是否被授权运行 xray。
// QuotaEnforced()==false(无 license key)或读库失败 → 返回 nil,表示「不执行配额」,
// 调用方据此跳过下发(不误停也不误放),保持 agent 各自持久化的现状。
// 否则按 sort_order,id 取前 EffectiveServerQuota() 台为 true、其余 false。
func (h *RemoteWSHandler) authorizedServerIDs(ctx context.Context) map[int64]bool {
	if h.licenseManager == nil || h.repo == nil || !h.licenseManager.QuotaEnforced() {
		return nil
	}
	servers, err := h.repo.ListRemoteServers(ctx)
	if err != nil {
		log.Printf("[license quota] ListRemoteServers failed: %v", err)
		return nil
	}
	ids := make([]int64, len(servers))
	for i, s := range servers {
		ids[i] = s.ID
	}
	return serverAuthMap(ids, h.licenseManager.EffectiveServerQuota())
}

// serverAuthMap 把「按优先级排好序的 server id 列表」映射为授权表:前 quota 台为 true、其余 false。
// ids 必须已按 sort_order,id 排序(ListRemoteServers 保证)。
func serverAuthMap(ids []int64, quota int) map[int64]bool {
	result := make(map[int64]bool, len(ids))
	for i, id := range ids {
		result[id] = i < quota
	}
	return result
}

// ReconcileServerQuota 重算全量授权并把 xray_authorized 下发给每台在线 agent。
// 触发点:license 配额变化(onQuotaChange)、5min 定期兜底、server 增删。
func (h *RemoteWSHandler) ReconcileServerQuota(ctx context.Context) {
	auth := h.authorizedServerIDs(ctx)
	if auth == nil {
		return
	}
	for id, ok := range auth {
		_ = h.SendConfigUpdate(id, map[string]string{"xray_authorized": boolToFlag(ok)})
	}
}

// reconcileOne 只算并下发单台 server 的授权,用于 agent 上线时(新连的服务器授权不影响其它台)。
func (h *RemoteWSHandler) reconcileOne(serverID int64) {
	auth := h.authorizedServerIDs(context.Background())
	if auth == nil {
		return
	}
	_ = h.SendConfigUpdate(serverID, map[string]string{"xray_authorized": boolToFlag(auth[serverID])})
}

func boolToFlag(b bool) string {
	if b {
		return "1"
	}
	return "0"
}
