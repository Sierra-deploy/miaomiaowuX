package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"miaomiaowux/internal/logger"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"miaomiaowux/internal/auth"
	"miaomiaowux/internal/license"
	"miaomiaowux/internal/storage"

	"gopkg.in/yaml.v3"
)

// ConvertNilToEmptyStringInMap 递归地将 nil 值转换为映射中的空字符串
func convertNilToEmptyStringInMap(m map[string]any) {
	for k, v := range m {
		if v == nil {
			m[k] = ""
		} else if subMap, ok := v.(map[string]any); ok {
			convertNilToEmptyStringInMap(subMap)
		} else if slice, ok := v.([]any); ok {
			for i, item := range slice {
				if item == nil {
					slice[i] = ""
				} else if itemMap, ok := item.(map[string]any); ok {
					convertNilToEmptyStringInMap(itemMap)
				}
			}
		}
	}
}

// 安全地进行 URL 解码，解码失败时返回原字符串
func safeURLDecode(s string) string {
	if s == "" {
		return s
	}
	decoded, err := url.QueryUnescape(s)
	if err != nil {
		return s
	}
	return decoded
}

// decodeProxyURLFields 对代理节点中可能包含 URL 编码的字段进行解码
// 主要处理 path、host 等字段，支持 ws-opts、h2-opts、grpc-opts 等传输层配置
func decodeProxyURLFields(proxy map[string]any) {
	// 处理 ws-opts
	if wsOpts, ok := proxy["ws-opts"].(map[string]any); ok {
		if path, ok := wsOpts["path"].(string); ok {
			wsOpts["path"] = safeURLDecode(path)
		}
		if headers, ok := wsOpts["headers"].(map[string]any); ok {
			if host, ok := headers["Host"].(string); ok {
				headers["Host"] = safeURLDecode(host)
			}
		}
	}

	// 处理 h2-opts
	if h2Opts, ok := proxy["h2-opts"].(map[string]any); ok {
		if path, ok := h2Opts["path"].(string); ok {
			h2Opts["path"] = safeURLDecode(path)
		}
		if host, ok := h2Opts["host"].(string); ok {
			h2Opts["host"] = safeURLDecode(host)
		}
		// host 也可能是数组
		if hosts, ok := h2Opts["host"].([]any); ok {
			for i, h := range hosts {
				if hs, ok := h.(string); ok {
					hosts[i] = safeURLDecode(hs)
				}
			}
		}
	}

	// 处理 grpc-opts
	if grpcOpts, ok := proxy["grpc-opts"].(map[string]any); ok {
		if serviceName, ok := grpcOpts["grpc-service-name"].(string); ok {
			grpcOpts["grpc-service-name"] = safeURLDecode(serviceName)
		}
	}

	// 处理顶层的 path 和 host 字段（某些协议可能直接放在顶层）
	if path, ok := proxy["path"].(string); ok {
		proxy["path"] = safeURLDecode(path)
	}
	if host, ok := proxy["host"].(string); ok {
		proxy["host"] = safeURLDecode(host)
	}

	// 处理 sni 和 servername 字段（TLS 相关）
	if sni, ok := proxy["sni"].(string); ok {
		proxy["sni"] = safeURLDecode(sni)
	}
	if servername, ok := proxy["servername"].(string); ok {
		proxy["servername"] = safeURLDecode(servername)
	}
}

type nodesHandler struct {
	repo            *storage.TrafficRepository
	subscribeDir    string
	yamlSyncManager *YAMLSyncManager
	remoteManage    *RemoteManageHandler
	licenseManager  *license.Manager
}

// 返回一个管理代理节点的仅管理处理程序。
func NewNodesHandler(repo *storage.TrafficRepository, subscribeDir string, remoteManage *RemoteManageHandler, licenseMgr *license.Manager) http.Handler {
	if repo == nil {
		panic("nodes handler requires repository")
	}

	return &nodesHandler{
		repo:            repo,
		subscribeDir:    subscribeDir,
		yamlSyncManager: NewYAMLSyncManager(subscribeDir),
		remoteManage:    remoteManage,
		licenseManager:  licenseMgr,
	}
}

// fetchNodeForAccess 按权限获取节点:管理员可取任意节点,普通用户只能取自己创建的(否则 NotFound)。
func (h *nodesHandler) fetchNodeForAccess(ctx context.Context, id int64, username string, isAdmin bool) (storage.Node, error) {
	if isAdmin {
		return h.repo.GetNodeByID(ctx, id)
	}
	return h.repo.GetNode(ctx, id, username)
}

// deleteNodeForAccess 按权限删除节点:管理员可删任意,普通用户只能删自己的。
func (h *nodesHandler) deleteNodeForAccess(ctx context.Context, id int64, username string, isAdmin bool) error {
	if isAdmin {
		return h.repo.DeleteNodeByID(ctx, id)
	}
	return h.repo.DeleteNode(ctx, id, username)
}

func (h *nodesHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/admin/nodes")
	path = strings.Trim(path, "/")

	// 普通用户开放:列表 / 标签 / 解析订阅 / 批量导入(自己的外部节点) / 查看关联入站。
	// 仅管理员:手动单个新增、改名/改标签/改服务器/改配置、删除/清空/批量删改
	//（这些写操作会同步到共享 YAML 订阅文件,影响管理员)。
	isAdmin := userIsAdmin(r.Context(), h.repo, auth.UsernameFromContext(r.Context()))
	denyNonAdmin := func() bool {
		if !isAdmin {
			writeError(w, http.StatusForbidden, errors.New("该操作仅管理员可用"))
			return true
		}
		return false
	}

	switch {
	case path == "" && r.Method == http.MethodGet:
		h.handleList(w, r)
	case path == "" && r.Method == http.MethodPost:
		if denyNonAdmin() {
			return
		}
		h.handleCreate(w, r)
	case path == "batch" && r.Method == http.MethodPost:
		h.handleBatchCreate(w, r)
	case path == "fetch-subscription" && r.Method == http.MethodPost:
		h.handleFetchSubscription(w, r)
	case strings.HasSuffix(path, "/related-inbounds") && r.Method == http.MethodGet:
		idSegment := strings.TrimSuffix(path, "/related-inbounds")
		h.handleGetRelatedInbounds(w, r, idSegment)
	case strings.HasSuffix(path, "/server") && r.Method == http.MethodPut:
		if denyNonAdmin() {
			return
		}
		idSegment := strings.TrimSuffix(path, "/server")
		h.handleUpdateServer(w, r, idSegment)
	case strings.HasSuffix(path, "/restore-server") && r.Method == http.MethodPut:
		if denyNonAdmin() {
			return
		}
		idSegment := strings.TrimSuffix(path, "/restore-server")
		h.handleRestoreServer(w, r, idSegment)
	case strings.HasSuffix(path, "/config") && r.Method == http.MethodPut:
		if denyNonAdmin() {
			return
		}
		idSegment := strings.TrimSuffix(path, "/config")
		h.handleUpdateConfig(w, r, idSegment)
	case path != "" && path != "batch" && path != "fetch-subscription" && !strings.HasSuffix(path, "/server") && !strings.HasSuffix(path, "/restore-server") && !strings.HasSuffix(path, "/config") && !strings.HasSuffix(path, "/related-inbounds") && (r.Method == http.MethodPut || r.Method == http.MethodPatch):
		if denyNonAdmin() {
			return
		}
		h.handleUpdate(w, r, path)
	case path != "" && path != "batch" && path != "fetch-subscription" && !strings.HasSuffix(path, "/related-inbounds") && r.Method == http.MethodDelete:
		if denyNonAdmin() {
			return
		}
		h.handleDelete(w, r, path)
	case path == "clear" && r.Method == http.MethodPost:
		if denyNonAdmin() {
			return
		}
		h.handleClearAll(w, r)
	case path == "batch-delete" && r.Method == http.MethodPost:
		if denyNonAdmin() {
			return
		}
		h.handleBatchDelete(w, r)
	case path == "batch-rename" && r.Method == http.MethodPost:
		if denyNonAdmin() {
			return
		}
		h.handleBatchRename(w, r)
	case path == "tags" && r.Method == http.MethodGet:
		h.handleListTags(w, r)
	default:
		allowed := []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete}
		methodNotAllowed(w, allowed...)
	}
}

