package handler

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"miaomiaowux/internal/storage"
)

// 从**指定远程服务器**发起 TCP 拨测(不是从主控本机)。
//
// 与已有的 /api/admin/tcping 的区别就在这里:那个是主控自己去连目标,只能回答
// 「主控能不能连到 X」;而配隧道时真正要回答的是「入口服务器能不能连到目标」——
// 两者经常不一致(主控在国内、入口在香港,路径完全不同)。
//
// 底层复用 RemoteWSHandler.SendDomainLatencyProbe:主控经 WS 把探测任务下发给 agent,
// agent 侧就是 net.DialTimeout("tcp", host:port)(见 mmw-agent domain_latency_handler.go),
// 支持 "host:port" 形式,不带端口时默认 443。

const (
	// 单次最多探几个目标 —— 表单场景一次只探 1~2 个,给点余量即可,顺便挡住把它当扫描器用。
	serverTCPingMaxTargets = 8
	serverTCPingDefaultMs  = 3000
	serverTCPingMaxMs      = 10000
)

// NewServerTCPingHandler POST /api/admin/remote/tcping
//
//	{"server_id":2,"targets":["1.2.3.4:443"],"timeout_ms":3000}
//	→ {"success":true,"results":[{"target":"1.2.3.4:443","success":true,"latency_ms":42}]}
//
// 探测失败(目标不通)不算接口失败:HTTP 仍是 200,靠每条结果里的 success 区分,
// 这样前端能把"不通"当正常态展示,而不是弹一个错误框。
func NewServerTCPingHandler(rm *RemoteManageHandler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			methodNotAllowed(w, http.MethodPost)
			return
		}
		var req struct {
			ServerID  int64    `json:"server_id"`
			Targets   []string `json:"targets"`
			TimeoutMs int      `json:"timeout_ms"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeBadRequest(w, "请求格式不正确")
			return
		}
		if req.ServerID <= 0 {
			writeBadRequest(w, "server_id 不能为空")
			return
		}

		targets := make([]string, 0, len(req.Targets))
		for _, t := range req.Targets {
			if t = strings.TrimSpace(t); t != "" {
				targets = append(targets, t)
			}
			if len(targets) >= serverTCPingMaxTargets {
				break
			}
		}
		if len(targets) == 0 {
			writeBadRequest(w, "targets 不能为空")
			return
		}

		timeoutMs := req.TimeoutMs
		if timeoutMs <= 0 {
			timeoutMs = serverTCPingDefaultMs
		}
		if timeoutMs > serverTCPingMaxMs {
			timeoutMs = serverTCPingMaxMs
		}

		if rm == nil {
			respondJSON(w, http.StatusOK, map[string]any{"success": false, "error": "服务未就绪"})
			return
		}

		// 走 forwardToRemoteServer 而不是直接调 SendDomainLatencyProbe:
		// 前者是 **WS-first + HTTP 回退**(见其内部 tryWSRPC 注释),后者是纯 WS ——
		// pull/HTTP 模式的 agent、以及 WS 临时断开时,纯 WS 版会直接失败,
		// 表现成"探测不了",而实际上 HTTP 通道是好的。
		body, _ := json.Marshal(map[string]any{"domains": targets, "timeout_ms": timeoutMs})
		ctx, cancel := context.WithTimeout(r.Context(), time.Duration(timeoutMs)*time.Millisecond+8*time.Second)
		defer cancel()
		raw, err := rm.forwardToRemoteServer(ctx, req.ServerID, http.MethodPost, "/api/child/domains/latency", body)
		if err != nil {
			// agent 离线 / 两条通道都不可用 —— 对前端是"这次测不了",不是目标不通。
			respondJSON(w, http.StatusOK, map[string]any{"success": false, "error": err.Error()})
			return
		}

		// agent 返回 {success, results:[{domain,target,success,latency_ms,error}]},原样透传需要的字段。
		var parsed struct {
			Success bool   `json:"success"`
			Error   string `json:"error"`
			Results []struct {
				Target    string `json:"target"`
				Success   bool   `json:"success"`
				LatencyMs int64  `json:"latency_ms"`
				Error     string `json:"error"`
			} `json:"results"`
		}
		if jerr := json.Unmarshal(raw, &parsed); jerr != nil {
			respondJSON(w, http.StatusOK, map[string]any{"success": false, "error": "解析探测结果失败"})
			return
		}
		out := make([]map[string]any, 0, len(parsed.Results))
		for _, item := range parsed.Results {
			out = append(out, map[string]any{
				"target":     item.Target,
				"success":    item.Success,
				"latency_ms": item.LatencyMs,
				"error":      item.Error,
			})
		}
		respondJSON(w, http.StatusOK, map[string]any{"success": parsed.Success, "results": out, "error": parsed.Error})
	})
}

// NewServerReachabilityHandler POST /api/admin/remote/reachable
//
//	{"from_server_id":2,"to_server_id":4}
//	→ {"success":true,"latency_ms":42,"probed":"1.2.3.4:443","port_source":"node"}
//
// 回答的是「A 到 B 的网络路径通不通」,用于链式隧道在**建链前**逐跳预检。
//
// 为什么不能直接探测"将来的隧道端口":建链前那个端口在 B 上根本没有监听,无论端口号
// 算得多准,拨过去都是 connection refused —— 测了等于没测,还会给用户一个假红叉。
//
// 所以改为探测 B 上**当前确定在监听**的端口,按可靠性排序:
//  1. B 上物理节点在用的端口 —— 用户正在连它,必然监听且对外开放,最可靠
//  2. B 的 agent 监听端口 —— 次选:开了「端口隐身」(hide_port_on_ws)的 agent
//     在 WS 在线期间会关掉这个监听,此时探测会失败
//  3. 443 —— 兜底,不一定开
func NewServerReachabilityHandler(rm *RemoteManageHandler, repo *storage.TrafficRepository) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			methodNotAllowed(w, http.MethodPost)
			return
		}
		var req struct {
			FromServerID int64 `json:"from_server_id"`
			ToServerID   int64 `json:"to_server_id"`
			TimeoutMs    int   `json:"timeout_ms"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeBadRequest(w, "请求格式不正确")
			return
		}
		if req.FromServerID <= 0 || req.ToServerID <= 0 {
			writeBadRequest(w, "from_server_id / to_server_id 不能为空")
			return
		}
		if req.FromServerID == req.ToServerID {
			writeBadRequest(w, "源和目标不能是同一台服务器")
			return
		}
		if rm == nil || repo == nil {
			respondJSON(w, http.StatusOK, map[string]any{"success": false, "error": "服务未就绪"})
			return
		}

		to, err := repo.GetRemoteServer(r.Context(), req.ToServerID)
		if err != nil || to == nil {
			respondJSON(w, http.StatusOK, map[string]any{"success": false, "error": "目标服务器不存在"})
			return
		}
		// 域名优先:IP 会漂,域名不会(与隧道取址口径一致)
		host := strings.TrimSpace(to.Domain)
		if host == "" {
			host = strings.TrimSpace(to.IPAddress)
		}
		if host == "" {
			host = strings.TrimSpace(to.PullAddress)
		}
		if host == "" {
			respondJSON(w, http.StatusOK, map[string]any{"success": false, "error": "目标服务器没有可用地址"})
			return
		}

		targets, conclusive := pickReachableTargets(r.Context(), repo, to, host)
		if len(targets) == 0 {
			respondJSON(w, http.StatusOK, map[string]any{
				"success": false, "conclusive": false, "error": "目标服务器没有可探测的端口",
			})
			return
		}

		timeoutMs := req.TimeoutMs
		if timeoutMs <= 0 {
			timeoutMs = serverTCPingDefaultMs
		}
		if timeoutMs > serverTCPingMaxMs {
			timeoutMs = serverTCPingMaxMs
		}

		// allow_icmp:候选端口全拨不通时让 agent 降级 ICMP,回答"主机可达吗"。
		// 没有任何入站的新服务器、以及开了端口隐身的 agent,只有这条路能给出结论。
		// 老 agent 不认这个字段会忽略它,行为与之前一致(只做 TCP)。
		body, _ := json.Marshal(map[string]any{"domains": targets, "timeout_ms": timeoutMs, "allow_icmp": true})
		ctx, cancel := context.WithTimeout(r.Context(), time.Duration(timeoutMs)*time.Millisecond+8*time.Second)
		defer cancel()
		raw, ferr := rm.forwardToRemoteServer(ctx, req.FromServerID, http.MethodPost, "/api/child/domains/latency", body)
		if ferr != nil {
			// 源服务器都联系不上 —— 这不是"目标不通",是这次测不了。
			respondJSON(w, http.StatusOK, map[string]any{
				"success": false, "conclusive": false, "error": ferr.Error(),
			})
			return
		}
		var parsed struct {
			Results []struct {
				Target    string `json:"target"`
				Success   bool   `json:"success"`
				LatencyMs int64  `json:"latency_ms"`
				Error     string `json:"error"`
				Method    string `json:"method"` // "tcp" | "icmp"(老 agent 为空)
			} `json:"results"`
		}
		if json.Unmarshal(raw, &parsed) != nil || len(parsed.Results) == 0 {
			respondJSON(w, http.StatusOK, map[string]any{
				"success": false, "conclusive": false, "error": "解析探测结果失败",
			})
			return
		}

		// 任一候选通 → 可达。**优先取 TCP 命中**:它同时证明了端口可连,
		// 比 ICMP 的"主机活着"更强;没有 TCP 命中才回退到 ICMP 结果。
		bestTCP, bestICMP := -1, -1
		for i, it := range parsed.Results {
			if !it.Success {
				continue
			}
			if it.Method == "icmp" {
				if bestICMP < 0 || it.LatencyMs < parsed.Results[bestICMP].LatencyMs {
					bestICMP = i
				}
				continue
			}
			if bestTCP < 0 || it.LatencyMs < parsed.Results[bestTCP].LatencyMs {
				bestTCP = i
			}
		}
		if best := bestTCP; best >= 0 {
			hit := parsed.Results[best]
			respondJSON(w, http.StatusOK, map[string]any{
				"success": true, "conclusive": true, "method": "tcp",
				"latency_ms": hit.LatencyMs, "probed": hit.Target,
			})
			return
		}
		if bestICMP >= 0 {
			hit := parsed.Results[bestICMP]
			// ICMP 通 = 主机可达、路由没问题,但端口是否放行未知。
			// 对链式隧道的预检来说这已经够用(它要排除的就是机房互封/路由不通)。
			respondJSON(w, http.StatusOK, map[string]any{
				"success": true, "conclusive": true, "method": "icmp",
				"latency_ms": hit.LatencyMs, "probed": hit.Target,
			})
			return
		}

		// 全部拨不通:能否下"不通"的结论,取决于候选里有没有确知在监听的端口。
		respondJSON(w, http.StatusOK, map[string]any{
			"success": false, "conclusive": conclusive,
			"probed": strings.Join(targets, ", "),
			"error":  parsed.Results[0].Error,
		})
	})
}

