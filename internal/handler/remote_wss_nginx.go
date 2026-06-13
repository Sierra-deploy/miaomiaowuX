package handler

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	texttemplate "text/template"

	"miaomiaowux/templates"
)

// VLESS WSS 入站 nginx 联动:
//   - 入站创建时:自动分配本地端口 + 随机 path,强制 listen 127.0.0.1 + security=none
//     (TLS 由 nginx 在 443 端口处理,xray 只负责 127.0.0.1:<port> 的 ws upgrade)
//   - 入站创建/删除后:聚合渲染该 server 全部 vless+ws 入站到一份 nginx domain.conf,
//     调 agent /api/child/nginx/setup-ssl 下发 + reload
//
// 与 reality 流程互斥(都覆盖 servers/{domain}.conf),设计上同一 server.domain 不应同时用两种。

const (
	wssPortRangeStart = 11000
	wssPortRangeEnd   = 19999
)

// wssServerLocks per-server mutex,防止并发添加 WSS 入站抢到同一端口。
var wssServerLocks sync.Map // serverID(int64) → *sync.Mutex

func wssServerLock(serverID int64) *sync.Mutex {
	v, _ := wssServerLocks.LoadOrStore(serverID, &sync.Mutex{})
	return v.(*sync.Mutex)
}

// 8 字符 a-z0-9 随机串,用于 ws path。
func randomWSPath() string {
	const charset = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "fallback1" // 极端罕见,撑住 nginx location 匹配即可
	}
	for i := range b {
		b[i] = charset[int(b[i])%len(charset)]
	}
	return "/ws/" + string(b)
}

// isVlessWSInboundReq 从 HandleInbounds 收到的 inboundReq 里判断是否 vless+ws 入站添加请求。
// 入参形如 {action: "add", inbound: {protocol, port, listen, streamSettings: {network, security, wsSettings: {path}}, ...}}。
func isVlessWSInboundReq(inboundReq map[string]interface{}) bool {
	inbound, _ := inboundReq["inbound"].(map[string]interface{})
	if inbound == nil {
		return false
	}
	if protocol, _ := inbound["protocol"].(string); strings.ToLower(protocol) != "vless" {
		return false
	}
	ss, _ := inbound["streamSettings"].(map[string]interface{})
	if ss == nil {
		return false
	}
	network, _ := ss["network"].(string)
	return network == "ws"
}

// preprocessWSSInbound 在 forward 之前对 vless+ws 入站强制注入安全默认值。
// 返回新的 body(已 marshal 好,可直接 forward)。
//
// 调用方持有 server-level 锁,内部扫端口安全。
func (h *RemoteManageHandler) preprocessWSSInbound(ctx context.Context, serverID int64, body []byte, inboundReq map[string]interface{}) ([]byte, error) {
	inbound, _ := inboundReq["inbound"].(map[string]interface{})
	if inbound == nil {
		return body, nil
	}

	// 强制 listen 127.0.0.1(xray 只接收 nginx 反代,不直接对外)
	inbound["listen"] = "127.0.0.1"

	// 自动分配未占用本地端口
	port, err := h.allocateWSSPort(ctx, serverID)
	if err != nil {
		return nil, fmt.Errorf("分配 WSS 本地端口失败: %v", err)
	}
	inbound["port"] = port

	// 强制 streamSettings.security="none"(TLS 给 nginx)
	ss, _ := inbound["streamSettings"].(map[string]interface{})
	if ss == nil {
		ss = map[string]interface{}{}
		inbound["streamSettings"] = ss
	}
	ss["network"] = "ws"
	ss["security"] = "none"

	// wsSettings.path 后端强制随机化(隐蔽性 + 避免前端默认 "/wss" 等可猜路径泄漏)。
	// 用户想要的可见 path 在节点详情可查。
	ws, _ := ss["wsSettings"].(map[string]interface{})
	if ws == nil {
		ws = map[string]interface{}{}
		ss["wsSettings"] = ws
	}
	ws["path"] = randomWSPath()

	newBody, err := json.Marshal(inboundReq)
	if err != nil {
		return nil, fmt.Errorf("重新序列化 inbound 失败: %v", err)
	}
	return newBody, nil
}

// allocateWSSPort 在 wssPortRangeStart-End 段挑一个未被该 server 现有 inbounds 占用的端口。
// 走 forward GET /api/child/inbounds 拿当前真实端口集(权威,不依赖 cache 的 snapshot)。
func (h *RemoteManageHandler) allocateWSSPort(ctx context.Context, serverID int64) (int, error) {
	used := make(map[int]struct{})
	if result, err := h.forwardToRemoteServer(ctx, serverID, http.MethodGet, "/api/child/inbounds", nil); err == nil {
		var resp struct {
			Inbounds []map[string]interface{} `json:"inbounds"`
		}
		if jerr := json.Unmarshal(result, &resp); jerr == nil {
			for _, ib := range resp.Inbounds {
				if p, ok := ib["port"].(float64); ok {
					used[int(p)] = struct{}{}
				}
			}
		}
	}

	// 从 start 顺序找第一个空闲;扫整段都满了直接报错(WSS 入站不应该有这么多)
	for p := wssPortRangeStart; p <= wssPortRangeEnd; p++ {
		if _, taken := used[p]; !taken {
			return p, nil
		}
	}
	return 0, fmt.Errorf("端口段 %d-%d 全被占用", wssPortRangeStart, wssPortRangeEnd)
}

// wssInboundInfo 渲染到 nginx 模板的单条 location 信息。
type wssInboundInfo struct {
	WSPath string
	Port   string
}