func (h *nodesHandler) handleList(w http.ResponseWriter, r *http.Request) {
	username := auth.UsernameFromContext(r.Context())
	if username == "" {
		writeError(w, http.StatusUnauthorized, errors.New("用户未认证"))
		return
	}

	// 数据隔离:管理员看全部节点,但屏蔽"普通用户私有"节点。
	// 反向过滤逻辑:只有当节点 username 属于现存普通用户时才屏蔽;
	// admin 用户/legacy "admin" 字面字符串/已不存在的用户名 → 一律保留。
	if userIsAdmin(r.Context(), h.repo, username) {
		nodes, err := h.repo.ListAllNodes(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		nonAdmins, err := h.repo.ListNonAdminUsernames(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		filtered := make([]storage.Node, 0, len(nodes))
		for _, n := range nodes {
			if nonAdmins[n.Username] {
				continue
			}
			filtered = append(filtered, n)
		}
		respondJSON(w, http.StatusOK, map[string]any{"nodes": convertNodes(filtered)})
		return
	}

	// 普通用户:自己导入的节点 + 绑定套餐内的节点(只读)。
	nodes, err := h.repo.ListNodes(r.Context(), username)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	seen := make(map[int64]bool, len(nodes))
	for _, n := range nodes {
		seen[n.ID] = true
	}
	if user, uerr := h.repo.GetUser(r.Context(), username); uerr == nil && user.PackageID > 0 {
		if pkg, perr := h.repo.GetPackage(r.Context(), user.PackageID); perr == nil && pkg != nil {
			for _, nid := range pkg.Nodes {
				if seen[nid] {
					continue
				}
				if pn, nerr := h.repo.GetNodeByID(r.Context(), nid); nerr == nil {
					nodes = append(nodes, pn)
					seen[nid] = true
				}
			}
		}
	}

	// 安全:把每个节点的 clash_config 里 admin uuid/password 等凭据替换为本用户的凭据。
	// 不替换 = 把 admin 凭据原样下发给所有能看到节点的普通用户(节点管理眼睛图标会显示)。
	// routed 节点没有用户子账号的 → 完全过滤掉(用户无访问权,不该出现在列表)。
	nodes = substituteNodesForUser(r.Context(), h.repo, username, nodes)

	respondJSON(w, http.StatusOK, map[string]any{
		"nodes": convertNodes(nodes),
	})
}

// buildUserCredMapForCreator 给某个用户构造 (server_name, inbound_tag) → credential_json 映射,
// 给 applyUserCredentials 用。从 user_inbound_configs 表拉,跟 PackageSubscribeHandler.buildUserCredentialMap 同源。
//
// 复用点:nodes.go substituteNodesForUser + subscription.go generateFromTemplate(模板订阅) 都用这个。
// 抽成包级函数避免重复 + 也避免漏改一处的安全隐患。
func buildUserCredMapForCreator(ctx context.Context, repo *storage.TrafficRepository, username string) map[credKey]string {
	if username == "" {
		return nil
	}
	userConfigs, err := repo.GetUserInboundConfigs(ctx, username)
	if err != nil || len(userConfigs) == 0 {
		return nil
	}
	servers, err := repo.ListRemoteServers(ctx)
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

// substituteNodesForUser 把节点列表里的 clash_config 替换成该用户视角的版本。
//   - 普通节点:applyUserCredentials 改 uuid / password 等
//   - routed 节点:buildRoutedProxyForUser 用 user_subaccounts 凭据重建(没子账号即 drop)
// 替换/重建失败的节点保留 admin 凭据 → 这种情况是数据异常(凭据没建好),为了不让用户彻底看不到节点,
// 退而求其次返回原样;但更典型场景(用户从未绑过该节点)已经被 ListNodes 的 username 过滤掉了。
func substituteNodesForUser(ctx context.Context, repo *storage.TrafficRepository, username string, nodes []storage.Node) []storage.Node {
	if len(nodes) == 0 {
		return nodes
	}
	credMap := buildUserCredMapForCreator(ctx, repo, username)
	if credMap == nil {
		credMap = map[credKey]string{}
	}
	out := make([]storage.Node, 0, len(nodes))
	for _, n := range nodes {
		if n.NodeType == "routed" {
			// routed 节点必须有 active 子账号才能给用户;没的话整个节点过滤掉,
			// 避免把 admin 的 routed 父凭据(uuid)泄露给无权用户。
			proxy, ok := buildRoutedProxyForUser(ctx, repo, n, username)
			if !ok {
				continue
			}
			if raw, err := json.Marshal(proxy); err == nil {
				n.ClashConfig = string(raw)
			}
			out = append(out, n)
			continue
		}
		if n.ClashConfig == "" {
			out = append(out, n)
			continue
		}
		var proxy map[string]any
		if err := json.Unmarshal([]byte(n.ClashConfig), &proxy); err != nil {
			// 解析失败保持原样,避免凭空丢节点;但日志记一下方便排查
			out = append(out, n)
			continue
		}
		applyUserCredentials(proxy, n, credMap)
		if raw, err := json.Marshal(proxy); err == nil {
			n.ClashConfig = string(raw)
		}
		out = append(out, n)
	}
	return out
}

func (h *nodesHandler) handleCreate(w http.ResponseWriter, r *http.Request) {
	username := auth.UsernameFromContext(r.Context())
	if username == "" {
		writeError(w, http.StatusUnauthorized, errors.New("用户未认证"))
		return
	}

	if h.licenseManager != nil {
		status := h.licenseManager.GetStatus()
		maxNodes := 20
		if status.Plan != nil {
			maxNodes = status.Plan.MaxNodes
		}
		count, err := h.repo.CountNodes(r.Context())
		if err == nil && count >= int64(maxNodes) {
			writeJSONError(w, http.StatusForbidden, fmt.Sprintf("已达到节点数量上限 (%d/%d)，请升级许可证", count, maxNodes))
			return
		}
	}

	var req nodeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeBadRequest(w, "请求格式不正确")
		return
	}
	req.parseChainProxyNodeID()

	// 校验节点名称不为空
	if strings.TrimSpace(req.NodeName) == "" {
		logger.Info("[节点创建] 节点名称为空")
		writeBadRequest(w, "节点名称不能为空")
		return
	}

	// 校验节点名称是否重复（数据库层面）
	exists, err := h.repo.CheckNodeNameExists(r.Context(), req.NodeName, username, 0)
	if err != nil {
		logger.Info("[节点创建] 检查节点名称重复失败", "error", err)
		writeError(w, http.StatusInternalServerError, errors.New("服务器错误"))
		return
	}
	if exists {
		logger.Info("[节点创建] 节点名称重复", "node_name", req.NodeName)
		writeBadRequest(w, fmt.Sprintf("节点名称 \"%s\" 已存在，请使用其他名称", req.NodeName))
		return
	}

	// 校验Clash配置格式
	if req.ClashConfig != "" {
		var clashConfig map[string]interface{}
		if err := json.Unmarshal([]byte(req.ClashConfig), &clashConfig); err != nil {
			logger.Info("[节点创建] Clash配置格式错误", "error", err)
			writeBadRequest(w, "Clash配置格式错误")
			return
		}

		// 确保配置中的name与节点名称一致
		if configName, ok := clashConfig["name"].(string); !ok || configName != req.NodeName {
			logger.Info("[节点创建] 配置name不匹配: 节点名=, 配置名", "node_name", req.NodeName, "param", clashConfig["name"])
			writeBadRequest(w, "Clash配置中的name字段必须与节点名称一致")
			return
		}
	}

	logger.Info("[节点创建] 校验通过 - 节点名称, 用户", "node_name", req.NodeName, "user", username)

	node := storage.Node{
		Username:     username,
		RawURL:       req.RawURL,
		NodeName:     req.NodeName,
		Protocol:     req.Protocol,
		ParsedConfig: req.ParsedConfig,
		ClashConfig:  req.ClashConfig,
		Enabled:      req.Enabled,
		Tag:          req.Tag,
		InboundTag:       req.InboundTag,
		ChainProxyNodeID: req.ChainProxyNodeID,
	}

	created, err := h.repo.CreateNode(r.Context(), node)
	if err != nil {
		logger.Info("[节点创建] 数据库创建失败", "error", err)
		writeError(w, http.StatusBadRequest, err)
		return
	}

	logger.Info("[节点创建] 成功 - ID, 节点名称", "id", created.ID, "node_name", created.NodeName)

	respondJSON(w, http.StatusCreated, map[string]any{
		"node": convertNode(created),
	})
}

func (h *nodesHandler) handleBatchCreate(w http.ResponseWriter, r *http.Request) {
	username := auth.UsernameFromContext(r.Context())
	if username == "" {
		writeError(w, http.StatusUnauthorized, errors.New("用户未认证"))
		return
	}

	var req struct {
		Nodes []nodeRequest `json:"nodes"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeBadRequest(w, "请求格式不正确")
		return
	}

	if len(req.Nodes) == 0 {
		writeBadRequest(w, "节点列表不能为空")
		return
	}

	if h.licenseManager != nil {
		status := h.licenseManager.GetStatus()
		maxNodes := 20
		if status.Plan != nil {
			maxNodes = status.Plan.MaxNodes
		}
		count, err := h.repo.CountNodes(r.Context())
		if err == nil && count+int64(len(req.Nodes)) > int64(maxNodes) {
			writeJSONError(w, http.StatusForbidden, fmt.Sprintf("批量创建将超出节点上限 (%d+%d > %d)，请升级许可证", count, len(req.Nodes), maxNodes))
			return
		}
	}

	nodes := make([]storage.Node, 0, len(req.Nodes))
	for _, n := range req.Nodes {
		// 允许 Clash 订阅节点没有 RawURL，但必须有 NodeName 和 ClashConfig
		if n.NodeName == "" || n.ClashConfig == "" {
			continue
		}
		nodes = append(nodes, storage.Node{
			Username:     username,
			RawURL:       n.RawURL, // 可以为空（Clash 订阅节点）
			NodeName:     n.NodeName,
			Protocol:     n.Protocol,
			ParsedConfig: n.ParsedConfig,
			ClashConfig:  n.ClashConfig,
			Enabled:      n.Enabled,
			Tag:          n.Tag,
			InboundTag:   n.InboundTag,
		})
	}

	if len(nodes) == 0 {
		writeBadRequest(w, "没有有效的节点可以保存")
		return
	}

	created, err := h.repo.BatchCreateNodes(r.Context(), nodes)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	respondJSON(w, http.StatusCreated, map[string]any{
		"nodes": convertNodes(created),
	})
}

func (h *nodesHandler) handleUpdate(w http.ResponseWriter, r *http.Request, idSegment string) {
	username := auth.UsernameFromContext(r.Context())
	if username == "" {
		writeError(w, http.StatusUnauthorized, errors.New("用户未认证"))
		return
	}

	id, err := strconv.ParseInt(idSegment, 10, 64)
	if err != nil || id <= 0 {
		writeBadRequest(w, "无效的节点标识")
		return
	}

	existing, err := h.fetchNodeForAccess(r.Context(), id, username, userIsAdmin(r.Context(), h.repo, username))
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, storage.ErrNodeNotFound) {
			status = http.StatusNotFound
		}
		writeError(w, status, err)
		return
	}

	// 保存旧节点名称以进行 YAML 同步
	oldNodeName := existing.NodeName

	var req nodeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeBadRequest(w, "请求格式不正确")
		return
	}
	req.parseChainProxyNodeID()

	// 如果节点名称被修改，需要校验新名称
	if req.NodeName != "" && req.NodeName != oldNodeName {
		// 校验节点名称不为空
		if strings.TrimSpace(req.NodeName) == "" {
			logger.Info("[节点更新] 节点名称为空")
			writeBadRequest(w, "节点名称不能为空")
			return
		}

		// 校验节点名称是否重复（在节点所有者的命名空间内）
		exists, err := h.repo.CheckNodeNameExists(r.Context(), req.NodeName, existing.Username, id)
		if err != nil {
			logger.Info("[节点更新] 检查节点名称重复失败", "error", err)
			writeError(w, http.StatusInternalServerError, errors.New("服务器错误"))
			return
		}
		if exists {
			logger.Info("[节点更新] 节点名称重复", "node_name", req.NodeName)
			writeBadRequest(w, fmt.Sprintf("节点名称 \"%s\" 已存在，请使用其他名称", req.NodeName))
			return
		}
	}

	// 如果Clash配置被修改，需要校验格式
	if req.ClashConfig != "" {
		var clashConfig map[string]interface{}
		if err := json.Unmarshal([]byte(req.ClashConfig), &clashConfig); err != nil {
			logger.Info("[节点更新] Clash配置格式错误", "error", err)
			writeBadRequest(w, "Clash配置格式错误")
			return
		}

		// 确保配置中的name与节点名称一致
		newNodeName := req.NodeName
		if newNodeName == "" {
			newNodeName = oldNodeName
		}
		if configName, ok := clashConfig["name"].(string); !ok || configName != newNodeName {
			logger.Info("[节点更新] 配置name不匹配: 节点名=, 配置名", "value", newNodeName, "param", clashConfig["name"])
			writeBadRequest(w, "Clash配置中的name字段必须与节点名称一致")
			return
		}
	}

	logger.Info("[节点更新] 校验通过 - 节点ID, 旧名称, 新名称", "value", id, "param", oldNodeName, "node_name", req.NodeName)

	// 更新字段
	if req.RawURL != "" {
		existing.RawURL = req.RawURL
	}
	if req.NodeName != "" {
		existing.NodeName = req.NodeName
	}
	if req.Protocol != "" {
		existing.Protocol = req.Protocol
	}
	if req.ParsedConfig != "" {
		existing.ParsedConfig = req.ParsedConfig
	}
	if req.ClashConfig != "" {
		existing.ClashConfig = req.ClashConfig
	}
	if req.Tag != "" {
		existing.Tag = req.Tag
	}
	existing.Enabled = req.Enabled
	if req.hasChainProxyNodeID() {
		existing.ChainProxyNodeID = req.ChainProxyNodeID
	}

	updated, err := h.repo.UpdateNode(r.Context(), existing)
	if err != nil {
		logger.Info("[节点更新] 数据库更新失败", "error", err)
		status := http.StatusBadRequest
		if errors.Is(err, storage.ErrNodeNotFound) {
			status = http.StatusNotFound
		}
		writeError(w, status, err)
		return
	}

	logger.Info("[节点更新] 数据库更新成功 - 节点ID, 节点名称", "id", updated.ID, "node_name", updated.NodeName)

	// 使用同步管理器将节点更改同步到 YAML 文件
	if updated.ClashConfig != "" {
		newNodeName := updated.NodeName
		if err := h.yamlSyncManager.SyncNode(oldNodeName, newNodeName, updated.ClashConfig); err != nil {
			// 记录错误但不要使请求失败
			// 节点更新成功，YAML 同步已尽力
			// 如果需要，您可以在此处添加日志记录
		}
	}

	respondJSON(w, http.StatusOK, map[string]any{
		"node": convertNode(updated),
	})
}

func (h *nodesHandler) handleUpdateServer(w http.ResponseWriter, r *http.Request, idSegment string) {
	username := auth.UsernameFromContext(r.Context())
	if username == "" {
		writeError(w, http.StatusUnauthorized, errors.New("用户未认证"))
		return
	}

	id, err := strconv.ParseInt(idSegment, 10, 64)
	if err != nil || id <= 0 {
		writeBadRequest(w, "无效的节点标识")
		return
	}

	existing, err := h.fetchNodeForAccess(r.Context(), id, username, userIsAdmin(r.Context(), h.repo, username))
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, storage.ErrNodeNotFound) {
			status = http.StatusNotFound
		}
		writeError(w, status, err)
		return
	}

	var req struct {
		Server string `json:"server"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeBadRequest(w, "请求格式不正确")
		return
	}

	if req.Server == "" {
		writeBadRequest(w, "服务器地址不能为空")
		return
	}

	// 更新前保存原始域名到 OriginalDomain（专用字段，不能用 OriginalServer——那是服务器名/路由键）
	var currentClashConfig map[string]any
	if err := json.Unmarshal([]byte(existing.ClashConfig), &currentClashConfig); err == nil {
		if currentServer, ok := currentClashConfig["server"].(string); ok && currentServer != "" {
			existing.OriginalDomain = currentServer
		}
	}

	// 更新 ParsedConfig 中的 server 字段
	var parsedConfig map[string]any
	if err := json.Unmarshal([]byte(existing.ParsedConfig), &parsedConfig); err == nil {
		parsedConfig["server"] = req.Server
		if updatedParsed, err := json.Marshal(parsedConfig); err == nil {
			existing.ParsedConfig = string(updatedParsed)
		}
	}

	// 更新 ClashConfig 中的 server 字段
	var clashConfig map[string]any
	if err := json.Unmarshal([]byte(existing.ClashConfig), &clashConfig); err == nil {
		clashConfig["server"] = req.Server
		if updatedClash, err := json.Marshal(clashConfig); err == nil {
			existing.ClashConfig = string(updatedClash)
		}
	}

	updated, err := h.repo.UpdateNode(r.Context(), existing)
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, storage.ErrNodeNotFound) {
			status = http.StatusNotFound
		}
		writeError(w, status, err)
		return
	}

	// 使用同步管理器将节点更改同步到 YAML 文件（服务器地址更新）
	if updated.ClashConfig != "" {
		nodeName := updated.NodeName
		if err := h.yamlSyncManager.SyncNode(nodeName, nodeName, updated.ClashConfig); err != nil {
			// 记录错误但不要使请求失败
		}
	}

	respondJSON(w, http.StatusOK, map[string]any{
		"node": convertNode(updated),
	})
}

