package handler

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"miaomiaowux/internal/notify"
	"miaomiaowux/internal/storage"
)

// 服务器续费提醒。
//
// 服务器的 traffic_reset_day 就是机房的账单日/流量重置日,所以拿它当续费日:
//   - 重置日前 7 天、3 天各提醒一次(该续费了)
//   - 重置日次日若服务器仍在线,视为续费成功,发一条确认
//
// 为什么"次日仍在线"就算续费成功:没续费的机器会被机房停机,agent 随即掉线。
// 判定放在次日而不是当天,是给重置日当天的停机/重启留出缓冲,避免误报。
var renewalNoticeDaysAhead = []int{7, 3}

// renewalNotified 去重:serverID → 该服务器本轮周期已发过的里程碑集合。
//
// 周期(即目标重置日)一变就整体换掉内层 map,天然不会无限增长。
// 与 checkPackageExpiring 一样是内存态:主控重启当天可能重发一次,
// 但每天只在 09:00 扫一次,重复通知的代价远小于引入一张表。
var (
	renewalNotifyMu sync.Mutex
	renewalNotified = make(map[int64]map[string]bool)
)

// markRenewalNotified 登记一次通知,返回 true 表示"本次是新的,应当发送"。
// cycle 是本轮的目标日期(YYYY-MM-DD),milestone 形如 "d7" / "d3" / "renewed"。
func markRenewalNotified(serverID int64, cycle, milestone string) bool {
	renewalNotifyMu.Lock()
	defer renewalNotifyMu.Unlock()

	sent := renewalNotified[serverID]
	if sent == nil || sent["__cycle__"+cycle] != true {
		// 换周期(或首次):丢弃上一轮的记录
		sent = map[string]bool{"__cycle__" + cycle: true}
		renewalNotified[serverID] = sent
	}
	if sent[milestone] {
		return false
	}
	sent[milestone] = true
	return true
}

// dayStart 归一化到当天零点,用于按"天"做差值,避免被时分秒带偏一天。
func dayStart(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location())
}

// nextResetDate 返回 now 之后(含今天)的下一个重置日期。
// 短月份由 effectiveResetDay 夹到月末,与真正的流量重置保持同一口径。
func nextResetDate(now time.Time, resetDay int) time.Time {
	today := dayStart(now)
	thisMonth := time.Date(today.Year(), today.Month(), effectiveResetDay(today, resetDay), 0, 0, 0, 0, today.Location())
	if !thisMonth.Before(today) {
		return thisMonth
	}
	nextMonthAnchor := time.Date(today.Year(), today.Month()+1, 1, 0, 0, 0, 0, today.Location())
	return time.Date(nextMonthAnchor.Year(), nextMonthAnchor.Month(), effectiveResetDay(nextMonthAnchor, resetDay), 0, 0, 0, 0, today.Location())
}

// prevResetDate 返回 now 之前(含今天)最近的一个重置日期。
func prevResetDate(now time.Time, resetDay int) time.Time {
	today := dayStart(now)
	thisMonth := time.Date(today.Year(), today.Month(), effectiveResetDay(today, resetDay), 0, 0, 0, 0, today.Location())
	if !thisMonth.After(today) {
		return thisMonth
	}
	prevMonthAnchor := time.Date(today.Year(), today.Month(), 0, 0, 0, 0, 0, today.Location()) // 上月最后一天
	return time.Date(prevMonthAnchor.Year(), prevMonthAnchor.Month(), effectiveResetDay(prevMonthAnchor, resetDay), 0, 0, 0, 0, today.Location())
}

// serverRenewalPlan 是对单台服务器算出的当日动作,抽成纯函数便于单测。
type serverRenewalPlan struct {
	DueInDays int    // >0 表示应发"将至"提醒,值为剩余天数
	Renewed   bool   // true 表示应发"续费成功"
	Cycle     string // 去重用的周期标识(目标重置日)
}

// planServerRenewalNotice 决定今天要不要给这台服务器发通知、发哪种。
// online 只影响"续费成功"判定;"将至"提醒即使离线也要发(离线更该提醒去续费)。
func planServerRenewalNotice(now time.Time, resetDay int, online bool) serverRenewalPlan {
	if resetDay <= 0 || resetDay > 31 {
		return serverRenewalPlan{}
	}
	today := dayStart(now)

	// 续费成功:重置日次日仍在线
	prev := prevResetDate(now, resetDay)
	if online && today.Equal(prev.AddDate(0, 0, 1)) {
		return serverRenewalPlan{Renewed: true, Cycle: prev.Format("2006-01-02")}
	}

	// 将至提醒:距下一个重置日恰好 7 天或 3 天
	next := nextResetDate(now, resetDay)
	daysLeft := int(next.Sub(today).Hours() / 24)
	for _, d := range renewalNoticeDaysAhead {
		if daysLeft == d {
			return serverRenewalPlan{DueInDays: d, Cycle: next.Format("2006-01-02")}
		}
	}
	return serverRenewalPlan{}
}

// checkServerRenewal 扫全部远程服务器,按重置日发续费提醒 / 续费成功确认。
func checkServerRenewal(ctx context.Context, repo *storage.TrafficRepository) {
	servers, err := repo.ListRemoteServers(ctx)
	if err != nil {
		log.Printf("[Notify] checkServerRenewal list servers failed: %v", err)
		return
	}
	now := time.Now()
	for _, s := range servers {
		online := s.Status == storage.RemoteServerStatusConnected
		plan := planServerRenewalNotice(now, s.TrafficResetDay, online)

		switch {
		case plan.Renewed:
			if markRenewalNotified(s.ID, plan.Cycle, "renewed") {
				SendServerRenewedNotification(ctx, s.Name, plan.Cycle)
			}
		case plan.DueInDays > 0:
			if markRenewalNotified(s.ID, plan.Cycle, fmt.Sprintf("d%d", plan.DueInDays)) {
				SendServerRenewalDueNotification(ctx, s.Name, plan.DueInDays, plan.Cycle, online)
			}
		}
	}
}

// SendServerRenewalDueNotification 服务器将在 N 天后到重置日(=续费日)。
func SendServerRenewalDueNotification(ctx context.Context, serverName string, daysLeft int, resetDate string, online bool) {
	state := "在线"
	if !online {
		state = "离线"
	}
	notifyAsync(ctx, notify.EventServerRenewalDue,
		"⏰ 服务器即将到期",
		fmt.Sprintf("服务器: `%s`\n到期(重置)日: %s\n剩余: %d 天\n当前状态: %s", serverName, resetDate, daysLeft, state),
	)
}

// SendServerRenewedNotification 重置日已过、服务器仍在线 → 续费成功。
func SendServerRenewedNotification(ctx context.Context, serverName, resetDate string) {
	notifyAsync(ctx, notify.EventServerRenewed,
		"✅ 服务器续费成功",
		fmt.Sprintf("服务器: `%s`\n到期(重置)日: %s\n次日仍在线，判定为已续费", serverName, resetDate),
	)
}
