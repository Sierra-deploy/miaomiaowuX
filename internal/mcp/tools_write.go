package mcp

import (
	"context"
	"net/http"

	mcpgo "github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// argsBody 取工具入参作为请求体,去掉控制字段(confirm)与指定的路径参数。
func argsBody(req mcpgo.CallToolRequest, omit ...string) map[string]any {
	src := req.GetArguments()
	out := make(map[string]any, len(src))
	for k, v := range src {
		skip := k == "confirm"
		for _, o := range omit {
			if k == o {
				skip = true
			}
		}
		if !skip {
			out[k] = v
		}
	}
	return out
}

// confirmGate 高危写操作的二次确认:未传 confirm=true 时返回提示、不执行。
func confirmGate(req mcpgo.CallToolRequest, action string) (*mcpgo.CallToolResult, bool) {
	if c, _ := req.GetArguments()["confirm"].(bool); c {
		return nil, true
	}
	return mcpgo.NewToolResultError("⚠️ 「" + action + "」是高危操作,确认后请在参数中加 confirm=true 再次调用以执行。"), false
}

// writeTool 构造写工具(标注非只读)。destructive=true 时标注 destructiveHint。
func writeTool(name, desc string, destructive bool, extra ...mcpgo.ToolOption) mcpgo.Tool {
	opts := []mcpgo.ToolOption{
		mcpgo.WithDescription(desc),
		mcpgo.WithReadOnlyHintAnnotation(false),
		mcpgo.WithDestructiveHintAnnotation(destructive),
	}
	opts = append(opts, extra...)
	return mcpgo.NewTool(name, opts...)
}

// registerWriteTools 注册写工具(含 confirm 机制与 SSE 运维)。高危接口(令牌重置/清空/卸载/改凭据)不在此暴露。
func registerWriteTools(s *server.MCPServer, b *bridge) {
	// —— 节点域 ——
	s.AddTool(writeTool("node_speedtest", "对指定节点发起测速(异步,结果稍后可经 speedtest 结果查询)。", false,
		mcpgo.WithString("node_id", mcpgo.Required(), mcpgo.Description("节点 ID")),
		mcpgo.WithNumber("tester_id", mcpgo.Description("家用测速端 ID;省略则用主控本机")),
	),
		func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
			return b.send(ctx, http.MethodPost, "/api/admin/speedtest/run", argsBody(req))
		})

	s.AddTool(writeTool("node_delete", "删除指定节点(会同步更新所有订阅)。", true,
		mcpgo.WithString("id", mcpgo.Required(), mcpgo.Description("节点 ID")),
		mcpgo.WithBoolean("confirm", mcpgo.Description("必须为 true 才执行")),
	),
		func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
			id, err := req.RequireString("id")
			if err != nil {
				return mcpgo.NewToolResultError("id 必填"), nil
			}
			if msg, ok := confirmGate(req, "删除节点 "+id); !ok {
				return msg, nil
			}
			return b.send(ctx, http.MethodDelete, "/api/admin/nodes/"+pathEscape(id), nil)
		})

	// —— 订阅域 ——
	s.AddTool(writeTool("temp_subscription_create", "为节点生成临时订阅链接(限时/限流)。", false,
		mcpgo.WithNumber("expire_hours", mcpgo.Description("有效小时数")),
		mcpgo.WithNumber("traffic_limit_gb", mcpgo.Description("流量上限 GB")),
	),
		func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
			return b.send(ctx, http.MethodPost, "/api/admin/temp-subscription", argsBody(req))
		})

	// —— 服务器与服务域 ——
	s.AddTool(writeTool("server_service_control", "控制远程服务器上的服务(启动/停止/重启 xray、nginx 等)。", true,
		mcpgo.WithString("server_id", mcpgo.Required(), mcpgo.Description("服务器 ID")),
		mcpgo.WithString("service", mcpgo.Required(), mcpgo.Description("服务名,如 xray / nginx")),
		mcpgo.WithString("action", mcpgo.Required(), mcpgo.Description("动作:start / stop / restart")),
	),
		func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
			return b.send(ctx, http.MethodPost, "/api/admin/remote/services/control", argsBody(req))
		})

	s.AddTool(writeTool("server_inbound_apply", "在远程服务器上新增/更新/删除一个 xray 入站。action=add/update/remove;add/update 传 inbound 对象,remove 传 tag。", true,
		mcpgo.WithString("server_id", mcpgo.Required(), mcpgo.Description("服务器 ID")),
		mcpgo.WithString("action", mcpgo.Required(), mcpgo.Description("add / update / remove")),
		mcpgo.WithObject("inbound", mcpgo.Description("入站对象(add/update 时必填)")),
		mcpgo.WithString("tag", mcpgo.Description("入站 tag(remove 时必填)")),
	),
		func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
			sid, err := req.RequireString("server_id")
			if err != nil {
				return mcpgo.NewToolResultError("server_id 必填"), nil
			}
			return b.send(ctx, http.MethodPost, "/api/admin/remote/inbounds?server_id="+pathEscape(sid), argsBody(req, "server_id"))
		})

	// SSE 运维:bridge 经 httptest 录制器消费整条流到结束,把进度日志一次性返回(执行并等待完成型)
	s.AddTool(writeTool("server_xray_install", "在远程服务器安装 Xray(耗时操作,会等待完成并返回安装日志)。", true,
		mcpgo.WithString("server_id", mcpgo.Required(), mcpgo.Description("服务器 ID")),
		mcpgo.WithBoolean("confirm", mcpgo.Description("必须为 true 才执行")),
	),
		func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
			if msg, ok := confirmGate(req, "安装 Xray"); !ok {
				return msg, nil
			}
			return b.send(ctx, http.MethodPost, "/api/admin/remote/xray/install-stream", argsBody(req))
		})

	s.AddTool(writeTool("server_nginx_install", "在远程服务器安装 Nginx(耗时操作,会等待完成并返回日志)。", true,
		mcpgo.WithString("server_id", mcpgo.Required(), mcpgo.Description("服务器 ID")),
		mcpgo.WithBoolean("confirm", mcpgo.Description("必须为 true 才执行")),
	),
		func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
			if msg, ok := confirmGate(req, "安装 Nginx"); !ok {
				return msg, nil
			}
			return b.send(ctx, http.MethodPost, "/api/admin/remote/nginx/install-stream", argsBody(req))
		})

	s.AddTool(writeTool("server_sync_nodes", "把远程服务器的入站同步为节点管理中的节点。", false,
		mcpgo.WithString("server_id", mcpgo.Required(), mcpgo.Description("服务器 ID")),
	),
		func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
			return b.send(ctx, http.MethodPost, "/api/admin/remote/sync-nodes", argsBody(req))
		})

	// —— 用户与套餐域 ——
	s.AddTool(writeTool("user_create", "创建新用户。", false,
		mcpgo.WithString("username", mcpgo.Required(), mcpgo.Description("用户名")),
		mcpgo.WithString("password", mcpgo.Required(), mcpgo.Description("密码")),
		mcpgo.WithString("email", mcpgo.Description("邮箱")),
		mcpgo.WithString("nickname", mcpgo.Description("昵称")),
	),
		func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
			return b.send(ctx, http.MethodPost, "/api/admin/users/create", argsBody(req))
		})

	s.AddTool(writeTool("user_set_status", "启用/禁用用户。", false,
		mcpgo.WithString("username", mcpgo.Required(), mcpgo.Description("用户名")),
		mcpgo.WithBoolean("is_active", mcpgo.Required(), mcpgo.Description("true 启用 / false 禁用")),
	),
		func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
			return b.send(ctx, http.MethodPost, "/api/admin/users/status", argsBody(req))
		})

	s.AddTool(writeTool("user_set_limits", "设置用户限速与设备数。", false,
		mcpgo.WithString("username", mcpgo.Required(), mcpgo.Description("用户名")),
		mcpgo.WithNumber("speed_limit_mbps", mcpgo.Description("限速 Mbps,0 不限")),
		mcpgo.WithNumber("device_limit", mcpgo.Description("设备数,0 不限")),
	),
		func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
			return b.send(ctx, http.MethodPost, "/api/admin/users/limits", argsBody(req))
		})

	s.AddTool(writeTool("user_delete", "删除用户(会解绑套餐、清理入站凭据)。", true,
		mcpgo.WithString("username", mcpgo.Required(), mcpgo.Description("用户名")),
		mcpgo.WithBoolean("confirm", mcpgo.Description("必须为 true 才执行")),
	),
		func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
			u, err := req.RequireString("username")
			if err != nil {
				return mcpgo.NewToolResultError("username 必填"), nil
			}
			if msg, ok := confirmGate(req, "删除用户 "+u); !ok {
				return msg, nil
			}
			return b.send(ctx, http.MethodPost, "/api/admin/users/delete", map[string]any{"username": u})
		})

	s.AddTool(writeTool("package_create", "创建套餐。nodes 为节点 ID 数组,traffic_mode 为 oneway/twoway。", false,
		mcpgo.WithString("name", mcpgo.Required(), mcpgo.Description("套餐名")),
		mcpgo.WithNumber("traffic_limit_gb", mcpgo.Required(), mcpgo.Description("流量上限 GB")),
		mcpgo.WithNumber("cycle_days", mcpgo.Required(), mcpgo.Description("周期天数")),
		mcpgo.WithArray("nodes", mcpgo.Description("节点 ID 数组")),
		mcpgo.WithString("traffic_mode", mcpgo.Description("oneway / twoway")),
		mcpgo.WithNumber("speed_limit_mbps", mcpgo.Description("限速 Mbps")),
		mcpgo.WithNumber("device_limit", mcpgo.Description("设备数")),
	),
		func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
			return b.send(ctx, http.MethodPost, "/api/admin/packages/create", argsBody(req))
		})

	s.AddTool(writeTool("package_assign", "把用户绑定到套餐。", false,
		mcpgo.WithString("username", mcpgo.Required(), mcpgo.Description("用户名")),
		mcpgo.WithNumber("package_id", mcpgo.Required(), mcpgo.Description("套餐 ID")),
		mcpgo.WithString("start_date", mcpgo.Description("开始日期 YYYY-MM-DD")),
		mcpgo.WithString("expire_date", mcpgo.Description("到期日期 YYYY-MM-DD")),
	),
		func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
			return b.send(ctx, http.MethodPost, "/api/admin/packages/assign", argsBody(req))
		})

	s.AddTool(writeTool("package_unassign", "解绑用户的套餐。", false,
		mcpgo.WithString("username", mcpgo.Required(), mcpgo.Description("用户名")),
	),
		func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
			return b.send(ctx, http.MethodPost, "/api/admin/packages/unassign", argsBody(req))
		})
}
