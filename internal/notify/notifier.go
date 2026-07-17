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

// SkipReason 取值:enabled / global_disabled / bot_token_empty / chat_id_empty / event_disabled
// 上层 helper 根据 reason 做 throttled log,排查"为什么有时不发"用。
type SkipReason string

const (
	ReasonEnabled         SkipReason = ""
	ReasonGlobalDisabled  SkipReason = "global_disabled"
	ReasonBotTokenEmpty   SkipReason = "bot_token_empty"
	ReasonChatIDEmpty     SkipReason = "chat_id_empty"
	ReasonEventDisabled   SkipReason = "event_disabled"
)

// CheckEnabled 返回 (是否启用, 不启用原因)。
//   - 全部配置就绪 + 该事件开关打开:(true, ReasonEnabled)
//   - 全局关 / 缺 token / 缺 chat_id / 该事件开关 off:(false, 对应 reason)
//
// 上层 notifyAsync 拿 reason 做 throttled log,避免静默丢消息时用户无法排查。
func (n *Notifier) CheckEnabled(eventType EventType) (bool, SkipReason) {
	n.mu.RLock()
	defer n.mu.RUnlock()

	if !n.cfg.Enabled {
		return false, ReasonGlobalDisabled
	}
	if n.cfg.BotToken == "" {
		return false, ReasonBotTokenEmpty
	}
	if n.cfg.ChatID == "" {
		return false, ReasonChatIDEmpty
	}

	var on bool
	switch eventType {
	case EventLogin:
		on = n.cfg.NotifyLogin
	case EventSubscribeFetch:
		on = n.cfg.NotifySubscribeFetch
	case EventDailyTraffic:
		on = n.cfg.NotifyDailyTraffic
	case EventServerOffline:
		on = n.cfg.NotifyServerOffline
	case EventServerOnline:
		on = n.cfg.NotifyServerOnline
	case EventTrafficThreshold:
		on = n.cfg.NotifyTrafficThreshold
	case EventTrafficThreshold80:
		on = n.cfg.NotifyTrafficThreshold80
	case EventOverLimit:
		on = n.cfg.NotifyOverLimit
	case EventPackageExpiring:
		on = n.cfg.NotifyPackageExpiring
	case EventPackageExpired:
		on = n.cfg.NotifyPackageExpired
	case EventUserRegistered:
		on = n.cfg.NotifyUserRegistered
	case EventTelegramBound:
		on = n.cfg.NotifyTelegramBound
	case EventCertResult:
		on = n.cfg.NotifyCertResult
	case EventAgentLongOffline:
		on = n.cfg.NotifyAgentLongOffline
	case EventDeviceLimitExceeded:
		on = n.cfg.NotifyDeviceLimitExceeded
	case EventIPBan:
		on = n.cfg.NotifyIPBan
	default:
		on = false
	}
	if !on {
		return false, ReasonEventDisabled
	}
	return true, ReasonEnabled
}

// composeText 拼最终发给 TG 的正文。
//
// Title 为空 → 整条消息就是 Message,不前置标题行。每日流量推送走这条路:
// 它的文案(含首行标题)整段由管理员的模板决定;若仍无条件前置,会渲染出 "**" 这种
// 坏 Markdown,TG 直接 400,当天推送整个发不出去。
func composeText(title, message string) string {
	if title == "" {
		return message
	}
	return fmt.Sprintf("*%s*\n%s", title, message)
}

func (n *Notifier) Send(ctx context.Context, event Event) error {
	if ok, _ := n.CheckEnabled(event.Type); !ok {
		return nil
	}
	// 串行进入 telegram 发送 — 防止多个 go n.Send 并发跑时 HTTP 顺序乱掉(下/上线倒序的根因)
	n.sendMu.Lock()
	defer n.sendMu.Unlock()

	cfg := n.GetConfig()
	return sendTelegram(ctx, cfg.BotToken, cfg.ChatID, composeText(event.Title, event.Message))
}

func (n *Notifier) SendTest(ctx context.Context) error {
	cfg := n.GetConfig()
	if cfg.BotToken == "" || cfg.ChatID == "" {
		return fmt.Errorf("bot token or chat ID is empty")
	}
	return sendTelegram(ctx, cfg.BotToken, cfg.ChatID, "*测试通知*\n妙妙屋X 通知配置成功 ✓")
}
