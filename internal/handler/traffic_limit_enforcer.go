package handler

import (
	"context"
	"log"
	"time"

	"miaomiaowux/internal/storage"
)

type TrafficLimitEnforcer struct {
	repo         *storage.TrafficRepository
	remoteManage *RemoteManageHandler
	pusher       *LimiterConfigPusher
}

func NewTrafficLimitEnforcer(repo *storage.TrafficRepository, remoteManage *RemoteManageHandler, pusher *LimiterConfigPusher) *TrafficLimitEnforcer {
	return &TrafficLimitEnforcer{repo: repo, remoteManage: remoteManage, pusher: pusher}
}

func (e *TrafficLimitEnforcer) Start(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = 5 * time.Minute
	}
	log.Printf("[TrafficLimitEnforcer] Starting with interval: %v", interval)
	e.CheckAll(ctx)

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			e.CheckAll(ctx)
		}
	}
}

// shouldResetThisMonth 判断当前时刻是否应触发用户的本月流量重置。
//
// 规则:
//  1. 必须 user.IsReset=true,resetDay∈[1,31]
//  2. 当月的"有效重置日" = min(resetDay, 当月最后一天) — 处理 reset_day=31 但 2 月只有 28 天的边界
//  3. now.Day() >= 有效重置日 才进入触发窗口
//  4. lastResetAt 为 nil(从未重置过)或不在本月 → 应该重置;否则跳过(避免同月反复)
//
// 注:用 now 的本地时区(time.Now() 默认)。生产环境 server 时区需配为本地时区,否则用户感知的"7号"会偏移。
func shouldResetThisMonth(now time.Time, isReset bool, resetDay int, lastResetAt *time.Time) bool {
	if !isReset || resetDay <= 0 || resetDay > 31 {
		return false
	}
	// 当月最后一天 = 下月第 0 天
	lastDayOfMonth := time.Date(now.Year(), now.Month()+1, 0, 0, 0, 0, 0, now.Location()).Day()
	effectiveDay := resetDay
	if effectiveDay > lastDayOfMonth {
		effectiveDay = lastDayOfMonth
	}
	if now.Day() < effectiveDay {
		return false
	}
	if lastResetAt == nil {
		return true
	}
	// 同年同月 = 本月已经 reset 过,跳过
	return lastResetAt.Year() != now.Year() || lastResetAt.Month() != now.Month()
}