func (h *nodesHandler) handleRestoreServer(w http.ResponseWriter, r *http.Request, idSegment string) {
	username := auth.UsernameFromContext(r.Context())
	if username == "" {
		writeError(w, http.StatusUnauthorized, errors.New("用户未认证"))
		return
	}

	id, err := strconv.ParseInt(idSegment, 10, 64)
	if err != nil || id <= 0 {
		writeBadRequest(w, "无效的节点标识")
		return
	}

	existing, err := h.fetchNodeForAccess(r.Context(), id, username, userIsAdmin(r.Context(), h.repo, username))
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, storage.ErrNodeNotFound) {
			status = http.StatusNotFound
		}
		writeError(w, status, err)
		return
	}

	// 检查原始域名是否存在
	if existing.OriginalDomain == "" {
		writeBadRequest(w, "节点没有保存原始域名")
		return
	}

	// 从 original_domain 恢复服务器地址
	originalServer := existing.OriginalDomain

	// 更新 ParsedConfig 中的 server 字段
	var parsedConfig map[string]any
	if err := json.Unmarshal([]byte(existing.ParsedConfig), &parsedConfig); err == nil {
		parsedConfig["server"] = originalServer
		if updatedParsed, err := json.Marshal(parsedConfig); err == nil {
			existing.ParsedConfig = string(updatedParsed)
		}
	}

	// 更新 ClashConfig 中的 server 字段
	var clashConfig map[string]any
	if err := json.Unmarshal([]byte(existing.ClashConfig), &clashConfig); err == nil {
		clashConfig["server"] = originalServer
		if updatedClash, err := json.Marshal(clashConfig); err == nil {
			existing.ClashConfig = string(updatedClash)
		}
	}

	// 恢复后清除 original_domain（OriginalServer 路由键保持不变）
	existing.OriginalDomain = ""

	updated, err := h.repo.UpdateNode(r.Context(), existing)
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, storage.ErrNodeNotFound) {
			status = http.StatusNotFound
		}
		writeError(w, status, err)
		return
	}

	// 使用同步管理器将节点更改同步到 YAML 文件（恢复服务器地址）
	if updated.ClashConfig != "" {
		nodeName := updated.NodeName
		if err := h.yamlSyncManager.SyncNode(nodeName, nodeName, updated.ClashConfig); err != nil {
			// 记录错误但不要使请求失败
		}
	}

	respondJSON(w, http.StatusOK, map[string]any{
		"node": convertNode(updated),
	})
}

