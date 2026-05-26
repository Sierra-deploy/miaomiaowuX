// edit-nodes-dialog 内部共享的类型 + 常量。
// 外部不需要 import 这里的东西,所以不做 `export *` 的桶导出。

export interface ProxyGroup {
  name: string
  type: string
  proxies: string[]
  use?: string[] // 代理集合引用
  url?: string
  interval?: number
  strategy?: 'round-robin' | 'consistent-hashing' | 'sticky-sessions'
}

export interface Node {
  node_name: string
  tag?: string
  [key: string]: any
}

// 拖拽类型定义
export type DragItemType =
  | 'available-node'
  | 'available-header'
  | 'group-node'
  | 'group-title'
  | 'group-card'
  | 'proxy-provider'
  | 'use-item'

export interface DragItemData {
  type: DragItemType
  nodeName?: string
  nodeNames?: string[]
  groupName?: string
  index?: number
  providerName?: string // 代理集合名称
}

export interface ActiveDragItem {
  id: string
  data: DragItemData
}

// 特殊节点列表
export const SPECIAL_NODES = ['♻️ 自动选择', '🚀 节点选择', 'DIRECT', 'REJECT']

// 预置的代理分流服务相关 emoji
// 注意:这个列表已废弃,改为从 proxy-groups.json 动态获取。仅保留基础通用 emoji 作为备选
export const PROXY_SERVICE_EMOJIS = [
  { emoji: '🚀', labelKey: 'editNodesDialog.emojiLabels.nodeSelect' as const },
  { emoji: '♻️', labelKey: 'editNodesDialog.emojiLabels.autoSelect' as const },
  { emoji: '🐟', labelKey: 'editNodesDialog.emojiLabels.missedFish' as const },
  { emoji: '🎯', labelKey: 'editNodesDialog.emojiLabels.direct' as const },
  { emoji: '🚫', labelKey: 'editNodesDialog.emojiLabels.reject' as const },
]
