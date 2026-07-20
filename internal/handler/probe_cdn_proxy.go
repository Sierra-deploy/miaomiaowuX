package handler

import (
	_ "embed"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"miaomiaowux/internal/storage"
)

// ProbeCDNProxyHandler 代理 + 缓存 CDN(lf3-ips.zstaticcdn.com)的省市×三网 ping 目标列表,
// 供管理员在配置伪装探针时勾选。
//
// 数据源是 `window.nodeData = {...};` 的 JS 赋值(非纯 JSON,provinceBaseData 用不带引号的键),
// 故用正则提取而非 json.Unmarshal。逆向结论:
//   - provinceBaseData: 31 省 × {unicom,mobile,telecom},值形如 "he-cu-v4.ip.zstaticcdn.com:80"
//   - extraCityNodeMeta: 159 市级单运营商节点,key(如 ah-anqing-cu-v4)→ 中文名;host = key+".ip.zstaticcdn.com:80"
//
// 安全:端点可配置但 host 后缀必须 = zstaticcdn.com(防 SSRF),仅 HTTPS GET、超时、响应体上限。
type ProbeCDNProxyHandler struct {
	repo *storage.TrafficRepository

	mu       sync.Mutex
	cache    *CDNRegions
	cachedAt time.Time
	cacheTTL time.Duration
}

func NewProbeCDNProxyHandler(repo *storage.TrafficRepository) *ProbeCDNProxyHandler {
	return &ProbeCDNProxyHandler{repo: repo, cacheTTL: 6 * time.Hour}
}

const (
	defaultCDNRegionsEndpoint = "https://lf3-ips.zstaticcdn.com/nodes_data.js"
	cdnAllowedHostSuffix      = "zstaticcdn.com" // SSRF 白名单:只允许这个域
	cdnMaxRespBytes           = 4 << 20          // 4MB 上限
)

// 兜底快照:逆向失败/断网时用内嵌的这份也能让管理员勾选(目标 IP 可能过期,需人工更新)。
//
//go:embed testdata/cdn_nodes_data.js
var embeddedCDNSnapshot []byte

// CarrierTarget 是一个可勾选的 ping 目标。
type CarrierTarget struct {
	Key  string `json:"key"`  // 全局唯一,如 he-cu-v4
	ISP  string `json:"isp"`  // unicom/mobile/telecom
	Host string `json:"host"` // he-cu-v4.ip.zstaticcdn.com(不含端口)
	Port int    `json:"port"` // 80
}

// ProvinceGroup 一个省的三网目标。
type ProvinceGroup struct {
	Province string          `json:"province"`
	Targets  []CarrierTarget `json:"targets"`
}

// CityTarget 一个市级单运营商目标。
type CityTarget struct {
	Key   string `json:"key"`
	Label string `json:"label"` // 中文名,如「安徽省安庆市」
	ISP   string `json:"isp"`
	Host  string `json:"host"`
	Port  int    `json:"port"`
}

type CDNRegions struct {
	Provinces []ProvinceGroup `json:"provinces"`
	Cities    []CityTarget    `json:"cities"`
	// International 是内置的国际目标(常量,不来自 CDN),独立分组避免与三网省市混淆。
	International []IntlTarget `json:"international"`
}

// ispFromKey 从 key 的 -cu-/-cm-/-ct- 后缀推运营商。
func ispFromKey(key string) string {
	switch {
	case strings.Contains(key, "-cu-"):
		return "unicom"
	case strings.Contains(key, "-cm-"):
		return "mobile"
	case strings.Contains(key, "-ct-"):
		return "telecom"
	}
	return ""
}

var (
	provinceRe = regexp.MustCompile(`province:\s*"([^"]+)",\s*carriers:\s*\{\s*unicom:\s*"([^"]+)",\s*mobile:\s*"([^"]+)",\s*telecom:\s*"([^"]+)"`)
	cityMetaRe = regexp.MustCompile(`"([a-z0-9]+-[a-z0-9]+-c[umt]-v4)":\s*"([^"]+)"`)
)

// splitHostPort 拆 "host:port" → (host, port)。无端口默认 80。纯函数。
func splitHostPort(s string) (string, int) {
	if i := strings.LastIndex(s, ":"); i >= 0 {
		host := s[:i]
		if p, err := strconv.Atoi(s[i+1:]); err == nil {
			return host, p
		}
		return host, 80
	}
	return s, 80
}

// keyFromHost 从省级 host(he-cu-v4.ip.zstaticcdn.com)取 key(he-cu-v4)。
func keyFromHost(host string) string {
	if i := strings.Index(host, ".ip.zstaticcdn.com"); i >= 0 {
		return host[:i]
	}
	return host
}

