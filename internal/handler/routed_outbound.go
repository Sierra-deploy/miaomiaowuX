package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/google/uuid"

	"miaomiaowux/internal/storage"
)

// RoutedOutboundHandler 管理"路由出站"虚拟节点。
// 创建时自动:
//  1. 给父物理节点的 inbound 加一个占位 admin client(email = _admin__<short>__<label>)
//  2. 调 agent 加 outbound(tag = routed:<short>:<label>)
//  3. 调 agent 加 routing rule(带 marktag,user=[admin_email],prepend 到 rules[])
//  4. 在 nodes 表插一行 node_type='routed' 关联到父节点
//
// 删除时反向:agent 移除 rule + outbound + 占位 client,DB 删 routed node(级联清子账号)。
type RoutedOutboundHandler struct {
	repo         *storage.TrafficRepository
	remoteManage *RemoteManageHandler
}

func NewRoutedOutboundHandler(repo *storage.TrafficRepository, rm *RemoteManageHandler) *RoutedOutboundHandler {
	return &RoutedOutboundHandler{repo: repo, remoteManage: rm}
}

func (h *RoutedOutboundHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.list(w, r)
	case http.MethodPost:
		h.create(w, r)
	case http.MethodDelete:
		h.delete(w, r)
	default:
		writeJSONError(w, http.StatusMethodNotAllowed, "Method not allowed")
	}
}

// 列出某父节点下所有 routed 子节点。
// GET /api/admin/nodes/routed-outbound?parent_id=X
func (h *RoutedOutboundHandler) list(w http.ResponseWriter, r *http.Request) {
	parentID, err := strconv.ParseInt(r.URL.Query().Get("parent_id"), 10, 64)
	if err != nil || parentID <= 0 {
		writeJSONError(w, http.StatusBadRequest, "parent_id 必填")
		return
	}
	items, err := h.repo.ListRoutedNodesByParent(r.Context(), parentID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, fmt.Sprintf("list routed nodes: %v", err))
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{"items": items})
}

type createRoutedOutboundReq struct {
	ParentNodeID int64                  `json:"parent_node_id"`
	Label        string                 `json:"label"`            // 必填,如 "WTT" / "HK-T4"
	Outbound     map[string]interface{} `json:"outbound"`         // xray outbound 完整定义(无 tag,由后端生成 namespacedTag)
	NodeName     string                 `json:"node_name"`        // 订阅里展示用,可空,默认 "<parent>-<label>"
}

