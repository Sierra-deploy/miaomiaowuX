package handler

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"time"

	"miaomiaowux/internal/logger"
	"miaomiaowux/internal/notify"
)

var globalBruteForceProtector *BruteForceProtector

type bruteForceRecord struct {
	count      int
	firstTime  time.Time
	blockUntil time.Time
}

type BruteForceProtector struct {
	mu            sync.RWMutex
	attempts      sync.Map // IP -> *bruteForceRecord
	enabled       bool
	maxFailures   int
	window        time.Duration
	blockDuration time.Duration
}

// NewBruteForceProtector 用 hardcoded 默认值构造。
// 加严:24h 窗口内 5 次失败 → 封 24h(同步自 mmw v0.7.3 #89,防订阅 token 枚举)。
// 启动时若 system_settings 里有自定义阈值,main.go 会改用 NewBruteForceProtectorWithConfig。
func NewBruteForceProtector() *BruteForceProtector {
	p := &BruteForceProtector{
		enabled:       true,
		maxFailures:   5,
		window:        24 * time.Hour,
		blockDuration: 24 * time.Hour,
	}
	globalBruteForceProtector = p
	return p
}

// NewBruteForceProtectorWithConfig 用 system_settings 里读出的自定义阈值构造。
// windowMinutes / blockMinutes 用分钟为单位,因为前端配置面板按分钟输入更直观。
func NewBruteForceProtectorWithConfig(enabled bool, maxFailures, windowMinutes, blockMinutes int) *BruteForceProtector {
	p := &BruteForceProtector{
		enabled:       enabled,
		maxFailures:   maxFailures,
		window:        time.Duration(windowMinutes) * time.Minute,
		blockDuration: time.Duration(blockMinutes) * time.Minute,
	}
	globalBruteForceProtector = p
	return p
}

// UpdateConfig 热更新参数 — security_settings handler 收到 PUT 后调用,无需重启主控。
func (p *BruteForceProtector) UpdateConfig(enabled bool, maxFailures, windowMinutes, blockMinutes int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.enabled = enabled
	p.maxFailures = maxFailures
	p.window = time.Duration(windowMinutes) * time.Minute
	p.blockDuration = time.Duration(blockMinutes) * time.Minute
}

func (p *BruteForceProtector) getConfig() (bool, int, time.Duration, time.Duration) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.enabled, p.maxFailures, p.window, p.blockDuration
}

func GetBruteForceProtector() *BruteForceProtector {
	return globalBruteForceProtector
}

func (p *BruteForceProtector) IsBlocked(ip, path string) bool {
	enabled, _, _, _ := p.getConfig()
	if !enabled {
		return false
	}

	val, ok := p.attempts.Load(ip)
	if !ok {
		return false
	}
	rec := val.(*bruteForceRecord)

	now := time.Now()
	if !rec.blockUntil.IsZero() && now.Before(rec.blockUntil) {
		logger.Warn("🚫🚫🚫 [BRUTE_FORCE] 已封禁IP尝试访问，已拦截",
			"ip", ip,
			"访问路径", path,
			"封禁剩余", rec.blockUntil.Sub(now).Round(time.Second).String(),
		)
		return true
	}

	// 封禁已过期，清除
	if !rec.blockUntil.IsZero() {
		logger.Info("✅ [BRUTE_FORCE] IP封禁已过期，已自动解除",
			"ip", ip,
		)
		p.attempts.Delete(ip)
	}
	return false
}

func (p *BruteForceProtector) RecordFailure(ip, path string) {
	enabled, maxFailures, window, blockDuration := p.getConfig()
	if !enabled {
		return
	}

	now := time.Now()

	val, loaded := p.attempts.Load(ip)
	if !loaded {
		logger.Warn("⚠️ [BRUTE_FORCE] 订阅探测失败",
			"ip", ip,
			"访问路径", path,
			"次数", fmt.Sprintf("1/%d", maxFailures),
		)
		p.attempts.Store(ip, &bruteForceRecord{
			count:     1,
			firstTime: now,
		})
		return
	}

	rec := val.(*bruteForceRecord)

	if !rec.blockUntil.IsZero() && now.Before(rec.blockUntil) {
		return
	}

	if now.Sub(rec.firstTime) > window {
		logger.Warn("⚠️ [BRUTE_FORCE] 订阅探测失败（窗口重置）",
			"ip", ip,
			"访问路径", path,
			"次数", fmt.Sprintf("1/%d", maxFailures),
		)
		p.attempts.Store(ip, &bruteForceRecord{
			count:     1,
			firstTime: now,
		})
		return
	}

	rec.count++
	if rec.count >= maxFailures {
		rec.blockUntil = now.Add(blockDuration)
		logger.Warn("🚫🚫🚫 [BRUTE_FORCE] IP 已被封禁！",
			"ip", ip,
			"触发路径", path,
			"失败次数", rec.count,
			"封禁至", rec.blockUntil.Format("2006-01-02 15:04:05"),
		)

		if n := GetNotifier(); n != nil {
			go n.Send(context.Background(), notify.Event{
				Type:    notify.EventIPBan,
				Title:   "IP 封禁",
				Message: fmt.Sprintf("IP `%s` 已被封禁\n触发路径: `%s`\n失败次数: %d\n封禁至: %s", ip, path, rec.count, rec.blockUntil.Format("2006-01-02 15:04:05")),
			})
		}
	} else {
		logger.Warn("⚠️ [BRUTE_FORCE] 订阅探测失败",
			"ip", ip,
			"访问路径", path,
			"次数", fmt.Sprintf("%d/%d", rec.count, maxFailures),
		)
	}
}

func (p *BruteForceProtector) RecordSuccess(ip string) {
	p.attempts.Delete(ip)
}

// StatusRecorder wraps http.ResponseWriter to capture the status code.
type StatusRecorder struct {
	http.ResponseWriter
	StatusCode int
}

func (r *StatusRecorder) WriteHeader(code int) {
	r.StatusCode = code
	r.ResponseWriter.WriteHeader(code)
}
