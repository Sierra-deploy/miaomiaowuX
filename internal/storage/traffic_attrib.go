package storage

import (
	"context"
	"strings"
)

// 流量归因(email → 恰好一个用户 + 一/多个节点)。三个流量视图(节点视图 / 用户视图 / 节点列表)
// 与**采集时计价**共用同一个归因器,保证口径一致、消除"物理父入站与 routed 出站双算"的历史 bug。
//
// 本文件原在 internal/handler,为了让 collector(internal/traffic)在采集时就能算计费权重而下沉到
// storage —— 导入方向是 handler → traffic → storage,storage 是唯一三方都能引用的层。
// 下沉后 GetUserWeightedTraffic 里那套重复的归因实现被删除,全仓只剩这一套。
//
// 归因优先级(与 ResolveUsernameByEmail 对齐,#1/#2 在这里直接落到 routed 节点):
//  1. user_subaccounts.email → 该 routed 节点(**忽略 is_active**,UNIQUE(routed_node_id,email) 保证唯一)
//  2. _admin__ 占位 email → nodes.routed_admin_email 对应的 routed 节点
//  3. users.email → username → 该 user 在本 server 的物理入站节点
//  4. `<username>__<tag>` 取首段 → 同上
//  5. 否则丢弃(脏 email:outbound tag 等)
//
// 关键不变量:**任何 routed email(含被停用)都在 #1/#2 命中并归 routed 节点,永不落到父入站**。
// 于是物理节点总量 = Σ其非-routed email = 入站总量 − routed 部分(自动成立,无需显式相减)。

// NodeShare 表示一条 email 归属到某节点;Scale 为均分分母(1=全量,N=该 email 在 N 个物理入站间均分)。
type NodeShare struct {
	NodeID     int64
	NodeName   string
	ServerName string
	Scale      int
}

// EmailAttribution 是一条 email 的归因结果。Username 为空表示丢弃(脏数据)。
type EmailAttribution struct {
	Username string
	Routed   bool
	Shares   []NodeShare
}

// EmailAttributor 预加载全部映射,Classify 为纯内存操作(不再每 email 打 DB)。
type EmailAttributor struct {
	routedByEmail   map[string]NodeShare // #1+#2: email → routed 节点
	routedEmailUser map[string]string    // email → 归属 username
	inbNodeByKey    map[string]Node
	serverNameByID  map[int64]string
	userServerTags  map[string]map[int64][]string // username → serverID → []inbound_tag
	serverInbTags   map[string][]string           // serverName → 该 server 物理入站 tags(admin 自用兜底)
	usersEmail      map[string]string             // users.email → username
	realUsernames   map[string]bool
	pkgByUsername   map[string]*Package // 计费权重用:username → 其当前套餐(无套餐则不存在)
}

// BuildEmailAttributor 一次性加载归因所需全部映射。
func (r *TrafficRepository) BuildEmailAttributor(ctx context.Context) (*EmailAttributor, error) {
	a := &EmailAttributor{
		routedByEmail:   map[string]NodeShare{},
		routedEmailUser: map[string]string{},
		inbNodeByKey:    map[string]Node{},
		serverNameByID:  map[int64]string{},
		userServerTags:  map[string]map[int64][]string{},
		serverInbTags:   map[string][]string{},
		usersEmail:      map[string]string{},
		realUsernames:   map[string]bool{},
		pkgByUsername:   map[string]*Package{},
	}

	nodes, err := r.ListAllNodes(ctx)
	if err != nil {
		return nil, err
	}
	nodesByID := make(map[int64]Node, len(nodes))
	for _, n := range nodes {
		nodesByID[n.ID] = n
		if n.NodeType != "routed" && n.InboundTag != "" {
			a.inbNodeByKey[n.OriginalServer+"::"+n.InboundTag] = n
			a.serverInbTags[n.OriginalServer] = append(a.serverInbTags[n.OriginalServer], n.InboundTag)
		}
	}

	// #1 user_subaccounts(全部,忽略 is_active)→ routed 节点
	subs, err := r.ListAllSubaccounts(ctx)
	if err != nil {
		return nil, err
	}
	for _, s := range subs {
		n, ok := nodesByID[s.RoutedNodeID]
		if !ok {
			continue
		}
		a.routedByEmail[s.Email] = NodeShare{NodeID: n.ID, NodeName: n.NodeName, ServerName: n.OriginalServer, Scale: 1}
		a.routedEmailUser[s.Email] = s.Username
	}
	// #2 _admin__ 占位 email → routed 节点
	admins, err := r.ListRoutedAdminEmailNodes(ctx)
	if err != nil {
		return nil, err
	}
	for _, ad := range admins {
		n, ok := nodesByID[ad.NodeID]
		if !ok {
			continue
		}
		if _, exists := a.routedByEmail[ad.Email]; exists {
			continue // 子账号优先
		}
		a.routedByEmail[ad.Email] = NodeShare{NodeID: n.ID, NodeName: n.NodeName, ServerName: n.OriginalServer, Scale: 1}
		a.routedEmailUser[ad.Email] = ad.Username
	}

	servers, err := r.ListRemoteServers(ctx)
	if err != nil {
		return nil, err
	}
	for _, s := range servers {
		a.serverNameByID[s.ID] = s.Name
	}

	cfgs, err := r.ListAllUserInboundConfigs(ctx)
	if err != nil {
		return nil, err
	}
	for _, c := range cfgs {
		if a.userServerTags[c.Username] == nil {
			a.userServerTags[c.Username] = map[int64][]string{}
		}
		a.userServerTags[c.Username][c.ServerID] = append(a.userServerTags[c.Username][c.ServerID], c.InboundTag)
	}

	users, err := r.ListUsers(ctx, 100000)
	if err != nil {
		return nil, err
	}
	// 计费权重需要每个用户当前的套餐(倍率来源)。一次性载入,Classify/EmailWeight 纯内存。
	packages, err := r.ListPackages(ctx)
	if err != nil {
		return nil, err
	}
	pkgByID := make(map[int64]*Package, len(packages))
	for i := range packages {
		pkgByID[packages[i].ID] = &packages[i]
	}
	for _, u := range users {
		a.realUsernames[u.Username] = true
		if u.Email != "" {
			a.usersEmail[u.Email] = u.Username
		}
		if u.PackageID > 0 {
			if p, ok := pkgByID[u.PackageID]; ok {
				a.pkgByUsername[u.Username] = p
			}
		}
	}
	return a, nil
}