// 创建路由出站节点。
// POST /api/admin/nodes/routed-outbound
func (h *RoutedOutboundHandler) create(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var req createRoutedOutboundReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.ParentNodeID <= 0 || strings.TrimSpace(req.Label) == "" || req.Outbound == nil {
		writeJSONError(w, http.StatusBadRequest, "parent_node_id, label, outbound 都必填")
		return
	}
	labelSlug := slugify(req.Label)
	if labelSlug == "" {
		writeJSONError(w, http.StatusBadRequest, "label 只能包含字母数字和短横线,长度 2-32")
		return
	}

	parent, err := h.repo.GetNodeByID(ctx, req.ParentNodeID)
	if err != nil {
		writeJSONError(w, http.StatusNotFound, fmt.Sprintf("父节点不存在: %v", err))
		return
	}
	if parent.NodeType != "" && parent.NodeType != "physical" {
		writeJSONError(w, http.StatusBadRequest, "父节点必须是物理节点,不能挂在另一个 routed 节点下")
		return
	}
	if strings.TrimSpace(parent.OriginalServer) == "" || strings.TrimSpace(parent.InboundTag) == "" {
		writeJSONError(w, http.StatusBadRequest, "父节点缺少 original_server 或 inbound_tag,无法定位 agent inbound")
		return
	}

	// 反查 server_id
	serverID, err := h.resolveServerIDByName(ctx, parent.OriginalServer)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("无法定位父节点所属 agent server: %v", err))
		return
	}

	// 命名空间生成:用父节点 ID + label 保唯一,前缀清晰
	shortID := fmt.Sprintf("p%d", parent.ID)
	outboundTag := fmt.Sprintf("routed:%s:%s", shortID, labelSlug)
	marktag := outboundTag
	adminEmail := fmt.Sprintf("_admin__%s__%s", shortID, labelSlug)

	// 检查唯一性(同父节点同 label 不能重复)
	existing, _ := h.repo.ListRoutedNodesByParent(ctx, parent.ID)
	for _, ex := range existing {
		if ex.RoutedOutboundTag == outboundTag {
			writeJSONError(w, http.StatusConflict, fmt.Sprintf("已存在相同 label 的路由出站: %s", req.Label))
			return
		}
	}

	// 准备 outbound:强制设 tag 防止调用方乱传
	outboundCopy := cloneMap(req.Outbound)
	outboundCopy["tag"] = outboundTag

	// 准备 admin client 凭据:复用父 inbound 第一个 client 的 flow(VLESS Reality 必需)
	adminCred := map[string]interface{}{
		"id":    uuid.New().String(),
		"email": adminEmail,
	}
	inboundFlow, err := h.peekInboundFirstClientFlow(ctx, serverID, parent.InboundTag)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, fmt.Sprintf("读取父 inbound 失败: %v", err))
		return
	}
	if inboundFlow != "" {
		adminCred["flow"] = inboundFlow
	}

	// === Step 1: 给 agent inbound 加 admin client ===
	if err := addClientToInbound(ctx, h.remoteManage, serverID, parent.InboundTag, adminCred); err != nil {
		writeJSONError(w, http.StatusBadGateway, fmt.Sprintf("加 admin client 失败: %v", err))
		return
	}

	// === Step 2: 加 outbound ===
	addOutBody, _ := json.Marshal(map[string]interface{}{"action": "add", "outbound": outboundCopy})
	if _, err := h.remoteManage.forwardToRemoteServer(ctx, serverID, "POST", "/api/child/outbounds", addOutBody); err != nil {
		// rollback: 删 admin client
		removeClientFromInbound(ctx, h.remoteManage, serverID, parent.InboundTag, adminEmail)
		writeJSONError(w, http.StatusBadGateway, fmt.Sprintf("加 outbound 失败: %v", err))
		return
	}

	// === Step 3: 加 routing rule ===
	rule := map[string]interface{}{
		"type":        "field",
		"marktag":     marktag,
		"user":        []string{adminEmail},
		"inboundTag":  []string{parent.InboundTag},
		"outboundTag": outboundTag,
	}
	addRuleBody, _ := json.Marshal(map[string]interface{}{"action": "add_rule", "rule": rule})
	if _, err := h.remoteManage.forwardToRemoteServer(ctx, serverID, "POST", "/api/child/routing", addRuleBody); err != nil {
		// rollback: 删 outbound + admin client
		removeOutBody, _ := json.Marshal(map[string]string{"action": "remove", "tag": outboundTag})
		h.remoteManage.forwardToRemoteServer(ctx, serverID, "POST", "/api/child/outbounds", removeOutBody)
		removeClientFromInbound(ctx, h.remoteManage, serverID, parent.InboundTag, adminEmail)
		writeJSONError(w, http.StatusBadGateway, fmt.Sprintf("加 routing rule 失败: %v", err))
		return
	}

	// === Step 4: 持久化 routed node ===
	// routed 节点的 clash_config / parsed_config 完全继承父节点(同 inbound,网络/TLS/reality 参数都一样),
	// 仅替换"客户端凭据"为 admin 占位:
	//   - VLESS/VMess: uuid → admin uuid
	//   - Trojan: password → admin uuid
	//   - SS: password 拼接 admin password
	// 节点名换成 routed.NodeName。订阅生成时再用用户子账号 uuid 覆盖(见 buildRoutedProxyForUser)。
	parentID := parent.ID
	nodeName := strings.TrimSpace(req.NodeName)
	if nodeName == "" {
		nodeName = fmt.Sprintf("%s-%s", parent.NodeName, req.Label)
	}
	clashWithAdmin := cloneClashWithCredential(parent.ClashConfig, parent.Protocol, adminCred, nodeName)
	parsedWithAdmin := parent.ParsedConfig // parsed_config 是 xray inbound 结构,与凭据无关,直接继承
	outboundJSONBytes, _ := json.Marshal(outboundCopy)
	credBytes, _ := json.Marshal(adminCred)
	detail := storage.RoutedNodeDetail{
		Node: storage.Node{
			Username:       parent.Username,
			RawURL:         parent.RawURL,
			NodeName:       nodeName,
			Protocol:       parent.Protocol,
			ParsedConfig:   parsedWithAdmin,
			ClashConfig:    clashWithAdmin,
			Enabled:        true,
			Tag:            "路由出站",
			OriginalServer: parent.OriginalServer,
			OriginalDomain: parent.OriginalDomain,
			InboundTag:     parent.InboundTag,
			NodeType:       "routed",
			ParentNodeID:   &parentID,
		},
		RoutedOutboundTag:     outboundTag,
		RoutedOutboundJSON:    string(outboundJSONBytes),
		RoutedRuleMarktag:     marktag,
		RoutedAdminEmail:      adminEmail,
		RoutedAdminCredential: string(credBytes),
	}
	created, err := h.repo.CreateRoutedNode(ctx, detail)
	if err != nil {
		log.Printf("[RoutedOutbound] DB insert failed after agent ops succeeded: %v - agent 已变更但 DB 未记录,需人工清理", err)
		writeJSONError(w, http.StatusInternalServerError, fmt.Sprintf("DB 写入失败,agent 已修改,需人工修复: %v", err))
		return
	}

	log.Printf("[RoutedOutbound] created routed node id=%d tag=%s parent=%d", created.ID, outboundTag, parent.ID)
	respondJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"node":    created,
	})
}

