package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"miaomiaowux/internal/storage"
)

// XrayClientReconciler 的**决策层**:算出「该做什么」,不做任何 mutation。
// 与执行层分离是为了让最危险的逻辑(什么该删)能在没有 agent、没有网络的情况下被穷举测试。

type reconcileActionKind string

const (
	actionAddPhysical    reconcileActionKind = "add_physical"
	actionRemovePhysical reconcileActionKind = "remove_physical"
	actionAddRouted      reconcileActionKind = "add_routed"
	actionRemoveRouted   reconcileActionKind = "remove_routed"
)

// plannedAction 是一条待执行的修复。Email 是决策单元 —— 见 xray_reconcile_expect.go 的说明。
type plannedAction struct {
	Kind       reconcileActionKind
	ServerID   int64
	InboundTag string
	Username   string
	Email      string
	RoutedNode int64 // 仅 routed 动作
	Reason     string
}

func (a plannedAction) isDelete() bool {
	return a.Kind == actionRemovePhysical || a.Kind == actionRemoveRouted
}

// key 用于滞后判定:同一偏差在两轮之间必须稳定可辨认。
func (a plannedAction) key() string {
	return fmt.Sprintf("%s|%d|%s|%s|%d", a.Kind, a.ServerID, a.InboundTag, a.Email, a.RoutedNode)
}

// 安全阀常量。触发预算 = 期望模型出了 bug,不是限流 —— 所以中止整轮而非截断。
const (
	maxDeletesPerRun        = 50
	maxDeleteRatioPerServer = 0.2
	// 比例阀的最小样本量:域内 client 太少时比例没有统计意义 —— 一台只有 2 个 client 的
	// 服务器删 1 个就是 50%,会让 reconciler 在小规模部署上**永远熔断、彻底失效**。
	// 样本不足时只靠绝对上限兜底(对小站点来说 50 个删除本身已是明显异常)。
	minDomainForRatioCheck = 20
)

// errDeleteBudget 表示本轮删除量越过安全阀 → 整轮作废。
type errDeleteBudget struct{ msg string }

func (e errDeleteBudget) Error() string { return e.msg }

// snapshotClient 是从 xray config snapshot 解析出的一个 client。
type snapshotClient struct {
	InboundTag string
	Email      string
}

// parseSnapshotClients 从 agent 的 xray config JSON 里取出所有 (inboundTag, email)。
// 与 orphan_xray_client_cleaner 的解析同款(刻意保持一致,两者读同一份 snapshot)。
func parseSnapshotClients(configJSON string) ([]snapshotClient, error) {
	var cfg struct {
		Inbounds []struct {
			Tag      string `json:"tag"`
			Settings struct {
				Clients []map[string]interface{} `json:"clients"`
			} `json:"settings"`
		} `json:"inbounds"`
	}
	if err := json.Unmarshal([]byte(configJSON), &cfg); err != nil {
		return nil, err
	}
	var out []snapshotClient
	for _, ib := range cfg.Inbounds {
		// tag=="api" 是内置管理入站,不属于任何用户
		if ib.Tag == "" || ib.Tag == "api" {
			continue
		}
		for _, c := range ib.Settings.Clients {
			email, _ := c["email"].(string)
			out = append(out, snapshotClient{InboundTag: ib.Tag, Email: email})
		}
	}
	return out, nil
}

// reconcileInputs 是一轮对账所需的全部只读快照,一次性加载。
// 任一加载失败 → 整轮放弃(部分输入正是期望状态塌掉的方式)。
type reconcileInputs struct {
	users          []storage.User
	nodesByID      map[int64]storage.Node
	serverIDByName map[string]int64
	subaccounts    []storage.SubaccountRef // 含 is_active + routed_node_id
	adminEmails    map[string]bool
	overLimit      map[string]bool
	pkgNodes       map[int64][]int64 // package_id → nodes(严格解析)
	pkgErr         map[int64]error
}

