package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"miaomiaowux/internal/storage"
)

// Tunnel(dokodemo-door 转发入站 + 端口转发路由)聚合管理:
//   - kind="inbound": protocol=tunnel 入站(新建模式产物 / 现有 tunnel)
//   - kind="routed":  outboundTag 以 "tunnel-" 开头的 routing rule(复用模式产物 — 加 freedom outbound + rule)
//
// 节点表里都没有这些条目,「Tunnel 管理」弹窗集中展示 + 删除。仅管理员;删除两种类型走不同 API:
// inbound 删 → /api/admin/remote/inbounds action=remove;routed 删 → 先 remove_rule(按 outboundTag 定位 index)再 remove outbound。

type TunnelsHandler struct {
	repo         *storage.TrafficRepository
	remoteManage *RemoteManageHandler
}

func NewTunnelsHandler(repo *storage.TrafficRepository, rm *RemoteManageHandler) *TunnelsHandler {
	return &TunnelsHandler{repo: repo, remoteManage: rm}
}

type tunnelInfo struct {
	// kind 区分两种来源,前端按此走不同 UI / 删除 flow。
	//   "inbound" — protocol=tunnel 入站(Tag, ListenPort, TargetAddress, TargetPort 都有意义)
	//   "routed"  — outboundTag tunnel-* 的 routing rule(Tag=outboundTag, MatchDomain/MatchIP 是命中条件,
	//               ListenPort 用对应 InboundTag 在 inbounds 里 lookup,TargetAddress/TargetPort 从 outbound.redirect 解析)
	Kind          string   `json:"kind"`
	ServerID      int64    `json:"server_id"`
	ServerName    string   `json:"server_name"`
	IsFederated   bool     `json:"is_federated"`
	Tag           string   `json:"tag"`
	ListenPort    int      `json:"listen_port"`
	TargetAddress string   `json:"target_address"`
	TargetPort    int      `json:"target_port"`
	Network       string   `json:"network"`
	InboundTag    string   `json:"inbound_tag,omitempty"`    // routed: rule.inboundTag[0]
	MatchDomain   []string `json:"match_domain,omitempty"`   // routed: rule.domain
	MatchIP       []string `json:"match_ip,omitempty"`       // routed: rule.ip
	RuleIndex     int      `json:"rule_index,omitempty"`     // routed: 删除时按 index 调 remove_rule(以拉取时为准,删前主控再 GET 一次校对)
}

