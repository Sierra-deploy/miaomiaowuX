package handler

import (
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
		if err != nil || !node.Enabled || node.ClashConfig == "" {
			continue
		}
		var proxyConfig map[string]any
		if err := json.Unmarshal([]byte(node.ClashConfig), &proxyConfig); err != nil {
			continue
		}
		applyUserCredentials(proxyConfig, node, credMap)
		proxies = append(proxies, proxyConfig)
	}

	if len(proxies) == 0 {
		writeError(w, http.StatusNotFound, errors.New("套餐内无可用节点"))
		return
	}

	// Load template: default.yaml > redirhost__v3.yaml
	templateContent, err := h.loadTemplate(r)
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
		w.Header().Set("Content-Disposition", "attachment; filename=\""+pkg.Name+".yaml\"")
		h.writeTrafficHeader(w, user, pkg)
		w.Write([]byte(result))
		return
	}

	converted, err := h.convertFormat(r, []byte(result), clientType)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	h.writeTrafficHeader(w, user, pkg)
	w.Write(converted)
}

func (h *PackageSubscribeHandler) loadTemplate(r *http.Request) (string, error) {
	templatesDir := "rule_templates"

	cfg, err := h.repo.GetSystemConfig(r.Context())
	if err == nil && cfg.DefaultTemplateFilename != "" {
		content, err := os.ReadFile(filepath.Join(templatesDir, cfg.DefaultTemplateFilename))
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
	templateContent, err := h.loadTemplate(r)
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
		w.Header().Set("Content-Disposition", `attachment; filename="all-nodes.yaml"`)
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

func (h *PackageSubscribeHandler) writeTrafficHeader(w http.ResponseWriter, user storage.User, pkg *storage.Package) {
	if pkg.TrafficLimitBytes > 0 {
		w.Header().Set("subscription-userinfo", fmt.Sprintf("upload=0; download=0; total=%d", pkg.TrafficLimitBytes))
	}
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
	}
}