func (e *TrafficLimitEnforcer) CheckAll(ctx context.Context) {
	users, err := e.repo.ListUsersWithPackage(ctx)
	if err != nil {
		log.Printf("[TrafficLimitEnforcer] Failed to list users: %v", err)
		return
	}

	pkgCache := make(map[int64]*storage.Package)
	now := time.Now()

	for _, user := range users {
		// 套餐到期检查：到期后移除入站并清除套餐绑定
		if user.PackageEndDate != nil && now.After(*user.PackageEndDate) {
			log.Printf("[TrafficLimitEnforcer] User %s package expired at %s, removing from inbounds and clearing package",
				user.Username, user.PackageEndDate.Format("2006-01-02"))
			e.removeUserFromAllInbounds(ctx, user.Username)
			// 用户私有路由出站(routed_owner='user'):父 inbound 来自套餐分配的节点,
			// 套餐到期后失去访问权,所以一并 suspend(凭据保留供续费恢复)。
			suspendUserPrivateRouted(ctx, e.remoteManage, e.repo, user.Username)
			if err := e.repo.DeleteUserInboundConfigs(ctx, user.Username); err != nil {
				log.Printf("[TrafficLimitEnforcer] Failed to delete inbound configs for %s: %v", user.Username, err)
			}
			if err := e.repo.RemovePackageFromUser(ctx, user.Username); err != nil {
				log.Printf("[TrafficLimitEnforcer] Failed to remove package from %s: %v", user.Username, err)
			}
			// 套餐过期跟 user delete 一样,需要通知所有 agent limiter 同步移除该用户
			// 否则 agent 内存里的 limiter UserInfo 还有这个用户,旧 IP 复用时仍能匹配 bucket。
			if e.pusher != nil {
				go e.pusher.PushToAllServersForUser(context.Background(), user.Username)
			}
			continue
		}

		pkg, ok := pkgCache[user.PackageID]
		if !ok {
			p, err := e.repo.GetPackage(ctx, user.PackageID)
			if err != nil {
				log.Printf("[TrafficLimitEnforcer] Failed to get package %d: %v", user.PackageID, err)
				continue
			}
			pkg = p
			pkgCache[user.PackageID] = pkg
		}

		// 每月流量周期自动重置 — 到 reset_day 当天 0 点之后(实际由 enforcer ticker 触发,粒度=interval)
		// 触发后立刻把当前周期 uplink/downlink 归 0 + cycle_start=now,并写 last_reset_at 防止同月反复。
		// 还原"超额"标志:重置后用户应该重新有流量配额,wasOverLimit → 立即恢复入站。
		if shouldResetThisMonth(now, user.IsReset, user.ResetDay, user.LastResetAt) {
			log.Printf("[TrafficLimitEnforcer] User %s monthly reset (day=%d, last=%v)", user.Username, user.ResetDay, user.LastResetAt)
			if err := e.repo.ResetUserTrafficCycle(ctx, user.Username); err != nil {
				log.Printf("[TrafficLimitEnforcer] Failed to reset user %s: %v", user.Username, err)
			} else {
				if err := e.repo.UpdateUserLastResetAt(ctx, user.Username, now); err != nil {
					log.Printf("[TrafficLimitEnforcer] Failed to write last_reset_at for %s: %v", user.Username, err)
				}
				// 复用现有"恢复入站"路径:如果用户之前因超额被踢,reset 后自动放回
				if wasOver, _ := e.repo.IsUserOverLimit(ctx, user.Username); wasOver {
					log.Printf("[TrafficLimitEnforcer] User %s back under limit after monthly reset, restoring inbounds", user.Username)
					e.restoreUserToInbounds(ctx, user)
					resumeUserPrivateRouted(ctx, e.remoteManage, e.repo, user.Username)
					e.repo.UpdateUserOverLimit(ctx, user.Username, false)
				}
				// limiter 配置在 agent 端按 user_traffic 累计算,重置归零后下次 push 自然刷新
			}
		}

		if pkg.TrafficLimitBytes <= 0 {
			continue
		}

		// 加权流量:每行 user_email_traffic 乘以节点在套餐内的倍率(routed 子节点继承父节点)
		totalTraffic, err := e.repo.GetUserWeightedTraffic(ctx, user.Username, pkg)
		if err != nil {
			log.Printf("[TrafficLimitEnforcer] Failed to get traffic for %s: %v", user.Username, err)
			continue
		}

		wasOverLimit, _ := e.repo.IsUserOverLimit(ctx, user.Username)
		isOverLimit := totalTraffic*pkg.TrafficMultiplier() >= pkg.TrafficLimitBytes

		if isOverLimit && !wasOverLimit {
			log.Printf("[TrafficLimitEnforcer] User %s exceeded limit (%d/%d bytes), removing from inbounds",
				user.Username, totalTraffic, pkg.TrafficLimitBytes)
			e.removeUserFromAllInbounds(ctx, user.Username)
			suspendUserPrivateRouted(ctx, e.remoteManage, e.repo, user.Username)
			e.repo.UpdateUserOverLimit(ctx, user.Username, true)
		} else if !isOverLimit && wasOverLimit {
			log.Printf("[TrafficLimitEnforcer] User %s back under limit (%d/%d bytes), restoring inbounds",
				user.Username, totalTraffic, pkg.TrafficLimitBytes)
			e.restoreUserToInbounds(ctx, user)
			resumeUserPrivateRouted(ctx, e.remoteManage, e.repo, user.Username)
			e.repo.UpdateUserOverLimit(ctx, user.Username, false)
		}
	}
}

func (e *TrafficLimitEnforcer) removeUserFromAllInbounds(ctx context.Context, username string) {
	configs, err := e.repo.GetUserInboundConfigs(ctx, username)
	if err != nil {
		log.Printf("[TrafficLimitEnforcer] Failed to get inbound configs for %s: %v", username, err)
		return
	}
	for _, cfg := range configs {
		if err := removeUserFromInbound(ctx, e.remoteManage, cfg); err != nil {
			log.Printf("[TrafficLimitEnforcer] Failed to remove %s from %s on server %d: %v",
				username, cfg.InboundTag, cfg.ServerID, err)
		}
	}
}

func (e *TrafficLimitEnforcer) restoreUserToInbounds(ctx context.Context, user storage.User) {
	configs, err := e.repo.GetUserInboundConfigs(ctx, user.Username)
	if err != nil {
		log.Printf("[TrafficLimitEnforcer] Failed to get inbound configs for %s: %v", user.Username, err)
		return
	}
	for _, cfg := range configs {
		if err := addUserToInbound(ctx, e.remoteManage, e.repo, user, cfg.ServerID, cfg.InboundTag); err != nil {
			log.Printf("[TrafficLimitEnforcer] Failed to restore %s to %s on server %d: %v",
				user.Username, cfg.InboundTag, cfg.ServerID, err)
		}
	}
}