func (h *TunnelsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, errors.New("only GET is supported"))
		return
	}
	servers, err := h.repo.ListRemoteServers(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	tunnels := make([]tunnelInfo, 0)
	for _, s := range servers {
		if s.Status != "connected" {
			continue
		}
		// 一次性拉完整 config:inbounds / outbounds / routing.rules 都用得上,比分别调 3 个 endpoint 省 RTT。
		// 注意:agent /api/child/xray/config 返回结构 {"config": "<JSON 字符串>"} — config 字段是字符串
		// 不是对象,所以这里要二次 Unmarshal 才能拿到内部结构。
		ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
		result, ferr := h.remoteManage.ForwardToServer(ctx, s.ID, "GET", "/api/child/xray/config", nil)
		cancel()
		if ferr != nil {
			continue
		}
		var envelope struct {
			Config string `json:"config"`
		}
		if json.Unmarshal(result, &envelope) != nil || envelope.Config == "" {
			continue
		}
		var xrayCfg map[string]any
		if json.Unmarshal([]byte(envelope.Config), &xrayCfg) != nil || xrayCfg == nil {
			continue
		}
		inbounds, _ := xrayCfg["inbounds"].([]any)
		outbounds, _ := xrayCfg["outbounds"].([]any)
		var rules []any
		if routing, ok := xrayCfg["routing"].(map[string]any); ok {
			rules, _ = routing["rules"].([]any)
		}

		_, fedErr := h.repo.GetFederatedServer(r.Context(), s.ID)
		isFed := fedErr == nil

		// 1) tunnel inbound 条目(排除基础设施:tunnel-in 是 reality 自盗回源;api 是 xray API 命令通道)
		//    + 同时建 tag→inbound 索引,routed 分支查端口用
		inboundByTag := map[string]map[string]any{}
		for _, ibAny := range inbounds {
			ib, ok := ibAny.(map[string]any)
			if !ok {
				continue
			}
			tag, _ := ib["tag"].(string)
			inboundByTag[tag] = ib
			if p, _ := ib["protocol"].(string); p != "tunnel" {
				continue
			}
			if tag == "tunnel-in" || tag == "api" {
				continue
			}
			ti := tunnelInfo{Kind: "inbound", ServerID: s.ID, ServerName: s.Name, IsFederated: isFed, Tag: tag}
			ti.ListenPort = toInt(ib["port"])
			if settings, ok := ib["settings"].(map[string]any); ok {
				ti.TargetAddress, _ = settings["address"].(string)
				ti.TargetPort = toInt(settings["port"])
				ti.Network, _ = settings["network"].(string)
			}
			tunnels = append(tunnels, ti)
		}

		// 2) routed_forward 条目:outboundTag tunnel-* 的 rule + 对应 outbound 的 redirect 信息
		outboundByTag := map[string]map[string]any{}
		for _, obAny := range outbounds {
			ob, ok := obAny.(map[string]any)
			if !ok {
				continue
			}
			if tag, _ := ob["tag"].(string); tag != "" {
				outboundByTag[tag] = ob
			}
		}
		for idx, rAny := range rules {
			rm, ok := rAny.(map[string]any)
			if !ok {
				continue
			}
			obTag, _ := rm["outboundTag"].(string)
			if !strings.HasPrefix(obTag, "tunnel-") {
				continue
			}
			ti := tunnelInfo{
				Kind:        "routed",
				ServerID:    s.ID,
				ServerName:  s.Name,
				IsFederated: isFed,
				Tag:         obTag,
				RuleIndex:   idx,
			}
			// inboundTag 是 array;取第一条作为「源 tunnel 入站 tag」
			if inTags, ok := rm["inboundTag"].([]any); ok && len(inTags) > 0 {
				if s, ok := inTags[0].(string); ok {
					ti.InboundTag = s
					if srcIb, ok := inboundByTag[s]; ok {
						ti.ListenPort = toInt(srcIb["port"])
					}
				}
			}
			ti.MatchDomain = toStringSlice(rm["domain"])
			ti.MatchIP = toStringSlice(rm["ip"])
			// freedom outbound 的 redirect 形如 "addr:port",拆出来回填 TargetAddress/TargetPort
			if ob, ok := outboundByTag[obTag]; ok {
				if settings, ok := ob["settings"].(map[string]any); ok {
					if redir, ok := settings["redirect"].(string); ok && redir != "" {
						parseHostPort(redir, &ti.TargetAddress, &ti.TargetPort)
					}
				}
			}
			tunnels = append(tunnels, ti)
		}
	}
	respondJSON(w, http.StatusOK, map[string]any{"success": true, "tunnels": tunnels})
}

func toInt(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case int64:
		return int(n)
	}
	return 0
}

func toStringSlice(v any) []string {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, item := range arr {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// parseHostPort 解析 "host:port" / "[ipv6]:port",回填 addr 和 port。失败保持原值。
func parseHostPort(s string, addr *string, port *int) {
	s = strings.TrimSpace(s)
	if s == "" {
		return
	}
	// IPv6 形如 [::1]:443
	if strings.HasPrefix(s, "[") {
		end := strings.Index(s, "]")
		if end > 0 && end+1 < len(s) && s[end+1] == ':' {
			*addr = s[1:end]
			*port = parseInt(s[end+2:])
			return
		}
	}
	idx := strings.LastIndex(s, ":")
	if idx <= 0 {
		*addr = s
		return
	}
	*addr = s[:idx]
	*port = parseInt(s[idx+1:])
}

func parseInt(s string) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0
		}
		n = n*10 + int(c-'0')
	}
	return n
}
