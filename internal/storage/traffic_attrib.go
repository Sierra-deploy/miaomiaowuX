package storage

import (
	"context"
	"errors"
	"sort"
	"strings"
	"sync"
	"time"
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
	// inbNodesByKey 同一 (server, tag) 下的**全部**候选物理节点,按 ID 升序。
	// 曾是 map[string]Node —— 同 server+tag 存在多个节点时后写覆盖先写,
	// 选中谁取决于 ListAllNodes 的返回顺序,同一个库可能算出不同的 NodeMultiplier。
	inbNodesByKey  map[string][]Node
	serverNameByID map[int64]string
	userServerTags map[string]map[int64][]string // username → serverID → []inbound_tag
	serverInbTags  map[string][]string           // serverName → 该 server 物理入站 tags(admin 自用兜底)
	usersEmail     map[string]string             // users.email → username
	realUsernames  map[string]bool
	pkgByUsername  map[string]*Package // 计费权重用:username → 其当前套餐(无套餐则不存在)
}

// BuildEmailAttributor 一次性加载归因所需全部映射。
func (r *TrafficRepository) BuildEmailAttributor(ctx context.Context) (*EmailAttributor, error) {
	a := &EmailAttributor{
		routedByEmail:   map[string]NodeShare{},
		routedEmailUser: map[string]string{},
		inbNodesByKey:   map[string][]Node{},
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
	// seenServerTag 给 serverInbTags 去重:同 server+tag 有多个节点时,tag 只能进一次。
	// 否则它会被当成均分分母 len(tags) 的一员重复计数,把权重稀释掉(流量凭空蒸发)。
	seenServerTag := map[string]bool{}
	for _, n := range nodes {
		nodesByID[n.ID] = n
		if n.NodeType != "routed" && n.InboundTag != "" {
			key := n.OriginalServer + "::" + n.InboundTag
			a.inbNodesByKey[key] = append(a.inbNodesByKey[key], n)
			if !seenServerTag[key] {
				seenServerTag[key] = true
				a.serverInbTags[n.OriginalServer] = append(a.serverInbTags[n.OriginalServer], n.InboundTag)
			}
		}
	}
	// 候选按 ID 升序:pickNode 的"最小 ID 兜底"靠它保证结果稳定,不受查询顺序影响。
	for k := range a.inbNodesByKey {
		sort.Slice(a.inbNodesByKey[k], func(i, j int) bool {
			return a.inbNodesByKey[k][i].ID < a.inbNodesByKey[k][j].ID
		})
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
		// 服务器已被删除(历史流量行仍在)。节点无从确定,但**用户归属与套餐倍率跟服务器无关**,
		// 必须保住 —— 以前这里直接返回空归因,连带把 username 和 pkg.TrafficMultiplier() 一起丢了,
		// 回填时 twoway 用户的计费用量直接腰斩。
		return EmailAttribution{Username: username}
	}
	// email 形如 <username>__<inbound_tag>:后段就是采集时的 inbound tag。
	// 能凭它精确命中本 server 的某个物理入站节点时,直接归该节点(scale=1),不再在用户的多个
	// 入站间均分 —— 均分只是无法定位到具体 tag 时的兜底(email==username、或 tag 已无对应节点)。
	if strings.HasPrefix(email, username+"__") {
		if n, ok := a.pickNode(serverName, email[len(username)+2:], username); ok {
			return EmailAttribution{Username: username, Shares: []NodeShare{{NodeID: n.ID, NodeName: n.NodeName, ServerName: serverName, Scale: 1}}}
		}
	}
	tags := a.userServerTags[username][serverID]
	if len(tags) == 0 {
		// admin 自用 inbound(email==username、没走绑套餐注册)→ 摊到该 server 所有物理入站。
		// routed email 已在 #1/#2 拦截,这里只会是真实物理流量,不会污染。
		tags = a.serverInbTags[serverName]
	}
	// 两趟:先解析出真正存在的节点,再用它的数量当均分分母。
	// 以前分母取 len(tags) —— 但只有"能解析出节点"的 tag 才产生 share,绑定了却没有对应节点的
	// tag(节点被删但 user_inbound_configs 残留)白占分母,那一份权重直接蒸发 → 持续少计费。
	resolved := make([]Node, 0, len(tags))
	for _, tag := range tags {
		if n, ok := a.pickNode(serverName, tag, username); ok {
			resolved = append(resolved, n)
		}
	}
	if len(resolved) == 0 {
		// 一个节点都定位不到:仍保留用户归属,让套餐倍率照常生效(同上面服务器已删除的处理)。
		return EmailAttribution{Username: username}
	}
	scale := len(resolved)
	shares := make([]NodeShare, 0, scale)
	for _, n := range resolved {
		shares = append(shares, NodeShare{NodeID: n.ID, NodeName: n.NodeName, ServerName: serverName, Scale: scale})
	}
	return EmailAttribution{Username: username, Shares: shares}
}

// pickNode 从同 (server, tag) 的候选节点里挑一个。
//
// 候选多于一个时(同 server 同 tag 建了多个物理节点),优先选用户当前套餐内的那个 ——
// 选错节点就会用错 NodeMultiplier,直接算错钱。都不在套餐里则取最小 ID:
// 候选已按 ID 升序,取第一个即可,保证同一个库每次算出的结果一致。
func (a *EmailAttributor) pickNode(serverName, tag, username string) (Node, bool) {
	cands := a.inbNodesByKey[serverName+"::"+tag]
	if len(cands) == 0 {
		return Node{}, false
	}
	if len(cands) == 1 {
		return cands[0], true // 绝大多数情况,免去下面的套餐比对
	}
	if pkg := a.pkgByUsername[username]; pkg != nil && len(pkg.Nodes) > 0 {
		for _, n := range cands {
			for _, id := range pkg.Nodes {
				if id == n.ID {
					return n, true
				}
			}
		}
	}
	return cands[0], true
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
	// 节点无从确定(服务器已删 / 绑定的 tag 都没有对应节点)时,节点倍率按 1 处理,
	// 但**套餐 oneway/twoway 倍率照常应用** —— 它只依赖 username,与节点、服务器都无关。
	// 以前这里返回裸 1.0,把套餐倍率一起吞掉了。
	w := 1.0
	if len(at.Shares) > 0 {
		w = 0
		for _, ns := range at.Shares {
			scale := ns.Scale
			if scale < 1 {
				scale = 1
			}
			w += pkg.MultiplierForNode(ns.NodeID) / float64(scale)
		}
		if w == 0 {
			w = 1.0
		}
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

// attributorCacheTTL 是归因器的缓存有效期。
//
// 为什么需要缓存:BuildEmailAttributor 要跑 7 个全表查询(nodes / subaccounts / routed-admin /
// remote_servers / user_inbound_configs / users / packages),而它构建的是**全局**归因表 ——
// 签名里根本没有 serverID,每台服务器拿到的是完全相同的一份。
//
// 采集热路径是 per-server 并发的(每个 agent 的 WS 上报各一个 goroutine),所以几十台服务器
// 会在同一瞬间各建一份一模一样的表:50 台 × 7 次全表查询 / 每个上报周期。这些长读事务持续
// 持有 WAL read mark,导致 wal_checkpoint(TRUNCATE) 永远等不到"所有 reader 都读到最新",
// 一直返回 busy → WAL 无限膨胀(线上实测 53 GiB,而主库只有 17 MiB)。
//
// 5 秒的取值:与默认上报周期(main.go reportMs 默认 5000ms)对齐。
// 取 2 秒时 TTL 短于常见周期(3~5s),等于每轮都要重建 —— 缓存只在"同一轮里几十台并发"
// 这个窗口内生效;放宽到 5 秒后跨轮也能命中,3 秒周期下重建频率再降约 40%。
//
// 代价是倍率/节点变更的生效延迟 ≤5s,但改动前的行为本就是"每 tick 重建"(即 ≤1 个上报周期,
// 默认正是 5s),所以这里没有任何退化。
const attributorCacheTTL = 5 * time.Second

type attributorCache struct {
	mu      sync.Mutex
	val     *EmailAttributor
	builtAt time.Time
}

// BuildEmailAttributorCached 是 BuildEmailAttributor 的带 TTL 缓存版本,供**高频并发**的采集
// 热路径使用。低频调用方(面板查询、测试)继续用不带缓存的原方法,以免读到滞后数据。
//
// 并发安全:持锁重建 —— 缓存刚过期时几十个 goroutine 同时进来,只有第一个真正查库,
// 其余等它建完直接复用(等价 singleflight)。返回的 *EmailAttributor 只被读
// (Classify / EmailWeight / pickNode / resolveUser 都不写内部 map),可安全共享。
func (r *TrafficRepository) BuildEmailAttributorCached(ctx context.Context) (*EmailAttributor, error) {
	if r == nil {
		return nil, errors.New("traffic repository not initialized")
	}
	r.attrCache.mu.Lock()
	defer r.attrCache.mu.Unlock()

	if r.attrCache.val != nil && time.Since(r.attrCache.builtAt) < attributorCacheTTL {
		return r.attrCache.val, nil
	}
	a, err := r.BuildEmailAttributor(ctx)
	if err != nil {
		// 不缓存失败:下一次调用照常重试,避免一次抖动把错误状态钉住 TTL 那么久。
		return nil, err
	}
	r.attrCache.val = a
	r.attrCache.builtAt = time.Now()
	return a, nil
}
