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

type SettingsGetter interface {
	GetSystemSetting(ctx context.Context, key string) (string, error)
}

type Manager struct {
	mu        sync.RWMutex
	status    Status
	serverURL string
	key       string
	machineID string
	settings  SettingsGetter
	client    *http.Client
	cancel    context.CancelFunc
}

const DefaultServerURL = "https://license.miaomiaowu.net"

func NewManager(settings SettingsGetter, machineID string) *Manager {
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
	if !m.status.Valid {
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
}

func (m *Manager) activate(ctx context.Context) {
	body, _ := json.Marshal(map[string]string{
		"key":        m.key,
		"machine_id": m.machineID,
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

	m.parseResponse(resp)
}

func (m *Manager) heartbeat(ctx context.Context) {
	if m.key == "" || m.serverURL == "" {
		return
	}

	body, _ := json.Marshal(map[string]string{
		"key":        m.key,
		"machine_id": m.machineID,
	})

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.serverURL+"/api/v1/heartbeat", bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := m.client.Do(req)
	if err != nil {
		log.Printf("[license] heartbeat failed: %v", err)
		return
	}
	defer resp.Body.Close()

	m.parseResponse(resp)
}

func (m *Manager) parseResponse(resp *http.Response) {
	var result struct {
		Valid      bool            `json:"valid"`
		Error      string          `json:"error,omitempty"`
		MaxServers int             `json:"max_servers"`
		ExpiresAt  string          `json:"expires_at,omitempty"`
		Plan       json.RawMessage `json:"plan,omitempty"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		log.Printf("[license] parse response error: %v", err)
		return
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	m.status.Valid = result.Valid
	m.status.Error = result.Error
	m.status.LastCheck = time.Now()

	if result.Valid {
		m.status.MaxServers = result.MaxServers
		m.status.ExpiresAt = result.ExpiresAt
		if result.Plan != nil {
			var plan PlanInfo
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
				m.status.Plan = &plan
			}
		}
	}
}

func (m *Manager) heartbeatLoop(ctx context.Context) {
	m.loadSettings(ctx)

	ticker := time.NewTicker(30 * time.Minute)
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