func (h *nodesHandler) handleUpdateConfig(w http.ResponseWriter, r *http.Request, idSegment string) {
	username := auth.UsernameFromContext(r.Context())
	if username == "" {
		writeError(w, http.StatusUnauthorized, errors.New("用户未认证"))
		return
	}

	id, err := strconv.ParseInt(idSegment, 10, 64)
	if err != nil || id <= 0 {
		writeBadRequest(w, "无效的节点标识")
		return
	}

	var req struct {
		ClashConfig string `json:"clash_config"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeBadRequest(w, "请求格式不正确")
		return
	}

	// 验证 JSON 格式
	var clashConfigMap map[string]interface{}
	if err := json.Unmarshal([]byte(req.ClashConfig), &clashConfigMap); err != nil {
		writeBadRequest(w, "Clash 配置格式不正确: "+err.Error())
		return
	}

	// 验证必填字段
	requiredFields := []string{"name", "type", "server", "port"}
	for _, field := range requiredFields {
		if _, ok := clashConfigMap[field]; !ok {
			writeBadRequest(w, fmt.Sprintf("配置缺少必需字段: %s", field))
			return
		}
	}

	// 获取现有节点(按权限:管理员任意,普通用户仅自己的)
	node, err := h.fetchNodeForAccess(r.Context(), id, username, userIsAdmin(r.Context(), h.repo, username))
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, storage.ErrNodeNotFound) {
			status = http.StatusNotFound
		}
		writeError(w, status, err)
		return
	}

	oldNodeName := node.NodeName

	// 更新节点的 ClashConfig 和 ParsedConfig
	node.ClashConfig = req.ClashConfig
	node.ParsedConfig = req.ClashConfig

	// 如果更改，请从配置中更新节点名称
	if nameValue, ok := clashConfigMap["name"]; ok {
		if newName, ok := nameValue.(string); ok && newName != "" {
			node.NodeName = newName
		}
	}

	// 更新数据库中的节点
	updated, err := h.repo.UpdateNode(r.Context(), node)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	// 使用同步管理器同步到 YAML 订阅文件
	if updated.ClashConfig != "" {
		// 如果节点名称发生更改，请将 YAML 文件中的旧名称更新为新名称
		newNodeName := updated.NodeName
		if err := h.yamlSyncManager.SyncNode(oldNodeName, newNodeName, updated.ClashConfig); err != nil {
			// 记录错误但不要使请求失败
		}
	}

	respondJSON(w, http.StatusOK, map[string]any{
		"node": convertNode(updated),
	})
}

func (h *nodesHandler) handleDelete(w http.ResponseWriter, r *http.Request, idSegment string) {
	username := auth.UsernameFromContext(r.Context())
	if username == "" {
		writeError(w, http.StatusUnauthorized, errors.New("用户未认证"))
		return
	}

	id, err := strconv.ParseInt(idSegment, 10, 64)
	if err != nil || id <= 0 {
		writeBadRequest(w, "无效的节点标识")
		return
	}

	// 检查delete_inbound参数是否设置
	deleteInbound := r.URL.Query().Get("delete_inbound") == "true"

	isAdmin := userIsAdmin(r.Context(), h.repo, username)

	// 在删除之前获取节点名称以进行 YAML 同步(按权限:管理员任意,普通用户仅自己的)
	// 如果没有找到节点，我们仍然继续删除（可能已经在其他地方删除了）
	node, err := h.fetchNodeForAccess(r.Context(), id, username, isAdmin)
	nodeNotFound := errors.Is(err, storage.ErrNodeNotFound)
	if err != nil && !nodeNotFound {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	// 如果找到节点并且delete_inbound为true，则删除关联的批次入站
	var deletedInboundCount int
	if !nodeNotFound && deleteInbound && node.NodeName != "" {
		// 获取带有匹配标签的批次入站
		batches, err := h.repo.GetBatchInboundsByTag(r.Context(), node.NodeName)
		if err == nil && len(batches) > 0 {
			// 删除批量入库记录
			if err := h.repo.DeleteBatchInboundsByTag(r.Context(), node.NodeName); err == nil {
				deletedInboundCount = len(batches)
			}
		}
	}

	// 如果节点链接到远程服务器:routed 节点只需清掉它绑定的 outbound + rule(不能动 inbound,会误删其它节点);
	// 普通物理节点保持原来"清掉整个 inbound"的行为。
	if !nodeNotFound && node.OriginalServer != "" {
		if node.NodeType == "routed" && node.RoutedOutboundTag != "" {
			h.deleteRemoteRoutedOutbound(r.Context(), node.OriginalServer, node.RoutedOutboundTag)
		} else if node.InboundTag != "" {
			h.deleteRemoteInbound(r.Context(), node.OriginalServer, node.InboundTag)
		}
	}

	// 删除节点(按权限:管理员任意,普通用户仅自己的)
	if err := h.deleteNodeForAccess(r.Context(), id, username, isAdmin); err != nil {
		if !errors.Is(err, storage.ErrNodeNotFound) {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		// 未找到节点是可以接受的 - 它已被删除
	}

	// 使用同步管理器将删除同步到 YAML 文件
	if !nodeNotFound && node.NodeName != "" {
		if err := h.yamlSyncManager.DeleteNode(node.NodeName); err != nil {
			// 记录错误但不要使请求失败
		}
	}

	resp := map[string]any{"status": "deleted"}
	if deletedInboundCount > 0 {
		resp["deleted_inbound_count"] = deletedInboundCount
	}
	respondJSON(w, http.StatusOK, resp)
}

// 通过 inbound_tag 返回与节点关联的批次入站
func (h *nodesHandler) handleGetRelatedInbounds(w http.ResponseWriter, r *http.Request, idSegment string) {
	username := auth.UsernameFromContext(r.Context())
	if username == "" {
		writeError(w, http.StatusUnauthorized, errors.New("用户未认证"))
		return
	}

	id, err := strconv.ParseInt(idSegment, 10, 64)
	if err != nil || id <= 0 {
		writeBadRequest(w, "无效的节点标识")
		return
	}

	// 获取节点以找到其入站标签
	node, err := h.repo.GetNode(r.Context(), id, username)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, storage.ErrNodeNotFound) {
			status = http.StatusNotFound
		}
		writeError(w, status, err)
		return
	}

	// 查找具有匹配标记的批次入站（如果设置了 InboundTag，则使用 InboundTag，否则回退到 NodeName 以实现向后兼容性）
	var inbounds []storage.BatchInbound
	searchTag := node.InboundTag
	if searchTag == "" {
		searchTag = node.NodeName
	}
	if searchTag != "" {
		inbounds, err = h.repo.GetBatchInboundsByTag(r.Context(), searchTag)
		if err != nil {
			// 不是严重错误，只是返回空列表
			inbounds = []storage.BatchInbound{}
		}
	}

	respondJSON(w, http.StatusOK, map[string]any{
		"node_name":   node.NodeName,
		"inbound_tag": node.InboundTag,
		"inbounds":    inbounds,
		"count":       len(inbounds),
	})
}

func (h *nodesHandler) handleClearAll(w http.ResponseWriter, r *http.Request) {
	username := auth.UsernameFromContext(r.Context())
	if username == "" {
		writeError(w, http.StatusUnauthorized, errors.New("用户未认证"))
		return
	}

	if err := h.repo.DeleteAllUserNodes(r.Context(), username); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	respondJSON(w, http.StatusOK, map[string]string{"status": "cleared"})
}

func (h *nodesHandler) handleBatchDelete(w http.ResponseWriter, r *http.Request) {
	username := auth.UsernameFromContext(r.Context())
	if username == "" {
		writeError(w, http.StatusUnauthorized, errors.New("用户未认证"))
		return
	}

	var req struct {
		NodeIDs []int64 `json:"node_ids"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeBadRequest(w, "请求格式不正确")
		return
	}

	if len(req.NodeIDs) == 0 {
		writeBadRequest(w, "节点ID列表不能为空")
		return
	}

	// 在删除之前获取所有节点信息以进行 YAML 同步和远程入站清理
	type nodeInfo struct {
		name           string
		originalServer string
		inboundTag     string
	}
	isAdmin := userIsAdmin(r.Context(), h.repo, username)

	// 只处理调用者有权访问的节点(管理员任意,普通用户仅自己的)。
	accessibleIDs := make([]int64, 0, len(req.NodeIDs))
	nodes := make([]nodeInfo, 0, len(req.NodeIDs))
	for _, id := range req.NodeIDs {
		node, err := h.fetchNodeForAccess(r.Context(), id, username, isAdmin)
		if err != nil {
			continue
		}
		accessibleIDs = append(accessibleIDs, id)
		nodes = append(nodes, nodeInfo{
			name:           node.NodeName,
			originalServer: node.OriginalServer,
			inboundTag:     node.InboundTag,
		})
	}

	// 删除座席的远程入站
	for _, n := range nodes {
		if n.originalServer != "" && n.inboundTag != "" {
			h.deleteRemoteInbound(r.Context(), n.originalServer, n.inboundTag)
		}
	}

	// 从数据库中删除节点(按权限)
	deletedCount := 0
	for _, id := range accessibleIDs {
		if err := h.deleteNodeForAccess(r.Context(), id, username, isAdmin); err != nil {
			continue
		}
		deletedCount++
	}

	// 使用同步管理器批量同步删除 YAML 文件
	nodeNames := make([]string, 0, len(nodes))
	for _, n := range nodes {
		if n.name != "" {
			nodeNames = append(nodeNames, n.name)
		}
	}
	if len(nodeNames) > 0 {
		if err := h.yamlSyncManager.BatchDeleteNodes(nodeNames); err != nil {
			// 记录错误但不要使请求失败
		}
	}

	respondJSON(w, http.StatusOK, map[string]any{
		"status":  "deleted",
		"deleted": deletedCount,
		"total":   len(req.NodeIDs),
	})
}

