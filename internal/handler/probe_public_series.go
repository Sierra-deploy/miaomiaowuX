package handler

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"time"

	"miaomiaowux/internal/storage"
)

// ProbeSeriesHandler 提供 GET /api/public/probe-series —— 单台服务器单个 ping 目标的
// 详细延迟曲线,供伪装页的延迟弹窗按需拉取(列表端点只带近 1 小时的粗粒度)。
//
// 这是**无鉴权公开端点**,三条硬约束:
//  1. 响应恒定小(单 server × 单 target × 至多 288 桶),不给放大攻击留空间;
//  2. server 必须在管理员选定的展示列表里,否则 404 —— 否则它会变成 serverID 枚举器;
//  3. target key 必须在该服务器生效的目标白名单里,复用 probeTargetResolver。
//     这条和 fillProbeMetrics 里"未知 key 直接 continue"是同一道防线:
//     不让被攻破的 agent 上报的任意 key 变成可查询的曲线。
type ProbeSeriesHandler struct {
	repo       *storage.TrafficRepository
	probeStore *ProbeMetricsStore
}

func NewProbeSeriesHandler(repo *storage.TrafficRepository, store *ProbeMetricsStore) *ProbeSeriesHandler {
	return &ProbeSeriesHandler{repo: repo, probeStore: store}
}

// probeSeriesRange 是允许的时间窗口。粒度不接受任意整数 —— 否则
// range=24h&granularity=1s 就是 86400 个桶。
type probeSeriesRange struct {
	Buckets   int // 桶数
	BucketSec int // 每桶秒数
}

var probeSeriesRanges = map[string]probeSeriesRange{
	"1h":  {Buckets: 12, BucketSec: 300},  // 5 分钟 × 12
	"6h":  {Buckets: 36, BucketSec: 600},  // 10 分钟 × 36
	"24h": {Buckets: 48, BucketSec: 1800}, // 30 分钟 × 48
}

// probeSeriesAvgKey 是"全部目标平均"的伪 key,与前端 LATENCY_KEY 对齐。
// 支持它是为了避免前端为了画一条平均曲线去发 N 个请求。
const probeSeriesAvgKey = "__avg__"

// probeSeriesAllKey 表示"要全部目标",配合 all=1 使用。
const probeSeriesAllKey = "__all__"