// Classify 把一条 email(在 serverID 上采集到的)归因到用户与节点。纯内存。
func (a *EmailAttributor) Classify(email string, serverID int64) EmailAttribution {
	// #1 + #2:routed(含被停用的子账号 / admin 占位)——永不落父入站
	if ns, ok := a.routedByEmail[email]; ok {
		return EmailAttribution{Username: a.routedEmailUser[email], Routed: true, Shares: []NodeShare{ns}}
	}
	// _admin__ 前缀但没有任何 routed 节点持有 → 孤儿,丢弃(与 ResolveUsernameByEmail 一致)
	if strings.HasPrefix(email, "_admin__") {
		return EmailAttribution{}
	}
	// #3/#4:解析物理用户
	username := a.resolveUser(email)
	if username == "" || !a.realUsernames[username] {
		return EmailAttribution{}
	}
	serverName := a.serverNameByID[serverID]
	if serverName == "" {
		return EmailAttribution{}
	}
	// email 形如 <username>__<inbound_tag>:后段就是采集时的 inbound tag。
	// 能凭它精确命中本 server 的某个物理入站节点时,直接归该节点(scale=1),不再在用户的多个
	// 入站间均分 —— 均分只是无法定位到具体 tag 时的兜底(email==username、或 tag 已无对应节点)。
	if strings.HasPrefix(email, username+"__") {
		if n, ok := a.inbNodeByKey[serverName+"::"+email[len(username)+2:]]; ok {
			return EmailAttribution{Username: username, Shares: []NodeShare{{NodeID: n.ID, NodeName: n.NodeName, ServerName: serverName, Scale: 1}}}
		}
	}
	tags := a.userServerTags[username][serverID]
	if len(tags) == 0 {
		// admin 自用 inbound(email==username、没走绑套餐注册)→ 摊到该 server 所有物理入站。
		// routed email 已在 #1/#2 拦截,这里只会是真实物理流量,不会污染。
		tags = a.serverInbTags[serverName]
		if len(tags) == 0 {
			return EmailAttribution{}
		}
	}
	scale := len(tags)
	var shares []NodeShare
	for _, tag := range tags {
		if n, ok := a.inbNodeByKey[serverName+"::"+tag]; ok {
			shares = append(shares, NodeShare{NodeID: n.ID, NodeName: n.NodeName, ServerName: serverName, Scale: scale})
		}
	}
	if len(shares) == 0 {
		return EmailAttribution{}
	}
	return EmailAttribution{Username: username, Shares: shares}
}

// EmailWeight 返回该 email 的**计费权重**,供采集时把 delta 折算成计费流量:
//
//	weight = Σ(MultiplierForNode(share_i) / Scale) × pkg.TrafficMultiplier()
//
// 两层倍率(per-node 与套餐 oneway/twoway)在此合一 —— 落库后读侧直接 SUM,不再乘任何倍率。
// 除以 Scale 与 scaledEmailTraffic 的均分语义一致:定位不到节点的那一份自然蒸发。
//
// 归因失败 / 用户无套餐 → 1.0(按裸量计费),保住旧实现"认不出就 ×1"的 fallback 语义。
func (a *EmailAttributor) EmailWeight(email string, serverID int64) float64 {
	at := a.Classify(email, serverID)
	if at.Username == "" {
		return 1.0
	}
	pkg := a.pkgByUsername[at.Username]
	if pkg == nil {
		return 1.0
	}
	var w float64
	for _, ns := range at.Shares {
		scale := ns.Scale
		if scale < 1 {
			scale = 1
		}
		w += pkg.MultiplierForNode(ns.NodeID) / float64(scale)
	}
	if w == 0 {
		return 1.0
	}
	return w * float64(pkg.TrafficMultiplier())
}

// resolveUser 复刻 ResolveUsernameByEmail 的 #3/#4/#5(#1/#2 已在 Classify 前置处理)。
func (a *EmailAttributor) resolveUser(email string) string {
	if u, ok := a.usersEmail[email]; ok {
		return u
	}
	// 按最长真实用户名匹配 `<username>__`,避免用户名含 `__`/尾 `_` 时首个 `__` 拆错(纯内存,遍历预载的 realUsernames)。
	best := ""
	for u := range a.realUsernames {
		if len(u) > len(best) && strings.HasPrefix(email, u+"__") {
			best = u
		}
	}
	if best != "" {
		return best
	}
	if i := strings.Index(email, "__"); i > 0 {
		return email[:i]
	}
	return email
}

// ScaledEmailTraffic 按 share.Scale 均分一条 email 流量(Scale<=1 原样)。
func ScaledEmailTraffic(uet UserEmailTraffic, scale int) UserEmailTraffic {
	if scale <= 1 {
		return uet
	}
	uet.Uplink /= int64(scale)
	uet.Downlink /= int64(scale)
	uet.LastUplink /= int64(scale)
	uet.LastDownlink /= int64(scale)
	return uet
}
