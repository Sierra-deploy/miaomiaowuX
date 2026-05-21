package license

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"
)

type PlanInfo struct {
	Name        string   `json:"name"`
	DisplayName string   `json:"display_name"`
	Description string   `json:"description,omitempty"`
	MaxServers  int      `json:"max_servers"`
	MaxNodes    int      `json:"max_nodes"`
	MaxUsers    int      `json:"max_users"`
	Features    []string `json:"features"`
}

type Status struct {
	Valid      bool      `json:"valid"`
	Error      string    `json:"error,omitempty"`
	MaxServers int       `json:"max_servers"`
	ExpiresAt  string    `json:"expires_at,omitempty"`
	Plan       *PlanInfo `json:"plan,omitempty"`
	LastCheck  time.Time `json:"last_check"`

	// HardRevoked 为 true 表示 license 服务器明确返回了"无效"(unbind / revoked / expired / wrong machine_id),
	// 跟"网络故障导致没拿到响应"区分开。IsValid() 在 HardRevoked=true 时直接 return false,
	// 不再走 24h grace period;反之网络故障下保留 grace,容忍短暂中断。
	HardRevoked bool `json:"hard_revoked,omitempty"`
}

func (s *Status) HasFeature(name string) bool {
	if s.Plan == nil {
		return false
	}
	for _, f := range s.Plan.Features {
		if f == name {
			return true
		}
	}
	return false
}

var defaultStatus = Status{
	Valid:      true,
	MaxServers: 5,
	Plan: &PlanInfo{
		Name:        "TRIAL",
		DisplayName: "试用版",
		MaxServers:  5,
		MaxNodes:    20,
		MaxUsers:    10,
		Features:    nil,
	},
}

// SettingsGetter is kept for backward compatibility.
type SettingsGetter interface {
	GetSystemSetting(ctx context.Context, key string) (string, error)
}

// SettingsStore extends SettingsGetter with write capability.
type SettingsStore interface {
	GetSystemSetting(ctx context.Context, key string) (string, error)
	SetSystemSetting(ctx context.Context, key, value string) error
}

// UsageReporter 让 manager 在心跳时取本机当前 license 占用数。
// 通常用 *storage.TrafficRepository 实现(已在 storage.LicenseUsage 提供)。
// 实现可以返回 err 表示采集失败,heartbeat 会跳过 usage 字段不影响验签。
type UsageReporter interface {
	LicenseUsage(ctx context.Context) (servers, nodes, users int, err error)
}

type Manager struct {
	mu        sync.RWMutex
	status    Status
	serverURL string
	key       string
	machineID string
	settings  SettingsStore
	usage     UsageReporter
	client    *http.Client
	cancel    context.CancelFunc
}

// SetUsageReporter 注入 usage 来源,启动前调一次。nil 时 heartbeat payload 不带 used_* 字段。
func (m *Manager) SetUsageReporter(r UsageReporter) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.usage = r
}

const DefaultServerURL = "https://license.miaomiaowu.net"

func NewManager(settings SettingsStore, machineID string) *Manager {
	return &Manager{
		status:    defaultStatus,
		serverURL: DefaultServerURL,
		machineID: machineID,
		settings:  settings,
		client:    &http.Client{Timeout: 15 * time.Second},
	}
}

func (m *Manager) Start(ctx context.Context) {
	ctx, m.cancel = context.WithCancel(ctx)

	m.loadSettings(ctx)
	m.loadPersistedStatus(ctx)

	if m.key != "" && m.serverURL != "" {
		m.activate(ctx)
	}

	go m.heartbeatLoop(ctx)
}

func (m *Manager) Stop() {
	if m.cancel != nil {
		m.cancel()
	}
}

func (m *Manager) GetStatus() Status {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.status
}

func (m *Manager) IsValid() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.status.HardRevoked {
		// 服务器明确否决 → 立即失效,不进 grace。
		return false
	}
	if !m.status.Valid {
		// valid=false 但不是 HardRevoked → 通常是网络故障 / 启动期未 activate,允许 grace。
		return m.withinGracePeriod()
	}
	return true
}

