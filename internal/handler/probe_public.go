package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

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

// probePingSeries 是一条 ping 曲线的**聚合结果**(每目标一条):只带展示名(省市/运营商) +
// 当前延迟 + 丢包率 + 24 小时桶。**绝不含目标 host/IP、agent 出口 IP**。
//
// 为什么不再返回原始点:ring 容量已到 1440(1 天),原始点全量返回会让每 5 秒轮询的公开端点
// payload 爆炸(1440×目标数×服务器数)。故服务端聚合成 24 个小时桶 + 当前值 + 丢包率,payload 恒定小。
// 折线图/色块条用这 24 个桶展示(小时粒度,匹配"24 小时每小时一格"的设计)。
type probePingSeries struct {
	Label     string            `json:"label"`
	ISP       string            `json:"isp,omitempty"`
	CurrentMs int64             `json:"current_ms"` // 最新一次延迟,-1=当前探测失败
	LossPct   float64           `json:"loss_pct"`   // 整个窗口内失败占比(0~100)
	Buckets   []probeHourBucket `json:"buckets"`    // 最近 24 小时,每小时一个桶(索引 0=23 小时前 … 23=最近 1 小时)
}

// probeHourBucket 是某一小时的聚合。无数据的小时 Ms=-1、Loss=-1(前端据此画"无数据"格)。
type probeHourBucket struct {
	Ms   int64   `json:"ms"`   // 该小时成功探测的平均延迟;-1=该小时无数据或全失败
	Loss float64 `json:"loss"` // 该小时丢包率(0~100);-1=无数据
}

// probeServer 是对外暴露的白名单字段集合(刻意不含 id/ip/token/host/reset_day 等)。
// 新增的 cpu/mem/disk/ping 全用指针/切片 + omitempty:未开启或无数据时整个字段消失,不泄露 0 值。
type probeServer struct {
	Name string `json:"name,omitempty"` // show_name 关闭时省略
	// 网速/流量是展示开关控制的:关闭时置 nil + omitempty,整个字段消失,前端据此隐藏。
	UploadSpeed   *int64 `json:"upload_speed,omitempty"`   // B/s(当前上行速率)
	DownloadSpeed *int64 `json:"download_speed,omitempty"` // B/s(当前下行速率)
	TrafficUsed   *int64 `json:"traffic_used,omitempty"`
	TrafficLimit  *int64 `json:"traffic_limit,omitempty"`
	// 累计上/下行流量(系统级 rx/tx cycle):图2 底部"已用上下行"。仅 system-source 有值,
	// 其余为 0 → 前端隐藏该行。受 onTraffic 门控。
	CumulativeUp   *int64 `json:"cumulative_up,omitempty"`   // 累计上行(SystemTxCycle)
	CumulativeDown *int64 `json:"cumulative_down,omitempty"` // 累计下行(SystemRxCycle)
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
	// 流量/网速展示开关:默认开(历史行为),仅显式存 "0" 才关。
	trafficRaw, _ := h.repo.GetSystemSetting(ctx, probeDisguiseMetricTrafficKey)
	speedRaw, _ := h.repo.GetSystemSetting(ctx, probeDisguiseMetricSpeedKey)
	onTraffic := trafficRaw != "0"
	onSpeed := speedRaw != "0"

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
		ps := probeServer{Online: online}
		if onSpeed {
			up, down := s.CurrentUploadSpeed, s.CurrentDownloadSpeed
			ps.UploadSpeed, ps.DownloadSpeed = &up, &down
		}
		if onTraffic {
			tu, tl := used, s.TrafficLimit
			ps.TrafficUsed, ps.TrafficLimit = &tu, &tl
			// 累计上下行:仅 system-source 服务器有 rx/tx cycle;>0 才带(前端据此显示"已用上下行"行)。
			if s.SystemTxCycle > 0 || s.SystemRxCycle > 0 {
				up, down := s.SystemTxCycle, s.SystemRxCycle
				ps.CumulativeUp, ps.CumulativeDown = &up, &down
			}
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
			ps.Ping = append(ps.Ping, aggregatePingSeries(meta.Label, meta.ISP, pts))
		}
	}
}

// aggregatePingSeries 把一个目标的原始延迟点聚合成对外的 probePingSeries:
// 当前延迟(最新点) + 全窗口丢包率 + 最近 24 小时每小时一个桶。
// 纯函数,可单测。pts 已按时间递增(ingest 顺序)。
func aggregatePingSeries(label, isp string, pts []probeLatencyPoint) probePingSeries {
	s := probePingSeries{Label: label, ISP: isp, CurrentMs: -1, LossPct: 0}

	// 当前延迟 = 最新一个点。
	if len(pts) > 0 {
		s.CurrentMs = pts[len(pts)-1].LatencyMs
	}

	// 全窗口丢包率 = 失败点(ms<0)占比。
	if len(pts) > 0 {
		fail := 0
		for _, p := range pts {
			if p.LatencyMs < 0 {
				fail++
			}
		}
		s.LossPct = float64(fail) * 100 / float64(len(pts))
	}

	// 24 小时桶:索引 0 = 23 小时前那一小时,23 = 最近一小时。
	const buckets = 24
	now := time.Now().Unix()
	type acc struct {
		sum, cnt, fail int64
	}
	accs := make([]acc, buckets)
	for _, p := range pts {
		ageH := (now - p.Ts) / 3600 // 距今多少小时
		if ageH < 0 || ageH >= buckets {
			continue
		}
		idx := buckets - 1 - int(ageH)
		accs[idx].cnt++
		if p.LatencyMs < 0 {
			accs[idx].fail++
		} else {
			accs[idx].sum += p.LatencyMs
		}
	}
	s.Buckets = make([]probeHourBucket, buckets)
	for i := range accs {
		if accs[i].cnt == 0 {
			s.Buckets[i] = probeHourBucket{Ms: -1, Loss: -1}
			continue
		}
		ok := accs[i].cnt - accs[i].fail
		ms := int64(-1)
		if ok > 0 {
			ms = accs[i].sum / ok
		}
		s.Buckets[i] = probeHourBucket{Ms: ms, Loss: float64(accs[i].fail) * 100 / float64(accs[i].cnt)}
	}
	return s
}
