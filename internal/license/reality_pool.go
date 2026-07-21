package license

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
)

// FeatureRealityPool 是 reality 共享域名池的 PRO 特性名,
// 与许可证服务器套餐 features 里配置的字符串必须完全一致。
const FeatureRealityPool = "reality_pool"

// RealityPoolDomain 是共享池下发的一条域名及其验证结果。
type RealityPoolDomain struct {
	Domain       string `json:"domain"`
	TLSVersion   string `json:"tls_version"`
	CipherSuite  string `json:"cipher_suite"`
	CurveID      string `json:"curve_id"`
	CertLen      int    `json:"cert_len"`
	Contributors int    `json:"contributors"`
}

// ErrRealityPoolUnavailable 表示当前许可证不具备共享池能力(未激活或无 PRO 特性)。
var ErrRealityPoolUnavailable = errors.New("共享域名池不可用:许可证无效或未包含该特性")

// realityPoolRequest 发一次共享池请求。三件套(key/machine_id/nonce)与心跳一致,
// 服务端用同一套校验;这里不复用 parseResponse——那个是解析许可证状态的,
// 共享池响应是普通业务数据,没有许可证签名字段。
func (m *Manager) realityPoolRequest(ctx context.Context, path string, extra map[string]any, out any) error {
	if m.key == "" || m.serverURL == "" {
		return ErrRealityPoolUnavailable
	}
	if !m.HasFeature(FeatureRealityPool) {
		return ErrRealityPoolUnavailable
	}

	payload := map[string]any{
		"key":        m.key,
		"machine_id": m.machineID,
		"nonce":      genNonce(),
	}
	for k, v := range extra {
		payload[k] = v
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.serverURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := m.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusForbidden {
		return ErrRealityPoolUnavailable
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("许可证服务器返回 %d", resp.StatusCode)
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// SubmitRealityDomains 上报可共享的偷取域名。
//
// 调用方**必须**先做隐私过滤——这里不做任何判断,传进来什么就发什么。
// 过滤逻辑在 internal/handler/reality_domain_share.go 的 selectShareableDomains。
func (m *Manager) SubmitRealityDomains(ctx context.Context, domains []string) ([]string, map[string]string, error) {
	if len(domains) == 0 {
		return nil, nil, nil
	}
	var res struct {
		Success  bool              `json:"success"`
		Accepted []string          `json:"accepted"`
		Rejected map[string]string `json:"rejected"`
		Error    string            `json:"error"`
	}
	if err := m.realityPoolRequest(ctx, "/api/v1/reality-domains/submit",
		map[string]any{"domains": domains}, &res); err != nil {
		return nil, nil, err
	}
	if !res.Success {
		return nil, nil, errors.New(res.Error)
	}
	return res.Accepted, res.Rejected, nil
}

// WithdrawRealityDomains 撤回本机对这些域名的贡献。
func (m *Manager) WithdrawRealityDomains(ctx context.Context, domains []string) ([]string, error) {
	if len(domains) == 0 {
		return nil, nil
	}
	var res struct {
		Success   bool     `json:"success"`
		Withdrawn []string `json:"withdrawn"`
		Error     string   `json:"error"`
	}
	if err := m.realityPoolRequest(ctx, "/api/v1/reality-domains/withdraw",
		map[string]any{"domains": domains}, &res); err != nil {
		return nil, err
	}
	if !res.Success {
		return nil, errors.New(res.Error)
	}
	return res.Withdrawn, nil
}

// ListRealityDomains 拉取共享池里已验证可用的域名。
func (m *Manager) ListRealityDomains(ctx context.Context) ([]RealityPoolDomain, error) {
	var res struct {
		Success bool                `json:"success"`
		Domains []RealityPoolDomain `json:"domains"`
		Error   string              `json:"error"`
	}
	if err := m.realityPoolRequest(ctx, "/api/v1/reality-domains/list", nil, &res); err != nil {
		return nil, err
	}
	if !res.Success {
		return nil, errors.New(res.Error)
	}
	return res.Domains, nil
}
