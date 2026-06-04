package event

// EventType 事件类型
type EventType string

const (
	EventInboundAdded   EventType = "inbound.added"
	EventInboundRemoved EventType = "inbound.removed"
	EventInboundUpdated EventType = "inbound.updated"
)

// InboundEvent 入站事件数据
type InboundEvent struct {
	Type     EventType
	ServerID int64          // 服务器 ID
	Tag      string         // 入站 Tag
	Protocol string         // 协议类型
	Port     int            // 端口
	Inbound  map[string]any // 完整入站配置 (添加/更新时)
	NodeName string         // 自定义节点显示名称（可选）
	// ForwardNodeID > 0 表示这是「转发已有节点」创建的 tunnel：
	// 监听器会据此克隆源节点配置生成一个配套节点（server 改为 tunnel 服务器 IP/端口），而非跳过 tunnel
	ForwardNodeID int64
}

// Listener 事件监听器接口
type Listener interface {
	Handle(event InboundEvent)
}
