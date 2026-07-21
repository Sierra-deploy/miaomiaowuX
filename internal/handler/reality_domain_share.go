package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"

	"miaomiaowux/internal/license"
)

// featureRealityPool 复用 license 包的定义,避免两处字符串各写一遍导致门控静默失效。
const featureRealityPool = license.FeatureRealityPool

const (
	realityShareEnabledSettingKey = "reality_domain_share_enabled"
	realityShareSharedSettingKey  = "reality_domains_shared"
	// 用户主动撤回过的域名,不再自动上报(否则下次同步又会传上去)
	realityShareOptOutSettingKey = "reality_domains_share_optout"
)

// shareFilterInput 是隐私过滤的全部输入。抽成结构体是为了让过滤逻辑成为纯函数,
// 可以在单测里精确构造各种泄露场景——这是本功能唯一不能出错的地方。
type shareFilterInput struct {
	// Domains 候选域名(通常取 realityDomainInventory.Domains)
	Domains []string
	// Sources 域名 -> 来源标记
	Sources map[string]string
	// SelfOwned 收集阶段已判定为自有的域名(含 steal-self 的 dest)
	SelfOwned map[string]struct{}
	// CertDomains 证书库里的域名:在本系统申请过证书 ⇒ 是客户自己的
	CertDomains []string
	// OptOut 用户手动撤回过的域名
	OptOut []string
}

// selectShareableDomains 挑出可以上报到许可证服务器的域名。
//
// 判定是**白名单式**的:默认全部不可共享,只有同时满足下列全部条件才放行——
//
//  1. 来源必须是 domainSourceRealityDest(真正在偷的目标)。
//     master / server / tls_sni / custom / shared_pool 一律排除:
//     前三者是客户自有;custom 是用户手输的,无法确认是不是自有;
//     shared_pool 是从池子里拉回来的,再传回去会让贡献计数虚高。
//  2. 不在 SelfOwned 集合里(steal-self 的 dest、与服务器域名重名的 dest)。
//  3. 域名本身及其根域都不在「自有根域」集合里。根域比对是必须的:
//     服务器域名是 us1.example.com、而 dest 写成 example.com 时,
//     纯字符串相等比不出来,会直接把客户的根域泄露出去。
//  4. 不在用户撤回名单里。
//
// 任何一条判不准时都选择**不共享**——少传一个公共站没有代价,多传一个客户域名是事故。
func selectShareableDomains(in shareFilterInput) []string {
	selfRoots := make(map[string]struct{}, 16)
	markSelfRoot := func(raw string) {
		d := normalizeDomainCandidate(raw)
		if d == "" {
			return
		}
		selfRoots[d] = struct{}{}
		selfRoots[extractRootDomain(d)] = struct{}{}
	}

	for d := range in.SelfOwned {
		markSelfRoot(d)
	}
	for _, c := range in.CertDomains {
		markSelfRoot(c)
	}

	optOut := make(map[string]struct{}, len(in.OptOut))
	for _, d := range in.OptOut {
		if n := normalizeDomainCandidate(d); n != "" {
			optOut[n] = struct{}{}
		}
	}

	out := make([]string, 0, len(in.Domains))
	for _, raw := range in.Domains {
		d := normalizeDomainCandidate(raw)
		if d == "" {
			continue
		}
		if in.Sources[d] != domainSourceRealityDest {
			continue
		}
		if _, self := in.SelfOwned[d]; self {
			continue
		}
		if _, self := selfRoots[d]; self {
			continue
		}
		if _, self := selfRoots[extractRootDomain(d)]; self {
			continue
		}
		if _, skipped := optOut[d]; skipped {
			continue
		}
		out = append(out, d)
	}

	sort.Strings(out)
	return out
}

// shareEnabled 读共享开关。开关本身与 PRO 门控是两件事:
// 开关记录用户意愿,门控决定能不能真的用。
func (h *RemoteManageHandler) shareEnabled(ctx context.Context) bool {
	v, _ := h.repo.GetSystemSetting(ctx, realityShareEnabledSettingKey)
	return v == "true" || v == "1"
}

