package handler

import (
	"testing"

	"miaomiaowux/internal/storage"
)

// 复现并回归「中转/外部节点订阅用错凭据」bug:节点 OriginalServer 为空(host 未命中已注册服务器 →
// enforceLicenseIfNodeHostMatchesServer 不 claim,常见于外部中转 / 手动节点)时,订阅必须按
// inbound_tag 兜底套用该用户的 per-user 凭据 —— 否则静默回退到节点自带的基础凭据(创建者/admin),
// 导致流量算 admin、删号/解绑后仍可连。
func TestApplyUserCredentialsFallbackByInboundTag(t *testing.T) {
	credMap := map[credKey]string{
		{serverName: "🇺🇸 美国 Akko SJC", inboundTag: "mmwx-src"}: `{"id":"per-user-uuid","email":"u__mmwx-src"}`,
	}
	// OriginalServer 空 = bug 触发条件;clash 自带的是基础 uuid。
	node := storage.Node{OriginalServer: "", InboundTag: "mmwx-src", Protocol: "vless"}
	proxy := map[string]any{"uuid": "base-uuid", "type": "vless"}

	applyUserCredentials(proxy, node, credMap)

	if proxy["uuid"] != "per-user-uuid" {
		t.Fatalf("OriginalServer 空时应按 inbound_tag 兜底套用 per-user 凭据,实际 uuid=%v(仍是基础凭据=bug 未修)", proxy["uuid"])
	}
}

// 精确 {server,tag} 匹配优先且仍生效(未破坏原有行为)。
func TestApplyUserCredentialsExactMatchStillWorks(t *testing.T) {
	credMap := map[credKey]string{
		{serverName: "SrvA", inboundTag: "tag1"}: `{"id":"uuid-a","email":"u__tag1"}`,
	}
	node := storage.Node{OriginalServer: "SrvA", InboundTag: "tag1", Protocol: "vless"}
	proxy := map[string]any{"uuid": "base-uuid", "type": "vless"}

	applyUserCredentials(proxy, node, credMap)

	if proxy["uuid"] != "uuid-a" {
		t.Fatalf("精确匹配应套用 per-user 凭据,实际 uuid=%v", proxy["uuid"])
	}
}

// 同一 inbound_tag 分布在多台服务器 → tag 兜底有歧义,不应乱套(保持基础凭据);
// 但 OriginalServer 指定时精确匹配仍按服务器区分。
func TestApplyUserCredentialsAmbiguousTagNoGuess(t *testing.T) {
	credMap := map[credKey]string{
		{serverName: "SrvA", inboundTag: "shared"}: `{"id":"uuid-a","email":"u__shared"}`,
		{serverName: "SrvB", inboundTag: "shared"}: `{"id":"uuid-b","email":"u__shared"}`,
	}
	// OriginalServer 空 + 歧义 tag → 不兜底,保持基础凭据(避免错配到别的服务器)。
	nodeAmbig := storage.Node{OriginalServer: "", InboundTag: "shared", Protocol: "vless"}
	proxyAmbig := map[string]any{"uuid": "base-uuid", "type": "vless"}
	applyUserCredentials(proxyAmbig, nodeAmbig, credMap)
	if proxyAmbig["uuid"] != "base-uuid" {
		t.Fatalf("歧义 tag 不应乱套凭据,应保持基础,实际 uuid=%v", proxyAmbig["uuid"])
	}
	// 指定 OriginalServer=SrvB → 精确命中 uuid-b。
	nodeExact := storage.Node{OriginalServer: "SrvB", InboundTag: "shared", Protocol: "vless"}
	proxyExact := map[string]any{"uuid": "base-uuid", "type": "vless"}
	applyUserCredentials(proxyExact, nodeExact, credMap)
	if proxyExact["uuid"] != "uuid-b" {
		t.Fatalf("精确 {server,tag} 匹配应区分服务器,实际 uuid=%v", proxyExact["uuid"])
	}
}
