package handler

import (
	"context"
	"fmt"
	"log"
	"sort"
	"strings"
	"time"

	"miaomiaowux/internal/notify"
	"miaomiaowux/internal/storage"
)

func StartNotifyScheduler(ctx context.Context, repo *storage.TrafficRepository) {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	var lastDailyRun string

	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			n := GetNotifier()
			if n == nil {
				continue
			}
			cfg := n.GetConfig()

			if cfg.NotifyDailyTraffic {
				today := now.Format("2006-01-02")
				nowTime := now.Format("15:04")
				targetTime := cfg.DailyTrafficTime
				if targetTime == "" {
					targetTime = "08:00"
				}
				if nowTime == targetTime && lastDailyRun != today {
					lastDailyRun = today
					go sendDailyTrafficNotification(ctx, repo, n)
				}
			}

			if cfg.NotifyTrafficThreshold && cfg.TrafficThresholdPercent > 0 {
				go checkTrafficThreshold(ctx, repo, n, cfg.TrafficThresholdPercent)
			}
		}
	}
}

func sendDailyTrafficNotification(ctx context.Context, repo *storage.TrafficRepository, n *notify.Notifier) {
	servers, err := repo.ListRemoteServers(ctx)
	if err != nil {
		log.Printf("[Notify] 获取服务器列表失败: %v", err)
		return
	}

	type serverTraffic struct {
		name  string
		used  int64
		limit int64
	}
	var serverList []serverTraffic
	var totalUsed int64

	for _, s := range servers {
		used, _ := repo.GetServerTrafficUsed(ctx, s.ID)
		totalUsed += used
		serverList = append(serverList, serverTraffic{name: s.Name, used: used, limit: s.TrafficLimit})
	}

	sort.Slice(serverList, func(i, j int) bool { return serverList[i].used > serverList[j].used })

	var lines []string
	lines = append(lines, fmt.Sprintf("*总流量:* %.2fGB", float64(totalUsed)/(1024*1024*1024)))

	if len(serverList) > 0 {
		lines = append(lines, "\n*服务器流量:*")
		for _, s := range serverList {
			usedGB := float64(s.used) / (1024 * 1024 * 1024)
			if s.limit > 0 {
				limitGB := float64(s.limit) / (1024 * 1024 * 1024)
				pct := float64(s.used) / float64(s.limit) * 100
				lines = append(lines, fmt.Sprintf("• %s: %.1fGB/%.0fGB (%.0f%%)", s.name, usedGB, limitGB, pct))
			} else {
				lines = append(lines, fmt.Sprintf("• %s: %.1fGB", s.name, usedGB))
			}
		}
	}

	allUserTraffic, err := repo.GetAllUserTraffic(ctx)
	if err == nil && len(allUserTraffic) > 0 {
		// 拉一次「子账号 email → 父用户名」映射,把子账号产生的流量合并到主用户头上
		// (路由出站子账号的 user_traffic.username 是 email,不合并的话主账号和子账号会各占一行)
		subToParent, _ := repo.ListSubaccountEmailToUsername(ctx)
		userTotals := make(map[string]int64)
		for _, ut := range allUserTraffic {
			name := ut.Username
			if parent, ok := subToParent[name]; ok && parent != "" {
				name = parent
			}
			userTotals[name] += ut.Uplink + ut.Downlink
		}

		// 应用流量倍率
		allUsers, _ := repo.ListUsersWithPackage(ctx)
		packages, _ := repo.ListPackages(ctx)
		pkgMap := make(map[int64]storage.Package)
		for _, p := range packages {
			pkgMap[p.ID] = p
		}
		for _, u := range allUsers {
			if pkg, ok := pkgMap[u.PackageID]; ok {
				if m := pkg.TrafficMultiplier(); m > 1 {
					userTotals[u.Username] *= m
				}
			}
		}

		type userUsage struct {
			name string
			used int64
		}
		var users []userUsage
		for name, used := range userTotals {
			users = append(users, userUsage{name: name, used: used})
		}
		sort.Slice(users, func(i, j int) bool { return users[i].used > users[j].used })

		lines = append(lines, "\n*用户流量:*")
		for _, u := range users {
			if u.used == 0 {
				continue
			}
			usedGB := float64(u.used) / (1024 * 1024 * 1024)
			lines = append(lines, fmt.Sprintf("• %s: %.2fGB", u.name, usedGB))
		}
	}

	if len(lines) <= 1 {
		return
	}

	_ = n.Send(ctx, notify.Event{
		Type:    notify.EventDailyTraffic,
		Title:   "每日流量统计",
		Message: strings.Join(lines, "\n"),
	})
}

