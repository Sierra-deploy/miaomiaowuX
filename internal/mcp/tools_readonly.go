package mcp

import (
	"context"

	mcpgo "github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// readTool 构造只读工具:统一打上 readOnly / 非 destructive 注解,便于 agent 判断安全性。
func readTool(name, desc string, extra ...mcpgo.ToolOption) mcpgo.Tool {
	opts := []mcpgo.ToolOption{
		mcpgo.WithDescription(desc),
		mcpgo.WithReadOnlyHintAnnotation(true),
		mcpgo.WithDestructiveHintAnnotation(false),
		mcpgo.WithOpenWorldHintAnnotation(false),
	}
	opts = append(opts, extra...)
	return mcpgo.NewTool(name, opts...)
}

// registerReadTools 注册只读工具(四域 list/get)。无副作用,可安全暴露给 agent。
func registerReadTools(s *server.MCPServer, b *bridge) {
	// —— 节点域 ——
	s.AddTool(readTool("node_list", "列出所有代理节点(协议、名称、服务器地址、入站标签等)。"),
		func(ctx context.Context, _ mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
			return b.get(ctx, "/api/admin/nodes")
		})

	s.AddTool(readTool("tunnel_list", "列出所有 tunnel(dokodemo 转发)入站,跨所有远程/分享服务器。"),
		func(ctx context.Context, _ mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
			return b.get(ctx, "/api/admin/tunnels")
		})

	// —— 订阅与流量域 ——
	s.AddTool(readTool("subscribe_file_list", "列出所有订阅文件(含短链、绑定模板等)。"),
		func(ctx context.Context, _ mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
			return b.get(ctx, "/api/admin/subscribe-files")
		})

	s.AddTool(readTool("traffic_summary", "获取流量汇总概览(跨服务器聚合的已用/限额等)。"),
		func(ctx context.Context, _ mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
			return b.get(ctx, "/api/traffic/summary/aggregated")
		})

	s.AddTool(readTool("traffic_user_detail", "查询指定用户的详细流量统计。",
		mcpgo.WithString("username", mcpgo.Required(), mcpgo.Description("用户名"))),
		func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
			u, err := req.RequireString("username")
			if err != nil {
				return mcpgo.NewToolResultError("username 必填"), nil
			}
			return b.get(ctx, "/api/admin/traffic/users/"+pathEscape(u))
		})

	// —— 服务器与服务域 ——
	s.AddTool(readTool("server_list", "列出所有远程服务器(状态、IP、xray 运行情况等)。"),
		func(ctx context.Context, _ mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
			return b.get(ctx, "/api/admin/remote-servers")
		})

	s.AddTool(readTool("server_service_status", "查询某远程服务器上服务(xray/nginx 等)的运行状态。",
		mcpgo.WithString("server_id", mcpgo.Required(), mcpgo.Description("服务器 ID"))),
		func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
			id, err := req.RequireString("server_id")
			if err != nil {
				return mcpgo.NewToolResultError("server_id 必填"), nil
			}
			return b.get(ctx, "/api/admin/remote/services/status?server_id="+pathEscape(id))
		})

	s.AddTool(readTool("server_inbound_list", "列出某远程服务器的 xray 入站。",
		mcpgo.WithString("server_id", mcpgo.Required(), mcpgo.Description("服务器 ID"))),
		func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
			id, err := req.RequireString("server_id")
			if err != nil {
				return mcpgo.NewToolResultError("server_id 必填"), nil
			}
			return b.get(ctx, "/api/admin/remote/inbounds?server_id="+pathEscape(id))
		})

	// —— 用户与套餐域 ——
	s.AddTool(readTool("user_list", "列出所有用户(状态、套餐、配额等)。"),
		func(ctx context.Context, _ mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
			return b.get(ctx, "/api/admin/users")
		})

	s.AddTool(readTool("user_detail", "查询指定用户的订阅/配额信息。",
		mcpgo.WithString("username", mcpgo.Required(), mcpgo.Description("用户名"))),
		func(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
			u, err := req.RequireString("username")
			if err != nil {
				return mcpgo.NewToolResultError("username 必填"), nil
			}
			return b.get(ctx, "/api/admin/users/"+pathEscape(u))
		})

	s.AddTool(readTool("package_list", "列出所有套餐(流量/周期/节点/限速/设备数)。"),
		func(ctx context.Context, _ mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
			return b.get(ctx, "/api/admin/packages")
		})
}