// realityPoolLicensed 判断当前许可证是否具备共享池能力。
func (h *RemoteManageHandler) realityPoolLicensed() bool {
	return h.licenseManager != nil && h.licenseManager.HasFeature(featureRealityPool)
}

// buildShareCandidates 收集当前可共享的域名清单。
// 它把 inventory + 证书库 + 撤回名单喂给 selectShareableDomains。
func (h *RemoteManageHandler) buildShareCandidates(ctx context.Context) ([]string, error) {
	inv, err := h.collectRealityDomainInventory(ctx)
	if err != nil {
		return nil, err
	}

	var certDomains []string
	if certs, certErr := h.repo.ListCertificates(ctx); certErr == nil {
		for _, c := range certs {
			if d := strings.TrimSpace(c.Domain); d != "" {
				certDomains = append(certDomains, d)
			}
		}
	}

	return selectShareableDomains(shareFilterInput{
		Domains:     inv.Domains,
		Sources:     inv.Sources,
		SelfOwned:   inv.SelfOwned,
		CertDomains: certDomains,
		OptOut:      loadDomainListSetting(ctx, h.repo, realityShareOptOutSettingKey),
	}), nil
}

// HandleRealityShareStatus 返回共享功能的当前状态 + 待共享清单预览。
//
// 预览是刻意设计的:自动过滤覆盖不到「客户自有但证书不在本系统申请」的情况,
// 让用户开启前先看一眼清单,是对这个盲区唯一的兜底。
func (h *RemoteManageHandler) HandleRealityShareStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		remoteWriteError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	ctx := r.Context()

	candidates, err := h.buildShareCandidates(ctx)
	if err != nil {
		remoteWriteError(w, http.StatusInternalServerError, fmt.Sprintf("收集待共享域名失败: %v", err))
		return
	}
	shared := loadDomainListSetting(ctx, h.repo, realityShareSharedSettingKey)
	if shared == nil {
		shared = []string{}
	}

	poolSize := 0
	if h.realityPoolLicensed() {
		if pool, poolErr := h.licenseManager.ListRealityDomains(ctx); poolErr == nil {
			poolSize = len(pool)
		}
	}

	remoteWriteJSON(w, http.StatusOK, map[string]any{
		"success":   true,
		"enabled":   h.shareEnabled(ctx),
		"licensed":  h.realityPoolLicensed(),
		"pending":   candidates,
		"shared":    shared,
		"pool_size": poolSize,
	})
}