func checkTrafficThreshold(ctx context.Context, repo *storage.TrafficRepository, n *notify.Notifier, thresholdPct int) {
	servers, err := repo.ListRemoteServers(ctx)
	if err != nil {
		return
	}

	for _, s := range servers {
		if s.TrafficLimit <= 0 || s.Status != "connected" {
			continue
		}
		used, _ := repo.GetServerTrafficUsed(ctx, s.ID)
		pct := int(float64(used) / float64(s.TrafficLimit) * 100)
		if pct >= thresholdPct {
			alreadyNotified, _ := repo.IsTrafficThresholdNotified(ctx, s.ID)
			if alreadyNotified {
				continue
			}
			usedGB := float64(used) / (1024 * 1024 * 1024)
			limitGB := float64(s.TrafficLimit) / (1024 * 1024 * 1024)
			_ = n.Send(ctx, notify.Event{
				Type:  notify.EventTrafficThreshold,
				Title: "流量告警",
				Message: fmt.Sprintf("服务器 `%s` 流量已达 %d%%\n已用: %.1fGB / %.0fGB",
					s.Name, pct, usedGB, limitGB),
			})
			_ = repo.MarkTrafficThresholdNotified(ctx, s.ID)
		}
	}
}

// 同步发送 — 调用方需要保证顺序的场景(下线 → 上线)直接靠"上一个 Send 返回再发下一个"来对齐;
// 短消息发 telegram 通常 100-500ms,阻塞 caller 一两秒是可接受的代价。
// 想异步不想阻塞的 caller 自己包一层 go func(){...}() 即可。
func SendServerOnlineNotification(ctx context.Context, serverName, ip string) {
	n := GetNotifier()
	if n == nil {
		return
	}
	_ = n.Send(ctx, notify.Event{
		Type:    notify.EventServerOnline,
		Title:   "🟢 服务器上线",
		Message: fmt.Sprintf("服务器: `%s`\nIP: `%s`", serverName, ip),
	})
}

func SendServerOfflineNotification(ctx context.Context, serverName, ip string) {
	n := GetNotifier()
	if n == nil {
		return
	}
	_ = n.Send(ctx, notify.Event{
		Type:    notify.EventServerOffline,
		Title:   "🔴 服务器离线",
		Message: fmt.Sprintf("服务器: `%s`\nIP: `%s`", serverName, ip),
	})
}

// SendXrayStatusChangeNotification 在 xray 启停切换时发 TG 通知。
// 复用 server_online / server_offline 两个开关:用户已勾选服务器上下线通知,xray 状态变化一起通知,
// 不引入新开关、不增加配置面板复杂度。
func SendXrayStatusChangeNotification(ctx context.Context, serverName, ip string, running bool) {
	n := GetNotifier()
	if n == nil {
		return
	}
	var evt notify.Event
	if running {
		evt = notify.Event{
			Type:    notify.EventServerOnline,
			Title:   "🟢 Xray 已启动",
			Message: fmt.Sprintf("服务器: `%s`\nIP: `%s`", serverName, ip),
		}
	} else {
		evt = notify.Event{
			Type:    notify.EventServerOffline,
			Title:   "🔴 Xray 已停止",
			Message: fmt.Sprintf("服务器: `%s`\nIP: `%s`", serverName, ip),
		}
	}
	go n.Send(ctx, evt)
}

func SendLoginNotification(ctx context.Context, username, ip string) {
	n := GetNotifier()
	if n == nil {
		return
	}
	go n.Send(ctx, notify.Event{
		Type:    notify.EventLogin,
		Title:   "用户登录",
		Message: fmt.Sprintf("用户: `%s`\nIP: `%s`", username, ip),
	})
}

func SendSubscribeFetchNotification(ctx context.Context, username, clientType, ip string) {
	n := GetNotifier()
	if n == nil {
		return
	}
	go n.Send(ctx, notify.Event{
		Type:    notify.EventSubscribeFetch,
		Title:   "订阅获取",
		Message: fmt.Sprintf("用户: `%s`\n客户端: `%s`\nIP: `%s`", username, clientType, ip),
	})
}
