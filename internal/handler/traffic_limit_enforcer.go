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