// 删除路由出站节点。
// DELETE /api/admin/nodes/routed-outbound?id=X
func (h *RoutedOutboundHandler) delete(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id, err := strconv.ParseInt(r.URL.Query().Get("id"), 10, 64)
	if err != nil || id <= 0 {
		writeJSONError(w, http.StatusBadRequest, "id 必填")
		return
	}
	detail, err := h.repo.GetRoutedNodeDetail(ctx, id)
	if err != nil {
		writeJSONError(w, http.StatusNotFound, fmt.Sprintf("routed 节点不存在: %v", err))
		return
	}
	serverID, err := h.resolveServerIDByName(ctx, detail.OriginalServer)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("无法定位 agent server: %v", err))
		return
	}

	// 1. 移除 routing rule(按 marktag 找到 index 然后 remove_rule)
	removeRuleByMarktag(ctx, h.remoteManage, serverID, detail.RoutedRuleMarktag)

	// 2. 移除 outbound
	rmOutBody, _ := json.Marshal(map[string]string{"action": "remove", "tag": detail.RoutedOutboundTag})
	h.remoteManage.forwardToRemoteServer(ctx, serverID, "POST", "/api/child/outbounds", rmOutBody)

	// 3. 移除 admin client(以及所有子账号 client — 通过 user_subaccounts 反查)
	subaccs, _ := h.repo.ListSubaccountsByRoutedNode(ctx, id)
	for _, sa := range subaccs {
		removeClientFromInbound(ctx, h.remoteManage, serverID, detail.InboundTag, sa.Email)
	}
	removeClientFromInbound(ctx, h.remoteManage, serverID, detail.InboundTag, detail.RoutedAdminEmail)

	// 4. 删 DB 行(级联清 user_subaccounts via FK)
	if err := h.repo.DeleteRoutedNode(ctx, id); err != nil {
		writeJSONError(w, http.StatusInternalServerError, fmt.Sprintf("DB 删除失败: %v", err))
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{"success": true})
}

// ===== helpers =====

func (h *RoutedOutboundHandler) resolveServerIDByName(ctx context.Context, serverName string) (int64, error) {
	servers, err := h.repo.ListRemoteServers(ctx)
	if err != nil {
		return 0, err
	}
	for _, s := range servers {
		if s.Name == serverName {
			return s.ID, nil
		}
	}
	return 0, errors.New("server not found in remote_servers by name " + serverName)
}

