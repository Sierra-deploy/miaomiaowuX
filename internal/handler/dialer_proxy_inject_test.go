package handler

import "testing"

// 客户反馈:套餐短链接订阅里链式节点没注入 dialer-proxy,导致它跟原节点实际走同一条链路。
// injectDialerProxyRefs 是套餐订阅 / serveAllNodes 两条路径共用的注入核心,这里钉住它的两个关键行为:
//  1. 引用目标节点在本次输出里的**最终名字**(套餐倍率前缀会改名,必须引用改名后的);
//  2. 目标不在本次输出(被过滤 / 未加入套餐)→ 绝不写 dialer-proxy(否则 Mihomo 悬空引用报错)。
func TestInjectDialerProxyRefsUsesFinalNameAndSkipsDangling(t *testing.T) {
	// 节点 1 = 链式节点(chain → 节点 2);节点 2 = 落地出口,被倍率改名为 "「2」HK";
	// 节点 3 = 链式节点,但目标 99 不在输出里(未加入套餐)。
	chain := map[string]any{"name": "香港V6"}
	exit := map[string]any{"name": "「2」HK"} // 已被 applyMultiplierPrefix 改名后的最终名
	dangling := map[string]any{"name": "上海"}

	finalName := map[int64]string{
		1: "香港V6",
		2: "「2」HK",
		3: "上海",
		// 99 缺席
	}
	refs := []dialerRef{
		{proxy: chain, target: 2},
		{proxy: dangling, target: 99},
	}

	injectDialerProxyRefs(refs, finalName)

	if got := chain["dialer-proxy"]; got != "「2」HK" {
		t.Errorf("链式节点应引用目标的最终(改名后)名字 「2」HK,得到 %v", got)
	}
	if _, ok := dangling["dialer-proxy"]; ok {
		t.Errorf("目标缺席时不能注入 dialer-proxy(会产生悬空引用),但被注入了: %v", dangling["dialer-proxy"])
	}
	_ = exit
}

// 客户反馈:全局 API token 解析出的虚拟用户名 api-token-admin 被 userIsAdmin 误判为非管理员
// (GetUser 查不到 → /api/admin/nodes 返回空列表)。这两个分支在 GetUser 之前返回,不碰 repo。
func TestUserIsAdminRecognizesAPITokenAdmin(t *testing.T) {
	if !userIsAdmin(t.Context(), nil, "api-token-admin") {
		t.Error("api-token-admin 应被识别为管理员")
	}
	if userIsAdmin(t.Context(), nil, "") {
		t.Error("空用户名不应是管理员")
	}
}
