package handler

import (
	"encoding/json"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"miaomiaowux/internal/logger"
)

// ProbeWSHandler 用 WebSocket 向伪装探针页推送服务器状态,替代 5 秒一次的 HTTP 轮询。
//
// 轮询的问题:每个访客每 5 秒拉一次全量 payload(目标数×服务器数,几百 KB 级),
// 服务端每次都要重新查 DB + 快照 + 聚合。推送模式下**一次计算广播给所有连接**,
// 且只在有人看的时候才计算。
//
// 这是**无鉴权公开端点**,所以下面几条限制是必需的,不是可选优化:
//   - 全局连接数上限:否则任何人都能靠开连接把主控内存吃光
//   - per-IP 连接数上限:挡住单机开几千连接
//   - 读超时 + 心跳:清掉半开连接(客户端断网不发 FIN 的情况)
//   - 只读不写:客户端发来的任何消息都丢弃,不解析 —— 不给它任何影响服务端状态的机会
type ProbeWSHandler struct {
	public   *ProbePublicHandler
	upgrader websocket.Upgrader

	mu      sync.Mutex
	clients map[*probeWSClient]struct{}
	perIP   map[string]int
	running bool // 广播 goroutine 是否在跑(有连接才跑)
}

type probeWSClient struct {
	conn *websocket.Conn
	send chan []byte
	ip   string
}

const (
	probeWSMaxClients      = 200 // 全局连接上限
	probeWSMaxPerIP        = 5   // 单 IP 连接上限
	probeWSBroadcastPeriod = 5 * time.Second
	probeWSWriteTimeout    = 10 * time.Second
	probeWSPongTimeout     = 60 * time.Second
	probeWSPingPeriod      = 25 * time.Second
	probeWSSendBuffer      = 4 // 发送队列;满了说明客户端消费不动,直接踢掉而不是无限堆积
)

func NewProbeWSHandler(public *ProbePublicHandler) *ProbeWSHandler {
	return &ProbeWSHandler{
		public: public,
		upgrader: websocket.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 4096,
			// 公开页面,允许任意来源(和 /api/public/probe-servers 的可访问性一致)。
			// 注意:这里不做 CSRF 意义上的防护,因为该端点本就是完全公开的只读数据。
			CheckOrigin: func(r *http.Request) bool { return true },
		},
		clients: make(map[*probeWSClient]struct{}),
		perIP:   make(map[string]int),
	}
}

func (h *ProbeWSHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// 伪装未开启时不提供该端点,避免暴露"这台机器装的是面板"。
	if v, _ := h.public.repo.GetSystemSetting(r.Context(), probeDisguiseEnabledKey); v != "1" {
		http.NotFound(w, r)
		return
	}

	ip := probeWSClientIP(r)

	h.mu.Lock()
	if len(h.clients) >= probeWSMaxClients || h.perIP[ip] >= probeWSMaxPerIP {
		h.mu.Unlock()
		// 超限返回 503 而不是升级失败,前端据此回落到 HTTP 轮询。
		http.Error(w, "too many connections", http.StatusServiceUnavailable)
		return
	}
	h.mu.Unlock()

	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return // Upgrade 内部已写过响应
	}

	c := &probeWSClient{conn: conn, send: make(chan []byte, probeWSSendBuffer), ip: ip}

	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.perIP[ip]++
	needStart := !h.running
	if needStart {
		h.running = true
	}
	h.mu.Unlock()

	if needStart {
		go h.broadcastLoop()
	}

	go h.writePump(c)
	h.readPump(c) // 阻塞到连接关闭
}

// readPump 只负责发现连接断开。客户端发来的消息**一律丢弃**:这个端点是单向推送,
// 解析入站消息只会凭空多出一片攻击面。
func (h *ProbeWSHandler) readPump(c *probeWSClient) {
	defer h.removeClient(c)

	c.conn.SetReadLimit(512) // 客户端没有理由发大消息
	_ = c.conn.SetReadDeadline(time.Now().Add(probeWSPongTimeout))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(probeWSPongTimeout))
	})

	for {
		if _, _, err := c.conn.ReadMessage(); err != nil {
			return
		}
		// 收到什么都不处理,只把读超时往后推(说明对端还活着)。
		_ = c.conn.SetReadDeadline(time.Now().Add(probeWSPongTimeout))
	}
}

func (h *ProbeWSHandler) writePump(c *probeWSClient) {
	ticker := time.NewTicker(probeWSPingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case msg, ok := <-c.send:
			if !ok {
				return
			}
			_ = c.conn.SetWriteDeadline(time.Now().Add(probeWSWriteTimeout))
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(probeWSWriteTimeout))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (h *ProbeWSHandler) removeClient(c *probeWSClient) {
	h.mu.Lock()
	if _, ok := h.clients[c]; ok {
		delete(h.clients, c)
		close(c.send)
		if h.perIP[c.ip] <= 1 {
			delete(h.perIP, c.ip)
		} else {
			h.perIP[c.ip]--
		}
	}
	h.mu.Unlock()
	c.conn.Close()
}

// broadcastLoop 每 probeWSBroadcastPeriod 算一次快照并广播。没有连接时退出,
// 下一个连接进来再拉起 —— 没人看的时候不做任何计算。
func (h *ProbeWSHandler) broadcastLoop() {
	ticker := time.NewTicker(probeWSBroadcastPeriod)
	defer ticker.Stop()

	for range ticker.C {
		h.mu.Lock()
		n := len(h.clients)
		if n == 0 {
			h.running = false
			h.mu.Unlock()
			return
		}
		h.mu.Unlock()

		payload, err := h.public.buildPayload(nil)
		if err != nil {
			logger.Warn("[探针WS] 构造推送数据失败", "error", err)
			continue
		}
		msg, err := json.Marshal(payload)
		if err != nil {
			continue
		}

		h.mu.Lock()
		for c := range h.clients {
			select {
			case c.send <- msg:
			default:
				// 队列满 = 这个客户端消费不动(网络慢/卡死)。直接断开,
				// 不能让它把广播 goroutine 拖住,也不能无限缓冲吃内存。
				go h.removeClient(c)
			}
		}
		h.mu.Unlock()
	}
}

// probeWSClientIP 取对端 IP 用于限流。
// 注意:这里**不信任** X-Forwarded-For —— 公开端点上它可以随便伪造,
// 用它做 per-IP 限流等于没限。反代场景下所有连接会算到反代 IP 上,
// 此时全局上限 probeWSMaxClients 才是真正起作用的那道闸。
func probeWSClientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