// pickReachableTargets 给出「探测 B 是否可达」的候选目标,以及结果是否**可下定论**。
//
// conclusive=true 表示候选里至少有一个端口是我们**确知在监听**的(该机物理节点在用的端口,
// 用户此刻正连着它)。这种情况下全部拨不通 → 可以断言两台机之间网络不通。
//
// conclusive=false 表示我们只能拿"可能开着"的端口去碰运气:
//   - agent 的 listen_port:WS 模式下 agent 会关闭入站监听(端口隐身),多半连不上
//   - 443 / 80:纯猜,机器上不一定有服务
//
// 这时拨不通**不能**说明网络不通,只能说"测不出来"—— 前端必须显示成「无法预检」而不是
// 红色的「不通」,否则会让用户误以为链路有问题而白白排查。
//
// 多个候选一起下发(agent 侧并发拨测),任一通即判可达 —— 提高命中率,不增加往返。
func pickReachableTargets(ctx context.Context, repo *storage.TrafficRepository, srv *storage.RemoteServer, host string) ([]string, bool) {
	seen := map[int]bool{}
	var ports []int
	add := func(p int) {
		if p > 0 && p <= 65535 && !seen[p] {
			seen[p] = true
			ports = append(ports, p)
		}
	}

	// 1) 该机物理节点在用的端口:确知在监听。最多取 3 个,够用且不把探测放大成端口扫描。
	conclusive := false
	if nodes, err := repo.ListAllNodes(ctx); err == nil {
		for _, n := range nodes {
			if len(ports) >= 3 {
				break
			}
			if n.NodeType == "routed" || n.OriginalServer != srv.Name || !n.Enabled {
				continue
			}
			if _, p, ok := clashConfigServerPort(n.ClashConfig); ok {
				add(p)
				conclusive = true
			}
		}
	}

	// 2) agent 端口:pull/HTTP 模式下开着,WS 模式下通常被端口隐身关掉 —— 只当补充候选,
	//    不因为它的存在就认为结果可下定论。
	add(srv.ListenPort)
	// 3) 常见端口兜底:没有任何入站的新服务器只能靠这个碰一下
	add(443)
	add(80)

	targets := make([]string, 0, len(ports))
	for _, p := range ports {
		targets = append(targets, net.JoinHostPort(host, strconv.Itoa(p)))
	}
	return targets, conclusive
}
