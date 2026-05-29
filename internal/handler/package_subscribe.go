package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"miaomiaowux/internal/auth"
	"miaomiaowux/internal/storage"
	"miaomiaowux/internal/substore"

	"gopkg.in/yaml.v3"
)

type PackageSubscribeHandler struct {
	repo *storage.TrafficRepository
}

func NewPackageSubscribeHandler(repo *storage.TrafficRepository) http.Handler {
	return &PackageSubscribeHandler{repo: repo}
}

func (h *PackageSubscribeHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, errors.New("only GET is supported"))
		return
	}

	username := auth.UsernameFromContext(r.Context())
	if username == "" {
		writeError(w, http.StatusUnauthorized, errors.New("unauthorized"))
		return
	}

	user, err := h.repo.GetUser(r.Context(), username)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	if user.PackageID == 0 {
		if user.Role != storage.RoleAdmin {
			writeError(w, http.StatusNotFound, errors.New("未绑定套餐"))
			return
		}
		h.serveAllNodes(w, r, user)
		return
	}

	pkg, err := h.repo.GetPackage(r.Context(), user.PackageID)
	if err != nil {
		if errors.Is(err, storage.ErrPackageNotFound) {
			writeError(w, http.StatusNotFound, errors.New("套餐不存在"))
			return
		}
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	// Build user credential lookup for per-user proxy configs
	credMap := h.buildUserCredentialMap(r, username)

	// Load nodes from package
	var proxies []map[string]any
	for _, nodeID := range pkg.Nodes {
		node, err := h.repo.GetNodeByID(r.Context(), nodeID)
		if err != nil || !node.Enabled {
			continue
		}
		// routed 节点:克隆父 inbound 的 clash 模板,替换 uuid 为该用户子账号 uuid + 节点名
		if node.NodeType == "routed" {
			if proxyConfig, ok := buildRoutedProxyForUser(r.Context(), h.repo, node, username); ok {
				proxies = append(proxies, proxyConfig)
			}
			continue
		}
		if node.ClashConfig == "" {
			continue
		}
		var proxyConfig map[string]any
		if err := json.Unmarshal([]byte(node.ClashConfig), &proxyConfig); err != nil {
			continue
		}
		applyUserCredentials(proxyConfig, node, credMap)
		proxies = append(proxies, proxyConfig)
	}

	// 追加用户私有路由出站(routed_owner='user' && username=<creator>):不依赖套餐分配,
	// 创建者一人独享。其 routed 子账号 email 已通过 user_subaccounts 维护,buildRoutedProxyForUser
	// 复用同一套替换 uuid 逻辑。
	if userRouted, err := h.repo.ListUserRoutedOutbounds(r.Context(), username); err == nil {
		for _, n := range userRouted {
			if !n.Enabled {
				continue
			}
			if proxyConfig, ok := buildRoutedProxyForUser(r.Context(), h.repo, n.Node, username); ok {
				proxies = append(proxies, proxyConfig)
			}
		}
	}

	if len(proxies) == 0 {
		writeError(w, http.StatusNotFound, errors.New("套餐内无可用节点"))
		return
	}

	// Load template: 套餐模板 > 系统默认 > 目录第一个
	templateContent, err := h.loadTemplate(r, pkg)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	// Process template with nodes
	processor := substore.NewTemplateV3Processor(nil, nil)
	result, err := processor.ProcessTemplate(templateContent, proxies)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	result, err = injectProxiesIntoTemplate(result, proxies)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	// Format conversion
	clientType := strings.TrimSpace(r.URL.Query().Get("t"))
	if clientType == "" || clientType == "clash" || clientType == "clashmeta" {
		w.Header().Set("Content-Type", "text/yaml; charset=utf-8")
		// 显式带 t=clash/clashmeta 通常是浏览器/调试预览,不想被强制下载;只有完全不带 t(典型 Clash 客户端拉取)才下发 attachment
		if clientType == "" {
			w.Header().Set("Content-Disposition", "attachment; filename=\""+pkg.Name+".yaml\"")
		}
		h.writeTrafficHeader(r.Context(), w, user, pkg)
		w.Write([]byte(result))
		return
	}

	converted, err := h.convertFormat(r, []byte(result), clientType)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	h.writeTrafficHeader(r.Context(), w, user, pkg)
	w.Write(converted)
}