// 通过 RemoteManageHandler 将删除入站请求转发给代理。
// deleteRemoteRoutedOutbound:routed 节点删除时清掉服务器侧的 routing rule + outbound,但不动 inbound。
// 同 outboundTag 的 rule 可能不止一条(理论上 sync 单一对一,防御性地全删);outbound 按 tag 删一次。
// inbound 里的 client 留着 — 节点配置已经删了,client 留着也无害,后续如果重建可以复用同凭据。
func (h *nodesHandler) deleteRemoteRoutedOutbound(ctx context.Context, serverName, outboundTag string) {
	if h.remoteManage == nil {
		return
	}
	server, err := h.repo.GetRemoteServerByName(ctx, serverName)
	if err != nil {
		log.Printf("[Nodes] routed delete: lookup server %q failed: %v", serverName, err)
		return
	}
	// 1. routing rules by outboundTag(全删,从后往前避免 index 漂移)
	if raw, err := h.remoteManage.forwardToRemoteServer(ctx, server.ID, "GET", "/api/child/routing", nil); err == nil {
		var resp struct {
			Success bool                   `json:"success"`
			Routing map[string]interface{} `json:"routing"`
		}
		if json.Unmarshal(raw, &resp) == nil && resp.Routing != nil {
			rules, _ := resp.Routing["rules"].([]interface{})
			for i := len(rules) - 1; i >= 0; i-- {
				rmap, _ := rules[i].(map[string]interface{})
				if t, _ := rmap["outboundTag"].(string); t == outboundTag {
					body, _ := json.Marshal(map[string]interface{}{"action": "remove_rule", "index": i})
					if _, err := h.remoteManage.forwardToRemoteServer(ctx, server.ID, "POST", "/api/child/routing", body); err != nil {
						log.Printf("[Nodes] routed delete: remove rule (server=%s tag=%s idx=%d) failed: %v", serverName, outboundTag, i, err)
					}
				}
			}
		}
	}
	// 2. outbound by tag
	rmOut, _ := json.Marshal(map[string]string{"action": "remove", "tag": outboundTag})
	if _, err := h.remoteManage.forwardToRemoteServer(ctx, server.ID, "POST", "/api/child/outbounds", rmOut); err != nil {
		log.Printf("[Nodes] routed delete: remove outbound (server=%s tag=%s) failed: %v", serverName, outboundTag, err)
	} else {
		log.Printf("[Nodes] routed delete: cleared rule+outbound %s on %s", outboundTag, serverName)
	}
}

