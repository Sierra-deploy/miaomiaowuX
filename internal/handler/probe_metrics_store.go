package handler

import (
	"sync"
	"time"
)

// 真探针数据后端的内存态。伪装探针页要像哪吒探针那样展示各服务器的 CPU/内存/硬盘 + ping 延迟曲线,
// 但用户选择「仅内存实时滚动」——不建 DB 时序表,主控内存维护环形缓冲,重启清空。
//
// 单例挂到 RemoteWSHandler(写)与 ProbePublicHandler(读),二者同包。仿 collector.go 的 serverSpeeds/speedMu。

// ProbePingTarget 是一个 ping 目标(省市×运营商),管理员从 CDN 列表勾选。host 形如
// "he-cu-v4.ip.zstaticcdn.com:80"(已含端口)或 host+port 分离。Key 全局唯一(如 "he-cu-v4")。
type ProbePingTarget struct {
	Key   string `json:"key"`
	Label string `json:"label"` // 展示名,如「河北联通」
	ISP   string `json:"isp"`   // unicom/mobile/telecom
	Host  string `json:"host"`  // 目标主机(不含端口)
	Port  int    `json:"port"`
}

// ProbeSysSnapshot 是一台服务器最新的系统指标(agent 上报的开启项;未开启的字段为 nil 指针语义靠上层处理)。
type ProbeSysSnapshot struct {
	CPUPct    float64 `json:"cpu_pct"`
	LoadAvg   string  `json:"loadavg"`
	MemUsed   int64   `json:"mem_used"`
	MemTotal  int64   `json:"mem_total"`
	DiskUsed  int64   `json:"disk_used"`
	DiskTotal int64   `json:"disk_total"`
	// 掩码:agent 只上报开启项,这里记录哪些字段有效(避免 0 值被当成真实数据)。
	HasCPU, HasMem, HasDisk bool
	At                      int64 // unix 秒
}

// ProbeLatencySample 是一次 ping 的结果(agent 上报)。
type ProbeLatencySample struct {
	Key       string `json:"key"`
	Success   bool   `json:"success"`
	LatencyMs int64  `json:"latency_ms"`
}

// probeLatencyPoint 是 ring 里的一个延迟点。
type probeLatencyPoint struct {
	Ts        int64 `json:"t"`  // unix 秒
	LatencyMs int64 `json:"ms"` // -1 表示本次探测失败
}

type probeServerMetrics struct {
	sys       ProbeSysSnapshot
	hasSys    bool
	latency   map[string][]probeLatencyPoint // targetKey -> 最近 capN 个点
	updatedAt int64
}

// ProbeMetricsStore 内存 ring:每服务器最新系统指标 + 每目标最近 N 个延迟点。并发安全。
type ProbeMetricsStore struct {
	mu   sync.RWMutex
	data map[int64]*probeServerMetrics // serverID -> metrics
	capN int                           // 每目标保留点数上界
}

// NewProbeMetricsStore capN 为每目标环形容量(如 60,即 5s 间隔约 5 分钟窗口)。
func NewProbeMetricsStore(capN int) *ProbeMetricsStore {
	if capN <= 0 {
		capN = 60
	}
	return &ProbeMetricsStore{data: make(map[int64]*probeServerMetrics), capN: capN}
}

func (s *ProbeMetricsStore) ensure(serverID int64) *probeServerMetrics {
	m, ok := s.data[serverID]
	if !ok {
		m = &probeServerMetrics{latency: make(map[string][]probeLatencyPoint)}
		s.data[serverID] = m
	}
	return m
}

// IngestSys 写入某服务器最新系统指标。
func (s *ProbeMetricsStore) IngestSys(serverID int64, snap ProbeSysSnapshot) {
	now := time.Now().Unix()
	snap.At = now
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.ensure(serverID)
	m.sys = snap
	m.hasSys = true
	m.updatedAt = now
}

// IngestLatency 追加一批 ping 结果,每目标 ring 截断到 capN。
func (s *ProbeMetricsStore) IngestLatency(serverID int64, samples []ProbeLatencySample) {
	if len(samples) == 0 {
		return
	}
	now := time.Now().Unix()
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.ensure(serverID)
	for _, smp := range samples {
		ms := smp.LatencyMs
		if !smp.Success {
			ms = -1
		}
		pts := append(m.latency[smp.Key], probeLatencyPoint{Ts: now, LatencyMs: ms})
		if len(pts) > s.capN {
			pts = pts[len(pts)-s.capN:]
		}
		m.latency[smp.Key] = pts
	}
	m.updatedAt = now
}

// ProbeServerView 是给公开端点/内部读取用的快照(值拷贝,读锁下产生,调用方无需再锁)。
type ProbeServerView struct {
	HasSys  bool
	Sys     ProbeSysSnapshot
	Latency map[string][]probeLatencyPoint
}

// Snapshot 返回某服务器的指标快照拷贝;不存在返回 (nil,false)。
func (s *ProbeMetricsStore) Snapshot(serverID int64) (*ProbeServerView, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	m, ok := s.data[serverID]
	if !ok {
		return nil, false
	}
	lat := make(map[string][]probeLatencyPoint, len(m.latency))
	for k, pts := range m.latency {
		cp := make([]probeLatencyPoint, len(pts))
		copy(cp, pts)
		lat[k] = cp
	}
	return &ProbeServerView{HasSys: m.hasSys, Sys: m.sys, Latency: lat}, true
}

// Evict 清掉 updatedAt 早于 cutoff 的服务器(掉线服务器),防内存无界增长。
func (s *ProbeMetricsStore) Evict(olderThan time.Duration) {
	cutoff := time.Now().Add(-olderThan).Unix()
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, m := range s.data {
		if m.updatedAt < cutoff {
			delete(s.data, id)
		}
	}
}
