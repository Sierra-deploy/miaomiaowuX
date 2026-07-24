package handler

import "testing"

// isV6Target 是「探测源无 v6 → v6 节点误报被墙」修复的分类基础:必须把字面 IPv6 目标认出来,
// 又不能把 v4 / 域名误判成 v6(否则会错误跳过它们的被墙判定)。
func TestIsV6Target(t *testing.T) {
	v6 := []string{
		"[2001:db8::1]:443",
		"[fe80::1]:8080",
		"[::1]:80",
		"[2408:8340:828:7340::1]:443", // 报修里的真实 v6 段
	}
	for _, tgt := range v6 {
		if !isV6Target(tgt) {
			t.Errorf("应识别为 v6: %q", tgt)
		}
	}
	notV6 := []string{
		"1.2.3.4:443",
		"192.168.0.1:8080",
		"example.com:443",  // 域名:无法从字符串定地址族,当非 v6
		"sub.a.b.com:2096", // 同上
		"",
	}
	for _, tgt := range notV6 {
		if isV6Target(tgt) {
			t.Errorf("不应识别为 v6: %q", tgt)
		}
	}
}
