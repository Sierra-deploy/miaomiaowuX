package notify

import (
	"context"
	"fmt"
	"sync"
)

type Notifier struct {
	mu  sync.RWMutex
	cfg Config
	// sendMu 串行化所有 Telegram 发送:多个 goroutine 同时 go n.Send(...) 会导致 HTTP 请求乱序到达,
	// 用户看到的消息顺序就和事件触发顺序对不上(典型现象:重启 agent 后"上线"比"下线"先收到)。
	sendMu sync.Mutex
}

func New(cfg Config) *Notifier {
	return &Notifier{cfg: cfg}
}

func (n *Notifier) UpdateConfig(cfg Config) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.cfg = cfg
}

func (n *Notifier) GetConfig() Config {
	n.mu.RLock()
	defer n.mu.RUnlock()
	return n.cfg
}

func (n *Notifier) IsEnabled(eventType EventType) bool {
	n.mu.RLock()
	defer n.mu.RUnlock()

	if !n.cfg.Enabled || n.cfg.BotToken == "" || n.cfg.ChatID == "" {
		return false
	}

	switch eventType {
	case EventLogin:
		return n.cfg.NotifyLogin
	case EventSubscribeFetch:
		return n.cfg.NotifySubscribeFetch
	case EventDailyTraffic:
		return n.cfg.NotifyDailyTraffic
	case EventServerOffline:
		return n.cfg.NotifyServerOffline
	case EventServerOnline:
		return n.cfg.NotifyServerOnline
	case EventTrafficThreshold:
		return n.cfg.NotifyTrafficThreshold
	default:
		return false
	}
}

func (n *Notifier) Send(ctx context.Context, event Event) error {
	if !n.IsEnabled(event.Type) {
		return nil
	}
	// 串行进入 telegram 发送 — 防止多个 go n.Send 并发跑时 HTTP 顺序乱掉(下/上线倒序的根因)
	n.sendMu.Lock()
	defer n.sendMu.Unlock()

	cfg := n.GetConfig()
	text := fmt.Sprintf("*%s*\n%s", event.Title, event.Message)
	return sendTelegram(ctx, cfg.BotToken, cfg.ChatID, text)
}

func (n *Notifier) SendTest(ctx context.Context) error {
	cfg := n.GetConfig()
	if cfg.BotToken == "" || cfg.ChatID == "" {
		return fmt.Errorf("bot token or chat ID is empty")
	}
	return sendTelegram(ctx, cfg.BotToken, cfg.ChatID, "*测试通知*\n妙妙屋X 通知配置成功 ✓")
}
