package handler

import (
	"context"
	"encoding/json"
	"sort"
	"strings"

	"miaomiaowux/internal/storage"
)

// 候选域名的来源标记。
//
// 这是共享功能的隐私基石:只有 domainSourceRealityDest(真正偷的公共站)才可能被上报到
// 许可证服务器,其余来源一律视为「客户自有」,永不外传。
//
// 历史坑:tlsSettings.serverName 是 WSS/TLS 入站的自有证书域名,以前和 reality dest 一起
// 塞进同一个切片,来源信息全丢——那样做共享等于直接泄露客户域名。
const (
	domainSourceMaster      = "master"       // 主控 URL 域名 —— 自有
	domainSourceCustom      = "custom"       // 用户在向导里手工添加
	domainSourceServer      = "server"       // remote_servers.Domain / PullAddress —— 自有
	domainSourceRealityDest = "reality_dest" // realitySettings.dest / serverNames —— 偷取目标
	domainSourceTLSSNI      = "tls_sni"      // tlsSettings.serverName —— 自有证书域名
	domainSourceSharedPool  = "shared_pool"  // 许可证服务器下发的共享池
)

const (
	realityDomainsSettingKey        = "reality_domains"
	realityDomainsBlockedSettingKey = "reality_domains_blocked"
)

// selfOwnedDomainSources 是判定为「客户自有」的来源集合。
func isSelfOwnedDomainSource(source string) bool {
	switch source {
	case domainSourceMaster, domainSourceServer, domainSourceTLSSNI:
		return true
	}
	return false
}

// realityDomainInventory 是一次候选域名收集的完整结果。
type realityDomainInventory struct {
	// Domains 已剔除屏蔽名单、已排序,供探测使用
	Domains []string
	// Sources 记录每个域名首次命中的来源
	Sources map[string]string
	// ServerMap 域名 -> 提供它的服务器(仅 server 来源)
	ServerMap map[string]domainServerInfo
	// SelfOwned 判定为客户自有的域名(含 steal-self 服务器的 dest)
	SelfOwned map[string]struct{}
	// Blocked 当前屏蔽名单(已从 Domains 中剔除)
	Blocked []string
}

// domainAccumulator 边收集边记录来源,替代原先裸的 seen/out 二元组。
type domainAccumulator struct {
	seen      map[string]struct{}
	order     []string
	sources   map[string]string
	selfOwned map[string]struct{}
}

func newDomainAccumulator() *domainAccumulator {
	return &domainAccumulator{
		seen:      make(map[string]struct{}),
		order:     make([]string, 0, 64),
		sources:   make(map[string]string, 64),
		selfOwned: make(map[string]struct{}, 16),
	}
}

// add 归一化后登记一个域名,返回归一化结果(无效则返回 "")。
//
// 同一域名多次出现时保留**首次**来源,但 selfOwned 标记是**粘性**的:只要任意一次以自有
// 来源出现过,就永久算自有。宁可少共享一个公共站,不可泄露一个客户域名。
func (a *domainAccumulator) add(raw, source string) string {
	d := normalizeDomainCandidate(raw)
	if d == "" {
		return ""
	}
	if _, exists := a.seen[d]; !exists {
		a.seen[d] = struct{}{}
		a.order = append(a.order, d)
		a.sources[d] = source
	}
	if isSelfOwnedDomainSource(source) {
		a.selfOwned[d] = struct{}{}
	}
	return d
}

// markSelfOwned 强制把某域名标为自有,用于 steal-self 服务器的 dest
// (它以 reality_dest 来源进来,但实际是客户自己的域名)。
func (a *domainAccumulator) markSelfOwned(domain string) {
	if domain != "" {
		a.selfOwned[domain] = struct{}{}
	}
}

// isStealSelfServer 判断服务器是否是「reality 偷自己」模式。
//
// 只认 DeployStealSelfConfig 里显式分支的两个值。空值/"default" 走内嵌默认模板,不偷自己。
// 即使这里判漏,服务器自己的 Domain/PullAddress 也已经以 server 来源进过 selfOwned
// (粘性标记),dest 等于自有域名的情况仍然会被拦住——本函数是第二道保险。
func isStealSelfServer(server storage.RemoteServer) bool {
	return server.StealMode == "tunnel" || server.StealMode == "fallback"
}

// loadDomainListSetting 读一个存成 JSON 数组的 system_config 域名列表。
// 解析失败按空列表处理:配置坏掉不应该让整个探测流程失败。
func loadDomainListSetting(ctx context.Context, repo *storage.TrafficRepository, key string) []string {
	raw, _ := repo.GetSystemSetting(ctx, key)
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var list []string
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		return nil
	}
	return list
}

// saveDomainListSetting 归一化 + 去重 + 排序后写回。
func saveDomainListSetting(ctx context.Context, repo *storage.TrafficRepository, key string, domains []string) error {
	seen := make(map[string]struct{}, len(domains))
	out := make([]string, 0, len(domains))
	for _, raw := range domains {
		d := normalizeDomainCandidate(raw)
		if d == "" {
			continue
		}
		if _, exists := seen[d]; exists {
			continue
		}
		seen[d] = struct{}{}
		out = append(out, d)
	}
	sort.Strings(out)
	data, err := json.Marshal(out)
	if err != nil {
		return err
	}
	return repo.SetSystemSetting(ctx, key, string(data))
}

// blockedDomainSet 返回屏蔽名单的集合形式,便于 O(1) 过滤。
func blockedDomainSet(ctx context.Context, repo *storage.TrafficRepository) map[string]struct{} {
	list := loadDomainListSetting(ctx, repo, realityDomainsBlockedSettingKey)
	set := make(map[string]struct{}, len(list))
	for _, d := range list {
		if n := normalizeDomainCandidate(d); n != "" {
			set[n] = struct{}{}
		}
	}
	return set
}