// 读父 inbound,返回第一个 client 的 flow 字段(VLESS Reality 子 client 必须继承)。
func (h *RoutedOutboundHandler) peekInboundFirstClientFlow(ctx context.Context, serverID int64, inboundTag string) (string, error) {
	return peekInboundFirstClientFlow(ctx, h.remoteManage, serverID, inboundTag)
}

// mutateRoutingRuleUserByOutboundTag 在 routing.rules 里找 outboundTag 匹配的 rule,
// 给它的 user[] 数组加/删一个 email,然后用 agent 的 `set` action 把整个 routing 推回去。
// 用途:auto-detected routed 节点没有 marktag,agent 的 add_user_to_rule 需要 marktag,绕开它。
// add=true 表示新增 email(去重 append);add=false 表示移除。
func mutateRoutingRuleUserByOutboundTag(ctx context.Context, rm *RemoteManageHandler, serverID int64, outboundTag, userEmail string, add bool) error {
	raw, err := rm.forwardToRemoteServer(ctx, serverID, "GET", "/api/child/routing", nil)
	if err != nil {
		return fmt.Errorf("get routing: %w", err)
	}
	var resp struct {
		Success bool                   `json:"success"`
		Routing map[string]interface{} `json:"routing"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return fmt.Errorf("parse routing: %w", err)
	}
	if resp.Routing == nil {
		return fmt.Errorf("no routing config")
	}
	rules, _ := resp.Routing["rules"].([]interface{})
	matched := -1
	for i, ru := range rules {
		rm, _ := ru.(map[string]interface{})
		if rm == nil {
			continue
		}
		if t, _ := rm["outboundTag"].(string); t == outboundTag {
			matched = i
			break
		}
	}
	if matched < 0 {
		return fmt.Errorf("no routing rule with outboundTag=%q", outboundTag)
	}
	rule := rules[matched].(map[string]interface{})
	users, _ := rule["user"].([]interface{})
	if add {
		for _, u := range users {
			if s, _ := u.(string); s == userEmail {
				return nil // 已存在,幂等
			}
		}
		users = append(users, userEmail)
	} else {
		filtered := users[:0]
		for _, u := range users {
			if s, _ := u.(string); s != userEmail {
				filtered = append(filtered, u)
			}
		}
		users = filtered
	}
	rule["user"] = users
	rules[matched] = rule
	resp.Routing["rules"] = rules

	body, _ := json.Marshal(map[string]interface{}{
		"action":  "set",
		"routing": resp.Routing,
	})
	if _, err := rm.forwardToRemoteServer(ctx, serverID, "POST", "/api/child/routing", body); err != nil {
		return fmt.Errorf("set routing: %w", err)
	}
	return nil
}

// peekInboundFirstClientFlow 给非 RoutedOutboundHandler 的调用方用(addUserToRoutedNode 直接拿 *RemoteManageHandler)。
func peekInboundFirstClientFlow(ctx context.Context, rm *RemoteManageHandler, serverID int64, inboundTag string) (string, error) {
	result, err := rm.forwardToRemoteServer(ctx, serverID, "GET", "/api/child/inbounds", nil)
	if err != nil {
		return "", err
	}
	var resp struct {
		Success  bool                     `json:"success"`
		Inbounds []map[string]interface{} `json:"inbounds"`
	}
	if err := json.Unmarshal(result, &resp); err != nil {
		return "", err
	}
	for _, ib := range resp.Inbounds {
		if tag, _ := ib["tag"].(string); tag != inboundTag {
			continue
		}
		settings, _ := ib["settings"].(map[string]interface{})
		if settings == nil {
			return "", nil
		}
		clients, _ := settings["clients"].([]interface{})
		if len(clients) == 0 {
			return "", nil
		}
		first, _ := clients[0].(map[string]interface{})
		flow, _ := first["flow"].(string)
		return flow, nil
	}
	return "", fmt.Errorf("inbound %s not found", inboundTag)
}

// 给目标 inbound 加一个 client — 走 agent 原子 add-client,在 inboundsMu 锁内完成 read-modify-write。
// 主控不再持有 inbound 快照,从根本上消除并发绑套餐丢 client 的问题。
func addClientToInbound(ctx context.Context, rm *RemoteManageHandler, serverID int64, inboundTag string, client map[string]interface{}) error {
	body, _ := json.Marshal(map[string]interface{}{
		"action": "add-client",
		"tag":    inboundTag,
		"client": client,
	})
	if _, err := rm.forwardToRemoteServer(ctx, serverID, "POST", "/api/child/inbounds", body); err != nil {
		return fmt.Errorf("add-client: %w", err)
	}
	return nil
}

// 从目标 inbound 移除一个 client(按 email 匹配)。
// agent 的 matchClientCredential 在 id/password 等主键缺失时会回退到 email,所以这里只传 email 也能匹配。
func removeClientFromInbound(ctx context.Context, rm *RemoteManageHandler, serverID int64, inboundTag, email string) error {
	body, _ := json.Marshal(map[string]interface{}{
		"action": "remove-client",
		"tag":    inboundTag,
		"client": map[string]interface{}{"email": email},
	})
	if _, err := rm.forwardToRemoteServer(ctx, serverID, "POST", "/api/child/inbounds", body); err != nil {
		return fmt.Errorf("remove-client: %w", err)
	}
	return nil
}

// 按 marktag 找到 rule 并删除。GET routing → 找 index → POST remove_rule {index}。
func removeRuleByMarktag(ctx context.Context, rm *RemoteManageHandler, serverID int64, marktag string) error {
	result, err := rm.forwardToRemoteServer(ctx, serverID, "GET", "/api/child/routing", nil)
	if err != nil {
		return err
	}
	var resp struct {
		Success bool                   `json:"success"`
		Routing map[string]interface{} `json:"routing"`
	}
	if err := json.Unmarshal(result, &resp); err != nil {
		return err
	}
	if resp.Routing == nil {
		return nil
	}
	rules, _ := resp.Routing["rules"].([]interface{})
	for i, ru := range rules {
		rmap, _ := ru.(map[string]interface{})
		if t, _ := rmap["marktag"].(string); t == marktag {
			body, _ := json.Marshal(map[string]interface{}{"action": "remove_rule", "index": i})
			_, err := rm.forwardToRemoteServer(ctx, serverID, "POST", "/api/child/routing", body)
			return err
		}
	}
	return nil
}

// addUserToRoutedNode 把用户 client 加进 routed 节点的父 inbound,并把 email 加入 routing rule.user[]。
// 复用 user_subaccounts 里已保存的 credential(续费场景),否则生成新 uuid。is_active 置 1。
//
// 支持两种 routed 节点来源:
//   - 老的"管理员创建路由出站"流程:routed.RoutedAdminEmail = "_admin__<id>__<label>",带 marktag,
//     用户 email = "<username>__<id>__<label>",rule 按 marktag 定位
//   - 自动检测路由节点(同步入站时识别出来的):RoutedAdminEmail / RoutedRuleMarktag /
//     RoutedAdminCredential 都为空,只有 RoutedOutboundTag。用户 email = "<username>-<outboundTag>",
//     rule 按 outboundTag 定位(走 mmwx 本地改 + agent set 替换整个 routing,绕开 agent 必须 marktag 的限制)
func addUserToRoutedNode(ctx context.Context, rm *RemoteManageHandler, repo *storage.TrafficRepository, user storage.User, routedNodeID int64) error {
	routed, err := repo.GetRoutedNodeDetail(ctx, routedNodeID)
	if err != nil {
		return fmt.Errorf("get routed node %d: %w", routedNodeID, err)
	}
	if routed.NodeType != "routed" {
		return fmt.Errorf("node %d is not a routed node", routedNodeID)
	}

	serverIDList, err := repo.ListRemoteServers(ctx)
	if err != nil {
		return fmt.Errorf("list servers: %w", err)
	}
	var serverID int64
	for _, s := range serverIDList {
		if s.Name == routed.OriginalServer {
			serverID = s.ID
			break
		}
	}
	if serverID == 0 {
		return fmt.Errorf("server %s not found", routed.OriginalServer)
	}

	// 算用户 email:legacy `_admin__xxx` → `<user>__xxx`;auto-detected → `<user>-<outboundTag>`
	var userEmail string
	if strings.HasPrefix(routed.RoutedAdminEmail, "_admin__") {
		suffix := strings.TrimPrefix(routed.RoutedAdminEmail, "_admin__")
		userEmail = fmt.Sprintf("%s__%s", user.Username, suffix)
	} else if routed.RoutedOutboundTag != "" {
		userEmail = fmt.Sprintf("%s-%s", user.Username, routed.RoutedOutboundTag)
	} else {
		return fmt.Errorf("routed node %d has neither admin_email nor outbound_tag", routedNodeID)
	}

	// 复用已存子账号凭据(续费/恢复路径) or 新建
	var credJSON string
	var credential map[string]interface{}
	existing, _ := repo.GetUserSubaccount(ctx, routedNodeID, user.Username)
	if existing != nil {
		json.Unmarshal([]byte(existing.CredentialJSON), &credential)
		credJSON = existing.CredentialJSON
		userEmail = existing.Email // saved 优先,避免命名规则变动导致 email 漂移
	} else {
		credential = map[string]interface{}{
			"id":    uuid.New().String(),
			"email": userEmail,
		}
		// flow 优先取 admin credential;auto-detected 没存 → 从 inbound 第一个 client 反查
		var flow string
		if routed.RoutedAdminCredential != "" {
			var adminCred map[string]interface{}
			if err := json.Unmarshal([]byte(routed.RoutedAdminCredential), &adminCred); err == nil {
				if f, ok := adminCred["flow"].(string); ok {
					flow = f
				}
			}
		}
		if flow == "" {
			if f, err := peekInboundFirstClientFlow(ctx, rm, serverID, routed.InboundTag); err == nil {
				flow = f
			}
		}
		if flow != "" {
			credential["flow"] = flow
		}
		if b, err := json.Marshal(credential); err == nil {
			credJSON = string(b)
		}
	}

	// 1. 加 client 到 inbound
	if err := addClientToInbound(ctx, rm, serverID, routed.InboundTag, credential); err != nil {
		return fmt.Errorf("add client to inbound: %w", err)
	}

	// 2. 把 email 写进路由 rule。
	//    legacy 节点有 marktag → 走 add_user_to_rule;auto-detected 没 marktag → 拉整个 routing、
	//    找 outboundTag 匹配的 rule、本地改 user[]、再用 set 推回去。
	if routed.RoutedRuleMarktag != "" {
		body, _ := json.Marshal(map[string]interface{}{
			"action":     "add_user_to_rule",
			"marktag":    routed.RoutedRuleMarktag,
			"user_email": userEmail,
		})
		if _, err := rm.forwardToRemoteServer(ctx, serverID, "POST", "/api/child/routing", body); err != nil {
			removeClientFromInbound(ctx, rm, serverID, routed.InboundTag, userEmail)
			return fmt.Errorf("add_user_to_rule: %w", err)
		}
	} else {
		if err := mutateRoutingRuleUserByOutboundTag(ctx, rm, serverID, routed.RoutedOutboundTag, userEmail, true); err != nil {
			removeClientFromInbound(ctx, rm, serverID, routed.InboundTag, userEmail)
			return fmt.Errorf("mutate routing(add): %w", err)
		}
	}

	// 3. UPSERT user_subaccounts(is_active=1)
	if _, err := repo.UpsertUserSubaccount(ctx, storage.UserSubaccount{
		Username:       user.Username,
		RoutedNodeID:   routedNodeID,
		Email:          userEmail,
		CredentialJSON: credJSON,
		IsActive:       true,
	}); err != nil {
		log.Printf("[RoutedNode] DB upsert subaccount failed (agent ops 已完成,需排查): %v", err)
		return fmt.Errorf("upsert subaccount: %w", err)
	}
	return nil
}

// removeUserFromRoutedNode 把用户从 routing rule.user[] 移除 + 从 inbound 移除 client。
// is_active 置 0,credential 保留 — 下次绑定/续费可无缝恢复。
func removeUserFromRoutedNode(ctx context.Context, rm *RemoteManageHandler, repo *storage.TrafficRepository, username string, routedNodeID int64) error {
	routed, err := repo.GetRoutedNodeDetail(ctx, routedNodeID)
	if err != nil {
		return fmt.Errorf("get routed node %d: %w", routedNodeID, err)
	}
	sa, err := repo.GetUserSubaccount(ctx, routedNodeID, username)
	if err != nil || sa == nil {
		return nil // 没有子账号,无事可做
	}

	servers, err := repo.ListRemoteServers(ctx)
	if err != nil {
		return fmt.Errorf("list servers: %w", err)
	}
	var serverID int64
	for _, s := range servers {
		if s.Name == routed.OriginalServer {
			serverID = s.ID
			break
		}
	}
	if serverID == 0 {
		return fmt.Errorf("server %s not found", routed.OriginalServer)
	}

	// 1. 从 rule.user[] 移除(best-effort,失败也继续)。同 add 路径分两种 routed 节点处理
	if routed.RoutedRuleMarktag != "" {
		body, _ := json.Marshal(map[string]interface{}{
			"action":     "remove_user_from_rule",
			"marktag":    routed.RoutedRuleMarktag,
			"user_email": sa.Email,
		})
		if _, err := rm.forwardToRemoteServer(ctx, serverID, "POST", "/api/child/routing", body); err != nil {
			log.Printf("[RoutedNode] remove_user_from_rule(marktag) 失败 (continue): %v", err)
		}
	} else if routed.RoutedOutboundTag != "" {
		if err := mutateRoutingRuleUserByOutboundTag(ctx, rm, serverID, routed.RoutedOutboundTag, sa.Email, false); err != nil {
			log.Printf("[RoutedNode] remove_user_from_rule(outboundTag) 失败 (continue): %v", err)
		}
	}

	// 2. 从 inbound 移除 client
	if err := removeClientFromInbound(ctx, rm, serverID, routed.InboundTag, sa.Email); err != nil {
		log.Printf("[RoutedNode] removeClientFromInbound 失败 (continue): %v", err)
	}

	// 3. DB 置 is_active=0(凭据保留)
	return repo.SetSubaccountActive(ctx, sa.ID, false)
}

var labelRe = regexp.MustCompile(`^[a-zA-Z0-9-]{2,32}$`)

// slugify 把用户输入的 label 转成 outbound tag / email 用的 slug,只允许 [a-z0-9-]
func slugify(s string) string {
	s = strings.TrimSpace(s)
	if !labelRe.MatchString(s) {
		return ""
	}
	return strings.ToLower(s)
}

func cloneMap(m map[string]interface{}) map[string]interface{} {
	out := make(map[string]interface{}, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// cloneClashWithCredential 克隆父节点的 clash_config(单 proxy JSON)并替换关键凭据字段为 newCred,
// 用于 routed 节点存储 admin 占位版本的 clash 配置。返回 JSON 字符串;失败返回原 clash。
func cloneClashWithCredential(parentClash, protocol string, newCred map[string]interface{}, newName string) string {
	if parentClash == "" {
		return ""
	}
	var pc map[string]interface{}
	if err := json.Unmarshal([]byte(parentClash), &pc); err != nil {
		return parentClash
	}
	// 节点名换
	if newName != "" {
		pc["name"] = newName
	}
	// 凭据字段替换
	switch strings.ToLower(protocol) {
	case "vless", "vmess":
		if id, ok := newCred["id"].(string); ok && id != "" {
			pc["uuid"] = id
		}
	case "trojan":
		if pw, ok := newCred["password"].(string); ok && pw != "" {
			pc["password"] = pw
		} else if id, ok := newCred["id"].(string); ok && id != "" {
			// admin client 可能只有 id,用作 trojan password fallback
			pc["password"] = id
		}
	case "shadowsocks", "ss":
		// SS2022 user password 拼到节点 password 后面 `nodePass:userPass`
		if userPass, ok := newCred["password"].(string); ok && userPass != "" {
			if nodePass, ok := pc["password"].(string); ok && nodePass != "" {
				pc["password"] = nodePass + ":" + userPass
			} else {
				pc["password"] = userPass
			}
		}
	case "hysteria2", "hysteria", "hy2":
		if auth, ok := newCred["auth"].(string); ok && auth != "" {
			pc["password"] = auth
		}
	}
	b, err := json.Marshal(pc)
	if err != nil {
		return parentClash
	}
	return string(b)
}
