package handler

import (
	"context"
	"encoding/json"
	"net/http"

	"miaomiaowux/internal/storage"
)

// ProbePublicHandler 提供"伪装成探针"的公开(无鉴权)只读服务器状态。
// 安全红线:只序列化下方白名单字段,绝不返回 IP / token / host / inbound 等敏感信息。
type ProbePublicHandler struct {
	repo       *storage.TrafficRepository
	wsHandler  *RemoteWSHandler
	probeStore *ProbeMetricsStore // 真探针数据(cpu/mem/disk/ping),来自 agent 上报的内存 ring
}

func NewProbePublicHandler(repo *storage.TrafficRepository, ws *RemoteWSHandler, store *ProbeMetricsStore) *ProbePublicHandler {
	return &ProbePublicHandler{repo: repo, wsHandler: ws, probeStore: store}
}

// probePingSeries 是一条 ping 曲线:只带展示名(省市/运营商)+ 延迟点,
// **绝不含目标 host/IP、agent 出口 IP**。ms=-1 表示该次探测失败。
type probePingSeries struct {
	Label  string           `json:"label"`
	ISP    string           `json:"isp,omitempty"`
	Points []probePingPoint `json:"points"`
}
type probePingPoint struct {
	T  int64 `json:"t"`
	Ms int64 `json:"ms"`
}

// probeServer 是对外暴露的白名单字段集合(刻意不含 id/ip/token/host/reset_day 等)。
// 新增的 cpu/mem/disk/ping 全用指针/切片 + omitempty:未开启或无数据时整个字段消失,不泄露 0 值。
type probeServer struct {
	Name          string `json:"name,omitempty"` // show_name 关闭时省略
	UploadSpeed   int64  `json:"upload_speed"`   // B/s
	DownloadSpeed int64  `json:"download_speed"` // B/s
	TrafficUsed   int64  `json:"traffic_used"`
	TrafficLimit  int64  `json:"traffic_limit"`
	Online        bool   `json:"online"`
	// 真探针字段(聚合数值,用户已接受公开;不含任何主机标识)
	CPUPct    *float64          `json:"cpu_pct,omitempty"`
	LoadAvg   string            `json:"loadavg,omitempty"`
	MemUsed   *int64            `json:"mem_used,omitempty"`
	MemTotal  *int64            `json:"mem_total,omitempty"`
	DiskUsed  *int64            `json:"disk_used,omitempty"`
	DiskTotal *int64            `json:"disk_total,omitempty"`
	Ping      []probePingSeries `json:"ping,omitempty"`
}

// ServeHTTP 处理 GET /api/public/probe-servers(无鉴权)。
// 伪装未开启 → {enabled:false};开启 → {enabled:true, title, show_name, servers:[白名单]}。
func (h *ProbePublicHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	ctx := r.Context()
	w.Header().Set("Content-Type", "application/json")

	if v, _ := h.repo.GetSystemSetting(ctx, probeDisguiseEnabledKey); v != "1" {
		json.NewEncoder(w).Encode(map[string]any{"enabled": false})
		return
	}

	title, _ := h.repo.GetSystemSetting(ctx, probeDisguiseTitleKey)
	showName := func() bool { v, _ := h.repo.GetSystemSetting(ctx, probeDisguiseShowNameKey); return v == "1" }()

	// 采集子开关:关掉的指标即使 ring 里还有陈旧数据也不展示。
	onCPU := h.setting(ctx, probeDisguiseMetricCPUKey)
	onMem := h.setting(ctx, probeDisguiseMetricMemKey)
	onDisk := h.setting(ctx, probeDisguiseMetricDiskKey)
	onPing := h.setting(ctx, probeDisguiseMetricPingKey)

	// ping 目标的 Key→(Label,ISP) 映射,用于给 ring 里的 targetKey 配展示名(不回传 host/IP)。
	targetMeta := map[string]ProbePingTarget{}
	if onPing {
		if raw, _ := h.repo.GetSystemSetting(ctx, probeDisguisePingTargetsKey); raw != "" {
			var ts []ProbePingTarget
			if json.Unmarshal([]byte(raw), &ts) == nil {
				for _, t := range ts {
					targetMeta[t.Key] = t
				}
			}
		}
	}

	idSet := map[int64]bool{}
	if raw, _ := h.repo.GetSystemSetting(ctx, probeDisguiseServerIDsKey); raw != "" {
		var ids []int64
		if json.Unmarshal([]byte(raw), &ids) == nil {
			for _, id := range ids {
				idSet[id] = true
			}
		}
	}

	servers, _ := h.repo.ListRemoteServers(ctx)
	out := make([]probeServer, 0, len(idSet))
	for i := range servers {
		s := &servers[i]
		if !idSet[s.ID] {
			continue
		}
		used, _ := h.repo.GetServerTrafficUsed(ctx, s.ID)
		used += s.TrafficUsedOffset
		online := (h.wsHandler != nil && h.wsHandler.IsConnected(s.Token)) || s.Status == "connected"
		ps := probeServer{
			UploadSpeed:   s.CurrentUploadSpeed,
			DownloadSpeed: s.CurrentDownloadSpeed,
			TrafficUsed:   used,
			TrafficLimit:  s.TrafficLimit,
			Online:        online,
		}
		if showName {
			ps.Name = s.Name
		}
		// 从 ring 填真探针字段(用 s.ID 查,s.ID 不入响应)。仅在「开关开 且 agent 报了该项」时才带。
		if h.probeStore != nil {
			if view, ok := h.probeStore.Snapshot(s.ID); ok {
				fillProbeMetrics(&ps, view, onCPU, onMem, onDisk, onPing, targetMeta)
			}
		}
		out = append(out, ps)
	}

	json.NewEncoder(w).Encode(map[string]any{
		"enabled":   true,
		"title":     title,
		"show_name": showName,
		"servers":   out,
	})
}

func (h *ProbePublicHandler) setting(ctx context.Context, key string) bool {
	v, _ := h.repo.GetSystemSetting(ctx, key)
	return v == "1"
}

// fillProbeMetrics 把 ring 快照按开关填进白名单 probeServer。
// 安全关键:ping 只取 targetMeta 里配的 Label/ISP(不碰 ProbePingTarget.Host/Port),
// 系统指标只填聚合数值。任何主机标识(IP/host/hostname)都不进 ps。
func fillProbeMetrics(ps *probeServer, view *ProbeServerView, onCPU, onMem, onDisk, onPing bool, targetMeta map[string]ProbePingTarget) {
	if view.HasSys {
		sys := view.Sys
		if onCPU && sys.HasCPU {
			cpu := sys.CPUPct
			ps.CPUPct = &cpu
			ps.LoadAvg = sys.LoadAvg
		}
		if onMem && sys.HasMem {
			mu, mt := sys.MemUsed, sys.MemTotal
			ps.MemUsed, ps.MemTotal = &mu, &mt
		}
		if onDisk && sys.HasDisk {
			du, dt := sys.DiskUsed, sys.DiskTotal
			ps.DiskUsed, ps.DiskTotal = &du, &dt
		}
	}
	if onPing && len(view.Latency) > 0 {
		for key, pts := range view.Latency {
			meta, ok := targetMeta[key]
			if !ok {
				// 目标已从配置移除 → 不展示这条陈旧曲线
				continue
			}
			series := probePingSeries{Label: meta.Label, ISP: meta.ISP}
			for _, p := range pts {
				series.Points = append(series.Points, probePingPoint{T: p.Ts, Ms: p.LatencyMs})
			}
			ps.Ping = append(ps.Ping, series)
		}
	}
}