func (h *ProbeSeriesHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	ctx := r.Context()
	w.Header().Set("Content-Type", "application/json")

	notFound := func() {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]any{"success": false})
	}

	// 伪装未开启 / ping 采集未开启 → 一律 404,不透露任何存在性。
	if v, _ := h.repo.GetSystemSetting(ctx, probeDisguiseEnabledKey); v != "1" {
		notFound()
		return
	}
	if v, _ := h.repo.GetSystemSetting(ctx, probeDisguiseMetricPingKey); v != "1" {
		notFound()
		return
	}

	rng, ok := probeSeriesRanges[r.URL.Query().Get("range")]
	if !ok {
		rng = probeSeriesRanges["1h"]
	}

	// server 参数是**展示列表里的下标**,不是 serverID —— 公开页从不暴露 serverID,
	// 用下标可以避免这个端点变成 ID 探测器。
	idx, err := strconv.Atoi(r.URL.Query().Get("server"))
	if err != nil || idx < 0 {
		notFound()
		return
	}

	idSet := []int64{}
	if raw, _ := h.repo.GetSystemSetting(ctx, probeDisguiseServerIDsKey); raw != "" {
		_ = json.Unmarshal([]byte(raw), &idSet)
	}
	servers, _ := h.repo.ListRemoteServers(ctx)
	// 与列表端点保持同样的顺序(ListRemoteServers 顺序 ∩ 选中集合),下标才对得上。
	selected := make([]int64, 0, len(idSet))
	inSet := make(map[int64]bool, len(idSet))
	for _, id := range idSet {
		inSet[id] = true
	}
	for i := range servers {
		if inSet[servers[i].ID] {
			selected = append(selected, servers[i].ID)
		}
	}
	if idx >= len(selected) {
		notFound()
		return
	}
	serverID := selected[idx]

	globalRaw, _ := h.repo.GetSystemSetting(ctx, probeDisguisePingTargetsKey)
	overrideRaw, _ := h.repo.GetSystemSetting(ctx, probeDisguisePingTargetsOverrideKey)
	meta := newProbeTargetResolver(globalRaw, overrideRaw).For(serverID)

	view, ok := h.probeStore.Snapshot(serverID, 0)
	if !ok {
		notFound()
		return
	}

	// 平均永远返回(图表要用它做基准线),其余按 target 参数决定。
	merged := mergeTargetSlots(view.Latency, meta)
	avg := aggregatePingSeries(probeSeriesAvgKey, "平均", "", merged, rng.Buckets, rng.BucketSec)

	targetKey := r.URL.Query().Get("target")
	resp := map[string]any{
		"success":      true,
		"series":       avg,
		"bucket_sec":   rng.BucketSec,
		"generated_at": time.Now().Unix(),
	}

	if targetKey != "" && targetKey != probeSeriesAvgKey && targetKey != probeSeriesAllKey {
		m, allowed := meta[targetKey]
		if !allowed {
			notFound() // 不在白名单 → 当作不存在
			return
		}
		series, has := view.Latency[targetKey]
		if !has {
			series = ProbeTargetSeries{CurrentMs: -1}
		}
		resp["series"] = aggregatePingSeries(targetKey, m.Label, m.ISP, series, rng.Buckets, rng.BucketSec)
	}

	// all=1:同时返回该服务器所有目标的曲线,供图表一次画出全部探测点。
	// 只在弹窗打开时按需请求(不是 5 秒轮询的列表端点),且限定单服务器,
	// payload 量级 = 目标数(≤30) × 桶数(≤48),约几十 KB,可接受。
	if r.URL.Query().Get("all") == "1" {
		list := make([]probePingSeries, 0, len(meta))
		for key, series := range view.Latency {
			m, allowed := meta[key]
			if !allowed {
				continue // 白名单之外的 ring 残留,同 fillProbeMetrics 的纪律
			}
			list = append(list, aggregatePingSeries(key, m.Label, m.ISP, series, rng.Buckets, rng.BucketSec))
		}
		// map 遍历无序 → 排序,否则每次请求线条颜色都会重新洗牌。
		sort.Slice(list, func(i, j int) bool {
			if list[i].Label != list[j].Label {
				return list[i].Label < list[j].Label
			}
			return list[i].Key < list[j].Key
		})
		resp["all_series"] = list
	}

	json.NewEncoder(w).Encode(resp)
}

// mergeTargetSlots 把白名单内所有目标的聚合槽按 Slot 相加,得到"全部目标平均"的序列。
// 只并入 meta 里的 key —— 同一道白名单防线。
func mergeTargetSlots(latency map[string]ProbeTargetSeries, meta map[string]ProbePingTarget) ProbeTargetSeries {
	acc := map[int64]*probeAggSlot{}
	var curSum, curCnt int64
	for key, series := range latency {
		if _, ok := meta[key]; !ok {
			continue
		}
		if series.CurrentMs >= 0 {
			curSum += series.CurrentMs
			curCnt++
		}
		for _, sl := range series.Slots {
			a, ok := acc[sl.Slot]
			if !ok {
				a = &probeAggSlot{Slot: sl.Slot}
				acc[sl.Slot] = a
			}
			a.Sum += sl.Sum
			a.Cnt += sl.Cnt
			a.Fail += sl.Fail
		}
	}
	out := ProbeTargetSeries{CurrentMs: -1}
	if curCnt > 0 {
		out.CurrentMs = curSum / curCnt
	}
	out.Slots = make([]probeAggSlot, 0, len(acc))
	for _, a := range acc {
		out.Slots = append(out.Slots, *a)
	}
	// aggregatePingSeries 不要求有序(它按 Slot 算桶索引),但排一下便于调试和测试稳定。
	sortAggSlots(out.Slots)
	return out
}

func sortAggSlots(s []probeAggSlot) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j].Slot < s[j-1].Slot; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}
