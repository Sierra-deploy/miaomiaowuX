package handler

import (
	"context"
	"errors"
	"log"
	"sync"
	"time"

	"github.com/google/uuid"

	"miaomiaowux/internal/storage"
)

// 可达性(被墙)探测:从家用测速端拨测节点的 host:port。
//
// 为什么放在测速端而不是 agent:agent 都跑在机房,从机房拨测探不出「被墙」——
// 机房到境外通常是通的,反而会把正常节点判成可达、把落地节点误判成被墙。
// 真正需要的是**国内家庭网络**的观测点,而这正是家用测速端已经解决的部署形态
// (反向 WS 连入、天然穿透 NAT)。
//
// 判定语义沿用原实现:**任一探测源可达即视为可达**,最小化误判被墙。

const (
	// 单个测速端一轮探测的等待上限。客户端自身对每个目标有超时且并发拨测,
	// 这里只兜底"客户端根本不回话"的情况(如老版本静默丢弃 probe 消息)。
	probeDispatchTimeout = 90 * time.Second
	// 派给测速端的单目标拨测超时,与客户端的 clamp 区间保持一致。
	probeTargetTimeoutMS = 5000
)

// ProbeTargets 从一组测速端拨测 targets,返回每个 target 是否可达。
//
// 多个测速端并发派发,任一可达即判可达。某个测速端离线 / 不支持 probe / 超时,
// 只影响它自己那一份结果,不影响整体判定。
//
// 调用方须自行确保 testerIDs 已按能力过滤(见 ProbeCapableTesterIDs)——
// 给不支持的测速端派任务只会白等一个 dispatch 超时。
func (h *SpeedTesterWSHandler) ProbeTargets(ctx context.Context, testerIDs []int64, targets []string) map[string]bool {
	res := make(map[string]bool, len(targets))
	for _, t := range targets {
		res[t] = false
	}
	if len(testerIDs) == 0 || len(targets) == 0 {
		return res
	}

	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, id := range testerIDs {
		wg.Add(1)
		go func(testerID int64) {
			defer wg.Done()
			out, err := h.dispatchProbe(ctx, testerID, targets)
			if err != nil {
				log.Printf("[SpeedTester] 探测源 %d 本轮不可用: %v", testerID, err)
				return
			}
			mu.Lock()
			defer mu.Unlock()
			for _, r := range out {
				if r.OK {
					res[r.Target] = true
				}
			}
		}(id)
	}
	wg.Wait()
	return res
}

// dispatchProbe 给单个测速端派一次可达性探测并等结果。
//
// 复用 Dispatch 那套 jobID + pending 通道机制:jobID 全局唯一,
// probe_result 与 result 走同一条回收路径(见 ServeHTTP 的消息分发)。
func (h *SpeedTesterWSHandler) dispatchProbe(ctx context.Context, testerID int64, targets []string) ([]TesterProbeResult, error) {
	v, ok := h.conns.Load(testerID)
	if !ok {
		return nil, errors.New("测速端不在线")
	}
	tc := v.(*testerConn)
	jobID := uuid.New().String()
	ch := make(chan stWSMsg, 1)
	tc.pending.Store(jobID, ch)
	defer tc.pending.Delete(jobID)

	if err := tc.send(stWSMsg{
		Type: "probe", JobID: jobID, Targets: targets, TimeoutMS: probeTargetTimeoutMS,
	}); err != nil {
		return nil, errors.New("下发探测任务失败: " + err.Error())
	}

	select {
	case res := <-ch:
		if res.Status != "" && res.Status != "ok" {
			return nil, errors.New(res.Error)
		}
		return res.Results, nil
	case <-time.After(probeDispatchTimeout):
		// 最常见原因:测速端是老版本,收到未知的 probe 消息直接丢弃,永远不回。
		// 正常情况下探测源已按 caps 过滤过,走到这里说明能力信息过期了。
		return nil, errors.New("测速端响应超时(可能是旧版本,不支持可达性探测)")
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// ProbeCapableTesterIDs 从给定的测速端 ID 里筛出「在线 且 支持 probe」的那些。
//
// 两个条件缺一不可:不在线派不出去;在线但老版本会静默吞掉任务,只能等超时。
func (h *SpeedTesterWSHandler) ProbeCapableTesterIDs(ctx context.Context, want []int64) []int64 {
	if len(want) == 0 {
		return nil
	}
	testers, err := h.repo.ListSpeedTesters(ctx)
	if err != nil {
		return nil
	}
	capable := map[int64]bool{}
	for _, t := range testers {
		if t.HasCap(storage.CapProbe) {
			capable[t.ID] = true
		}
	}
	out := make([]int64, 0, len(want))
	for _, id := range want {
		if capable[id] && h.Online(id) {
			out = append(out, id)
		}
	}
	return out
}

// ProbeV6CapableTesterIDs 从给定测速端里筛出「在线 且 声明了 probe6(能拨通公网 IPv6)」的那些。
// 用于判断本轮有没有能可靠探测 v6 节点的观测点 —— 一个都没有时,v6 节点判「无法探测」而非被墙。
func (h *SpeedTesterWSHandler) ProbeV6CapableTesterIDs(ctx context.Context, want []int64) []int64 {
	if len(want) == 0 {
		return nil
	}
	testers, err := h.repo.ListSpeedTesters(ctx)
	if err != nil {
		return nil
	}
	v6capable := map[int64]bool{}
	for _, t := range testers {
		if t.HasCap(storage.CapProbe) && t.HasCap(storage.CapProbeV6) {
			v6capable[t.ID] = true
		}
	}
	out := make([]int64, 0, len(want))
	for _, id := range want {
		if v6capable[id] && h.Online(id) {
			out = append(out, id)
		}
	}
	return out
}