// parseCDNNodes 解析 nodes_data.js 内容。纯函数,golden 测试的目标。
func parseCDNNodes(raw []byte) *CDNRegions {
	s := string(raw)
	out := &CDNRegions{Provinces: []ProvinceGroup{}, Cities: []CityTarget{}}

	for _, m := range provinceRe.FindAllStringSubmatch(s, -1) {
		prov := m[1]
		grp := ProvinceGroup{Province: prov}
		for isp, raw := range map[string]string{"unicom": m[2], "mobile": m[3], "telecom": m[4]} {
			host, port := splitHostPort(raw)
			grp.Targets = append(grp.Targets, CarrierTarget{Key: keyFromHost(host), ISP: isp, Host: host, Port: port})
		}
		out.Provinces = append(out.Provinces, grp)
	}

	// 市级:extraCityNodeMeta 的 key→label。省级 key 也会匹配到 cityMetaRe(它们在 extraCityNodeMeta 里
	// 不出现,故不会重复);但 provinceBaseData 的 host 字符串里含 "he-cu-v4" 不带引号+冒号+label 结构,
	// 不会被 cityMetaRe 命中。去重保险:已在 provinces 里出现的 key 跳过。
	seen := map[string]bool{}
	for _, g := range out.Provinces {
		for _, t := range g.Targets {
			seen[t.Key] = true
		}
	}
	for _, m := range cityMetaRe.FindAllStringSubmatch(s, -1) {
		key, label := m[1], m[2]
		if seen[key] {
			continue
		}
		seen[key] = true
		out.Cities = append(out.Cities, CityTarget{
			Key:   key,
			Label: label,
			ISP:   ispFromKey(key),
			Host:  key + ".ip.zstaticcdn.com",
			Port:  80,
		})
	}
	return out
}

// isAllowedCDNEndpoint 校验端点 host 后缀 = zstaticcdn.com 且是 https(防 SSRF 到内网/任意 URL)。
func isAllowedCDNEndpoint(endpoint string) bool {
	if !strings.HasPrefix(endpoint, "https://") {
		return false
	}
	rest := strings.TrimPrefix(endpoint, "https://")
	host := rest
	if i := strings.IndexAny(rest, "/:"); i >= 0 {
		host = rest[:i]
	}
	return host == cdnAllowedHostSuffix || strings.HasSuffix(host, "."+cdnAllowedHostSuffix)
}

func (h *ProbeCDNProxyHandler) endpoint(r *http.Request) string {
	ep, _ := h.repo.GetSystemSetting(r.Context(), probeCDNRegionsEndpointKey)
	ep = strings.TrimSpace(ep)
	if ep == "" || !isAllowedCDNEndpoint(ep) {
		return defaultCDNRegionsEndpoint
	}
	return ep
}

// ServeHTTP GET /api/admin/probe/regions(管理员鉴权在路由层)。
func (h *ProbeCDNProxyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	h.mu.Lock()
	if h.cache != nil && time.Since(h.cachedAt) < h.cacheTTL {
		cached := h.cache
		h.mu.Unlock()
		respondJSON(w, http.StatusOK, map[string]any{"success": true, "regions": withIntl(cached), "source": "cache"})
		return
	}
	h.mu.Unlock()

	regions, source := h.fetchAndParse(r)

	h.mu.Lock()
	h.cache = regions
	h.cachedAt = time.Now()
	h.mu.Unlock()

	respondJSON(w, http.StatusOK, map[string]any{"success": true, "regions": withIntl(regions), "source": source})
}

// fetchAndParse 拉端点解析;失败回退内嵌快照。返回 (regions, source)。
func (h *ProbeCDNProxyHandler) fetchAndParse(r *http.Request) (*CDNRegions, string) {
	ep := h.endpoint(r)
	client := &http.Client{Timeout: 8 * time.Second}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, ep, nil)
	if err == nil {
		if resp, derr := client.Do(req); derr == nil {
			defer resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				body, _ := io.ReadAll(io.LimitReader(resp.Body, cdnMaxRespBytes))
				if regions := parseCDNNodes(body); len(regions.Provinces) > 0 {
					return regions, "live"
				}
			}
		}
	}
	// 兜底:内嵌快照
	return parseCDNNodes(embeddedCDNSnapshot), "embedded"
}

// withIntl 把内置国际目标挂进响应。不写进 h.cache —— 缓存的是 CDN 解析结果,
// 国际目标是编译期常量,每次拼上即可,免得改常量后还要等缓存过期。
func withIntl(r *CDNRegions) *CDNRegions {
	if r == nil {
		return &CDNRegions{Provinces: []ProvinceGroup{}, Cities: []CityTarget{}, International: builtinIntlTargets}
	}
	cp := *r
	cp.International = builtinIntlTargets
	return &cp
}
