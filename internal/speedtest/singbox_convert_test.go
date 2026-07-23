package speedtest

import "testing"

// snell v6 检测:决定测速走 mihomo 还是 sing-box 内核的分叉点。
// clash_config JSON 解析出的数字是 float64;也兜底 int/string 形态。
func TestIsSnellV6Proxy(t *testing.T) {
	cases := []struct {
		name  string
		proxy map[string]any
		want  bool
	}{
		{"v6 float64(JSON 解析形态)", map[string]any{"type": "snell", "version": float64(6)}, true},
		{"v5 走 mihomo", map[string]any{"type": "snell", "version": float64(5)}, false},
		{"非 snell", map[string]any{"type": "vless", "version": float64(6)}, false},
		{"无 version", map[string]any{"type": "snell"}, false},
		{"string 形态", map[string]any{"type": "snell", "version": "6"}, true},
	}
	for _, c := range cases {
		if got := isSnellV6Proxy(c.proxy); got != c.want {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}

// clash → sing-box outbound 字段映射:port→server_port(int)、v6 mode 缺省补 default。
func TestClashSnellToSingboxOutbound(t *testing.T) {
	// 节点 clash_config 的真实形态(JSON 解析,数字为 float64)
	ob := clashSnellToSingboxOutbound(map[string]any{
		"type": "snell", "server": "us-a.example.com", "port": float64(28666),
		"psk": "testpsk", "version": float64(6), "mode": "default",
	})
	if ob["server"] != "us-a.example.com" || ob["server_port"] != 28666 || ob["psk"] != "testpsk" {
		t.Errorf("基础字段映射错误: %v", ob)
	}
	if ob["version"] != 6 || ob["mode"] != "default" {
		t.Errorf("version/mode 映射错误: %v", ob)
	}

	// mode 缺省 → 补 default(fork 服务端 v6Mode 空串也当 default,两边一致)
	ob2 := clashSnellToSingboxOutbound(map[string]any{
		"type": "snell", "server": "x", "port": float64(1), "psk": "p", "version": float64(6),
	})
	if ob2["mode"] != "default" {
		t.Errorf("mode 缺省应补 default,得到 %v", ob2["mode"])
	}
}