// loadReconcileInputs 一次性拉齐决策所需的一切。
func loadReconcileInputs(ctx context.Context, repo *storage.TrafficRepository) (*reconcileInputs, error) {
	const userLimit = 100000
	// ⚠️ ListUsers 对 limit<=0 会静默 clamp 成 10 —— 传显式大值。
	users, err := repo.ListUsers(ctx, userLimit)
	if err != nil {
		return nil, fmt.Errorf("list users: %w", err)
	}
	if len(users) >= userLimit {
		return nil, fmt.Errorf("user count hit limit %d, refusing to reconcile on a truncated view", userLimit)
	}
	nodes, err := repo.ListAllNodes(ctx)
	if err != nil {
		return nil, fmt.Errorf("list nodes: %w", err)
	}
	servers, err := repo.ListRemoteServers(ctx)
	if err != nil {
		return nil, fmt.Errorf("list servers: %w", err)
	}
	subs, err := repo.ListAllSubaccounts(ctx)
	if err != nil {
		return nil, fmt.Errorf("list subaccounts: %w", err)
	}
	adminEmails, err := repo.ListRoutedAdminEmails(ctx)
	if err != nil {
		return nil, fmt.Errorf("list routed admin emails: %w", err)
	}

	in := &reconcileInputs{
		users:          users,
		nodesByID:      make(map[int64]storage.Node, len(nodes)),
		serverIDByName: make(map[string]int64, len(servers)),
		subaccounts:    subs,
		adminEmails:    adminEmails,
		overLimit:      make(map[string]bool),
		pkgNodes:       make(map[int64][]int64),
		pkgErr:         make(map[int64]error),
	}
	for _, n := range nodes {
		in.nodesByID[n.ID] = n
	}
	for _, s := range servers {
		in.serverIDByName[s.Name] = s.ID
	}
	// 套餐按 package_id 缓存,每轮每套餐查一次(抄 enforcer 的 pkgCache)
	for _, u := range users {
		if u.PackageID <= 0 {
			continue
		}
		if _, done := in.pkgNodes[u.PackageID]; done {
			continue
		}
		if _, done := in.pkgErr[u.PackageID]; done {
			continue
		}
		ns, perr := repo.GetPackageNodesStrict(ctx, u.PackageID)
		if perr != nil {
			in.pkgErr[u.PackageID] = perr
			continue
		}
		in.pkgNodes[u.PackageID] = ns
	}
	// 超额标志:必需输入,不是细化(见 computeUserExpectation 的说明)
	for _, u := range users {
		if over, oerr := repo.IsUserOverLimit(ctx, u.Username); oerr == nil && over {
			in.overLimit[u.Username] = true
		}
	}
	return in, nil
}

