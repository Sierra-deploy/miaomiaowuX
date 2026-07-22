package license

import (
	"context"
	"errors"
)

// FeatureSpeedTest 是测速端能力的 PRO 特性名。
//
// 官方探测(由许可证服务派发到作者部署在国内家庭网络的探测端)属于测速端能力的延伸,
// **刻意复用同一个特性名而不新增** —— 许可证后台的 AVAILABLE_FEATURES 是硬编码列表,
// 新增特性名漏改那边就会出现"买了 PRO 但开关打不开"(已经踩过一次)。
const FeatureSpeedTest = "speed_test"

// ErrOfficialProbeUnavailable 表示官方探测这一轮用不了:许可证没有该特性、未激活,
// 或服务端把官方探测临时下线了。调用方应当**静默跳过这个探测源**,而不是当成失败。
var ErrOfficialProbeUnavailable = errors.New("官方探测不可用:许可证无效、未包含该特性,或服务端未开放")

// OfficialProbeResult 单个目标的拨测结果。
type OfficialProbeResult struct {
	Target string `json:"target"`
	OK     bool   `json:"ok"`
}

// ProbeReachability 请求官方探测端拨测 targets(host:port),返回每个目标是否可达。
//
// 用途是判断节点有没有被墙:主控自己和 agent 都跑在机房,探不准国内的封锁情况,
// 只有国内家庭网络的观测点说了算。
//
// 服务端会过滤内网目标并按许可证计每日配额;超配额返回非 200,这里当普通错误上抛。
func (m *Manager) ProbeReachability(ctx context.Context, targets []string) (map[string]bool, error) {
	if len(targets) == 0 {
		return map[string]bool{}, nil
	}
	var res struct {
		Success bool                  `json:"success"`
		Results []OfficialProbeResult `json:"results"`
		Error   string                `json:"error"`
	}
	err := m.featureRequest(ctx, FeatureSpeedTest, "/api/v1/reachability/probe",
		map[string]any{"targets": targets}, &res, ErrOfficialProbeUnavailable)
	if err != nil {
		return nil, err
	}
	if !res.Success {
		if res.Error != "" {
			return nil, errors.New(res.Error)
		}
		return nil, errors.New("官方探测返回失败")
	}
	out := make(map[string]bool, len(res.Results))
	for _, r := range res.Results {
		out[r.Target] = r.OK
	}
	return out, nil
}