func (m *Manager) HasFeature(name string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.status.HasFeature(name)
}

func (m *Manager) Refresh(ctx context.Context) {
	m.loadSettings(ctx)
	if m.key != "" && m.serverURL != "" {
		m.activate(ctx)
	}
}

func (m *Manager) withinGracePeriod() bool {
	if m.status.LastCheck.IsZero() {
		return true
	}
	return time.Since(m.status.LastCheck) < 24*time.Hour
}

func (m *Manager) loadSettings(ctx context.Context) {
	if m.settings == nil {
		return
	}
	if key, err := m.settings.GetSystemSetting(ctx, "license_key"); err == nil && key != "" {
		m.key = key
	}
	// 可选 override:不写则用 DefaultServerURL。
	// 测试环境用:在 system_settings 表写 license_server_url=https://iloli.vip:2233
	if url, err := m.settings.GetSystemSetting(ctx, "license_server_url"); err == nil && url != "" {
		m.serverURL = url
	}
}

func (m *Manager) loadPersistedStatus(ctx context.Context) {
	if m.settings == nil {
		return
	}
	raw, err := m.settings.GetSystemSetting(ctx, "license_status")
	if err != nil || raw == "" {
		return
	}
	var status Status
	if err := json.Unmarshal([]byte(raw), &status); err != nil {
		log.Printf("[license] failed to load persisted status: %v", err)
		return
	}
	m.mu.Lock()
	m.status = status
	m.mu.Unlock()
	log.Printf("[license] restored status from database: valid=%v plan=%s", status.Valid, status.Plan.Name)
}

func (m *Manager) persistStatus(ctx context.Context) {
	if m.settings == nil {
		return
	}
	m.mu.RLock()
	data, err := json.Marshal(m.status)
	m.mu.RUnlock()
	if err != nil {
		return
	}
	if err := m.settings.SetSystemSetting(ctx, "license_status", string(data)); err != nil {
		log.Printf("[license] failed to persist status: %v", err)
	}
}

func (m *Manager) activate(ctx context.Context) {
	nonce := genNonce()
	body, _ := json.Marshal(map[string]string{
		"key":        m.key,
		"machine_id": m.machineID,
		"nonce":      nonce,
	})

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.serverURL+"/api/v1/activate", bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := m.client.Do(req)
	if err != nil {
		log.Printf("[license] activate failed: %v", err)
		return
	}
	defer resp.Body.Close()

	m.parseResponse(ctx, resp, nonce)
}

func (m *Manager) heartbeat(ctx context.Context) {
	if m.key == "" || m.serverURL == "" {
		return
	}

	// 带上本机当前 usage,license server 用来在面板上展示 + 兜底比对配额。
	// 采集失败(repo 错)不影响心跳本身,只是这次不传 used_* 字段。
	nonce := genNonce()
	payload := map[string]any{
		"key":        m.key,
		"machine_id": m.machineID,
		"nonce":      nonce,
	}
	m.mu.RLock()
	usage := m.usage
	m.mu.RUnlock()
	if usage != nil {
		if s, n, u, err := usage.LicenseUsage(ctx); err == nil {
			payload["used_servers"] = s
			payload["used_nodes"] = n
			payload["used_users"] = u
		} else {
			log.Printf("[license] usage report skipped: %v", err)
		}
	}
	body, _ := json.Marshal(payload)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.serverURL+"/api/v1/heartbeat", bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := m.client.Do(req)
	if err != nil {
		// 网络故障 → 静默,IsValid 走 grace 容忍。LastCheck 不更新避免 grace 永远续命。
		log.Printf("[license] heartbeat network error: %v (grace period in effect)", err)
		return
	}
	defer resp.Body.Close()

	m.parseResponse(ctx, resp, nonce)
}

