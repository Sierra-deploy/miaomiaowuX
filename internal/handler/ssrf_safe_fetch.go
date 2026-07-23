package handler

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// SSRF 防护:用户可提交任意 URL 的服务端抓取(订阅导入 / 外部订阅流量探测)必须防止
// 被指向内网/云元数据地址,否则把主控变成内网扫描器 + 内网内容外泄通道
// (例:GET http://127.0.0.1:PORT/... 或 http://169.254.169.254/ 拿云凭据)。
//
// 关键:纯"解析域名后再校验"有 DNS-rebinding TOCTOU(校验时解析到公网 IP、真正拨号时
// 重新解析到内网 IP)。这里在 **DialContext 拨号时**校验实际要连的 IP,并直接拨号已校验的 IP
// (不再二次解析),彻底关闭 rebinding;重定向逐跳复用同一 DialContext + scheme 检查。

var errSSRFBlocked = errors.New("目标 URL 指向内网/保留地址,已拒绝(SSRF 防护)")

const maxFetchBodyBytes = 10 << 20 // 抓取响应体上限 10MB,防超大响应 OOM

// validateFetchURL 校验用户提交的抓取 URL:仅允许 http/https,必须带主机名。
func validateFetchURL(rawURL string) error {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return errors.New("无效的 URL")
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return errors.New("只允许 http/https 协议的订阅 URL")
	}
	if u.Hostname() == "" {
		return errors.New("URL 缺少主机名")
	}
	return nil
}

// ssrfSafeDialContext 解析目标后,若任一解析 IP 落在内网/保留段则拒绝;否则拨号已校验的 IP。
func ssrfSafeDialContext(base *net.Dialer) func(ctx context.Context, network, addr string) (net.Conn, error) {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		// 字面量 IP:直接判后拨号。
		if ip := net.ParseIP(host); ip != nil {
			if isBlockedProbeIP(ip) {
				return nil, errSSRFBlocked
			}
			return base.DialContext(ctx, network, addr)
		}
		// 域名:解析后逐个校验;任一命中内网即拒绝(rebinding 防御:宁可误杀)。
		ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, err
		}
		if len(ips) == 0 {
			return nil, fmt.Errorf("域名 %s 未解析到任何地址", host)
		}
		for _, ipa := range ips {
			if isBlockedProbeIP(ipa.IP) {
				return nil, errSSRFBlocked
			}
		}
		// 直接拨号已校验的 IP(不再二次解析)。HTTPS 的 SNI/证书校验仍用原 hostname(由 http.Transport 保持)。
		return base.DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
	}
}

// firstNonInternalIP 解析 host 并校验:任一解析 IP 落在内网/保留段则拒绝;否则返回第一个已校验 IP。
// 用于 tcping/探测等"连任意 host"的场景——直接连返回的 IP 可关闭 DNS-rebinding(校验后再解析到内网)。
func firstNonInternalIP(ctx context.Context, host string) (net.IP, error) {
	host = strings.TrimSpace(host)
	if host == "" {
		return nil, errors.New("目标地址不能为空")
	}
	if ip := net.ParseIP(host); ip != nil {
		if isBlockedProbeIP(ip) {
			return nil, errSSRFBlocked
		}
		return ip, nil
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, fmt.Errorf("无法解析域名 %s: %w", host, err)
	}
	if len(ips) == 0 {
		return nil, fmt.Errorf("域名 %s 未解析到任何地址", host)
	}
	for _, ipa := range ips {
		if isBlockedProbeIP(ipa.IP) {
			return nil, errSSRFBlocked
		}
	}
	return ips[0].IP, nil
}

// newSSRFSafeHTTPClient 返回一个连接时校验目标 IP 的 http.Client,用于抓取用户提交的 URL。
func newSSRFSafeHTTPClient(timeout time.Duration) *http.Client {
	base := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	return &http.Client{
		Timeout: timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("重定向次数过多")
			}
			// 重定向目标 scheme 也限 http/https;目标 IP 由 DialContext 逐跳校验(含 rebinding)。
			s := strings.ToLower(req.URL.Scheme)
			if s != "http" && s != "https" {
				return errors.New("重定向到非 http(s) 协议,已拒绝")
			}
			return nil
		},
		Transport: &http.Transport{
			DialContext:           ssrfSafeDialContext(base),
			TLSHandshakeTimeout:   10 * time.Second,
			ResponseHeaderTimeout: 20 * time.Second,
		},
	}
}