// HandleRealityShareToggle 开关共享功能。开启时立即上报一次当前清单。
func (h *RemoteManageHandler) HandleRealityShareToggle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		remoteWriteError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	var req struct {
		Enabled bool `json:"enabled"`
		// Domains 为用户在预览清单里勾选保留的域名。前端必须显式传:
		// 不传就当空清单,宁可不共享,也不能默认把没确认过的域名传出去。
		Domains []string `json:"domains"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		remoteWriteError(w, http.StatusBadRequest, "invalid request")
		return
	}

	ctx := r.Context()
	if req.Enabled && !h.realityPoolLicensed() {
		remoteWriteError(w, http.StatusForbidden, "共享域名池是 PRO 功能，请升级许可证")
		return
	}

	value := "false"
	if req.Enabled {
		value = "true"
	}
	if err := h.repo.SetSystemSetting(ctx, realityShareEnabledSettingKey, value); err != nil {
		remoteWriteError(w, http.StatusInternalServerError, fmt.Sprintf("保存开关失败: %v", err))
		return
	}

	if !req.Enabled {
		remoteWriteJSON(w, http.StatusOK, map[string]any{"success": true, "enabled": false})
		return
	}

	accepted, rejected, err := h.shareDomains(ctx, req.Domains)
	if err != nil {
		remoteWriteError(w, http.StatusBadGateway, fmt.Sprintf("上报失败: %v", err))
		return
	}
	remoteWriteJSON(w, http.StatusOK, map[string]any{
		"success":  true,
		"enabled":  true,
		"accepted": accepted,
		"rejected": rejected,
	})
}

// HandleRealityShareSync 手动触发一次上报(用于新增域名后立即共享)。
func (h *RemoteManageHandler) HandleRealityShareSync(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		remoteWriteError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	ctx := r.Context()
	if !h.shareEnabled(ctx) {
		remoteWriteError(w, http.StatusBadRequest, "共享未开启")
		return
	}

	candidates, err := h.buildShareCandidates(ctx)
	if err != nil {
		remoteWriteError(w, http.StatusInternalServerError, fmt.Sprintf("收集待共享域名失败: %v", err))
		return
	}
	accepted, rejected, err := h.shareDomains(ctx, candidates)
	if err != nil {
		remoteWriteError(w, http.StatusBadGateway, fmt.Sprintf("上报失败: %v", err))
		return
	}
	remoteWriteJSON(w, http.StatusOK, map[string]any{
		"success": true, "accepted": accepted, "rejected": rejected,
	})
}

// HandleRealityShareWithdraw 撤回已共享的域名。
func (h *RemoteManageHandler) HandleRealityShareWithdraw(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		remoteWriteError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	var req struct {
		Domain string `json:"domain"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		remoteWriteError(w, http.StatusBadRequest, "invalid request")
		return
	}
	domain := normalizeDomainCandidate(req.Domain)
	if domain == "" {
		remoteWriteError(w, http.StatusBadRequest, "域名不能为空")
		return
	}

	ctx := r.Context()
	if h.licenseManager != nil {
		if _, err := h.licenseManager.WithdrawRealityDomains(ctx, []string{domain}); err != nil {
			remoteWriteError(w, http.StatusBadGateway, fmt.Sprintf("撤回失败: %v", err))
			return
		}
	}

	// 记进 opt-out,否则下次同步又会把它传上去
	optOut := loadDomainListSetting(ctx, h.repo, realityShareOptOutSettingKey)
	_ = saveDomainListSetting(ctx, h.repo, realityShareOptOutSettingKey, append(optOut, domain))

	shared := loadDomainListSetting(ctx, h.repo, realityShareSharedSettingKey)
	remaining := make([]string, 0, len(shared))
	for _, d := range shared {
		if normalizeDomainCandidate(d) != domain {
			remaining = append(remaining, d)
		}
	}
	_ = saveDomainListSetting(ctx, h.repo, realityShareSharedSettingKey, remaining)

	remoteWriteJSON(w, http.StatusOK, map[string]any{"success": true, "message": "已撤回"})
}

// shareDomains 把域名上报给许可证服务器,并记录成功的部分。
//
// 二次过滤是必须的:请求体里的 domains 来自前端,可能被篡改或过期。
// 服务端要以自己算出的可共享集合为准,前端只能在这个集合里做减法,不能做加法。
func (h *RemoteManageHandler) shareDomains(ctx context.Context, requested []string) ([]string, map[string]string, error) {
	if h.licenseManager == nil {
		return nil, nil, errors.New("许可证未初始化")
	}

	allowed, err := h.buildShareCandidates(ctx)
	if err != nil {
		return nil, nil, err
	}
	allowedSet := make(map[string]struct{}, len(allowed))
	for _, d := range allowed {
		allowedSet[d] = struct{}{}
	}

	final := make([]string, 0, len(requested))
	for _, raw := range requested {
		d := normalizeDomainCandidate(raw)
		if d == "" {
			continue
		}
		if _, ok := allowedSet[d]; !ok {
			log.Printf("[reality-share] 拒绝上报未通过隐私过滤的域名: %s", d)
			continue
		}
		final = append(final, d)
	}
	if len(final) == 0 {
		return []string{}, map[string]string{}, nil
	}

	accepted, rejected, err := h.licenseManager.SubmitRealityDomains(ctx, final)
	if err != nil {
		return nil, nil, err
	}

	shared := loadDomainListSetting(ctx, h.repo, realityShareSharedSettingKey)
	_ = saveDomainListSetting(ctx, h.repo, realityShareSharedSettingKey, append(shared, accepted...))

	return accepted, rejected, nil
}
