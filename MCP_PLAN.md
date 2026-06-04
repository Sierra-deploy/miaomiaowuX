# 妙妙屋X MCP 服务 + Claude Agent Skills 接入 OpenClaw — 方案

> 目标:让妙妙屋X主控对外提供 MCP 服务,并配套 Claude Agent Skills,使 OpenClaw(开源 AI agent 运行时,支持 MCP)能通过自然语言运维妙妙屋X。

## 0. 决策(已确认)

| 项 | 决策 |
|---|---|
| MCP 形态 | **嵌入主控二进制**,streamable-HTTP,挂 `/mcp` 路由 |
| 工具范围 | 四域全开:节点管理 / 订阅与流量统计 / 服务器与服务管理 / 用户与套餐 |
| 鉴权 | **新增「每用户 API Token」**(个人设置里生成),权限与该用户登录态一致 |
| Skills | **Claude Agent Skills**(`SKILL.md` 技能包) |
| OpenClaw 接入 | `mcp.servers` 配 `url` + `Authorization: Bearer <token>` 远程直连 |

设计总原则:**MCP 工具是薄封装**,内部转调现有 REST handler(经同一 mux + 同一鉴权中间件),不复制业务逻辑,保证权限语义与 Web 端完全一致。

---

## 1. 鉴权:每用户 API Token(基础设施,先做)

