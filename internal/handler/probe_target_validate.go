package handler

import (
	"errors"
	"fmt"
	"net"
	"strings"
)

// 自定义 ping 目标的校验。
//
// 为什么需要:在开放自定义目标之前,所有 host 都来自 CDN 白名单端点(zstaticcdn.com),
// 保存路径可以完全信任。一旦允许管理员填任意 host,主控就能让**所有 agent**去 connect
// 任意地址 —— 这是把面板变成分布式内网扫描器。agent 通常与业务同机房/同内网,
// 探测结果(通/不通、耗时)会回传到主控页面上,足以拿来摸内网拓扑。
//
// 所以这里挡住私网/环回/链路本地/云元数据地址,并且**解析域名之后再校验一次**
// —— 否则一个解析到 169.254.169.254 的域名就能绕过纯字符串检查(DNS rebinding)。

var errPrivateTarget = errors.New("目标指向内网/保留地址,不允许作为探测目标")

// probeTargetBlockedNets 是禁止作为探测目标的网段。
var probeTargetBlockedNets = func() []*net.IPNet {
	cidrs := []string{
		"0.0.0.0/8",          // 本网络
		"10.0.0.0/8",         // RFC1918
		"100.64.0.0/10",      // CGNAT
		"127.0.0.0/8",        // 环回
		"169.254.0.0/16",     // 链路本地(含 169.254.169.254 云元数据)
		"172.16.0.0/12",      // RFC1918
		"192.0.0.0/24",       // IETF 协议分配
		"192.168.0.0/16",     // RFC1918
		"198.18.0.0/15",      // 基准测试
		"224.0.0.0/4",        // 组播
		"240.0.0.0/4",        // 保留
		"255.255.255.255/32", // 广播
		"::1/128",            // IPv6 环回
		"fc00::/7",           // IPv6 ULA
		"fe80::/10",          // IPv6 链路本地
		"ff00::/8",           // IPv6 组播
	}
	out := make([]*net.IPNet, 0, len(cidrs))
	for _, c := range cidrs {
		if _, n, err := net.ParseCIDR(c); err == nil {
			out = append(out, n)
		}
	}
	return out
}()

// isBlockedProbeIP 判断一个 IP 是否落在禁止网段。
func isBlockedProbeIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() || ip.IsUnspecified() {
		return true
	}
	for _, n := range probeTargetBlockedNets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// validateCustomPingTarget 校验一个管理员自填的 ping 目标。
// 内置目标(builtinIntlByKey / CDN 来源)不走这里 —— 它们的 host 不可篡改。
//
// 注意:域名解析结果可能随时间变化,这里只能拦住"保存时就指向内网"的情况。
// 想彻底堵死 rebinding 需要 agent 在拨测前也校验一次,那是纵深防御的下一层。
func validateCustomPingTarget(t ProbePingTarget) error {
	host := strings.TrimSpace(t.Host)
	if host == "" {
		return errors.New("目标地址不能为空")
	}
	if len(host) > 253 {
		return errors.New("目标地址过长")
	}
	// 挡住带 scheme / 路径 / 端口的输入,避免 "http://x" 或 "1.2.3.4:22" 这类
	// 混入 host 字段后在 agent 侧被 JoinHostPort 拼成奇怪的地址。
	if strings.ContainsAny(host, "/\\ \t@?#") {
		return errors.New("目标地址只能是域名或 IP,不要带协议、端口或路径")
	}
	if t.Port < 0 || t.Port > 65535 {
		return errors.New("端口超出范围")
	}
	if t.Type != "" && t.Type != "tcp" && t.Type != "icmp" {
		return errors.New("探测方式只能是 tcp 或 icmp")
	}
	// TCP 必须有端口(agent 侧 port<=0 会默认 80,但那是给老配置的兼容,新建的应当明确)。
	if t.Type != "icmp" && t.Port == 0 {
		return errors.New("TCP 探测必须指定端口")
	}

	// 字面量 IP:直接判。
	if ip := net.ParseIP(host); ip != nil {
		if isBlockedProbeIP(ip) {
			return errPrivateTarget
		}
		return nil
	}

	// 域名:解析后逐个判。解析不了就拒绝 —— 保存一个当前不可解析的目标没有意义,
	// 而且会让 agent 每个周期都白跑一次 DNS。
	ips, err := net.LookupIP(host)
	if err != nil {
		return fmt.Errorf("无法解析域名 %s: %w", host, err)
	}
	if len(ips) == 0 {
		return fmt.Errorf("域名 %s 未解析到任何地址", host)
	}
	for _, ip := range ips {
		if isBlockedProbeIP(ip) {
			return errPrivateTarget
		}
	}
	return nil
}

// isBuiltinPingTargetKey 判断 key 是否来自内置国际清单。
func isBuiltinPingTargetKey(key string) bool {
	_, ok := builtinIntlByKey[key]
	return ok
}

// isCustomPingTargetKey 自定义目标统一用 custom- 前缀,便于保存路径区分是否要校验。
func isCustomPingTargetKey(key string) bool {
	return strings.HasPrefix(key, "custom-")
}

// validatePingTargetList 校验一批目标。内置(国际清单)与 CDN 来源的目标直接放行 ——
// 它们的 host 是常量/白名单端点来的,不可篡改;只有 custom- 前缀的自填目标要过 SSRF 检查。
func validatePingTargetList(targets []ProbePingTarget) error {
	for _, t := range targets {
		if t.Type != "" && t.Type != "tcp" && t.Type != "icmp" {
			return fmt.Errorf("目标 %s 的探测方式无效", t.Key)
		}
		if !isCustomPingTargetKey(t.Key) {
			continue // 内置 / CDN 目标
		}
		if err := validateCustomPingTarget(t); err != nil {
			label := t.Label
			if label == "" {
				label = t.Host
			}
			return fmt.Errorf("自定义目标「%s」: %w", label, err)
		}
	}
	return nil
}
