package handler

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"
)

// fetchPeerCertSha256 对 address:port 做 TLS handshake,返回第一张 peer cert 的 SHA256(hex)。
//   - InsecureSkipVerify=true:我们就是要任意证书的 sha256,不要被 chain 校验失败挡掉
//   - ServerName 取 sni;为空则用 address(避免空 SNI 命中默认证书)
//   - alpn 用 "," 分隔(跟 xray tlsSettings.alpn 同源),空则不设
//   - ctx 超时优先;无超时时 fallback 10s 不让线程卡死
func fetchPeerCertSha256(ctx context.Context, address string, port int, sni, alpn string) (string, error) {
	addr := strings.TrimSpace(address)
	if addr == "" {
		return "", errors.New("address required")
	}
	if port <= 0 || port > 65535 {
		return "", fmt.Errorf("invalid port: %d", port)
	}
	servername := strings.TrimSpace(sni)
	if servername == "" {
		servername = addr
	}

	// dialer 超时:取 ctx deadline,没有就 10s
	timeout := 10 * time.Second
	if deadline, ok := ctx.Deadline(); ok {
		if rem := time.Until(deadline); rem > 0 && rem < timeout {
			timeout = rem
		}
	}
	dialer := &net.Dialer{Timeout: timeout}

	cfg := &tls.Config{
		InsecureSkipVerify: true, // #nosec G402 -- 目的就是无校验拿任意 peer cert sha256
		ServerName:         servername,
	}
	if a := strings.TrimSpace(alpn); a != "" {
		parts := strings.Split(a, ",")
		for i, p := range parts {
			parts[i] = strings.TrimSpace(p)
		}
		cfg.NextProtos = parts
	}

	conn, err := tls.DialWithDialer(dialer, "tcp",
		net.JoinHostPort(addr, strconv.Itoa(port)), cfg)
	if err != nil {
		return "", fmt.Errorf("tls dial %s:%d: %w", addr, port, err)
	}
	defer conn.Close()

	certs := conn.ConnectionState().PeerCertificates
	if len(certs) == 0 {
		return "", errors.New("no peer certificate received")
	}
	sum := sha256.Sum256(certs[0].Raw)
	return hex.EncodeToString(sum[:]), nil
}
