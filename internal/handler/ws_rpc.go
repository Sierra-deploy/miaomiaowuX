package handler

// 通用 WS RPC:把 master → agent 反向控制(原本走 HTTP /api/child/*)挪到 WebSocket 通道上。
//
// 协议模式(已有 SendDomainLatencyProbe 模板,这里推广成通用):
//   1. master 生成 RequestID,把 (method, path, query, body) 包成 WSRPCCallPayload 通过 WS 发给 agent
//   2. master 在 pendingRPC sync.Map[reqID]chan reply 上挂一个 channel,select 等待 reply 或 timeout
//   3. agent 收到 rpc_call,把它转成 *http.Request 喂给内部 rpcMux(共享 /api/child/* handler 实例),
//      用一个 buffer ResponseWriter 接住响应,序列化为 WSRPCReplyPayload 用同一 reqID 回 master
//   4. master 在 handleConnection 主循环里收到 rpc_reply,按 RequestID 找回 channel,把响应 push 过去
//
// fallback 设计:
//   - agent 未上报 Capabilities.RPC(老 agent)→ master 直接走 HTTP,不调 CallAgent
//   - WS 连接已断 / pending reply 超时 / agent 端 panic → 返回 ErrWSRPCUnavailable,caller fallback HTTP
//   - HTTP-like 业务错误(status >= 400)→ 包装成 error 返回但**不**触发 fallback(业务语义错就是错)

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sync/atomic"
	"time"
)

const (
	WSMsgTypeRPCCall  = "rpc_call"
	WSMsgTypeRPCReply = "rpc_reply"
)

// WSRPCCallPayload master → agent。
type WSRPCCallPayload struct {
	RequestID string          `json:"request_id"`
	Method    string          `json:"method"`
	Path      string          `json:"path"`
	Query     string          `json:"query,omitempty"`
	Body      json.RawMessage `json:"body,omitempty"`
	// TimeoutMs 是 agent 内部执行限定时间(防 agent handler 死锁拖死整个 reply 通道)。
	// master 端 channel select timeout 比这个值多 2s 余量。
	TimeoutMs int `json:"timeout_ms,omitempty"`
}

// WSRPCReplyPayload agent → master。
type WSRPCReplyPayload struct {
	RequestID string          `json:"request_id"`
	Status    int             `json:"status"`           // HTTP-like:200 / 400 / 500
	Body      json.RawMessage `json:"body,omitempty"`
	Error     string          `json:"error,omitempty"`  // agent 端非业务异常(panic / decode 失败)
}

// ErrWSRPCUnavailable 表示 WS RPC 通道不可用 — 调用方应 fallback 到 HTTP。
// 业务层错误(handler 返回 4xx/5xx)不属于这种,会直接通过 error 透传业务原因。
var ErrWSRPCUnavailable = errors.New("ws rpc unavailable")

// HTTPLikeError master 端把 agent reply 的非 2xx 包成 error,语义跟原 HTTP 路径
// "remote server returned status %d: %s" 一致,前端 toast 文案对齐。
type HTTPLikeError struct {
	Status int
	Body   []byte
}

func (e *HTTPLikeError) Error() string {
	return fmt.Sprintf("remote server returned status %d: %s", e.Status, string(e.Body))
}

// rpcReqCounter 用于生成 RequestID,跟时间戳一起防 nano 碰撞(高并发批量 RPC 时同纳秒可能撞)。
var rpcReqCounter uint64

func nextRPCRequestID(serverID int64) string {
	return fmt.Sprintf("%d-%d-%d", serverID, time.Now().UnixNano(), atomic.AddUint64(&rpcReqCounter, 1))
}

