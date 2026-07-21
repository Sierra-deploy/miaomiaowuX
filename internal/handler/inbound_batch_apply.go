package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"

	"miaomiaowux/internal/storage"
)

// collectInboundClientAddItem 从 master InboundCache 拿 protocol/settings,算好 cred,
// 返回 batch item。**不调 agent / 不写 DB**。
//
// 返回 (nil, false, nil):缓存命中但用户在该 (server, inbound) 已有记录 → 跳过,续费场景
// 返回 (nil, false, err):缓存 miss / 入站不存在等 → 调用方应 fallback 到逐个 addUserToInbound
// 返回 (item, true, nil):成功,加入 batch 列表
func collectInboundClientAddItem(ctx context.Context, cache *InboundCache, repo *storage.TrafficRepository, user storage.User, serverID int64, inboundTag string) (*InboundClientAddItem, bool, error) {
	if cache == nil {
		return nil, false, fmt.Errorf("inbound cache not available")
	}
	ib, ok := cache.GetInbound(serverID, inboundTag)
	if !ok {
		return nil, false, fmt.Errorf("inbound cache miss for server=%d tag=%s", serverID, inboundTag)
	}

	// DB 有记录 **不等于** agent 上真有这个 client。
	//
	// 入站被删除后又用同 tag 重建时,agent 侧是全新的空入站,而 user_inbound_configs 里的旧行
	// 没有被级联清理(孤儿凭据)。早先这里只看 DB 就判定"已添加"并跳过下发,结果:订阅从 DB 读到
	// 孤儿凭据、发出一个 xray 里根本不存在的 UUID —— 表现为 TCPing 通(端口在)但真实连接握手失败。
	//
	// 所以 DB 命中后还要拿 agent 实配核对一次。ib.Settings 来自 InboundCache,其数据源是
	// server_xray_config_snapshots.current(agent 真实配置),且含 clients/users/accounts 列表。
	existing, _ := repo.GetUserInboundConfig(ctx, user.Username, serverID, inboundTag)
	if existing != nil && existing.Protocol == ib.Protocol {
		email := user.Username + "__" + inboundTag
		// ib.Settings == nil 表示拿不到该入站的实配(理论上 cache 命中即有,这里防御性处理):
		// 无从判断就维持旧行为跳过,避免每次绑定都无谓重发。
		if ib.Settings == nil || extractClientByEmail(ib.Settings, email) != nil {
			return nil, false, nil // 两边都有(或无从判断)→ 真·续费/重复绑定,跳过
		}
		// agent 缺这个 client → 用 DB 里**已有的**凭据补下发(不重新生成):
		// 订阅里的 UUID 保持不变,用户无需重新导入订阅即可恢复连接。
		// add-client 按 id 幂等;SaveUserInboundConfig 是 ON CONFLICT DO NOTHING,重复写不产生新行。
		var cred map[string]interface{}
		if json.Unmarshal([]byte(existing.CredentialJSON), &cred) == nil && cred != nil {
			log.Printf("[InboundBatch] DB 有凭据但 agent 缺 client,补下发 user=%s server=%d tag=%s",
				user.Username, serverID, inboundTag)
			return &InboundClientAddItem{
				Username:       user.Username,
				ServerID:       serverID,
				InboundTag:     inboundTag,
				Protocol:       existing.Protocol,
				Credential:     cred,
				CredentialJSON: existing.CredentialJSON,
			}, true, nil
		}
		// 凭据 JSON 损坏 → 落到下面重新生成一份
	}

	// DB 无记录 → 走 getOrCreateInboundCredential:全局锁内按 email 复用 agent 已有 client / 生成新凭据 + 立即写 DB。
	// 并发时两条路径拿到同一份 canonical 凭据(同 uuid),batch-apply / add-client 按 id 幂等,永不产生重复子账户。
	// flow(VLESS Reality)继承 + 写 DB 都在其内部完成。
	credential, credJSON, _, err := getOrCreateInboundCredential(ctx, repo, user, serverID, inboundTag, ib.Protocol, ib.Settings)
	if err != nil {
		return nil, false, fmt.Errorf("generate credential: %w", err)
	}
	return &InboundClientAddItem{
		Username:       user.Username,
		ServerID:       serverID,
		InboundTag:     inboundTag,
		Protocol:       ib.Protocol,
		Credential:     credential,
		CredentialJSON: credJSON,
	}, true, nil
}

// applyInboundBatchOrFallback per-server 收集到的 inbound add-client items 一次 batch-apply 提交,
// 失败时降级到逐项 addUserToInbound(老 agent 不支持 batch-apply 也走这条)。
// 返回收集到的 warning(供前端 toast),空切片=全成功。
func applyInboundBatchOrFallback(ctx context.Context, rm *RemoteManageHandler, repo *storage.TrafficRepository, serverID int64, items []InboundClientAddItem, label string) []string {
	if len(items) == 0 {
		return nil
	}
	err := applyInboundClientsBatchToAgent(ctx, rm, repo, serverID, items)
	if err == nil {
		return nil
	}
	if err != ErrAgentBatchNotSupported {
		log.Printf("[%s] inbound batch-apply server=%d failed: %v — falling back to per-item", label, serverID, err)
	} else {
		log.Printf("[%s] agent server=%d 不支持 batch-apply,fallback per-item", label, serverID)
	}

	var warnings []string
	for _, it := range items {
		user := storage.User{Username: it.Username}
		if ferr := addUserToInbound(ctx, rm, repo, user, it.ServerID, it.InboundTag); ferr != nil {
			log.Printf("[%s] fallback addUserToInbound user=%s server=%d tag=%s: %v",
				label, it.Username, it.ServerID, it.InboundTag, ferr)
			warnings = append(warnings, fmt.Sprintf("节点 %s 添加用户 %s 失败", it.InboundTag, it.Username))
		}
	}
	return warnings
}