func (m *Manager) parseResponse(ctx context.Context, resp *http.Response, nonce string) {
	var result struct {
		Valid      bool            `json:"valid"`
		Error      string          `json:"error,omitempty"`
		MaxServers int             `json:"max_servers"`
		ExpiresAt  string          `json:"expires_at,omitempty"`
		Plan       json.RawMessage `json:"plan,omitempty"`
		Sig        string          `json:"sig,omitempty"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		log.Printf("[license] parse response error: %v", err)
		return
	}

	// 解析 plan + features(同时用于验签和写入 status)。
	var plan PlanInfo
	var hasPlan bool
	if result.Valid && result.Plan != nil {
		if err := json.Unmarshal(result.Plan, &plan); err == nil {
			if plan.Features == nil {
				var raw struct {
					Features json.RawMessage `json:"features"`
				}
				_ = json.Unmarshal(result.Plan, &raw)
				if raw.Features != nil {
					_ = json.Unmarshal(raw.Features, &plan.Features)
				}
			}
			hasPlan = true
		}
	}

	// valid=true 的响应必须通过 ed25519 签名校验,否则视为"未拿到有效响应":
	// 不更新 status(保留上一次的合法状态 + 走 grace),从而假许可证服务/MITM 无法把 TRIAL 提权成 PRO。
	if result.Valid {
		if !verifyLicenseSig(nonce, m.machineID, true, result.MaxServers, result.ExpiresAt, plan.Features, result.Sig) {
			log.Printf("[license] response signature verification FAILED — ignoring response (possible forged license server / MITM)")
			return
		}
	}

	m.mu.Lock()

	m.status.Valid = result.Valid
	m.status.Error = result.Error
	m.status.LastCheck = time.Now()

	if result.Valid {
		// 服务器明确"有效"且验签通过 → 清除 HardRevoked(用于解绑后续绑生效场景)。
		m.status.HardRevoked = false
		m.status.MaxServers = result.MaxServers
		m.status.ExpiresAt = result.ExpiresAt
		if hasPlan {
			m.status.Plan = &plan
		}
	} else {
		// 收到了 HTTP 响应但 valid=false → 服务器明确否决(unbind / revoked / wrong machine_id 等),
		// 立即失效,不走 24h grace。这是跟"网络故障"的本质区别 —— 网络故障在 heartbeat() 早就 return 了,
		// 走不到这里。
		m.status.HardRevoked = true
		log.Printf("[license] HARD REVOKED by server: %s", result.Error)
	}

	m.mu.Unlock()

	m.persistStatus(ctx)
}

func (m *Manager) heartbeatLoop(ctx context.Context) {
	m.loadSettings(ctx)

	// 启动后立即先跑一次心跳,把 used_* 数据 + 当前激活状态推上去,
	// 避免之前 "first heartbeat 要等 30 分钟" 的尴尬。
	m.heartbeat(ctx)

	// 之前 30 分钟太长,解绑生效慢。5 分钟兼顾"unbind 快速生效"和"心跳负担"。
	// 进一步缩到 1 分钟需要 license server 加版本号协议(见 B 方案),当前 5 分钟够用。
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.loadSettings(ctx)
			m.heartbeat(ctx)
		}
	}
}

func (m *Manager) StatusForAgent() map[string]any {
	m.mu.RLock()
	defer m.mu.RUnlock()

	result := map[string]any{
		"valid":       m.status.Valid || m.withinGracePeriod(),
		"max_servers": m.status.MaxServers,
	}
	if m.status.ExpiresAt != "" {
		result["expires_at"] = m.status.ExpiresAt
	}
	if m.status.Plan != nil {
		result["plan"] = map[string]any{
			"name":         m.status.Plan.Name,
			"display_name": m.status.Plan.DisplayName,
			"description":  m.status.Plan.Description,
			"max_servers":  m.status.Plan.MaxServers,
			"max_nodes":    m.status.Plan.MaxNodes,
			"max_users":    m.status.Plan.MaxUsers,
			"features":     m.status.Plan.Features,
		}
	}
	return result
}

func GetMachineID() string {
	id, err := readMachineID()
	if err != nil {
		return fmt.Sprintf("mmwx-%d", time.Now().UnixNano())
	}
	return id
}