// CallAgent 给 forwardToRemoteServer 用 — master → agent 反向 RPC 调用。
//
//   - 必须已经通过 GetConnectionByServerID 拿到 wsConn 且 wsConn.Capabilities.RPC=true(调用方负责检查)
//   - timeout 是 master 端 channel select 的总等待,agent 内部超时 = timeout - 2s
//   - 返回 (status, body, err):
//     - WS 通道异常(连接断 / pending timeout)→ err = ErrWSRPCUnavailable,调用方 fallback HTTP
//     - agent reply.Error 非空(agent 内部 panic 等)→ err 含 reply.Error,**不** fallback
//     - status >= 400 → 把 (status, body) 包成 *HTTPLikeError 返回,**不** fallback
//     - status 2xx → status, body, nil
func (h *RemoteWSHandler) CallAgent(
	ctx context.Context,
	serverID int64,
	method, path, query string,
	body []byte,
	timeout time.Duration,
) (status int, respBody []byte, err error) {
	wsConn, ok := h.GetConnectionByServerID(serverID)
	if !ok {
		return 0, nil, fmt.Errorf("%w: ws not connected", ErrWSRPCUnavailable)
	}
	if !wsConn.Capabilities.RPC {
		return 0, nil, fmt.Errorf("%w: agent does not advertise rpc capability", ErrWSRPCUnavailable)
	}

	reqID := nextRPCRequestID(serverID)
	innerTimeoutMs := int(timeout / time.Millisecond) - 2000
	if innerTimeoutMs < 1000 {
		innerTimeoutMs = 1000
	}

	resultCh := make(chan WSRPCReplyPayload, 1)
	h.pendingRPC.Store(reqID, resultCh)
	defer func() {
		h.pendingRPC.Delete(reqID)
		// 不 close resultCh — routeRPCReply 用 non-blocking send,close 后 race 风险更大
	}()

	callPayload := WSRPCCallPayload{
		RequestID: reqID,
		Method:    method,
		Path:      path,
		Query:     query,
		Body:      json.RawMessage(body),
		TimeoutMs: innerTimeoutMs,
	}
	payloadBytes, err := json.Marshal(callPayload)
	if err != nil {
		return 0, nil, fmt.Errorf("marshal rpc call: %w", err)
	}

	wsConn.mu.Lock()
	sendErr := h.sendEncryptedMessage(wsConn, WSMessage{
		Type:    WSMsgTypeRPCCall,
		Payload: payloadBytes,
	})
	wsConn.mu.Unlock()
	if sendErr != nil {
		return 0, nil, fmt.Errorf("%w: send rpc_call: %v", ErrWSRPCUnavailable, sendErr)
	}

	select {
	case reply := <-resultCh:
		if reply.Error != "" {
			return reply.Status, reply.Body, fmt.Errorf("agent rpc error: %s", reply.Error)
		}
		if reply.Status >= 400 {
			return reply.Status, reply.Body, &HTTPLikeError{Status: reply.Status, Body: reply.Body}
		}
		return reply.Status, reply.Body, nil
	case <-ctx.Done():
		return 0, nil, fmt.Errorf("%w: ctx done: %v", ErrWSRPCUnavailable, ctx.Err())
	case <-time.After(timeout):
		return 0, nil, fmt.Errorf("%w: master timeout after %v", ErrWSRPCUnavailable, timeout)
	}
}

// tryWSRPC 给 forwardToRemoteServer 用 — 先决定是否走 WS RPC,执行后返回:
//
//	ok=true,err=nil       业务成功(2xx,respBody 是 agent reply body)
//	ok=true,err!=nil       业务错误(4xx/5xx 或 agent 内部 panic),不应 fallback HTTP
//	ok=false,err=nil       WS 不可用 / agent 老版本,调用方 fallback HTTP
//
// 路径中的 query string(老调用方习惯把 ?xxx=yyy 拼在 path 末尾)拆开传给 agent,
// agent 那边构造 *http.Request 时再合回去,避免 ServeMux 路径匹配把 query 当路径处理。
func (h *RemoteManageHandler) tryWSRPC(ctx context.Context, serverID int64, method, path string, body []byte) ([]byte, bool, error) {
	if h.wsHandler == nil {
		return nil, false, nil
	}
	wsConn, connected := h.wsHandler.GetConnectionByServerID(serverID)
	if !connected || !wsConn.Capabilities.RPC {
		return nil, false, nil
	}

	cleanPath, query := splitPathQuery(path)
	// 30s 总超时与 doPlainPullRequest / doEncryptedPullRequest 的 http.Client 默认 timeout 同款,
	// 跨长 op(xray restart)够用,跨短 op 也不会拖延 fallback。
	const wsRPCTimeout = 30 * time.Second
	status, respBody, err := h.wsHandler.CallAgent(ctx, serverID, method, cleanPath, query, body, wsRPCTimeout)
	if err != nil {
		if errors.Is(err, ErrWSRPCUnavailable) {
			log.Printf("[Remote Manage] WS RPC unavailable for server %d (%v), falling back to HTTP", serverID, err)
			return nil, false, nil
		}
		// 业务错误(*HTTPLikeError 或 agent reply.Error)— 透传给调用方,不 fallback
		return respBody, true, err
	}
	_ = status
	return respBody, true, nil
}

// splitPathQuery 把 "/api/child/foo?bar=1&baz=2" 拆成 ("/api/child/foo", "bar=1&baz=2")。
// 没 query 返回原 path + 空字符串。
func splitPathQuery(p string) (string, string) {
	if i := indexByte(p, '?'); i >= 0 {
		return p[:i], p[i+1:]
	}
	return p, ""
}

func indexByte(s string, c byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == c {
			return i
		}
	}
	return -1
}

// routeRPCReply 由 handleConnection 主循环在收到 WSMsgTypeRPCReply 时调用,
// 按 RequestID 找回 pending channel,把 reply push 过去。找不到 = 已超时被清理,丢弃即可。
func (h *RemoteWSHandler) routeRPCReply(payload json.RawMessage) {
	var reply WSRPCReplyPayload
	if err := json.Unmarshal(payload, &reply); err != nil {
		log.Printf("[Remote WS] Invalid rpc_reply payload: %v", err)
		return
	}
	chAny, ok := h.pendingRPC.Load(reply.RequestID)
	if !ok {
		log.Printf("[Remote WS] rpc_reply with unknown/expired request_id=%s", reply.RequestID)
		return
	}
	ch, _ := chAny.(chan WSRPCReplyPayload)
	if ch == nil {
		return
	}
	// non-blocking send:CallAgent 的 select 还在等,channel 容量 1,正常 send 成功
	select {
	case ch <- reply:
	default:
		log.Printf("[Remote WS] rpc_reply dropped (channel full) request_id=%s", reply.RequestID)
	}
}