// loadTemplate 优先级:套餐绑的模板 → 系统默认模板 → rule_templates 目录第一个 yaml。
// pkg 为 nil 时跳过套餐模板这一级(serveAllNodes 等无套餐上下文场景)。
func (h *PackageSubscribeHandler) loadTemplate(r *http.Request, pkg *storage.Package) (string, error) {
	templatesDir := "rule_templates"

	var candidates []string
	if pkg != nil && strings.TrimSpace(pkg.TemplateFilename) != "" {
		candidates = append(candidates, pkg.TemplateFilename)
	}
	if cfg, err := h.repo.GetSystemConfig(r.Context()); err == nil && cfg.DefaultTemplateFilename != "" {
		candidates = append(candidates, cfg.DefaultTemplateFilename)
	}
	for _, name := range candidates {
		content, err := os.ReadFile(filepath.Join(templatesDir, name))
		if err == nil {
			return string(content), nil
		}
	}

	entries, err := os.ReadDir(templatesDir)
	if err == nil {
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".yaml") {
				continue
			}
			content, err := os.ReadFile(filepath.Join(templatesDir, e.Name()))
			if err == nil {
				return string(content), nil
			}
		}
	}
	return "", errors.New("未找到可用模板，请管理员配置模板")
}

func (h *PackageSubscribeHandler) serveAllNodes(w http.ResponseWriter, r *http.Request, user storage.User) {
	allNodes, err := h.repo.ListAllNodes(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	var proxies []map[string]any
	for _, node := range allNodes {
		if !node.Enabled || node.ClashConfig == "" {
			continue
		}
		var proxyConfig map[string]any
		if err := json.Unmarshal([]byte(node.ClashConfig), &proxyConfig); err != nil {
			continue
		}
		proxies = append(proxies, proxyConfig)
	}
	if len(proxies) == 0 {
		writeError(w, http.StatusNotFound, errors.New("无可用节点"))
		return
	}
	// serveAllNodes 是"无套餐上下文,导出全部节点"的旁路调试入口 — 传 nil 走系统默认模板。
	templateContent, err := h.loadTemplate(r, nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	processor := substore.NewTemplateV3Processor(nil, nil)
	result, err := processor.ProcessTemplate(templateContent, proxies)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	result, err = injectProxiesIntoTemplate(result, proxies)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	clientType := strings.TrimSpace(r.URL.Query().Get("t"))
	if clientType == "" || clientType == "clash" || clientType == "clashmeta" {
		w.Header().Set("Content-Type", "text/yaml; charset=utf-8")
		if clientType == "" {
			w.Header().Set("Content-Disposition", `attachment; filename="all-nodes.yaml"`)
		}
		w.Write([]byte(result))
		return
	}
	converted, err := h.convertFormat(r, []byte(result), clientType)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write(converted)
}

func (h *PackageSubscribeHandler) writeTrafficHeader(ctx context.Context, w http.ResponseWriter, user storage.User, pkg *storage.Package) {
	if pkg.TrafficLimitBytes <= 0 {
		return
	}
	// 已用流量 = 裸流量(SUM(uplink+downlink)) × 套餐倍率(oneway×1 / twoway×2),
	// 与限额判定口径一致(traffic_limit_enforcer.go:已用×TrafficMultiplier 比限额),
	// 这样客户端显示的已用/剩余与实际被断流的时机吻合。
	// 之前这里硬编码 download=0,导致客户端永远显示已用 0。
	raw, _ := h.repo.GetUserTotalTraffic(ctx, user.Username)
	used := raw * pkg.TrafficMultiplier()
	info := fmt.Sprintf("upload=0; download=%d; total=%d", used, pkg.TrafficLimitBytes)
	if user.PackageEndDate != nil {
		info += fmt.Sprintf("; expire=%d", user.PackageEndDate.Unix())
	}
	w.Header().Set("subscription-userinfo", info)
}

func (h *PackageSubscribeHandler) convertFormat(r *http.Request, yamlData []byte, clientType string) ([]byte, error) {
	var rootNode yaml.Node
	if err := yaml.Unmarshal(yamlData, &rootNode); err != nil {
		return nil, err
	}

	config, err := yamlNodeToMap(&rootNode)
	if err != nil {
		return nil, err
	}

	proxiesRaw, ok := config["proxies"]
	if !ok {
		return nil, errors.New("no proxies in config")
	}

	proxiesArray, ok := proxiesRaw.([]interface{})
	if !ok {
		return nil, errors.New("proxies is not an array")
	}

	var proxies []substore.Proxy
	for _, p := range proxiesArray {
		proxyMap, ok := p.(map[string]interface{})
		if !ok {
			continue
		}
		proxies = append(proxies, substore.Proxy(proxyMap))
	}

	if clientType == "clash-to-surge" {
		sub := NewSubscriptionHandlerConcrete(h.repo, "subscribes")
		return sub.convertClashToSurge(config, proxies)
	}

	factory := substore.GetDefaultFactory()
	producer, err := factory.GetProducer(clientType)
	if err != nil {
		return nil, err
	}

	systemConfig, _ := h.repo.GetSystemConfig(r.Context())
	opts := &substore.ProduceOptions{
		FullConfig:              config,
		ClientCompatibilityMode: systemConfig.ClientCompatibilityMode,
	}

	result, err := producer.Produce(proxies, clientType, opts)
	if err != nil {
		return nil, err
	}

	switch v := result.(type) {
	case []byte:
		return v, nil
	case string:
		return []byte(v), nil
	default:
		return nil, fmt.Errorf("unexpected produce result type: %T", result)
	}
}

type credKey struct {
	serverName string
	inboundTag string
}

func (h *PackageSubscribeHandler) buildUserCredentialMap(r *http.Request, username string) map[credKey]string {
	ctx := r.Context()
	userConfigs, err := h.repo.GetUserInboundConfigs(ctx, username)
	if err != nil || len(userConfigs) == 0 {
		return nil
	}
	servers, err := h.repo.ListRemoteServers(ctx)
	if err != nil {
		return nil
	}
	idToName := make(map[int64]string, len(servers))
	for _, s := range servers {
		idToName[s.ID] = s.Name
	}
	m := make(map[credKey]string, len(userConfigs))
	for _, cfg := range userConfigs {
		if name, ok := idToName[cfg.ServerID]; ok {
			m[credKey{name, cfg.InboundTag}] = cfg.CredentialJSON
		}
	}
	return m
}

func applyUserCredentials(proxy map[string]any, node storage.Node, credMap map[credKey]string) {
	if credMap == nil || node.OriginalServer == "" || node.InboundTag == "" {
		return
	}
	credJSON, ok := credMap[credKey{node.OriginalServer, node.InboundTag}]
	if !ok {
		return
	}
	var cred map[string]any
	if err := json.Unmarshal([]byte(credJSON), &cred); err != nil {
		return
	}
	switch node.Protocol {
	case "vless", "vmess":
		if id, ok := cred["id"].(string); ok && id != "" {
			proxy["uuid"] = id
		}
	case "ss", "shadowsocks":
		if userPass, ok := cred["password"].(string); ok && userPass != "" {
			if nodePass, ok := proxy["password"].(string); ok && nodePass != "" {
				proxy["password"] = nodePass + ":" + userPass
			}
		}
	case "trojan":
		if password, ok := cred["password"].(string); ok && password != "" {
			proxy["password"] = password
		}
	case "hysteria2", "hysteria", "hy2":
		// HY2 客户端凭据 auth → clash hysteria2 节点的 password 字段。
		if auth, ok := cred["auth"].(string); ok && auth != "" {
			proxy["password"] = auth
		}
	}
}

// buildRoutedProxyForUser 为某用户 + 某 routed 节点生成订阅条目:
//   - 取父物理节点的 ClashConfig 作为协议/streamSettings 模板
//   - 用 user_subaccounts.credential_json 里的 uuid 覆盖
//   - 节点名换成 routed 节点的 NodeName
//
// 返回 (proxy_map, true) 或 (nil, false)(用户未绑定子账号 / 未 active / 父节点不可用 → 跳过)。
func buildRoutedProxyForUser(ctx context.Context, repo *storage.TrafficRepository, routedNode storage.Node, username string) (map[string]any, bool) {
	// 子账号必须 is_active=1,否则该用户当前没有访问权(下线 / 未绑套餐 / 暂停)
	sa, err := repo.GetUserSubaccount(ctx, routedNode.ID, username)
	if err != nil || sa == nil || !sa.IsActive {
		return nil, false
	}

	// clash_config 来源优先级:
	//   1. 父节点的 clash_config(绑定到普通 inbound 物理节点的标准 routed)
	//   2. routed 节点自身的 clash_config(纯出站 server 场景:server 上没默认 inbound,
	//      同步入站时识别不出 parent,但 routed 节点入库时已克隆了完整可连配置)
	var clashJSON string
	if routedNode.ParentNodeID != nil && *routedNode.ParentNodeID > 0 {
		if parent, perr := repo.GetNodeByID(ctx, *routedNode.ParentNodeID); perr == nil && parent.Enabled && parent.ClashConfig != "" {
			clashJSON = parent.ClashConfig
		}
	}
	if clashJSON == "" && strings.TrimSpace(routedNode.ClashConfig) != "" {
		clashJSON = routedNode.ClashConfig
	}
	if clashJSON == "" {
		return nil, false
	}

	var proxy map[string]any
	if err := json.Unmarshal([]byte(clashJSON), &proxy); err != nil {
		return nil, false
	}
	// 覆盖 uuid(VLESS/VMess 主键)、节点名
	var cred map[string]any
	if err := json.Unmarshal([]byte(sa.CredentialJSON), &cred); err == nil {
		if id, ok := cred["id"].(string); ok && id != "" {
			proxy["uuid"] = id
		}
	}
	proxy["name"] = routedNode.NodeName
	return proxy, true
}