func (h *nodesHandler) deleteRemoteInbound(ctx context.Context, serverName, inboundTag string) {
	if h.remoteManage == nil {
		return
	}

	server, err := h.repo.GetRemoteServerByName(ctx, serverName)
	if err != nil {
		log.Printf("[Nodes] Failed to find remote server %q for inbound cleanup: %v", serverName, err)
		return
	}

	body, _ := json.Marshal(map[string]string{
		"action": "remove",
		"tag":    inboundTag,
	})

	if _, err := h.remoteManage.forwardToRemoteServer(ctx, server.ID, "POST", "/api/child/inbounds", body); err != nil {
		log.Printf("[Nodes] Failed to delete remote inbound %s on server %s: %v", inboundTag, serverName, err)
	} else {
		log.Printf("[Nodes] Deleted remote inbound %s on server %s", inboundTag, serverName)
	}
}

func (h *nodesHandler) handleBatchRename(w http.ResponseWriter, r *http.Request) {
	username := auth.UsernameFromContext(r.Context())
	if username == "" {
		writeError(w, http.StatusUnauthorized, errors.New("用户未认证"))
		return
	}

	var req struct {
		Updates []struct {
			NodeID  int64  `json:"node_id"`
			NewName string `json:"new_name"`
		} `json:"updates"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeBadRequest(w, "请求格式不正确")
		return
	}

	if len(req.Updates) == 0 {
		writeBadRequest(w, "更新列表不能为空")
		return
	}

	isAdmin := userIsAdmin(r.Context(), h.repo, username)

	successCount := 0
	failCount := 0
	var updatedNodes []nodeDTO
	var yamlUpdates []NodeUpdate // 收集 YAML 同步更新

	for _, update := range req.Updates {
		if update.NewName == "" {
			failCount++
			continue
		}

		// 获取现有节点(按权限:管理员任意,普通用户仅自己的)
		node, err := h.fetchNodeForAccess(r.Context(), update.NodeID, username, isAdmin)
		if err != nil {
			failCount++
			continue
		}

		// 保存 YAML 同步的旧名称
		oldNodeName := node.NodeName

		// 更新节点名称
		node.NodeName = update.NewName

		// 更新 ClashConfig JSON 中的名称
		var clashConfig map[string]any
		if err := json.Unmarshal([]byte(node.ClashConfig), &clashConfig); err == nil {
			clashConfig["name"] = update.NewName
			if updatedClash, err := json.Marshal(clashConfig); err == nil {
				node.ClashConfig = string(updatedClash)
			}
		}

		// 更新 ParsedConfig JSON 中的名称
		var parsedConfig map[string]any
		if err := json.Unmarshal([]byte(node.ParsedConfig), &parsedConfig); err == nil {
			parsedConfig["name"] = update.NewName
			if updatedParsed, err := json.Marshal(parsedConfig); err == nil {
				node.ParsedConfig = string(updatedParsed)
			}
		}

		// 保存到数据库
		updated, err := h.repo.UpdateNode(r.Context(), node)
		if err != nil {
			failCount++
			continue
		}

		// 收集 YAML 同步更新（不立即同步）
		if updated.ClashConfig != "" {
			yamlUpdates = append(yamlUpdates, NodeUpdate{
				OldName:         oldNodeName,
				NewName:         update.NewName,
				ClashConfigJSON: updated.ClashConfig,
			})
		}

		successCount++
		updatedNodes = append(updatedNodes, convertNode(updated))
	}

	// 批量同步到 YAML 文件（只读写文件一次）
	if len(yamlUpdates) > 0 {
		if err := h.yamlSyncManager.BatchSyncNodes(yamlUpdates); err != nil {
			// 记录错误但不要使请求失败
			logger.Info("[批量重命名] YAML 同步失败", "error", err)
		}
	}

	respondJSON(w, http.StatusOK, map[string]any{
		"status":  "renamed",
		"success": successCount,
		"failed":  failCount,
		"total":   len(req.Updates),
		"nodes":   updatedNodes,
	})
}

type nodeRequest struct {
	RawURL              string          `json:"raw_url"`
	NodeName            string          `json:"node_name"`
	Protocol            string          `json:"protocol"`
	ParsedConfig        string          `json:"parsed_config"`
	ClashConfig         string          `json:"clash_config"`
	Enabled             bool            `json:"enabled"`
	Tag                 string          `json:"tag"`
	InboundTag          string          `json:"inbound_tag"`
	ChainProxyNodeID    *int64          `json:"-"`
	RawChainProxyNodeID json.RawMessage `json:"chain_proxy_node_id"`
}

func (r *nodeRequest) hasChainProxyNodeID() bool {
	return r.RawChainProxyNodeID != nil
}

func (r *nodeRequest) parseChainProxyNodeID() {
	if r.RawChainProxyNodeID == nil || string(r.RawChainProxyNodeID) == "null" {
		r.ChainProxyNodeID = nil
		return
	}
	var id int64
	if json.Unmarshal(r.RawChainProxyNodeID, &id) == nil {
		r.ChainProxyNodeID = &id
	}
}

type nodeDTO struct {
	ID               int64     `json:"id"`
	RawURL           string    `json:"raw_url"`
	NodeName         string    `json:"node_name"`
	Protocol         string    `json:"protocol"`
	ParsedConfig     string    `json:"parsed_config"`
	ClashConfig      string    `json:"clash_config"`
	Enabled          bool      `json:"enabled"`
	// Tag 字段后端仍保留(订阅生成里按 subscribe_files.selected_tags 过滤要用),但不再回前端。
	// 节点来源(直连节点 / 手动输入 / 订阅导入)这种归类元数据对普通用户没有价值,
	// 而管理员视角已经有 original_server / inbound_tag 等更精确的标识。
	Tag              string    `json:"-"`
	OriginalServer   string    `json:"original_server"`
	OriginalDomain   string    `json:"original_domain"`
	InboundTag       string    `json:"inbound_tag"`
	ChainProxyNodeID *int64    `json:"chain_proxy_node_id"`
	NodeType           string    `json:"node_type"`             // 'physical' | 'routed'
	ParentNodeID       *int64    `json:"parent_node_id"`        // routed 节点指向其父物理节点
	RoutedOutboundTag  string    `json:"routed_outbound_tag"`   // routed 节点专用:绑定的出站 tag(便于 UI 直接展示)
	RoutedOwner        string    `json:"routed_owner,omitempty"` // routed 节点专用:'shared'(admin 套餐分配) | 'user'(用户私有)
	CreatedBy          string    `json:"created_by,omitempty"`   // routed 节点专用:创建者用户名(user 视角下用于鉴别"是不是我创建的")
	CreatedAt          time.Time `json:"created_at"`
	UpdatedAt          time.Time `json:"updated_at"`
}

func convertNode(node storage.Node) nodeDTO {
	return nodeDTO{
		ID:                node.ID,
		RawURL:            node.RawURL,
		NodeName:          node.NodeName,
		Protocol:          node.Protocol,
		ParsedConfig:      node.ParsedConfig,
		ClashConfig:       node.ClashConfig,
		Enabled:           node.Enabled,
		Tag:               node.Tag,
		OriginalServer:    node.OriginalServer,
		OriginalDomain:    node.OriginalDomain,
		InboundTag:        node.InboundTag,
		ChainProxyNodeID:  node.ChainProxyNodeID,
		NodeType:          node.NodeType,
		ParentNodeID:      node.ParentNodeID,
		RoutedOutboundTag: node.RoutedOutboundTag,
		RoutedOwner:       node.RoutedOwner,
		CreatedBy:         node.Username, // nodes 表里 username = 创建/拥有者
		CreatedAt:         node.CreatedAt,
		UpdatedAt:         node.UpdatedAt,
	}
}

func convertNodes(nodes []storage.Node) []nodeDTO {
	result := make([]nodeDTO, 0, len(nodes))
	for _, node := range nodes {
		result = append(result, convertNode(node))
	}
	return result
}

func (h *nodesHandler) handleFetchSubscription(w http.ResponseWriter, r *http.Request) {
	username := auth.UsernameFromContext(r.Context())
	if username == "" {
		writeError(w, http.StatusUnauthorized, errors.New("用户未认证"))
		return
	}

	var req struct {
		URL       string `json:"url"`
		UserAgent string `json:"user_agent"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeBadRequest(w, "请求格式不正确")
		return
	}

	if req.URL == "" {
		writeBadRequest(w, "订阅URL是必填项")
		return
	}

	// 如果没有提供 User-Agent，使用默认值
	userAgent := req.UserAgent
	if userAgent == "" {
		userAgent = "clash-meta/2.4.0"
	}

	// 创建HTTP客户端并获取订阅内容
	client := &http.Client{
		Timeout: 30 * time.Second,
	}

	httpReq, err := http.NewRequest("GET", req.URL, nil)
	if err != nil {
		writeError(w, http.StatusBadRequest, errors.New("无效的订阅URL"))
		return
	}

	// 添加User-Agent头
	httpReq.Header.Set("User-Agent", userAgent)

	logger.Info("[订阅获取] 开始请求外部订阅", "url", req.URL, "user_agent", userAgent)

	resp, err := client.Do(httpReq)
	if err != nil {
		logger.Info("[订阅获取] 请求失败", "url", req.URL, "error", err)
		writeError(w, http.StatusBadRequest, errors.New("无法获取订阅内容: "+err.Error()))
		return
	}
	defer resp.Body.Close()

	logger.Info("[订阅获取] 收到响应",
		"url", req.URL,
		"status_code", resp.StatusCode,
		"status", resp.Status,
		"content_type", resp.Header.Get("Content-Type"),
		"content_length", resp.ContentLength)

	// 读取响应内容（无论成功还是失败都需要读取以便记录日志）
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		logger.Info("[订阅获取] 读取响应体失败", "url", req.URL, "error", err)
		writeError(w, http.StatusInternalServerError, errors.New("读取订阅内容失败"))
		return
	}

	logger.Info("[订阅获取] 响应体大小", "url", req.URL, "size", len(body))

	if resp.StatusCode != http.StatusOK {
		// 记录详细的错误响应内容
		bodyPreview := string(body)
		if len(bodyPreview) > 500 {
			bodyPreview = bodyPreview[:500] + "...(截断)"
		}
		logger.Info("[订阅获取] 服务器返回错误状态",
			"url", req.URL,
			"status_code", resp.StatusCode,
			"status", resp.Status,
			"response_preview", bodyPreview)
		writeError(w, http.StatusBadRequest, fmt.Errorf("订阅服务器返回错误状态: %d %s", resp.StatusCode, resp.Status))
		return
	}

	// 解析YAML
	var clashConfig struct {
		Proxies []map[string]any `yaml:"proxies"`
	}

	if err := yaml.Unmarshal(body, &clashConfig); err != nil {
		// 记录解析失败时的内容预览
		bodyPreview := string(body)
		if len(bodyPreview) > 500 {
			bodyPreview = bodyPreview[:500] + "...(截断)"
		}
		logger.Info("[订阅获取] YAML解析失败", "url", req.URL, "error", err, "content_preview", bodyPreview)
		writeError(w, http.StatusBadRequest, errors.New("解析订阅内容失败: "+err.Error()))
		return
	}

	if len(clashConfig.Proxies) == 0 {
		// 记录没有找到节点时的内容预览
		bodyPreview := string(body)
		if len(bodyPreview) > 500 {
			bodyPreview = bodyPreview[:500] + "...(截断)"
		}
		logger.Info("[订阅获取] 订阅中没有找到代理节点", "url", req.URL, "content_preview", bodyPreview)
		writeError(w, http.StatusBadRequest, errors.New("订阅中没有找到代理节点"))
		return
	}

	logger.Info("[订阅获取] 成功解析订阅", "url", req.URL, "node_count", len(clashConfig.Proxies))

	// 将 nil 值转换为空字符串并解码所有代理中的 URL 编码字段
	for _, proxy := range clashConfig.Proxies {
		convertNilToEmptyStringInMap(proxy)
		decodeProxyURLFields(proxy)
	}

	// 从 Content-Disposition 头中提取订阅名称作为建议的标签
	suggestedTag := ""
	contentDisposition := resp.Header.Get("Content-Disposition")
	if contentDisposition != "" {
		suggestedTag = parseFilenameFromContentDisposition(contentDisposition)
		// 移除文件扩展名
		if suggestedTag != "" {
			suggestedTag = strings.TrimSuffix(suggestedTag, ".yaml")
			suggestedTag = strings.TrimSuffix(suggestedTag, ".yml")
			suggestedTag = strings.TrimSuffix(suggestedTag, ".txt")
		}
	}

	respondJSON(w, http.StatusOK, map[string]any{
		"proxies":       clashConfig.Proxies,
		"count":         len(clashConfig.Proxies),
		"suggested_tag": suggestedTag,
	})
}

func (h *nodesHandler) handleListTags(w http.ResponseWriter, r *http.Request) {
	username := auth.UsernameFromContext(r.Context())
	if username == "" {
		writeError(w, http.StatusUnauthorized, errors.New("用户未认证"))
		return
	}

	// 数据隔离:管理员看全部标签,普通用户只看自己节点的标签。
	var allNodes []storage.Node
	var err error
	if userIsAdmin(r.Context(), h.repo, username) {
		allNodes, err = h.repo.ListAllNodes(r.Context())
	} else {
		allNodes, err = h.repo.ListNodes(r.Context(), username)
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	seen := make(map[string]bool)
	var tags []string
	for _, node := range allNodes {
		for _, t := range node.Tags {
			if t != "" && !seen[t] {
				seen[t] = true
				tags = append(tags, t)
			}
		}
	}
	if tags == nil {
		tags = []string{}
	}

	respondJSON(w, http.StatusOK, map[string]any{"tags": tags})
}
