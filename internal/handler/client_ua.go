package handler

import (
	"net/http"
	"strings"
)

// 订阅 auto 模式:`?t=auto` 时按 User-Agent 推断客户端,下发对应格式。
//
// auto **只负责把 UA 翻译成一个 t 值**,翻译完就走和用户显式传 `?t=xxx` 完全相同的分支,
// 不新增任何转换路径。推断不出来时返回空串,调用方按"不带 t"处理 → Clash YAML。

// clientUARule 一条 UA 特征 → 客户端类型的映射。
type clientUARule struct {
	// keywords 任一命中即算匹配(全部转小写后比对)
	keywords []string
	client   string
}

// clientUARules 的**顺序即优先级**,靠前的先匹配。顺序错了会静默给出错误格式:
//
//   - Stash 的 UA 形如 `Stash/2.5.0 Clash/1.9.0`,含 "clash" 子串 → 必须排在 Clash 之前
//   - Surge Mac 的 UA 含 "surge" → 必须排在 Surge 之前
//
// 这是本功能唯一容易写错的地方,client_ua_test.go 里逐条钉死了。
var clientUARules = []clientUARule{
	{[]string{"stash"}, "stash"},
	{[]string{"shadowrocket"}, "shadowrocket"},
	{[]string{"surge mac", "surgemac"}, "surgemac"},
	{[]string{"surge"}, "surge"},
	{[]string{"loon"}, "loon"},
	// Quantumult X 的 UA 常见三种写法:URL 编码的 %20、真空格、无空格
	{[]string{"quantumult%20x", "quantumult x", "quantumultx"}, "qx"},
	{[]string{"egern"}, "egern"},
	{[]string{"surfboard"}, "surfboard"},
	// sing-box 官方各平台客户端:SFI(iOS) / SFA(Android) / SFM(macOS) / SFT(tvOS)
	{[]string{"sing-box", "sfi/", "sfa/", "sfm/", "sft/"}, "sing-box"},
	{[]string{"v2rayn", "v2rayng", "v2box"}, "v2ray"},
	// Clash 系放最后兜底:mihomo / Clash.Meta / clash-verge / ClashforWindows 都归到这里
	{[]string{"mihomo", "clash"}, "clash"},
}

// detectClientTypeFromUA 从 User-Agent 推断客户端类型。推断不出返回 ""。
// 纯函数,便于单测。
func detectClientTypeFromUA(ua string) string {
	ua = strings.ToLower(strings.TrimSpace(ua))
	if ua == "" {
		return ""
	}
	for _, rule := range clientUARules {
		for _, kw := range rule.keywords {
			if strings.Contains(ua, kw) {
				return rule.client
			}
		}
	}
	return ""
}

// resolveClientType 读取 ?t=,值为 auto 时按 User-Agent 推断真实客户端类型。
//
// 非 auto 的值原样返回(含空串),行为与改动前完全一致。
//
// 注意:**不是所有读 ?t= 的地方都该调它** —— subscription.go 里还有一处把 t 当
// "订阅文件名"解析的遗留逻辑(legacyName),那里必须读原始值。
func resolveClientType(r *http.Request) string {
	t := strings.TrimSpace(r.URL.Query().Get("t"))
	if !strings.EqualFold(t, "auto") {
		return t
	}
	return detectClientTypeFromUA(r.Header.Get("User-Agent"))
}
