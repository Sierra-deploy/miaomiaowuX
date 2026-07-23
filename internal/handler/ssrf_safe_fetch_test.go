package handler

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// tcping 开放给普通用户;必须拒绝探测内网/保留地址,否则是内网端口扫描器。
func TestTcpingRejectsInternalHost(t *testing.T) {
	internal := []string{"127.0.0.1", "169.254.169.254", "10.0.0.1", "192.168.0.1", "172.16.0.1", "::1"}
	for _, h := range internal {
		resp := pingOne(context.Background(), TCPingRequest{Host: h, Port: 80}, time.Second)
		if resp.Success {
			t.Errorf("tcping 不应能探测内网 %s", h)
		}
		if !strings.Contains(resp.Error, "内网") {
			t.Errorf("host %s 应被 SSRF 拦截(而非连接失败),实际: %s", h, resp.Error)
		}
	}
}

// 复现漏洞并验证已堵:用 SSRF 安全客户端去 GET 本机 127.0.0.1 上的服务(正是漏洞被利用的目标),
// 必须被拒绝——否则任意登录用户就能让主控抓 http://127.0.0.1:PORT/... 拿内网内容。
func TestSSRFSafeClientBlocksLoopback(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"secret":"internal-data"}`)) // JSON 也是合法 YAML → 老代码会存下来外泄
	}))
	defer srv.Close()

	client := newSSRFSafeHTTPClient(5 * time.Second)
	resp, err := client.Get(srv.URL) // srv.URL = http://127.0.0.1:PORT
	if err == nil {
		resp.Body.Close()
		t.Fatal("SSRF 安全客户端不应能连上 127.0.0.1 内网服务")
	}
	if !strings.Contains(err.Error(), "内网") {
		t.Errorf("应为 SSRF 拦截错误,实际: %v", err)
	}
}

func TestValidateFetchURL(t *testing.T) {
	bad := []string{"", "notaurl", "http://", "file:///etc/passwd", "gopher://127.0.0.1:6379/_", "ftp://x/y", "dict://x"}
	for _, u := range bad {
		if err := validateFetchURL(u); err == nil {
			t.Errorf("应拒绝非法/危险 URL: %q", u)
		}
	}
	good := []string{"http://example.com/sub", "https://sub.example.com:8443/path?token=x"}
	for _, u := range good {
		if err := validateFetchURL(u); err != nil {
			t.Errorf("应接受合法 http(s) URL %q: %v", u, err)
		}
	}
}

func TestIsBlockedProbeIPForSSRF(t *testing.T) {
	blocked := []string{"127.0.0.1", "169.254.169.254", "10.0.0.5", "192.168.1.1", "172.16.0.1", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fc00::1"}
	for _, s := range blocked {
		if !isBlockedProbeIP(net.ParseIP(s)) {
			t.Errorf("内网/保留地址应被拦截: %s", s)
		}
	}
	allowed := []string{"8.8.8.8", "1.1.1.1", "93.184.216.34"}
	for _, s := range allowed {
		if isBlockedProbeIP(net.ParseIP(s)) {
			t.Errorf("公网地址不应被拦截: %s", s)
		}
	}
}