### 现状
[token_store.go:236-244](internal/auth/token_store.go#L236) 现有的是**单个全局 admin token**(`repo.GetAPIToken(ctx)`,无 username,命中即 `api-token-admin` 全权)。不满足「每用户、权限随登录态」。

### 要做
1. **存储**:新表 `user_api_tokens(id, username, name, token_hash, created_at, last_used_at)`。
   - token 明文仅创建时返回一次;库里只存 `sha256(token)`。
   - 一个用户可有多枚(便于区分用途/吊销);token 形如 `mmwx_<base64url(32B)>`。
2. **repo**(internal/storage):`CreateUserAPIToken / ListUserAPITokens / ResolveUsernameByAPITokenHash / TouchAPIToken / RevokeUserAPIToken`。
3. **auth 中间件**([token_store.go:220](internal/auth/token_store.go#L220) `RequireToken`):
   - 在 session lookup 失败后,**先查 per-user token**(`ResolveUsernameByAPITokenHash`)→ 命中则 `ContextWithUsername(真实用户名)`(而非 `api-token-admin`)。
   - `RequireAdmin` 因此自动按**真实角色**判定:普通用户的 token 调 admin 工具 → 403。
   - 保留旧全局 token 分支兼容。
   - `UserRepository` 接口加一个方法 `ResolveAPIToken(ctx, tokenHash) (username string, ok bool)`。
   - 同时接受 `MM-Authorization` 与 `Authorization: Bearer`(OpenClaw 习惯用后者)。
4. **前端**(个人设置页):新增「API 令牌」区块——生成(弹一次性明文+复制按钮)、列表(名称/创建时间/最近使用)、删除;附 OpenClaw 配置片段一键复制。

> 工作量:后端 ~0.5d,前端 ~0.5d。

---

## 2. MCP Server(嵌入式)

### 选型
- **`github.com/mark3labs/mcp-go`**:成熟、纯 Go(no CGO,契合 modernc.org/sqlite)、原生 streamable-HTTP server,可挂到现有 `http.ServeMux`。
- 备选:官方 `github.com/modelcontextprotocol/go-sdk`(`mcp.NewStreamableHTTPHandler`)。实现前先验证与 Go 1.26 的兼容性。

### 新包 `internal/mcp/`
```
internal/mcp/
├── server.go     # 构建 MCPServer、注册所有工具、产出 http.Handler
├── auth.go       # 从请求头(Authorization/MM-Authorization)取 token,解析为身份
├── bridge.go     # 工具调用 → 内部 HTTP 调用(httptest.ResponseRecorder + mux.ServeHTTP),复用现有 handler+鉴权
├── tools_node.go      # 节点域工具
├── tools_sub.go       # 订阅与流量域工具
├── tools_server.go    # 服务器与服务域工具
└── tools_user.go      # 用户与套餐域工具
```

### 接线(cmd/server/main.go)
```go
mcpHandler := mcp.NewHandler(repo, mux, tokenStore, userRepo) // mux 用于内部转调
mux.Handle("/mcp", mcpHandler) // streamable-HTTP;鉴权在 bridge 内按 token 解析
```

### bridge 机制(关键)
每个工具:把工具入参 → 构造内部 `*http.Request`(目标 = 对应 REST 路由),透传调用方 token(置于 `MM-Authorization`),`mux.ServeHTTP(recorder, req)`,把响应转成 MCP 结果。
- 权限与 REST **完全一致**(同一 RequireToken/RequireAdmin 链)。
- 业务逻辑零复制;后续 REST 改动自动反映到 MCP。

### 工具规范
- 命名 `domain.action`(`node.list`、`node.create`、`node.speedtest`、`server.service_control`、`package.assign` …)。
- **只读优先**:list/get 无副作用。
- **写操作**:`annotations.destructiveHint=true`;高危项(卸载 xray、删用户、清空节点、reset-all-tokens)要求显式 `confirm:true`,否则返回「将执行 X,请确认」的预演而不执行。
- 错误:REST 的 4xx/5xx + body 透传为 MCP tool error。
- 分页:list 工具带 `limit/offset`,输出裁剪避免超长上下文。

---

## 3. 工具清单(核心,全量见附录映射)

**节点域**:`node.list` / `node.get` / `node.create` / `node.update` / `node.delete` / `node.batch_delete` / `node.speedtest`(异步,配 `node.speedtest_results`) / `node.tcping` / `node.tunnels_list` / `node.resolve_ip`。

**订阅与流量域**:`sub.files_list` / `sub.file_get` / `sub.short_link_get` / `sub.temp_create` / `traffic.summary` / `traffic.server_detail` / `traffic.user_detail` / `traffic.snapshots`。

**服务器与服务域**:`server.list` / `server.create` / `server.delete`* / `server.service_status` / `server.service_control` / `server.xray_install` / `server.nginx_install` / `server.agent_upgrade` / `server.inbounds_list` / `server.inbound_apply`。

**用户与套餐域**:`user.list` / `user.create` / `user.set_status` / `user.set_limits` / `user.delete`* / `package.list` / `package.create` / `package.assign` / `package.unassign`。
(* = 写操作,需 `confirm:true`)

### SSE 流式运维(已确认要做)
xray/nginx 安装、agent 升级走 `*-stream`(SSE)。MCP 层处理方式:**bridge 内部消费 SSE 到结束**,把进度日志尾部 + 最终状态作为工具结果一次性返回(给足超时,如 5–10min)。对调用方表现为一个「执行并等待完成」的同步工具,无需额外 job 模型。`server.service_status` 可作为补充查询工具。

### 不暴露的接口(高危黑名单,已确认)
以下**不注册为 MCP 工具**(避免 agent 误操作的爆炸半径过大):
- `reset-all-tokens` / `reset-server-token` / `reset-agent-token`(令牌重置,会断所有 agent)
- `nodes/clear`(清空所有节点)
- xray/nginx **卸载**(`xray/remove*`、`nginx/remove*`)、`agent/uninstall-stream`
- 管理员凭据修改(`/api/admin/credentials`)、`users/reset-password`
- 删除类(`user.delete` / `package` 删除 / `node.delete` / `server.delete`)**保留但强制 `confirm:true`**,不进黑名单(属正常管理,只是要确认)。

---

## 4. Claude Agent Skills(SKILL.md)

放 `../mmwX-plugins/skills/`(独立维护,配一键发布脚本,与现有 speedtest 插件同范式)。每技能一个目录 + `SKILL.md`(frontmatter `name/description` + 何时用 + 步骤[调哪些 MCP 工具/参数/确认点] + 注意[写操作需确认、PRO 功能 gating])。

建议技能:
- **mmwx-onboard-user**:开通新用户全流程(建用户 → 选/建套餐 → 绑定 → 生成订阅 → 输出订阅链接)。
- **mmwx-add-server**:接入新服务器(建远程服务器 → 装 xray/nginx → 同步节点)。
- **mmwx-traffic-report**:流量巡检(超额用户、Top 用量、按服务器汇总)。
- **mmwx-node-speedtest**:批量测速并出报告。
- **mmwx-troubleshoot**:节点离线 / 订阅异常排查。

---

## 5. OpenClaw 接入

`openclaw.json`:
```json
{
  "mcp": {
    "servers": {
      "miaomiaowux": {
        "url": "https://x.miaomiaowu.net/mcp",
        "transport": "streamable-http",
        "headers": { "Authorization": "Bearer <在个人设置生成的 API Token>" }
      }
    }
  }
}
```
Skills 放入 OpenClaw 的 skills 目录随会话加载。在 miaomiaowu-docs 增一页《接入 OpenClaw / MCP》指南。

---

## 6. 安全

- token 存 hash,明文仅显示一次;支持命名与单独吊销。
- 权限随登录态:普通用户 token 调 admin 工具被 `RequireAdmin` 拦截(403)。
- 高危工具二次确认(`confirm:true`)。
- 审计:MCP 工具调用可写入 agentlog(可选)。
- `/mcp` 的 CORS/Origin 与现有 `withCORS` 的关系需确认(streamable-HTTP 通常由 agent 服务端发起,不走浏览器 CORS)。

---

## 7. 里程碑与工作量(估)

| 阶段 | 内容 | 估时 |
|---|---|---|
| M1 | per-user API Token(后端 + 个人设置前端) | 1d |
| M2 | MCP server 骨架 + bridge + 只读工具(四域 list/get) | 1.5d |
| M3 | 写操作工具 + 确认机制 + 错误透传 | 1.5d |
| M4 | Claude Agent Skills(5 个 + 发布脚本) | 1d |
| M5 | OpenClaw 联调 + 文档 | 0.5d |

合计 ~5.5d。

---

## 决策已定稿

1. ✅ **不暴露高危接口**(令牌重置 / 清空节点 / 卸载 xray-nginx-agent / 改管理员凭据 / 重置密码),见上"黑名单"。删除类保留但强制 `confirm:true`。
2. ✅ **SSE 流式运维要做**:bridge 内部消费流到结束,返回最终状态(执行并等待完成型工具)。
3. ✅ MCP 库选 **mark3labs/mcp-go**(实现前先做最小兼容性 spike 验 Go 1.26)。
4. 不单独做「只读 token」,靠用户角色区分权限(普通用户 token 调 admin 工具自动 403)。

## 遗留风险
- mark3labs/mcp-go 与 Go 1.26 的兼容性(M2 开工先 spike)。
- SSE 同步工具的超时设置需实测(安装可能数分钟)。

## 附录:工具 ↔ REST 映射(节选)

| MCP 工具 | REST | admin |
|---|---|---|
| node.list | GET /api/admin/nodes | ✓ |
| node.create | POST /api/admin/nodes | ✓ |
| node.speedtest | POST /api/admin/speedtest/run | ✓ |
| node.tunnels_list | GET /api/admin/tunnels | ✓ |
| traffic.user_detail | GET /api/admin/traffic/users/{username} | ✓ |
| sub.temp_create | POST /api/admin/temp-subscription | ✓ |
| server.list | GET /api/admin/remote-servers | ✓ |
| server.service_control | POST /api/admin/remote/services/control | ✓ |
| user.create | POST /api/admin/users/create | ✓ |
| package.assign | POST /api/admin/packages/assign | ✓ |

(全量映射在实现 M2/M3 时按 Explore 调研的接口表逐条补全。)