// InboundClientAddItem 描述一次 per-server batch 中的单条"加 client"操作。
// 调用方按 ServerID 聚合后一次性传给 applyInboundClientsBatchToAgent。
//
// 字段使用规则:
//   - InboundTag / Credential 给 agent batch-apply 用,生成 add-client 操作
//   - Username / ServerID / Protocol / CredentialJSON 给 master DB 写 user_inbound_configs 用
//
// 调用方必须保证 (Username, ServerID, InboundTag) 三元组在 master DB 中**不存在**
// (即:已过滤 GetUserInboundConfig 返回非 nil 的情况),否则会写入重复行。
type InboundClientAddItem struct {
	Username       string
	ServerID       int64
	InboundTag     string
	Protocol       string
	Credential     map[string]interface{}
	CredentialJSON string
}

// applyInboundClientsBatchToAgent 把同一 server 上多个用户加 client 的操作合并成 1 次
// POST /api/child/batch-apply,显著减少跨海外往返耗时:
//   - 现状:每个 (user, inbound) 一次 GET /api/child/inbounds + 一次 add-client → N 次 round-trip + agent inboundsMu 串行
//   - 改造:0 次 GET(cred 用 master InboundCache 算)+ 1 次 batch-apply → 整 server 1 次 round-trip
//
// 老 agent(无 batch-apply 端点)→ 返回 ErrAgentBatchNotSupported,caller 应 fallback 逐个 addUserToInbound。
// 全成功 → 批量 SaveUserInboundConfig 写 DB,返回 nil。
// agent 个别 item 报 err(如 inbound 不存在)→ 跳过该 item 的 DB 写入,其它仍写入,函数仍返回 nil。
func applyInboundClientsBatchToAgent(ctx context.Context, rm *RemoteManageHandler, repo *storage.TrafficRepository, serverID int64, items []InboundClientAddItem) error {
	if len(items) == 0 {
		return nil
	}

	type batchInboundClient struct {
		Tag    string                 `json:"tag"`
		Client map[string]interface{} `json:"client"`
	}
	type batchReq struct {
		InboundClients []batchInboundClient `json:"inbound_clients"`
		// NoRestart=true:agent 端只 replaceRuntimeInbound 热更新,不重启 xray。
		// 加 client 是 HandlerService 热生效的场景,完全不需要 restart。
		NoRestart bool `json:"no_restart,omitempty"`
	}

	req := batchReq{NoRestart: true}
	for _, it := range items {
		req.InboundClients = append(req.InboundClients, batchInboundClient{
			Tag:    it.InboundTag,
			Client: it.Credential,
		})
	}
	body, _ := json.Marshal(req)

	raw, err := rm.forwardToRemoteServer(ctx, serverID, "POST", "/api/child/batch-apply", body)
	if err != nil {
		low := strings.ToLower(err.Error())
		if strings.Contains(low, "404") || strings.Contains(low, "not found") || strings.Contains(low, "method not allowed") {
			return ErrAgentBatchNotSupported
		}
		return fmt.Errorf("inbound batch-apply server=%d: %w", serverID, err)
	}

	var resp struct {
		Success        bool     `json:"success"`
		InboundResults []string `json:"inbound_results"`
		Message        string   `json:"message"`
	}
	if jerr := json.Unmarshal(raw, &resp); jerr != nil {
		return fmt.Errorf("parse batch-apply response: %w", jerr)
	}
	if !resp.Success {
		return fmt.Errorf("batch-apply rejected: %s", resp.Message)
	}

	// 写 user_inbound_configs:跳过 agent 端返回 err: 的 item(常见:inbound tag 不存在)。
	for i, it := range items {
		if i < len(resp.InboundResults) && strings.HasPrefix(resp.InboundResults[i], "err:") {
			log.Printf("[InboundBatch] add-client err server=%d item=%d tag=%s user=%s: %s",
				serverID, i, it.InboundTag, it.Username, resp.InboundResults[i])
			continue
		}
		if serr := repo.SaveUserInboundConfig(ctx, storage.UserInboundConfig{
			Username:       it.Username,
			ServerID:       it.ServerID,
			InboundTag:     it.InboundTag,
			Protocol:       it.Protocol,
			CredentialJSON: it.CredentialJSON,
		}); serr != nil {
			log.Printf("[InboundBatch] DB save user_inbound_config failed user=%s server=%d tag=%s: %v",
				it.Username, it.ServerID, it.InboundTag, serr)
		}
	}
	return nil
}