// planReconcile 算出全部待修复动作。**纯决策,不 mutate**。
// snapshotsByServer: serverID → agent 的 xray config JSON(调用方负责跳过不可信 server)。
func planReconcile(in *reconcileInputs, snapshotsByServer map[int64]string, now time.Time) ([]plannedAction, error) {
	// 1) 逐用户算期望
	expByUser := make(map[string]userExpectation, len(in.users))
	userByName := make(map[string]storage.User, len(in.users))
	for _, u := range in.users {
		userByName[u.Username] = u
		expByUser[u.Username] = computeUserExpectation(
			u, now, in.pkgNodes[u.PackageID], in.pkgErr[u.PackageID],
			in.overLimit[u.Username], in.nodesByID, in.serverIDByName)
	}

	// 2) 建 routed 子账号的双向索引
	//    email → 子账号(判归属);(username, routedNodeID) → 子账号(判缺失)
	subByEmail := make(map[string]storage.SubaccountRef, len(in.subaccounts))
	subByUserNode := make(map[string]storage.SubaccountRef, len(in.subaccounts))
	for _, s := range in.subaccounts {
		subByEmail[s.Email] = s
		subByUserNode[s.Username+"|"+fmt.Sprint(s.RoutedNodeID)] = s
	}

	var actions []plannedAction

	// 3) 删除方向:遍历 xray 实际 client,**正向归属**后再判越界。
	//    绝不写成"不在 ∪expected 就删" —— 那样 ListUsers 截断/未知 email/联邦对方的 client 都会被删光。
	//    失败一律降级为"什么都不做"。
	deletesPerServer := make(map[int64]int)
	domainPerServer := make(map[int64]int)
	for serverID, cfgJSON := range snapshotsByServer {
		clients, perr := parseSnapshotClients(cfgJSON)
		if perr != nil {
			// 解析不了就不对这台做任何删除(它的 add 方向也不可信,整台跳过)
			continue
		}
		for _, c := range clients {
			// —— 域外排除(归属之前) ——
			if c.Email == "" || strings.HasPrefix(c.Email, "_admin__") {
				continue
			}
			if in.adminEmails[c.Email] {
				continue // routed 出站的 admin 占位
			}
			domainPerServer[serverID]++

			// —— routed 子账号:email 是 DB 权威,不能靠 __ split 推断 ——
			if sub, ok := subByEmail[c.Email]; ok {
				exp, has := expByUser[sub.Username]
				if !has || !exp.decided {
					continue // 无意见 → 不动
				}
				// 期望该 routed 节点 active,且子账号也确实 active → 保留
				if exp.hasRouted(sub.RoutedNodeID) && sub.IsActive {
					continue
				}
				actions = append(actions, plannedAction{
					Kind: actionRemoveRouted, ServerID: serverID, InboundTag: c.InboundTag,
					Username: sub.Username, Email: c.Email, RoutedNode: sub.RoutedNodeID,
					Reason: routedRemoveReason(exp, sub),
				})
				deletesPerServer[serverID]++
				continue
			}

			// —— 物理 client:精确等于某个已枚举用户的规范 email 才归属 ——
			//    用精确相等而非 ResolveUsernameByEmail:后者带 email[:i] 前缀兜底,
			//    绝不能让一个启发式来授权删除。
			owner, ok := attributePhysicalEmail(c.Email, c.InboundTag, userByName)
			if !ok {
				continue // 归属不到 → 不是我的域(可能是 legacy email / 联邦对方 / 已删用户)→ 不动
			}
			exp := expByUser[owner]
			if !exp.decided {
				continue
			}
			if exp.hasPhysical(inboundKey{ServerID: serverID, InboundTag: c.InboundTag}) {
				continue // 期望存在 → 保留
			}
			actions = append(actions, plannedAction{
				Kind: actionRemovePhysical, ServerID: serverID, InboundTag: c.InboundTag,
				Username: owner, Email: c.Email,
				Reason: physicalRemoveReason(userByName[owner], exp),
			})
			deletesPerServer[serverID]++
		}
	}

	// 4) 安全阀:预算。触发 → 整轮作废(不部分执行)。
	totalDeletes := 0
	for _, n := range deletesPerServer {
		totalDeletes += n
	}
	if totalDeletes > maxDeletesPerRun {
		return nil, errDeleteBudget{fmt.Sprintf(
			"本轮计划删除 %d 个 client,超过硬上限 %d —— 期望状态很可能算错了,整轮作废",
			totalDeletes, maxDeletesPerRun)}
	}
	for serverID, n := range deletesPerServer {
		domain := domainPerServer[serverID]
		// 样本不足 → 比例无意义,跳过(否则小站点永远熔断)。绝对上限仍然生效。
		if domain < minDomainForRatioCheck {
			continue
		}
		if ratio := float64(n) / float64(domain); ratio > maxDeleteRatioPerServer {
			return nil, errDeleteBudget{fmt.Sprintf(
				"server=%d 计划删除 %d/%d (%.0f%%) 超过比例上限 %.0f%% —— 期望状态很可能塌了,整轮作废",
				serverID, n, domain, ratio*100, maxDeleteRatioPerServer*100)}
		}
	}

	// 5) 补齐方向:期望有、snapshot 里没有 → 加。
	//    只对**有快照的 server**判断缺失(没快照 = 不知道实际状态,不能断言"缺")。
	presentPhysical := make(map[string]bool) // serverID|tag|email
	presentEmailOnServer := make(map[string]bool)
	for serverID, cfgJSON := range snapshotsByServer {
		clients, perr := parseSnapshotClients(cfgJSON)
		if perr != nil {
			continue
		}
		for _, c := range clients {
			presentPhysical[fmt.Sprintf("%d|%s|%s", serverID, c.InboundTag, c.Email)] = true
			presentEmailOnServer[fmt.Sprintf("%d|%s", serverID, c.Email)] = true
		}
	}
	for _, u := range in.users {
		exp := expByUser[u.Username]
		if !exp.decided {
			continue
		}
		// 抑制态(期望空集)天然不会进这个循环体的 add 分支 —— 集合是空的。
		for k := range exp.physical {
			if _, hasSnap := snapshotsByServer[k.ServerID]; !hasSnap {
				continue // 该 server 无可信快照 → 不断言缺失
			}
			email := canonicalPhysicalEmail(u.Username, k.InboundTag)
			if presentPhysical[fmt.Sprintf("%d|%s|%s", k.ServerID, k.InboundTag, email)] {
				continue
			}
			actions = append(actions, plannedAction{
				Kind: actionAddPhysical, ServerID: k.ServerID, InboundTag: k.InboundTag,
				Username: u.Username, Email: email,
				Reason: "套餐含该节点但 xray 缺少 client",
			})
		}
		for nodeID := range exp.routed {
			node, ok := in.nodesByID[nodeID]
			if !ok {
				continue
			}
			sid, ok := in.serverIDByName[node.OriginalServer]
			if !ok {
				continue
			}
			if _, hasSnap := snapshotsByServer[sid]; !hasSnap {
				continue
			}
			sub, ok := subByUserNode[u.Username+"|"+fmt.Sprint(nodeID)]
			if !ok {
				// 子账号还没建 —— 属于"从未下发",交给 AssignAndProvision 的正常路径,
				// reconciler 一期不代劳建子账号(要生成凭据 + 建 routing rule,风险面大)。
				continue
			}
			if presentEmailOnServer[fmt.Sprintf("%d|%s", sid, sub.Email)] && sub.IsActive {
				continue // 已在且应在
			}
			if !sub.IsActive {
				continue // DB 说该停用 → 不是"缺失",删除方向已覆盖
			}
			actions = append(actions, plannedAction{
				Kind: actionAddRouted, ServerID: sid, InboundTag: node.InboundTag,
				Username: u.Username, Email: sub.Email, RoutedNode: nodeID,
				Reason: "套餐含该 routed 节点且子账号 active,但 xray 缺少 client",
			})
		}
	}

	return actions, nil
}