// SyncWSSNginx 查该 server 所有 vless+ws 入站,聚合渲染 nginx domain.conf 并下发 agent。
// 关键约束:
//   - server.domain 必须有(无域名直接跳过,日志即可)
//   - 根域必须有可用证书(无证书直接跳过 — 调用前前端已预检,只兜底)
//   - 不下发主 nginx.conf(留空),只覆盖 servers/{domain}.conf
//   - infos 为空(用户删完所有 WSS 入站)时也走渲染流程下发空 location 的 server 块,
//     借模板的 default `location / { return 404; }` 兜底,把旧 location 全部覆盖,避免死 backend 残留。
//
// 大写导出:nodes.go 的 deleteRemoteInbound 也要调,删节点路径不走 HandleInbounds remove。
func (h *RemoteManageHandler) SyncWSSNginx(ctx context.Context, serverID int64) error {
	server, err := h.repo.GetRemoteServer(ctx, serverID)
	if err != nil {
		return fmt.Errorf("server not found: %v", err)
	}
	domain := strings.ToLower(strings.TrimSpace(server.Domain))
	if domain == "" {
		log.Printf("[WSS-Nginx] server %d 无域名,跳过 nginx 下发", serverID)
		return nil
	}
	rootDomain := extractRootDomain(domain)

	// 证书查找优先级 (跟 reality 流程一致,见 remote_reality_domains.go HandleSetupSSL):
	//   1. per-server 精确匹配 (server_id=X, domain=rootDomain)
	//   2. 回退到全局通配证书 (server_id=0, domain="*."+rootDomain) — auto_deploy 会被推到 agent
	//   3. 都找不到 → 跳过
	var certDomain string
	if c, err := h.repo.GetCertificateByDomain(ctx, rootDomain, serverID); err == nil && c != nil {
		certDomain = c.Domain
	} else if c2, err2 := h.repo.GetCertificateByDomain(ctx, "*."+rootDomain, 0); err2 == nil && c2 != nil {
		certDomain = c2.Domain
	}
	if certDomain == "" {
		log.Printf("[WSS-Nginx] server %d domain=%s 根域=%s 无可用证书,跳过 nginx 下发", serverID, domain, rootDomain)
		return nil
	}
	certName := certDeployFilename(certDomain)

	// 拉全部 inbounds,过滤 vless+ws
	result, err := h.forwardToRemoteServer(ctx, serverID, http.MethodGet, "/api/child/inbounds", nil)
	if err != nil {
		return fmt.Errorf("拉取 inbounds 失败: %v", err)
	}
	var resp struct {
		Inbounds []map[string]interface{} `json:"inbounds"`
	}
	if err := json.Unmarshal(result, &resp); err != nil {
		return fmt.Errorf("解析 inbounds 失败: %v", err)
	}

	var infos []wssInboundInfo
	for _, ib := range resp.Inbounds {
		protocol, _ := ib["protocol"].(string)
		if strings.ToLower(protocol) != "vless" {
			continue
		}
		ss, _ := ib["streamSettings"].(map[string]interface{})
		if ss == nil {
			continue
		}
		if network, _ := ss["network"].(string); network != "ws" {
			continue
		}
		ws, _ := ss["wsSettings"].(map[string]interface{})
		if ws == nil {
			continue
		}
		path, _ := ws["path"].(string)
		if path == "" {
			continue
		}
		var portStr string
		if p, ok := ib["port"].(float64); ok {
			portStr = strconv.Itoa(int(p))
		} else if ps, ok := ib["port"].(string); ok {
			portStr = ps
		}
		if portStr == "" {
			continue
		}
		infos = append(infos, wssInboundInfo{WSPath: path, Port: portStr})
	}

	// 空 infos 也继续走模板渲染:渲染后是「只有 ssl 配置 + 默认 404 location」的 server 块,
	// 覆盖 servers/{domain}.conf 后,旧的 WSS location 全部被冲掉,不再残留死 backend。
	// 当前架构假设 WSS 与 reality 在同 domain 互斥(同 conf 文件覆盖),没有共存场景下的副作用。
	if len(infos) == 0 {
		log.Printf("[WSS-Nginx] server %d domain=%s 已无 vless+ws 入站,下发空 location 兜底(覆盖残留)", serverID, domain)
	}

	tplBytes, err := templates.ReadFile("wss_domain.conf.tpl")
	if err != nil {
		return fmt.Errorf("读取 wss 模板失败: %v", err)
	}
	tpl, err := texttemplate.New("wss").Parse(string(tplBytes))
	if err != nil {
		return fmt.Errorf("解析 wss 模板失败: %v", err)
	}
	data := struct {
		Domain   string
		CertName string
		Inbounds []wssInboundInfo
	}{Domain: domain, CertName: certName, Inbounds: infos}
	var buf bytes.Buffer
	if err := tpl.Execute(&buf, data); err != nil {
		return fmt.Errorf("渲染 wss 模板失败: %v", err)
	}

	payload, _ := json.Marshal(map[string]interface{}{
		"domain":        domain,
		"nginx_config":  "", // 留空 → agent 跳过主 nginx.conf 写入(reality 已下过的不动)
		"domain_config": buf.String(),
	})
	if _, err := h.forwardToRemoteServer(ctx, serverID, http.MethodPost, "/api/child/nginx/setup-ssl", payload); err != nil {
		return fmt.Errorf("下发 nginx 配置失败: %v", err)
	}
	log.Printf("[WSS-Nginx] server %d domain=%s 已下发 %d 条 WSS location", serverID, domain, len(infos))
	return nil
}
