package handler

import (
	"context"
	"sync"
	"time"

	"miaomiaowux/internal/logger"
)

// SubscriptionRateLimiter 对"获取订阅"类请求(短链接 /x/、临时订阅 /t/、/api/clash/subscribe 等)
// 做每 IP 频率限制,防止枚举/抓取滥用。固定窗口计数。
type subRateRecord struct {
	count       int
	windowStart time.Time
}

type SubscriptionRateLimiter struct {
	mu     sync.Mutex
	ips    map[string]*subRateRecord
	limit  int
	window time.Duration
}

// NewSubscriptionRateLimiter limit=窗口内最大请求数,window=窗口时长。
func NewSubscriptionRateLimiter(limit int, window time.Duration) *SubscriptionRateLimiter {
	if limit <= 0 {
		limit = 60
	}
	if window <= 0 {
		window = time.Minute
	}
	return &SubscriptionRateLimiter{
		ips:    make(map[string]*subRateRecord),
		limit:  limit,
		window: window,
	}
}

// Allow 返回该 IP 此刻是否允许再发起一次订阅获取。
func (l *SubscriptionRateLimiter) Allow(ip string) bool {
	if ip == "" {
		return true
	}
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()

	rec, ok := l.ips[ip]
	if !ok || now.Sub(rec.windowStart) > l.window {
		l.ips[ip] = &subRateRecord{count: 1, windowStart: now}
		return true
	}
	rec.count++
	if rec.count > l.limit {
		if rec.count == l.limit+1 {
			logger.Warn("🚦 [SUB_RATE] 订阅获取频率超限,已限流", "ip", ip, "limit", l.limit, "window", l.window.String())
		}
		return false
	}
	return true
}

// StartCleanup 定期清理过期 IP 记录,避免 map 无限增长。
func (l *SubscriptionRateLimiter) StartCleanup(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			l.mu.Lock()
			for ip, rec := range l.ips {
				if now.Sub(rec.windowStart) > l.window {
					delete(l.ips, ip)
				}
			}
			l.mu.Unlock()
		}
	}
}