// attributePhysicalEmail 把一个物理 client email 精确归属到某个已枚举用户。
// **必须精确相等**:email == username + "__" + inboundTag。
// 归属不到 → (,"false") → 调用方不得删除它。
func attributePhysicalEmail(email, inboundTag string, userByName map[string]storage.User) (string, bool) {
	suffix := "__" + inboundTag
	if !strings.HasSuffix(email, suffix) {
		return "", false
	}
	username := strings.TrimSuffix(email, suffix)
	if username == "" {
		return "", false
	}
	if _, ok := userByName[username]; !ok {
		return "", false // 用户不存在 → 是 cleaner 的域(真孤儿),不是我的
	}
	return username, true
}

func physicalRemoveReason(u storage.User, exp userExpectation) string {
	switch {
	case !u.IsActive:
		return "用户已禁用"
	case u.PackageID <= 0:
		return "用户无套餐(可能是套餐到期后被清)"
	case len(exp.physical) == 0:
		return "用户当前不该有任何 client(到期/超额/空套餐)"
	default:
		return "该节点已不在用户套餐内"
	}
}

func routedRemoveReason(exp userExpectation, sub storage.SubaccountRef) string {
	if !sub.IsActive {
		return "子账号已停用但 xray 仍有 client"
	}
	if !exp.hasRouted(sub.RoutedNodeID) {
		return "该 routed 节点已不在用户套餐内"
	}
	return "用户当前不该有任何 client"
}
