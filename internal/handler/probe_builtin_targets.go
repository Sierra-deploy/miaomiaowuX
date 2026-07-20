package handler

// 内置国际探测目标。与 CDN 省市列表(probe_cdn_proxy.go,来自 zstaticcdn.com)并列,
// 不混进 provinces/cities —— 那两个的 ISP 语义是三大运营商,国际目标塞进去前端渲染会掉 fallback。
//
// 为什么放后端常量而不是前端:目标 host 决定了 agent 会去连哪里(remote_ws.go 下发),
// 属于安全边界内的数据。放前端等于让前端可以提交任意 host,保存路径就必须做完整 SSRF 校验;
// 后端常量则天然不可篡改(自定义目标另有校验,见 validateCustomPingTarget)。

// IntlTarget 是一个内置国际目标。
type IntlTarget struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Host  string `json:"host"`
	Port  int    `json:"port"`
	Type  string `json:"type"`  // tcp / icmp
	Group string `json:"group"` // 前端分组展示用
}

// builtinIntlTargets 是给用户勾选的国际目标候选。
//
//   - 公共 DNS 用 ICMP:它们是 anycast,ICMP 最接近"网络可达性"的原始语义,
//     且不受目标端口是否开放影响。
//   - Telegram DC 和网站类用 TCP 443:这些目标普遍不回 ICMP(或被沿途丢弃),
//     而且用户真正关心的是"能不能建连",TCP 更贴近实际体验。
//   - 网站类用域名而非 IP:测的是含 DNS 解析的真实可达性,对代理场景更有参考价值。
var builtinIntlTargets = []IntlTarget{
	// —— 公共 DNS(ICMP) ——
	{Key: "intl-dns-cloudflare", Label: "Cloudflare DNS", Host: "1.1.1.1", Port: 0, Type: "icmp", Group: "公共 DNS"},
	{Key: "intl-dns-google", Label: "Google DNS", Host: "8.8.8.8", Port: 0, Type: "icmp", Group: "公共 DNS"},
	{Key: "intl-dns-quad9", Label: "Quad9 DNS", Host: "9.9.9.9", Port: 0, Type: "icmp", Group: "公共 DNS"},
	{Key: "intl-dns-opendns", Label: "OpenDNS", Host: "208.67.222.222", Port: 0, Type: "icmp", Group: "公共 DNS"},

	// —— Telegram 数据中心(TCP 443)。IP 取自官方文档公布的 DC 地址。 ——
	{Key: "intl-tg-dc1", Label: "Telegram DC1", Host: "149.154.175.50", Port: 443, Type: "tcp", Group: "Telegram"},
	{Key: "intl-tg-dc2", Label: "Telegram DC2", Host: "149.154.167.51", Port: 443, Type: "tcp", Group: "Telegram"},
	{Key: "intl-tg-dc3", Label: "Telegram DC3", Host: "149.154.175.100", Port: 443, Type: "tcp", Group: "Telegram"},
	{Key: "intl-tg-dc4", Label: "Telegram DC4", Host: "149.154.167.91", Port: 443, Type: "tcp", Group: "Telegram"},
	{Key: "intl-tg-dc5", Label: "Telegram DC5", Host: "91.108.56.130", Port: 443, Type: "tcp", Group: "Telegram"},

	// —— 主流网站(TCP 443) ——
	{Key: "intl-web-google", Label: "Google", Host: "www.google.com", Port: 443, Type: "tcp", Group: "主流网站"},
	{Key: "intl-web-youtube", Label: "YouTube", Host: "www.youtube.com", Port: 443, Type: "tcp", Group: "主流网站"},
	{Key: "intl-web-github", Label: "GitHub", Host: "github.com", Port: 443, Type: "tcp", Group: "主流网站"},
	{Key: "intl-web-cloudflare", Label: "Cloudflare", Host: "www.cloudflare.com", Port: 443, Type: "tcp", Group: "主流网站"},
	{Key: "intl-web-netflix", Label: "Netflix", Host: "www.netflix.com", Port: 443, Type: "tcp", Group: "主流网站"},
	{Key: "intl-web-openai", Label: "ChatGPT / OpenAI", Host: "chatgpt.com", Port: 443, Type: "tcp", Group: "主流网站"},
	{Key: "intl-web-discord", Label: "Discord", Host: "discord.com", Port: 443, Type: "tcp", Group: "主流网站"},
	{Key: "intl-web-steam", Label: "Steam", Host: "steamcommunity.com", Port: 443, Type: "tcp", Group: "主流网站"},
}

// builtinIntlByKey 供保存路径校验:内置 key 直接放行,不必过 SSRF 检查
// (它们是常量,host 不可能被篡改)。
var builtinIntlByKey = func() map[string]IntlTarget {
	m := make(map[string]IntlTarget, len(builtinIntlTargets))
	for _, t := range builtinIntlTargets {
		m[t.Key] = t
	}
	return m
}()
