// @ts-nocheck
import React, { useState, useMemo, useCallback, useEffect, memo, useDeferredValue } from 'react'
import { createPortal } from 'react-dom'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { Topbar } from '@/components/layout/topbar'
import { useAuthStore } from '@/stores/auth-store'
import { profileQueryFn } from '@/lib/profile'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { parseProxyUrl, toClashProxy, type ProxyNode, type ClashProxy } from '@/lib/proxy-parser'
import { Check, Pencil, X, Undo2, Activity, Eye, Copy, ChevronDown, Link2, Flag, GripVertical, Zap, CheckCircle2, Loader2, Route as RouteIcon, Trash2, Cable } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import IpIcon from '@/assets/icons/ip.svg'
import ExchangeIcon from '@/assets/icons/exchange.svg'
import URI_Producer from '@/lib/substore/producers/uri'
import { countryCodeToFlag, hasRegionEmoji, getGeoIPInfo, stripFlagEmoji } from '@/lib/country-flag'
import { FlagEmojiPicker } from '@/components/flag-emoji-picker'
import { Twemoji } from '@/components/twemoji'
import { useMediaQuery } from '@/hooks/use-media-query'
import { InboundWizard } from '@/components/xray/inbound-wizard'
import { NodeRoutingDialog } from '@/components/node-routing-dialog'
import { TunnelManagerDialog } from '@/components/tunnel-manager-dialog'
import { RoutedOutboundsPanel } from '@/components/routed-outbounds-panel'
import { SpeedTestDialog } from '@/components/speedtest-dialog'
import { useLicenseFeature } from '@/hooks/use-license'
import { Gauge } from 'lucide-react'
import { clashConfigToOutbound } from '@/lib/xray-config-generator'
import {
  DndContext,
  closestCenter,
  DragEndEvent,
  DragStartEvent,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'

// @ts-ignore - retained simple route definition
export const Route = createFileRoute('/nodes/')({
  beforeLoad: () => {
    const token = useAuthStore.getState().auth.accessToken
    if (!token) {
      throw redirect({ to: '/' })
    }
  },
  component: NodesPage,
})

type ParsedNode = {
  id: number
  raw_url: string
  node_name: string
  protocol: string
  parsed_config: string
  clash_config: string
  enabled: boolean
  tag: string
  original_server: string
  original_domain: string
  inbound_tag: string
  chain_proxy_node_id: number | null
  node_type?: string
  parent_node_id?: number | null
  routed_outbound_tag?: string
  routed_owner?: 'shared' | 'user' | string
  created_by?: string
  created_at: string
  updated_at: string
}

type TempNode = {
  id: string
  rawUrl: string
  name: string
  parsed: ProxyNode | null
  clash: ClashProxy | null
  enabled: boolean
  originalServer?: string // 保存原始服务器地址，用于回退
  tag?: string
  isSaved?: boolean
  dbId?: number
  dbNode?: ParsedNode
}

const PROTOCOL_COLORS: Record<string, string> = {
  vmess: 'bg-blue-500/10 text-blue-700 dark:text-blue-400',
  vless: 'bg-purple-500/10 text-purple-700 dark:text-purple-400',
  trojan: 'bg-red-500/10 text-red-700 dark:text-red-400',
  ss: 'bg-green-500/10 text-green-700 dark:text-green-400',
  socks5: 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400',
  hysteria: 'bg-pink-500/10 text-pink-700 dark:text-pink-400',
  hysteria2: 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-400',
  tuic: 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-400',
  anytls: 'bg-teal-500/10 text-teal-700 dark:text-teal-400',
  wireguard: 'bg-orange-500/10 text-orange-700 dark:text-orange-400',
  snell: 'bg-lime-500/10 text-lime-700 dark:text-lime-400',
}

const PROTOCOLS = ['vmess', 'vless', 'trojan', 'ss', 'socks5', 'hysteria', 'hysteria2', 'tuic', 'anytls', 'wireguard', 'snell']

// 检查是否是IP地址（IPv4或IPv6）
function isIpAddress(hostname: string): boolean {
  if (!hostname) return false

  // 去除IPv6地址的方括号（如 [2a03:4000:6:d221::1]）
  const cleanHostname = hostname.replace(/^\[|\]$/g, '')

  // IPv4正则
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/
  // IPv6正则（简化版，匹配标准IPv6格式）
  const ipv6Regex = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/

  return ipv4Regex.test(cleanHostname) || ipv6Regex.test(cleanHostname)
}

// 重新排序代理配置对象，确保 name, type, server, port 在最前面
function reorderProxyConfig(config: ClashProxy): ClashProxy {
  if (!config || typeof config !== 'object') return config

  const ordered: any = {}
  const priorityKeys = ['name', 'type', 'server', 'port']

  // 先添加优先字段
  for (const key of priorityKeys) {
    if (key in config) {
      ordered[key] = config[key]
    }
  }

  // 再添加其他字段
  for (const [key, value] of Object.entries(config)) {
    if (!priorityKeys.includes(key)) {
      ordered[key] = value
    }
  }

  return ordered as ClashProxy
}

// 拖拽把手组件
function DragHandle({ id, size = 'default' }: { id: string; size?: 'default' | 'large' }) {
  const { attributes, listeners } = useSortable({ id })

  return (
    <div
      {...attributes}
      {...listeners}
      data-drag-handle
      className={cn(
        'cursor-grab active:cursor-grabbing touch-none rounded-md',
        size === 'large'
          ? 'p-2 hover:bg-accent/80'
          : 'p-1'
      )}
    >
      <GripVertical className={cn(
        'text-muted-foreground',
        size === 'large' ? 'h-5 w-5' : 'h-4 w-4'
      )} />
    </div>
  )
}

// 可拖拽排序的表格行组件
interface SortableTableRowProps {
  id: string
  isSaved: boolean
  isBatchDragging?: boolean
  isSelected?: boolean
  onClick?: (e: React.MouseEvent) => void
  children: React.ReactNode
}

const SortableTableRow = React.memo(function SortableTableRow({ id, isSaved, isBatchDragging, isSelected, onClick, children }: SortableTableRowProps) {
  const {
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id,
    disabled: !isSaved, // 只有已保存的节点可以拖拽
    animateLayoutChanges: () => false,
  })

  const batchDragging = Boolean(isBatchDragging && !isDragging)

  const style: React.CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    transition: isDragging ? undefined : transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <TableRow
      ref={setNodeRef}
      style={style}
      onClick={onClick}
      className={cn(
        'cursor-pointer group/row',
        isDragging
          ? 'opacity-0'
          : batchDragging
            ? 'opacity-30 bg-primary/10'
            : '',
        isSelected && !isDragging && !batchDragging && 'bg-primary/15 ring-2 ring-inset ring-primary/50 hover:bg-primary/20'
      )}
    >
      {children}
    </TableRow>
  )
})

// 可拖拽排序的移动端卡片组件
interface SortableCardProps {
  id: string
  isSaved: boolean
  isBatchDragging?: boolean
  isSelected?: boolean
  onClick?: (e: React.MouseEvent) => void
  children: React.ReactNode
}

const SortableCard = React.memo(function SortableCard({ id, isSaved, isBatchDragging, isSelected, onClick, children }: SortableCardProps) {
  const {
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id,
    disabled: !isSaved,
    animateLayoutChanges: () => false,
  })

  const batchDragging = Boolean(isBatchDragging && !isDragging)

  const style: React.CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    transition: isDragging ? undefined : transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <Card
      ref={setNodeRef}
      style={style}
      onClick={onClick}
      className={cn(
        'overflow-hidden cursor-pointer',
        isDragging
          ? 'opacity-0'
          : batchDragging
            ? 'opacity-30 bg-primary/10'
            : '',
        isSelected && !isDragging && !batchDragging && 'bg-accent'
      )}
    >
      {children}
    </Card>
  )
})

// DragOverlay 内容组件
function DragOverlayContent({ nodes, protocolColors }: { nodes: TempNode[]; protocolColors: Record<string, string> }) {
  const { t } = useTranslation('nodes')
  if (nodes.length === 0) return null

  if (nodes.length === 1) {
    // 单节点：显示简单的节点卡片
    const node = nodes[0]
    return (
      <div className='bg-background border rounded-md shadow-lg p-3 min-w-[200px] max-w-[300px]'>
        <div className='flex items-center gap-2'>
          <Badge variant='secondary' className={protocolColors[node.parsed?.type || ''] || ''}>
            {node.parsed?.type?.toUpperCase() || 'UNKNOWN'}
          </Badge>
          <span className='font-medium truncate'>{node.name}</span>
        </div>
      </div>
    )
  }

  // 多节点：显示堆叠效果 + 数量标记
  const firstNode = nodes[0]
  return (
    <div className='relative'>
      {/* 底部堆叠效果 */}
      {nodes.length > 2 && (
        <div className='absolute top-2 left-2 bg-muted border rounded-md shadow p-3 min-w-[200px] max-w-[300px] h-[48px] opacity-60' />
      )}
      <div className='absolute top-1 left-1 bg-muted border rounded-md shadow p-3 min-w-[200px] max-w-[300px] h-[48px] opacity-80' />

      {/* 主卡片 */}
      <div className='relative bg-background border rounded-md shadow-lg p-3 min-w-[200px] max-w-[300px]'>
        <div className='flex items-center gap-2'>
          <Badge variant='secondary' className={protocolColors[firstNode.parsed?.type || ''] || ''}>
            {firstNode.parsed?.type?.toUpperCase() || 'UNKNOWN'}
          </Badge>
          <span className='font-medium truncate'>{firstNode.name}</span>
        </div>

        {/* 数量标记 */}
        <Badge className='absolute -top-2 -right-2 bg-primary text-primary-foreground'>
          {t('label.nodeCount', { count: nodes.length })}
        </Badge>
      </div>
    </div>
  )
}

// 节点管理状态缓存key
const STORAGE_KEY_PROTOCOL = 'mmw_nodes_selectedProtocol'
const STORAGE_KEY_TAG = 'mmw_nodes_tagFilter'
const STORAGE_KEY_SELECTED_IDS = 'mmw_nodes_selectedIds'

// 从 localStorage 获取保存的筛选状态
function getStoredFilterState() {
  try {
    return {
      protocol: localStorage.getItem(STORAGE_KEY_PROTOCOL) || 'all',
      tag: localStorage.getItem(STORAGE_KEY_TAG) || 'all'
    }
  } catch {
    return { protocol: 'all', tag: 'all' }
  }
}

// 从 localStorage 获取保存的选中节点 ID
function getStoredSelectedIds(): Set<number> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_SELECTED_IDS)
    if (stored) {
      const ids = JSON.parse(stored) as number[]
      return new Set(ids)
    }
  } catch {}
  return new Set()
}

function NodesPage() {
  const { t } = useTranslation('nodes')
  const { auth } = useAuthStore()
  const queryClient = useQueryClient()

  const { data: profile } = useQuery({
    queryKey: ['profile'],
    queryFn: profileQueryFn,
    enabled: Boolean(auth.accessToken),
    staleTime: 5 * 60 * 1000,
  })
  const isAdmin = Boolean(profile?.is_admin)
  const { hasFeature: hasSpeedTest } = useLicenseFeature('speed_test')

  // 视口宽度判断 - 用于条件渲染 SortableContext，避免重复注册导致拖动偏移
  const isDesktop = useMediaQuery('(min-width: 1024px)')
  const isTablet = useMediaQuery('(min-width: 768px)')

  const [input, setInput] = useState('')
  const [subscriptionUrl, setSubscriptionUrl] = useState('')
  const [userAgent, setUserAgent] = useState<string>('clash.meta')
  const [customUserAgent, setCustomUserAgent] = useState<string>('')
  const [tempNodes, setTempNodes] = useState<TempNode[]>([])
  // 从 localStorage 恢复筛选状态
  const [selectedProtocol, setSelectedProtocol] = useState<string>(() => getStoredFilterState().protocol)
  const [currentTag, setCurrentTag] = useState<string>('manual') // 'manual' 或 'subscription'
  const [tagFilter, setTagFilter] = useState<string>(() => getStoredFilterState().tag)
  const [editingNode, setEditingNode] = useState<{ id: string; value: string } | null>(null)
  const [resolvingIpFor, setResolvingIpFor] = useState<string | null>(null) // 正在解析IP的节点ID
  const [ipMenuState, setIpMenuState] = useState<{ nodeId: string; ips: string[] } | null>(null) // IP选择菜单状态
  const [landingDialogOpen, setLandingDialogOpen] = useState(false)
  // 落地节点作用范围:'all'=节点级(默认,现有行为)| 'routed'=用户级(路由出站,套餐绑用户时自动开子账号)
  const [landingScope, setLandingScope] = useState<'all' | 'routed'>('all')
  // routed 模式下用户点选的目标节点(选后填 Label + 显示底部"创建"按钮,而不是立即提交)
  const [routedTargetNode, setRoutedTargetNode] = useState<ParsedNode | null>(null)
  const [landingRoutedLabel, setLandingRoutedLabel] = useState('')

  // 把节点名规整为合法 label slug([a-zA-Z0-9-] 长度 2-32):非合规字符全部转 -,首尾 - 去掉,过长截断
  const slugifyForLabel = (name: string) => {
    let s = name.replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
    if (s.length > 32) s = s.slice(0, 32)
    return s
  }
  const [sourceNodeForLanding, setSourceNodeForLanding] = useState<ParsedNode | null>(null)
  const [landingFilterText, setLandingFilterText] = useState<string>('')
  const [landingTagFilter, setLandingTagFilter] = useState<string>('all')
  // 落地节点 tunnel 二次确认:target 节点 server:port 命中某 tunnel 的 target 时,让用户选直连 or 走 tunnel
  const [landingTunnelChoice, setLandingTunnelChoice] = useState<null | {
    tunnelHost: string
    tunnelPort: number
    tunnelServerName: string
    tunnelTag: string
    directAddress: string
    directPort: number
  }>(null)
  const [landingTab, setLandingTab] = useState<'nodes' | 'servers'>('nodes')
  const [landingStep, setLandingStep] = useState<'select' | 'create-inbound'>('select')
  const [landingServerId, setLandingServerId] = useState<number | null>(null)
  const [landingLoading, setLandingLoading] = useState(false)

  const [chainProxyDialogOpen, setChainProxyDialogOpen] = useState(false)
  const [sourceNodeForChainProxy, setSourceNodeForChainProxy] = useState<ParsedNode | null>(null)
  const [chainProxyFilterText, setChainProxyFilterText] = useState<string>('')

  const [routingDialogOpen, setRoutingDialogOpen] = useState(false)
  const [routingSourceNode, setRoutingSourceNode] = useState<any>(null)
  const [tunnelDialogOpen, setTunnelDialogOpen] = useState(false)
  const [routedOutboundsDialogOpen, setRoutedOutboundsDialogOpen] = useState(false)
  const [speedDialogOpen, setSpeedDialogOpen] = useState(false) // 节点测速工作台是否打开
  const [speedDialogMin, setSpeedDialogMin] = useState(false)   // 是否收起为右侧悬浮按钮(点外部时,而非点 X)
  const [routingServerId, setRoutingServerId] = useState<number | null>(null)
  const [routingServerName, setRoutingServerName] = useState<string>('')

  // 自定义标签状态
  const [manualTag, setManualTag] = useState<string>(() => t('filter.manualInput'))
  const [subscriptionTag, setSubscriptionTag] = useState<string>('')

  // 导入节点时是否强制给 clash 配置加 skip-cert-verify:true。默认关,从 localStorage 恢复
  const [skipCertVerify, setSkipCertVerify] = useState<boolean>(() => {
    const cached = localStorage.getItem('mmwx-skip-cert-verify')
    return cached !== null ? cached === 'true' : false
  })

  // 导入节点卡片折叠状态 - 默认折叠
  const [isInputCardExpanded, setIsInputCardExpanded] = useState(false)

  // 批量操作状态 - 从 localStorage 恢复选中状态
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<number>>(() => getStoredSelectedIds())
  const [batchTagDialogOpen, setBatchTagDialogOpen] = useState(false)
  const [batchTag, setBatchTag] = useState<string>('')
  const [batchRenameDialogOpen, setBatchRenameDialogOpen] = useState(false)
  const [batchRenameText, setBatchRenameText] = useState<string>('')
  const [findText, setFindText] = useState<string>('')
  const [replaceText, setReplaceText] = useState<string>('')
  const [prefixText, setPrefixText] = useState<string>('')
  const [suffixText, setSuffixText] = useState<string>('')

  // Clash 配置编辑状态
  const [clashDialogOpen, setClashDialogOpen] = useState(false)
  const [editingClashConfig, setEditingClashConfig] = useState<{ nodeId: number; config: string } | null>(null)
  const [clashConfigError, setClashConfigError] = useState<string>('')
  const [jsonErrorLines, setJsonErrorLines] = useState<number[]>([])

  // URI 复制状态
  const [uriDialogOpen, setUriDialogOpen] = useState(false)
  const [uriContent, setUriContent] = useState<string>('')

  // 临时订阅状态
  const [tempSubDialogOpen, setTempSubDialogOpen] = useState(false)
  const [tempSubMaxAccess, setTempSubMaxAccess] = useState<number>(1)
  const [tempSubExpireSeconds, setTempSubExpireSeconds] = useState<number>(60)
  const [tempSubUrl, setTempSubUrl] = useState<string>('')
  const [tempSubGenerating, setTempSubGenerating] = useState(false)
  const [tempSubSingleNodeId, setTempSubSingleNodeId] = useState<number | null>(null) // 单个节点模式

  // 添加地区 emoji 状态
  const [addingRegionEmoji, setAddingRegionEmoji] = useState(false)
  const [addingEmojiForNode, setAddingEmojiForNode] = useState<number | null>(null)

  // 添加节点状态
  const [quickCreateServerDialogOpen, setQuickCreateServerDialogOpen] = useState(false)
  const [quickCreateServerId, setQuickCreateServerId] = useState<number | null>(null)
  const [quickCreateOpen, setQuickCreateOpen] = useState(false)
  const [quickCreateStep, setQuickCreateStep] = useState<'inbound' | 'done'>('inbound')
  const [quickCreateResult, setQuickCreateResult] = useState<{ serverCount: number; inboundTag: string; outboundTag: string } | null>(null)
  const [quickCreateLoading, setQuickCreateLoading] = useState(false)

  // 删除重复节点状态
  const [duplicateDialogOpen, setDuplicateDialogOpen] = useState(false)
  const [duplicateGroups, setDuplicateGroups] = useState<Array<{ config: string; nodes: ParsedNode[] }>>([])
  const [deletingDuplicates, setDeletingDuplicates] = useState(false)

  // TCPing 测试状态
  const [tcpingResults, setTcpingResults] = useState<Record<string, { success: boolean; latency: number; error?: string; loading?: boolean }>>({})
  const [tcpingNodeId, setTcpingNodeId] = useState<string | null>(null)
  const [batchTcpingLoading, setBatchTcpingLoading] = useState(false)

  // 优化的回调函数
  const handleUserAgentChange = useCallback((value: string) => {
    setUserAgent(value)
  }, [])

  const handleCustomUserAgentChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setCustomUserAgent(e.target.value)
  }, [])

  const handleSubscriptionUrlChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSubscriptionUrl(e.target.value)
  }, [])

  // 节点选择回调 - 使用函数式更新避免依赖 selectedNodeIds
  const handleNodeSelect = useCallback((nodeId: number) => {
    setSelectedNodeIds(prev => {
      const newSet = new Set(prev)
      if (newSet.has(nodeId)) {
        newSet.delete(nodeId)
      } else {
        newSet.add(nodeId)
      }
      return newSet
    })
  }, [])

  // 表格行点击处理 - 过滤掉按钮/复选框等的点击
  const handleRowClick = useCallback((e: React.MouseEvent, nodeId: number | undefined) => {
    const target = e.target as HTMLElement
    if (target.closest('button, input, [role="checkbox"], [data-drag-handle]')) {
      return
    }
    if (nodeId) {
      handleNodeSelect(nodeId)
    }
  }, [handleNodeSelect])

  // 节点排序状态
  // nodeOrder 从 localStorage 缓存初始化 —— 防止首次渲染时用空数组导致节点列表先以默认顺序闪一下再切换到用户排序
  const [nodeOrder, setNodeOrder] = useState<number[]>(() => {
    try {
      const cached = localStorage.getItem('nodes-node-order')
      if (cached) {
        const parsed = JSON.parse(cached)
        if (Array.isArray(parsed)) return parsed as number[]
      }
    } catch {}
    return []
  })
  // 批量拖动状态：当拖动选中的节点时，记录正在批量拖动的节点ID集合
  const [batchDraggingIds, setBatchDraggingIds] = useState<Set<number>>(new Set())
  // 当前正在拖动的节点ID（用于 DragOverlay）
  const [activeId, setActiveId] = useState<string | null>(null)
  // 获取用户配置
  const { data: userConfig } = useQuery({
    queryKey: ['user-config'],
    queryFn: async () => {
      const response = await api.get('/api/user/config')
      return response.data as {
        force_sync_external: boolean
        match_rule: string
        cache_expire_minutes: number
        sync_traffic: boolean
        node_order: number[]
      }
    },
    enabled: Boolean(auth.accessToken),
  })

  // 同步 nodeOrder 状态 + 写回 localStorage,下次进页面能立刻按这个顺序渲染
  useEffect(() => {
    if (userConfig?.node_order) {
      setNodeOrder(userConfig.node_order)
      try { localStorage.setItem('nodes-node-order', JSON.stringify(userConfig.node_order)) } catch {}
    }
  }, [userConfig?.node_order])

  // 保存筛选状态到 localStorage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_PROTOCOL, selectedProtocol)
    } catch {}
  }, [selectedProtocol])

  useEffect(() => {
    try {
      localStorage.setItem('mmwx-skip-cert-verify', String(skipCertVerify))
    } catch {}
  }, [skipCertVerify])

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_TAG, tagFilter)
    } catch {}
  }, [tagFilter])

  // 保存选中节点状态到 localStorage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_SELECTED_IDS, JSON.stringify(Array.from(selectedNodeIds)))
    } catch {}
  }, [selectedNodeIds])

  // dnd-kit sensors
  // 移动端需要更长的 delay 以允许正常滚动，只有长按才触发拖拽
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 500, tolerance: 8 },
    })
  )

  // 更新节点排序
  const updateNodeOrderMutation = useMutation({
    mutationFn: async (newOrder: number[]) => {
      await api.put('/api/user/config', {
        ...userConfig,
        node_order: newOrder
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-config'] })
    },
    onError: (error: any) => {
      toast.error(t('toast.saveOrderFailed', { error: error.response?.data?.error || error.message }))
    }
  })

  // 获取已保存的节点
  const { data: nodesData } = useQuery({
    queryKey: ['nodes'],
    queryFn: async () => {
      const response = await api.get('/api/admin/nodes')
      return response.data as { nodes: ParsedNode[] }
    },
    enabled: Boolean(auth.accessToken),
  })

  const savedNodes = useMemo(() => nodesData?.nodes ?? [], [nodesData?.nodes])

  // 按用户在节点管理里调整过的顺序排过的副本 — 传给测速等 dialog,让它们也跟列表顺序保持一致
  const savedNodesSorted = useMemo(() => {
    if (!nodeOrder?.length) return savedNodes
    const idx = new Map<number, number>()
    nodeOrder.forEach((id, i) => idx.set(id, i))
    return [...savedNodes].sort((a: any, b: any) => {
      const ai = idx.get(a.id) ?? Number.POSITIVE_INFINITY
      const bi = idx.get(b.id) ?? Number.POSITIVE_INFINITY
      return ai - bi
    })
  }, [savedNodes, nodeOrder])

  // 所有 tunnel 入站(跨远程/分享服务器),用于节点行「被 tunnel 转发」标识
  const { data: tunnelsData } = useQuery({
    queryKey: ['tunnels'],
    queryFn: async () => {
      const res = await api.get('/api/admin/tunnels')
      return (res.data.tunnels || []) as Array<{
        server_id: number
        server_name: string
        is_federated: boolean
        tag: string
        listen_port: number
        target_address: string
        target_port: number
        network: string
      }>
    },
    enabled: isAdmin && Boolean(auth.accessToken),
    staleTime: 30_000,
  })
  const tunnels = useMemo(() => tunnelsData || [], [tunnelsData])

  // 节点 server:port → 转发它的 tunnel 列表(用于行内标签 hover 显示)
  const tunnelsByTarget = useMemo(() => {
    const map = new Map<string, typeof tunnels>()
    for (const tn of tunnels) {
      const key = `${tn.target_address}:${tn.target_port}`
      const arr = map.get(key) || []
      arr.push(tn)
      map.set(key, arr)
    }
    return map
  }, [tunnels])

  // 节点行「被 tunnel 转发」标签:tunnel.target 和 node.server 可能是同一服务器不同别名(domain vs IP),
  // 按 port + node 所在服务器的别名集匹配(包含 clash server / ip_address / domain / pull_address)。
  // tooltip 里把 tunnel 的 target_address 也尝试反查回服务器名,跟 tunnel 管理面板显示一致。
  const renderForwardedBadge = (node: any) => {
    if (!node.parsed?.server || !node.parsed?.port) return null
    const nodeServer: any = (remoteServersData?.servers || []).find((s: any) => s.name === node.dbNode?.original_server)
    const nodeAliases = new Set<string>([node.parsed.server, nodeServer?.ip_address, nodeServer?.domain, nodeServer?.pull_address].filter(Boolean))
    const fwd = tunnels.filter((tn: any) => Number(tn.target_port) === Number(node.parsed.port) && nodeAliases.has(tn.target_address))
    if (!fwd || fwd.length === 0) return null
    const resolveServerByAddr = (addr: string): string | null => {
      for (const s of (remoteServersData?.servers || []) as any[]) {
        if (s.ip_address === addr || s.domain === addr || s.pull_address === addr) return s.name
      }
      return null
    }
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant='outline'
            className='h-5 w-5 p-0 flex items-center justify-center border-orange-300 text-orange-600 dark:text-orange-400'
            onClick={(e) => e.stopPropagation()}
            aria-label={t('nodeList.forwardedByTunnel')}
          >
            <Cable className='h-3 w-3' />
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          <div className='space-y-0.5 text-xs'>
            <div className='font-medium'>{t('nodeList.forwardedByTunnelTip')}</div>
            {fwd.map((tn: any) => {
              const targetServer = resolveServerByAddr(tn.target_address)
              const targetLabel = targetServer ? `${targetServer}:${tn.target_port}` : `${tn.target_address}:${tn.target_port}`
              return (
                <div key={`${tn.server_id}-${tn.tag}`} className='font-mono'>
                  {tn.server_name}:{tn.listen_port} → {targetLabel} · {tn.tag}
                </div>
              )
            })}
          </div>
        </TooltipContent>
      </Tooltip>
    )
  }

  // 取节点所属服务器名:优先 original_server,兼容老数据 tag=「远程:服务器名」
  const getNodeServerName = (dbNode: any): string => {
    if (!dbNode) return ''
    if (dbNode.original_server) return dbNode.original_server
    if (typeof dbNode.tag === 'string' && dbNode.tag.startsWith('远程:')) {
      return dbNode.tag.slice(3)
    }
    return ''
  }

  // 取要展示在 tag 徽章上的文本:若 tag 是「远程:xxx」形式,则不再显示(服务器名已挪到节点名下方)
  const getDisplayTag = (dbNode: any, fallbackTag?: string): string => {
    const raw = dbNode?.tag || fallbackTag || ''
    if (typeof raw === 'string' && raw.startsWith('远程:')) return ''
    return raw
  }

  // 远程服务器列表（admin 才能调,普通用户没有这个权限,跳过这个 query）
  const { data: remoteServersData } = useQuery({
    queryKey: ['remote-servers'],
    queryFn: async () => {
      const response = await api.get('/api/admin/remote-servers')
      return response.data as { success: boolean; servers: Array<{ id: number; name: string; status: string; ip_address?: string; pull_address?: string; domain?: string; xray_running?: boolean }> }
    },
    enabled: isAdmin && Boolean(auth.accessToken),
    staleTime: 30_000,
  })
  const remoteServers = useMemo(() => (remoteServersData?.servers || []).filter(s => s.status === 'connected'), [remoteServersData])

  // 路由出站节点的友好显示:列出所有需要解析的 routed 节点,按 original_server 分组拉一次 outbounds,
  // 然后建一份 (server_name, outbound_tag) → 友好名 的映射。优先 server 名 → 节点名 → tag 兜底。
  const routedDisplayServerIds = useMemo(() => {
    const names = new Set<string>()
    savedNodes.forEach((n: any) => {
      if (n.node_type === 'routed' && n.routed_outbound_tag && n.original_server) {
        names.add(n.original_server)
      }
    })
    return Array.from(names)
      .map(name => (remoteServersData?.servers || []).find(s => s.name === name))
      .filter(Boolean) as Array<{ id: number; name: string }>
  }, [savedNodes, remoteServersData])

  const routedOutboundsQ = useQuery({
    queryKey: ['routed-outbounds-resolve', routedDisplayServerIds.map(s => s.id)],
    enabled: isAdmin && Boolean(auth.accessToken) && routedDisplayServerIds.length > 0,
    queryFn: async () => {
      const map = new Map<string, any[]>() // serverName → outbounds[]
      await Promise.all(routedDisplayServerIds.map(async (s) => {
        try {
          const res = await api.get(`/api/admin/remote/outbounds?server_id=${s.id}`)
          map.set(s.name, res.data?.outbounds || [])
        } catch {}
      }))
      return map
    },
    staleTime: 60_000,
  })

  // (server_name, outbound_tag) → 显示名(优先 节点对应 server 名 → 节点名 → tag);
  // 路径里碰到的 tunnel 入站做一次"跳一跳"解析:如果命中某 server 的 tunnel listen_port,
  // 就接着按 tunnel.target_address:target_port 继续找,最多跳 3 次防环。
  const routedOutboundDisplay = useMemo(() => {
    const map: Record<string, string> = {}
    if (!routedOutboundsQ.data || savedNodes.length === 0) return map
    const nodeByAddr = new Map<string, { nodeName: string; serverName: string }>()
    for (const n of savedNodes as any[]) {
      try {
        const cfg = JSON.parse(n.clash_config)
        if (cfg?.server && cfg?.port != null) {
          const key = `${cfg.server}:${cfg.port}`
          if (!nodeByAddr.has(key)) nodeByAddr.set(key, { nodeName: n.node_name, serverName: n.original_server || '' })
        }
      } catch {}
    }
    const serverByAddr = new Map<string, { id: number; name: string }>()
    for (const s of (remoteServersData?.servers || []) as any[]) {
      for (const a of [s.ip_address, s.domain, s.pull_address]) {
        if (a) serverByAddr.set(a, { id: s.id, name: s.name })
      }
    }
    // server_id → tunnels[]
    const tunnelsByServerId = new Map<number, typeof tunnels>()
    for (const tn of tunnels) {
      const arr = tunnelsByServerId.get(tn.server_id) || []
      arr.push(tn)
      tunnelsByServerId.set(tn.server_id, arr)
    }

    // 解析单个 addr:port,跟 tunnel 一起最多 3 跳
    const resolve = (addr: string, port: any, depth = 0): string | null => {
      if (depth > 3 || !addr) return null
      const hit = nodeByAddr.get(`${addr}:${port}`)
      if (hit) return hit.serverName || hit.nodeName
      const srv = serverByAddr.get(addr)
      if (srv) {
        // 这台服务器是否有一个 tunnel 在监听这个 port?有就接着跳
        const list = tunnelsByServerId.get(srv.id) || []
        const tn = list.find((x) => Number(x.listen_port) === Number(port))
        if (tn) {
          const next = resolve(tn.target_address, tn.target_port, depth + 1)
          if (next) return next
        }
        return srv.name
      }
      // 兜底:用户常把同一台服务器配多个域名别名(hkbs.2ha.me / hkbs6.2ha.me 都指向 BAGE HKS),
      // 系统没记录这些 alias,直接按 addr 查不到 server。这时按 listen_port 在所有 tunnel 里找,
      // 如果端口在全局只命中 1 条 tunnel,基本可以断定它就是要找的那条;>1 条就放弃避免误判。
      const tunnelMatches = tunnels.filter((x) => Number(x.listen_port) === Number(port))
      if (tunnelMatches.length === 1) {
        const tn = tunnelMatches[0]
        const next = resolve(tn.target_address, tn.target_port, depth + 1)
        if (next) return next
        return tn.server_name
      }
      return null
    }

    for (const [serverName, outbounds] of routedOutboundsQ.data.entries()) {
      for (const ob of outbounds) {
        if (!ob.tag) continue
        let addr = '', port: any = ''
        const vnext = ob.settings?.vnext?.[0]
        const sv = ob.settings?.servers?.[0]
        if (vnext) { addr = vnext.address; port = vnext.port }
        else if (sv) { addr = sv.address; port = sv.port }
        else if (ob.settings?.address) { addr = ob.settings.address; port = ob.settings.port }
        const resolved = resolve(addr, port, 0)
        if (resolved) {
          map[`${serverName}::${ob.tag}`] = resolved
        }
      }
    }
    return map
  }, [routedOutboundsQ.data, savedNodes, remoteServersData, tunnels])

  const resolveRoutedDisplay = (n: any) => {
    if (!n?.routed_outbound_tag) return ''
    const tag = String(n.routed_outbound_tag).replace(/^routed:p\d+:/, '')
    if (!n.original_server) return tag
    return routedOutboundDisplay[`${n.original_server}::${tag}`] || tag
  }

  // 添加节点：提交入站 → 创建 freedom 出站（单服务器）
  const handleQuickCreateSubmit = async (serverIds: number[], inbound: any, tag: string, nodeName?: string, forwardNodeId?: number) => {
    if (serverIds.length === 0) {
      toast.error(t('toast.selectServer'))
      return
    }
    const notReadyServer = serverIds.find(id => {
      const s = (remoteServersData?.servers || []).find(srv => srv.id === id)
      return s && !s.xray_running
    })
    if (notReadyServer !== undefined) {
      toast.error(t('toast.xrayNotReady'))
      return
    }
    const trimmedTag = tag?.trim() || inbound.tag || ''
    if (!trimmedTag) {
      toast.error(t('toast.enterTag'))
      return
    }

    setQuickCreateLoading(true)
    try {
      let successCount = 0
      for (const serverId of serverIds) {
        // 1. 创建入站
        const inboundPayload: any = {
          action: 'add',
          inbound: { ...inbound, tag: trimmedTag },
        }
        if (nodeName) {
          inboundPayload.node_name = nodeName
        }
        // tunnel「转发已有节点」:携带源节点 ID,后端据此创建「<源节点名> | Tunnel」配套节点
        if (forwardNodeId) {
          inboundPayload.forward_node_id = forwardNodeId
        }
        const inboundRes = await api.post(`/api/admin/remote/inbounds?server_id=${serverId}`, inboundPayload)
        if (!inboundRes.data.success) {
          const serverName = remoteServers.find(s => s.id === serverId)?.name || serverId
          toast.error(t('toast.serverInboundFailed', { name: serverName, error: inboundRes.data.message || 'unknown' }))
          continue
        }

        successCount++
      }

      if (successCount === 0) {
        toast.error(t('toast.allServersFailed'))
        return
      }

      // 刷新节点列表（NodeSyncListener 已自动创建节点）+ 用户配置(后端把新节点 ID 写到 node_order 顶部,
      // 不一起刷新的话,前端 nodeOrder 还是旧数组,新节点 ID 拿不到序号会被排到末尾)
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['nodes'] })
        queryClient.invalidateQueries({ queryKey: ['user-config'] })
      }, 500)

      setQuickCreateResult({ serverCount: successCount, inboundTag: trimmedTag, outboundTag: '' })
      setQuickCreateStep('done')
      toast.success(successCount === serverIds.length
        ? t('toast.serversCreated', { count: successCount })
        : t('toast.serversPartialCreated', { success: successCount, total: serverIds.length }))
    } catch (error: any) {
      toast.error(error.response?.data?.error || t('toast.createFailed'))
    } finally {
      setQuickCreateLoading(false)
    }
  }

  // 节点数据加载后，清理已不存在的选中节点 ID
  useEffect(() => {
    if (!nodesData) return
    const validIds = new Set(savedNodes.map(n => n.id))
    setSelectedNodeIds(prev => {
      const filtered = new Set(Array.from(prev).filter(id => validIds.has(id)))
      // 只有当有变化时才更新，避免不必要的重渲染
      if (filtered.size !== prev.size) {
        return filtered
      }
      return prev
    })
  }, [nodesData, savedNodes])

  const updateConfigName = (config, name) => {
    if (!config) return config
    try {
      const parsed = JSON.parse(config)
      if (parsed && typeof parsed === 'object') {
        parsed.name = name
      }
      return JSON.stringify(parsed)
    } catch (error) {
      return config
    }
  }

  const cloneProxyWithName = (proxy, name) => {
    if (!proxy || typeof proxy !== 'object') {
      return proxy
    }
    return {
      ...proxy,
      name,
    }
  }

  const updateNodeNameMutation = useMutation({
    mutationFn: async ({ id, name }: { id: number; name: string }) => {
      const target = savedNodes.find(n => n.id === id)
      if (!target) {
        throw new Error(t('toast.nodeNotFound'))
      }
      const updatedParsedConfig = updateConfigName(target.parsed_config, name)
      const updatedClashConfig = updateConfigName(target.clash_config, name)
      const response = await api.put(`/api/admin/nodes/${id}`, {
        raw_url: target.raw_url,
        node_name: name,
        protocol: target.protocol,
        parsed_config: updatedParsedConfig,
        clash_config: updatedClashConfig,
        enabled: target.enabled,
        tag: target.tag,
      })
      return response.data
    },
    onSuccess: () => {
      toast.success(t('toast.nodeNameUpdated'))
      setEditingNode(null)
      queryClient.invalidateQueries({ queryKey: ['nodes'] })
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || t('toast.nodeNameUpdateFailed'))
    },
  })

  const isUpdatingNodeName = updateNodeNameMutation.isPending

  // DNS解析IP地址
  const resolveIpMutation = useMutation({
    mutationFn: async (hostname: string) => {
      const response = await api.get(`/api/dns/resolve?hostname=${encodeURIComponent(hostname)}`)
      return response.data as { ips: string[] }
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || t('toast.ipResolveFailed'))
      setResolvingIpFor(null)
    },
  })

  // 更新节点服务器地址
  const updateNodeServerMutation = useMutation({
    mutationFn: async (payload: { nodeId: number; server: string }) => {
      const response = await api.put(`/api/admin/nodes/${payload.nodeId}/server`, { server: payload.server })
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['nodes'] })
      toast.success(t('toast.serverAddressUpdated'))
      setResolvingIpFor(null)
      setIpMenuState(null)
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || t('toast.serverAddressUpdateFailed'))
      setResolvingIpFor(null)
    },
  })

  // 恢复节点原始域名
  const restoreNodeServerMutation = useMutation({
    mutationFn: async (nodeId: number) => {
      const response = await api.put(`/api/admin/nodes/${nodeId}/restore-server`)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['nodes'] })
      toast.success(t('toast.domainRestored'))
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || t('toast.domainRestoreFailed'))
    },
  })

  // 更新节点 Clash 配置
  const updateClashConfigMutation = useMutation({
    mutationFn: async (payload: { nodeId: number; clashConfig: string }) => {
      const response = await api.put(`/api/admin/nodes/${payload.nodeId}/config`, {
        clash_config: payload.clashConfig
      })
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['nodes'] })
      toast.success(t('toast.clashConfigUpdated'))
      setClashDialogOpen(false)
      // 状态清理会在 onOpenChange 中自动处理
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || t('toast.clashConfigUpdateFailed'))
    },
  })

  // 处理 Clash 配置编辑（支持已保存节点和临时节点）
  const handleEditClashConfig = useCallback((node: ParsedNode | TempNode) => {
    // 对于已保存节点，使用 clash_config 字段
    // 对于临时节点，使用 clash 对象
    const clashConfig = 'clash_config' in node
      ? node.clash_config
      : (node.clash ? JSON.stringify(node.clash) : null)

    if (!clashConfig) return

    // 格式化 JSON 以便编辑
    try {
      const parsed = JSON.parse(clashConfig)
      const formatted = JSON.stringify(parsed, null, 2)
      setEditingClashConfig({
        nodeId: 'id' in node && typeof node.id === 'number' ? node.id : -1, // 临时节点使用 -1
        config: formatted
      })
    } catch {
      // 如果解析失败，使用原始字符串
      setEditingClashConfig({
        nodeId: 'id' in node && typeof node.id === 'number' ? node.id : -1,
        config: clashConfig
      })
    }
    setClashConfigError('')
    setJsonErrorLines([])
    setClashDialogOpen(true)
  }, [])

  // 验证并保存 Clash 配置
  const handleSaveClashConfig = () => {
    if (!editingClashConfig) return

    try {
      // 验证 JSON 格式
      const parsedConfig = JSON.parse(editingClashConfig.config)

      // 检查必需字段
      if (!parsedConfig.name || !parsedConfig.type || !parsedConfig.server || !parsedConfig.port) {
        setClashConfigError(t('toast.configMissingFields'))
        return
      }

      // 保存配置（压缩格式，不带空格和换行）
      updateClashConfigMutation.mutate({
        nodeId: editingClashConfig.nodeId,
        clashConfig: JSON.stringify(parsedConfig)
      })
    } catch (error) {
      setClashConfigError(t('toast.jsonFormatError', { error: error instanceof Error ? error.message : String(error) }))
    }
  }

  // 处理配置文本变化，实时验证
  const handleClashConfigChange = (value: string) => {
    if (!editingClashConfig) return

    setEditingClashConfig({
      ...editingClashConfig,
      config: value
    })

    // 实时验证 JSON 格式
    try {
      JSON.parse(value)
      setClashConfigError('')
      setJsonErrorLines([])
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      setClashConfigError(t('toast.jsonFormatError', { error: errorMsg }))

      // 尝试提取错误行号
      // JSON.parse 错误信息格式通常是 "Unexpected token ... in JSON at position ..."
      // 我们需要根据position计算行号
      if (error instanceof SyntaxError && errorMsg.includes('position')) {
        const match = errorMsg.match(/position (\d+)/)
        if (match) {
          const position = parseInt(match[1], 10)
          const lines = value.substring(0, position).split('\n')
          const errorLine = lines.length

          // 只有当错误是 "Expected ',' or '}'" 时，才同时标记错误行和上一行
          // 因为这种错误通常是上一行缺少逗号导致的
          const isMissingCommaError = errorMsg.includes("Expected ',' or '}'")
          const errorLines = isMissingCommaError && errorLine > 1
            ? [errorLine - 1, errorLine]
            : [errorLine]
          setJsonErrorLines(errorLines)
        }
      } else {
        setJsonErrorLines([])
      }
    }
  }

  // 复制 URI 到剪贴板
  const handleCopyUri = useCallback(async (node: ParsedNode) => {
    if (!node.clash_config) return

    try {
      // 解析 Clash 配置
      const clashConfig = JSON.parse(node.clash_config)

      // 使用 URI producer 转换为 URI
      const producer = URI_Producer()
      const uri = producer.produce(clashConfig)

      // 尝试复制到剪贴板
      try {
        await navigator.clipboard.writeText(uri)
        toast.success(t('toast.uriCopied'))
      } catch (clipboardError) {
        // 复制失败，显示手动复制对话框
        setUriContent(uri)
        setUriDialogOpen(true)
      }
    } catch (error) {
      toast.error(t('toast.uriGenerateFailed', { error: error instanceof Error ? error.message : String(error) }))
    }
  }, [])

  // 处理IP解析
  const handleResolveIp = async (node: TempNode) => {
    if (!node.parsed?.server) return

    const nodeKey = node.isSaved ? String(node.dbId) : node.id
    setResolvingIpFor(nodeKey)

    try {
      const result = await resolveIpMutation.mutateAsync(node.parsed.server)

      if (result.ips.length === 0) {
        toast.error(t('toast.noIpResolved'))
        setResolvingIpFor(null)
        return
      }

      if (result.ips.length === 1) {
        // 只有一个IP，直接更新
        if (node.isSaved && node.dbId) {
          // 已保存的节点，调用API更新
          updateNodeServerMutation.mutate({
            nodeId: node.dbId,
            server: result.ips[0],
          })
        } else {
          // 未保存的节点，更新临时节点列表
          updateTempNodeServer(node.id, result.ips[0])
          setResolvingIpFor(null)
        }
      } else {
        // 多个IP，显示菜单让用户选择
        setIpMenuState({ nodeId: nodeKey, ips: result.ips })
        setResolvingIpFor(null)
      }
    } catch (error) {
      // Error already handled by mutation
    }
  }

  // 更新临时节点的服务器地址
  const updateTempNodeServer = (nodeId: string, server: string) => {
    setTempNodes(prev => prev.map(n => {
      if (n.id !== nodeId) return n

      // 如果还没有保存原始服务器地址，则保存当前的
      const originalServer = n.originalServer || n.parsed?.server

      // 更新 parsed 配置
      const updatedParsed = n.parsed ? { ...n.parsed, server } : n.parsed

      // 更新 clash 配置
      const updatedClash = n.clash ? { ...n.clash, server } : n.clash

      return {
        ...n,
        parsed: updatedParsed,
        clash: updatedClash,
        originalServer,
      }
    }))
    toast.success(t('toast.serverAddressUpdated'))
  }

  // 恢复临时节点的原始服务器地址
  const restoreTempNodeServer = (nodeId: string) => {
    setTempNodes(prev => prev.map(n => {
      if (n.id !== nodeId || !n.originalServer) return n

      // 恢复到原始服务器地址
      const updatedParsed = n.parsed ? { ...n.parsed, server: n.originalServer } : n.parsed
      const updatedClash = n.clash ? { ...n.clash, server: n.originalServer } : n.clash

      return {
        ...n,
        parsed: updatedParsed,
        clash: updatedClash,
        originalServer: undefined, // 清除原始服务器地址标记
      }
    }))
    toast.success(t('toast.serverRestoredAddress'))
  }

  // 批量创建节点
  const batchCreateMutation = useMutation({
    mutationFn: async (nodes: TempNode[]) => {
      // 根据当前标签类型使用对应的自定义标签
      const tag = currentTag === 'manual'
        ? (manualTag.trim() || t('filter.manualInput'))
        : (subscriptionTag.trim() || t('filter.subscriptionImport'))

      const payload = nodes.map(n => ({
        raw_url: n.rawUrl,
        node_name: n.name || t('nodeList.unknown'),
        protocol: n.parsed?.type || 'unknown',
        parsed_config: n.parsed ? JSON.stringify(cloneProxyWithName(n.parsed, n.name)) : '',
        clash_config: n.clash ? JSON.stringify(cloneProxyWithName(n.clash, n.name)) : '',
        enabled: n.enabled,
        tag: tag,
      }))

      const response = await api.post('/api/admin/nodes/batch', { nodes: payload })
      return response.data
    },
    onSuccess: (data) => {
      // 获取新创建的节点列表
      const newNodes = data.nodes || []
      const newNodeIds = newNodes.map((n: any) => n.id)

      // 将新节点 ID 添加到 nodeOrder 开头，保持节点在列表前面的位置
      if (newNodeIds.length > 0) {
        const newOrder = [...newNodeIds, ...nodeOrder]
        setNodeOrder(newOrder)
        updateNodeOrderMutation.mutate(newOrder)
      }

      // 使用 setQueryData 直接更新缓存，避免闪烁
      queryClient.setQueryData(['nodes'], (oldData: { nodes: ParsedNode[] } | undefined) => {
        if (!oldData) return { nodes: newNodes }
        return { nodes: [...newNodes, ...oldData.nodes] }
      })

      toast.success(t('toast.nodesSaved'))
      setInput('')
      setTempNodes([])
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || t('toast.saveFailed'))
    },
  })

  // 切换节点启用状态
  const toggleMutation = useMutation({
    mutationFn: async ({ id, enabled }: { id: number; enabled: boolean }) => {
      const node = savedNodes.find(n => n.id === id)
      if (!node) return

      const response = await api.put(`/api/admin/nodes/${id}`, {
        raw_url: node.raw_url,
        node_name: node.node_name,
        protocol: node.protocol,
        parsed_config: node.parsed_config,
        clash_config: node.clash_config,
        enabled,
      })
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['nodes'] })
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || t('toast.updateFailed'))
    },
  })

  // 删除节点
  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await api.delete(`/api/admin/nodes/${id}`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['nodes'] })
      toast.success(t('toast.nodeDeleted'))
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || t('toast.deleteFailed'))
    },
  })

  const isDeletingNode = deleteMutation.isPending

  // 清空所有节点
  const clearAllMutation = useMutation({
    mutationFn: async () => {
      await api.post('/api/admin/nodes/clear')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['nodes'] })
      toast.success(t('toast.allNodesCleared'))
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || t('toast.clearFailed'))
    },
  })

  // 批量更新节点标签
  const batchUpdateTagMutation = useMutation({
    mutationFn: async ({ nodeIds, tag }: { nodeIds: number[]; tag: string }) => {
      const promises = nodeIds.map((id) => {
        const node = savedNodes.find(n => n.id === id)
        if (!node) return Promise.resolve()

        return api.put(`/api/admin/nodes/${id}`, {
          raw_url: node.raw_url,
          node_name: node.node_name,
          protocol: node.protocol,
          parsed_config: node.parsed_config,
          clash_config: node.clash_config,
          enabled: node.enabled,
          tag: tag,
        })
      })
      await Promise.all(promises)
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['nodes'] })
      toast.success(t('toast.batchTagUpdated', { count: variables.nodeIds.length }))
      setBatchTagDialogOpen(false)
      setSelectedNodeIds(new Set())
      setBatchTag('')
      setTagFilter('all') // 切换到全部标签
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || t('toast.batchTagFailed'))
    },
  })

  // 批量修改节点名称
  const batchRenameMutation = useMutation({
    mutationFn: async (updates: Array<{ node_id: number; new_name: string }>) => {
      const response = await api.post('/api/admin/nodes/batch-rename', { updates })
      return response.data
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['nodes'] })
      toast.success(t('toast.batchRenameSuccess', { count: data.success }))
      setBatchRenameDialogOpen(false)
      setSelectedNodeIds(new Set())
      setBatchRenameText('')
      setFindText('')
      setReplaceText('')
      setPrefixText('')
      setSuffixText('')
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || t('toast.batchRenameFailed'))
    },
  })

  // 批量添加地区 emoji
  const handleAddRegionEmoji = useCallback(async () => {
    const nodeIds = Array.from(selectedNodeIds)
    if (nodeIds.length === 0) {
      toast.error(t('toast.selectNodeFirst'))
      return
    }

    setAddingRegionEmoji(true)
    let successCount = 0
    let skipCount = 0
    let failCount = 0

    try {
      for (const nodeId of nodeIds) {
        const node = savedNodes.find(n => n.id === nodeId)
        if (!node) continue

        // 检查节点名称是否已有 emoji 前缀
        if (hasRegionEmoji(node.node_name)) {
          skipCount++
          continue
        }

        try {
          // 获取 server 地址
          let parsedConfig
          try {
            parsedConfig = JSON.parse(node.parsed_config)
          } catch {
            failCount++
            continue
          }

          const server = parsedConfig?.server
          if (!server) {
            failCount++
            continue
          }

          let ip = server

          // 如果是域名，先解析为 IP（优先 IPv4）
          if (!isIpAddress(server)) {
            try {
              const dnsResult = await api.get(`/api/dns/resolve?hostname=${encodeURIComponent(server)}`)
              const ips = dnsResult.data?.ips || []
              if (ips.length === 0) {
                failCount++
                continue
              }
              // 优先使用 IPv4（DNS 接口已经排序好）
              ip = ips[0]
            } catch {
              failCount++
              continue
            }
          }

          // 获取 IP 地理位置
          const geoInfo = await getGeoIPInfo(ip)
          if (!geoInfo.country_code) {
            failCount++
            continue
          }

          // 转换为旗帜 emoji
          const flag = countryCodeToFlag(geoInfo.country_code)
          if (!flag) {
            failCount++
            continue
          }

          // 更新节点名称
          const newName = `${flag} ${node.node_name}`
          const updatedParsedConfig = updateConfigName(node.parsed_config, newName)
          const updatedClashConfig = updateConfigName(node.clash_config, newName)

          await api.put(`/api/admin/nodes/${nodeId}`, {
            raw_url: node.raw_url,
            node_name: newName,
            protocol: node.protocol,
            parsed_config: updatedParsedConfig,
            clash_config: updatedClashConfig,
            enabled: node.enabled,
            tag: node.tag,
          })

          successCount++
        } catch (error) {
          console.error(`Failed to add emoji for node ${nodeId}:`, error)
          failCount++
        }
      }

      // 刷新节点列表
      queryClient.invalidateQueries({ queryKey: ['nodes'] })

      // 显示结果
      if (successCount > 0 && failCount === 0 && skipCount === 0) {
        toast.success(t('toast.addRegionEmojiSuccess', { count: successCount }))
      } else {
        toast.info(t('toast.addRegionEmojiResult', { success: successCount, skip: skipCount, fail: failCount }))
      }
    } finally {
      setAddingRegionEmoji(false)
    }
  }, [selectedNodeIds, savedNodes, queryClient])

  // 为单个节点添加地区 emoji
  const handleAddSingleNodeEmoji = useCallback(async (nodeId: number) => {
    const node = savedNodes.find(n => n.id === nodeId)
    if (!node) return

    // 检查节点名称是否已有 emoji 前缀
    if (hasRegionEmoji(node.node_name)) {
      toast.info(t('toast.alreadyHasEmoji'))
      return
    }

    setAddingEmojiForNode(nodeId)

    try {
      // 获取 server 地址
      let parsedConfig
      try {
        parsedConfig = JSON.parse(node.parsed_config)
      } catch {
        toast.error(t('toast.cannotParseConfig'))
        return
      }

      const server = parsedConfig?.server
      if (!server) {
        toast.error(t('toast.noServerAddress'))
        return
      }

      let ip = server

      // 如果是域名，先解析为 IP（优先 IPv4）
      if (!isIpAddress(server)) {
        try {
          const dnsResult = await api.get(`/api/dns/resolve?hostname=${encodeURIComponent(server)}`)
          const ips = dnsResult.data?.ips || []
          if (ips.length === 0) {
            toast.error(t('toast.dnsResolveFailed'))
            return
          }
          ip = ips[0]
        } catch {
          toast.error(t('toast.dnsResolveFailed'))
          return
        }
      }

      // 获取 IP 地理位置
      const geoInfo = await getGeoIPInfo(ip)
      if (!geoInfo.country_code) {
        toast.error(t('toast.geoLocationFailed'))
        return
      }

      // 转换为旗帜 emoji
      const flag = countryCodeToFlag(geoInfo.country_code)
      if (!flag) {
        toast.error(t('toast.flagEmojiFailed'))
        return
      }

      // 更新节点名称
      const newName = `${flag} ${node.node_name}`
      const updatedParsedConfig = updateConfigName(node.parsed_config, newName)
      const updatedClashConfig = updateConfigName(node.clash_config, newName)

      await api.put(`/api/admin/nodes/${nodeId}`, {
        raw_url: node.raw_url,
        node_name: newName,
        protocol: node.protocol,
        parsed_config: updatedParsedConfig,
        clash_config: updatedClashConfig,
        enabled: node.enabled,
        tag: node.tag,
      })

      queryClient.invalidateQueries({ queryKey: ['nodes'] })
      toast.success(t('toast.emojiAdded'))
    } catch (error) {
      console.error('Failed to add emoji:', error)
      toast.error(t('toast.addEmojiFailed'))
    } finally {
      setAddingEmojiForNode(null)
    }
  }, [savedNodes, queryClient])

  // 查找重复节点
  const findDuplicateNodes = useCallback(() => {
    if (savedNodes.length === 0) {
      toast.info(t('toast.noNodes'))
      return
    }

    // 按 clash_config + node_name 分组（只有连接配置和名称都相同才算重复）
    const configGroups = new Map<string, ParsedNode[]>()

    for (const node of savedNodes) {
      try {
        // 解析配置并按 key 排序，同时加上 node_name 作为唯一标识的一部分
        const config = JSON.parse(node.clash_config)
        // 使用数据库中的 node_name（用户可能修改过）而不是配置中的 name
        const configKey = JSON.stringify({
          ...config,
          __node_name__: node.node_name // 使用特殊 key 避免与配置字段冲突
        }, Object.keys({ ...config, __node_name__: node.node_name }).sort())

        if (!configGroups.has(configKey)) {
          configGroups.set(configKey, [])
        }
        configGroups.get(configKey)!.push(node)
      } catch {
        // 无法解析的配置，使用原始字符串 + node_name
        const configKey = node.clash_config + '|' + node.node_name
        if (!configGroups.has(configKey)) {
          configGroups.set(configKey, [])
        }
        configGroups.get(configKey)!.push(node)
      }
    }

    // 过滤出有重复的组
    const duplicates: Array<{ config: string; nodes: ParsedNode[] }> = []
    for (const [config, nodes] of configGroups) {
      if (nodes.length > 1) {
        duplicates.push({ config, nodes })
      }
    }

    if (duplicates.length === 0) {
      toast.success(t('toast.noDuplicates'))
      return
    }

    setDuplicateGroups(duplicates)
    setDuplicateDialogOpen(true)
  }, [savedNodes])

  // 删除重复节点（保留每组的第一个）
  const handleDeleteDuplicates = useCallback(async () => {
    if (duplicateGroups.length === 0) return

    // 收集所有要删除的节点 ID（每组保留第一个，删除其余）
    const nodeIdsToDelete: number[] = []
    for (const group of duplicateGroups) {
      // 按创建时间排序，保留最早创建的
      const sortedNodes = [...group.nodes].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      )
      // 跳过第一个，删除其余
      for (let i = 1; i < sortedNodes.length; i++) {
        nodeIdsToDelete.push(sortedNodes[i].id)
      }
    }

    if (nodeIdsToDelete.length === 0) {
      toast.info(t('toast.nothingToDelete'))
      return
    }

    setDeletingDuplicates(true)
    try {
      await api.post('/api/admin/nodes/batch-delete', { node_ids: nodeIdsToDelete })
      queryClient.invalidateQueries({ queryKey: ['nodes'] })
      toast.success(t('toast.duplicatesDeleted', { count: nodeIdsToDelete.length }))
      setDuplicateDialogOpen(false)
      setDuplicateGroups([])
    } catch (error: any) {
      toast.error(error.response?.data?.error || t('toast.deleteFailed'))
    } finally {
      setDeletingDuplicates(false)
    }
  }, [duplicateGroups, queryClient])

  // 处理单个节点 TCPing 测试
  const handleTcping = useCallback(async (node: TempNode) => {
    if (!node.parsed?.server || !node.parsed?.port) return

    const nodeKey = node.isSaved ? String(node.dbId) : node.id
    setTcpingNodeId(nodeKey)
    setTcpingResults(prev => ({
      ...prev,
      [nodeKey]: { success: false, latency: 0, loading: true }
    }))

    try {
      const result = await api.post('/api/admin/tcping', {
        host: node.parsed.server,
        port: node.parsed.port,
        timeout: 5000
      })

      setTcpingResults(prev => ({
        ...prev,
        [nodeKey]: {
          success: result.data.success,
          latency: result.data.latency,
          error: result.data.error,
          loading: false
        }
      }))
    } catch (error) {
      setTcpingResults(prev => ({
        ...prev,
        [nodeKey]: {
          success: false,
          latency: 0,
          error: error instanceof Error ? error.message : t('toast.testFailed'),
          loading: false
        }
      }))
    } finally {
      setTcpingNodeId(null)
    }
  }, [])

  // 生成临时订阅 (支持单个节点或批量模式)
  const generateTempSubscription = useCallback(async (singleNodeId?: number) => {
    const nodeIds = singleNodeId !== undefined ? [singleNodeId] : Array.from(selectedNodeIds)
    if (nodeIds.length === 0) {
      toast.error(t('toast.selectNodeFirst'))
      return
    }

    setTempSubGenerating(true)
    try {
      // 获取节点的 clash 配置
      const nodesData = savedNodes.filter(n => nodeIds.includes(n.id))
      const proxies = nodesData.map(node => {
        try {
          return JSON.parse(node.clash_config)
        } catch {
          return null
        }
      }).filter(Boolean)

      if (proxies.length === 0) {
        toast.error(t('toast.noNodesToParse'))
        return
      }

      const response = await api.post('/api/admin/temp-subscription', {
        proxies,
        max_access: tempSubMaxAccess,
        expire_seconds: tempSubExpireSeconds,
      })

      const fullUrl = `${window.location.origin}${response.data.url}`
      setTempSubUrl(fullUrl)
    } catch (error: any) {
      toast.error(error.response?.data?.error || t('toast.tempSubGenerateFailed'))
    } finally {
      setTempSubGenerating(false)
    }
  }, [selectedNodeIds, savedNodes, tempSubMaxAccess, tempSubExpireSeconds])

  // 自动生成临时订阅：Dialog 打开时或参数变化时自动生成
  useEffect(() => {
    if (tempSubDialogOpen) {
      // 使用 setTimeout 来 debounce，避免频繁请求
      const timer = setTimeout(() => {
        generateTempSubscription(tempSubSingleNodeId ?? undefined)
      }, 300)
      return () => clearTimeout(timer)
    }
  }, [tempSubDialogOpen, tempSubMaxAccess, tempSubExpireSeconds, tempSubSingleNodeId])

  // 新增落地节点：在源服务器配置出站+路由，将入站流量转发到落地节点
  // overrideTarget(可选)用于"通过 tunnel"场景:在生成 outbound 之前把 clash 配置里的 server/port 换成 tunnel 服务器地址 + listen 端口
  const addLandingNodeMutation = useMutation({
    mutationFn: async ({ sourceNode, targetNode, overrideTarget }: { sourceNode: ParsedNode; targetNode: ParsedNode; overrideTarget?: { address: string; port: number } }) => {
      // 从 original_server 或 tag（格式 "远程:服务器名"）提取服务器名
      let serverName = sourceNode.original_server
      if (!serverName && sourceNode.tag?.startsWith('远程:')) {
        serverName = sourceNode.tag.slice(3)
      }
      const sourceServer = remoteServers.find(s => s.name === serverName)
      if (!sourceServer) throw new Error(t('toast.sourceNodeNoServer'))
      if (!sourceNode.inbound_tag) throw new Error(t('toast.sourceNodeNoInboundTag'))

      let targetClashConfig: any
      try { targetClashConfig = JSON.parse(targetNode.clash_config) } catch { throw new Error(t('toast.landingTargetParseError')) }
      // 落地出站默认用目标节点所在服务器的域名(域名比 IP 稳定;老节点 clash_config.server 可能存的还是 IP)
      if (!overrideTarget && targetNode.original_server) {
        const tnSrv: any = (remoteServersData?.servers || []).find((s: any) => s.name === targetNode.original_server)
        const domain = (tnSrv?.domain || '').trim()
        if (domain && domain !== targetClashConfig.server) {
          targetClashConfig = { ...targetClashConfig, server: domain }
        }
      }
      // 用户在 tunnel 二次确认里选了走 tunnel → 把 outbound 目标地址 + 端口换成 tunnel 服务器对外地址 + tunnel 监听端口
      if (overrideTarget) {
        targetClashConfig = { ...targetClashConfig, server: overrideTarget.address, port: overrideTarget.port }
      }

      // 检查是否已存在相同目标的出站
      const existingOutbounds = await api.get(`/api/admin/remote/outbounds?server_id=${sourceServer.id}`)
      const targetAddr = `${targetClashConfig.server}:${targetClashConfig.port}`
      if (existingOutbounds.data?.outbounds?.some((ob: any) => {
        const vnext = ob.settings?.vnext?.[0]
        const srv = ob.settings?.servers?.[0]
        const addr = vnext ? `${vnext.address}:${vnext.port}` : srv ? `${srv.address}:${srv.port}` : ''
        return addr === targetAddr
      })) {
        throw new Error(t('toast.landingTargetDuplicate', { name: targetNode.node_name }))
      }

      // 清理同一 source inbound 已有的"整个节点"落地配置:此 scope 的 outbound tag 由 addLandingNodeMutation 生成,
      // 格式 `landing-<inboundTag>-<ts>`。若不清理,旧 rule 在新 rule 之前先命中,新落地形同虚设。
      // (路由出站 scope 不走这里 — 它是新增一个 routed 节点,不会影响整个 inbound 的流量)
      const landingPrefix = `landing-${sourceNode.inbound_tag}-`
      const existingRouting = await api.get(`/api/admin/remote/routing?server_id=${sourceServer.id}`)
      const existingRules = existingRouting.data?.routing?.rules || []
      const staleOutboundTags = new Set<string>()
      for (let i = existingRules.length - 1; i >= 0; i--) {
        const ru = existingRules[i] || {}
        const tag = String(ru.outboundTag || '')
        if (tag.startsWith(landingPrefix) && Array.isArray(ru.inboundTag) && ru.inboundTag.includes(sourceNode.inbound_tag)) {
          await api.post(`/api/admin/remote/routing?server_id=${sourceServer.id}`, { action: 'remove_rule', index: i })
          staleOutboundTags.add(tag)
        }
      }
      // 也兜底扫一遍 outbounds:有 landing-<inboundTag>-* 但 rule 已经先删过的(脏数据),一起清掉
      for (const ob of existingOutbounds.data?.outbounds || []) {
        const tag = String(ob.tag || '')
        if (tag.startsWith(landingPrefix)) staleOutboundTags.add(tag)
      }
      for (const tag of staleOutboundTags) {
        try {
          await api.post(`/api/admin/remote/outbounds?server_id=${sourceServer.id}`, { action: 'remove', tag })
        } catch {}
      }

      const outboundTag = `landing-${sourceNode.inbound_tag}-${Date.now()}`
      const outbound = clashConfigToOutbound(targetClashConfig, outboundTag)

      // 1. 在源服务器添加出站
      const outRes = await api.post(`/api/admin/remote/outbounds?server_id=${sourceServer.id}`, {
        action: 'add',
        outbound,
      })
      if (!outRes.data.success) throw new Error(outRes.data.message || t('toast.addOutboundFailed'))

      // 2. 在源服务器添加路由规则：入站 → 新出站
      const routeRes = await api.post(`/api/admin/remote/routing?server_id=${sourceServer.id}`, {
        action: 'add_rule',
        rule: { type: 'field', inboundTag: [sourceNode.inbound_tag], outboundTag },
      })
      if (!routeRes.data.success) throw new Error(routeRes.data.message || t('toast.addRoutingRuleFailed'))

      return { outboundTag }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['nodes'] })
      toast.success(t('toast.landingConfigSuccess'))
      setLandingDialogOpen(false)
      setSourceNodeForLanding(null)
    },
    onError: (error: any) => {
      toast.error(error.message || error.response?.data?.error || t('toast.landingConfigFailed'))
    },
  })

  // 用户私有路由出站:普通用户为自己创建专属出站(不经套餐分配,创建即生效)
  // 后端 /api/user/routed-outbound POST,跳过 admin 占位,rule.user 直接是创建者 email
  const addUserRoutedLandingMutation = useMutation({
    mutationFn: async ({ sourceNode, targetNode, label }: { sourceNode: ParsedNode; targetNode: ParsedNode; label: string }) => {
      const trimmed = label.trim()
      if (!trimmed) throw new Error('请填写 Label')
      if (!/^[a-zA-Z0-9-]{2,32}$/.test(trimmed)) throw new Error('Label 只允许 [a-zA-Z0-9-] 长度 2-32')
      let targetClashConfig: any
      try { targetClashConfig = JSON.parse(targetNode.clash_config) } catch { throw new Error(t('toast.landingTargetParseError')) }
      const outbound = clashConfigToOutbound(targetClashConfig, 'tmp')
      delete outbound.tag
      const res = await api.post('/api/user/routed-outbound', {
        parent_node_id: sourceNode.id,
        target_node_id: targetNode.id,
        label: trimmed,
        outbound,
        node_name: `${sourceNode.node_name}-${trimmed}`,
      })
      return res.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['nodes'] })
      queryClient.invalidateQueries({ queryKey: ['user-routed-outbounds'] })
      toast.success('路由出站创建成功')
      setLandingDialogOpen(false)
      setSourceNodeForLanding(null)
      setLandingRoutedLabel('')
      setLandingScope('routed')
      setRoutedTargetNode(null)
    },
    onError: (error: any) => {
      toast.error(error.message || error.response?.data?.error || '创建失败')
    },
  })

  // 用户视角:查询自己已创建的私有路由出站数 + 配额 + 每日次数 + 全局开关(用于禁用按钮 + 显示剩余)
  const { data: userRoutedQuotaData } = useQuery({
    queryKey: ['user-routed-outbounds'],
    queryFn: async () => {
      const res = await api.get('/api/user/routed-outbound')
      return res.data as { items: any[]; enabled: boolean; quota: { used: number; max: number }; daily: { used: number; max: number } }
    },
    enabled: !isAdmin && Boolean(auth.accessToken),
    staleTime: 30 * 1000,
  })
  const userRoutedEnabled = Boolean(userRoutedQuotaData?.enabled)
  const userRoutedQuota = userRoutedQuotaData?.quota ?? { used: 0, max: 2 }
  const userRoutedDaily = userRoutedQuotaData?.daily ?? { used: 0, max: 5 }
  const userRoutedQuotaExhausted = !isAdmin && userRoutedQuota.max > 0 && userRoutedQuota.used >= userRoutedQuota.max
  const userRoutedDailyExhausted = !isAdmin && userRoutedDaily.max > 0 && userRoutedDaily.used >= userRoutedDaily.max

  // 节点行内联渲染:用户私有路由出站的删除按钮(仅创建者本人可见)
  const renderUserRoutedDeleteBtn = (dbNode: any) => {
    if (!dbNode) return null
    if (dbNode.node_type !== 'routed' || dbNode.routed_owner !== 'user') return null
    if (dbNode.created_by && profile?.username && dbNode.created_by !== profile.username) return null
    return (
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            variant='ghost'
            size='icon'
            className='size-7 text-destructive hover:text-destructive/80'
            title='删除我的路由出站'
          >
            <Trash2 className='size-4' />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除路由出站</AlertDialogTitle>
            <AlertDialogDescription>
              将从你的订阅中移除该节点,并清理 xray 上对应的出站与路由规则。此操作不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleteUserRoutedMutation.mutate(dbNode.id)}>
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    )
  }

  // 用户删除自己的路由出站
  const deleteUserRoutedMutation = useMutation({
    mutationFn: async (id: number) => {
      await api.delete(`/api/user/routed-outbound?id=${id}`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['nodes'] })
      queryClient.invalidateQueries({ queryKey: ['user-routed-outbounds'] })
      toast.success('路由出站已删除')
    },
    onError: (e: any) => {
      toast.error(e?.response?.data?.error || e?.message || '删除失败')
    },
  })

  // 路由出站(用户级)版本的落地:源 inbound 加一个 routed 子节点 + admin 占位 + marktag rule
  // 套餐分配该 routed 子节点的用户会自动开子账号并加入 rule.user
  const addRoutedLandingMutation = useMutation({
    mutationFn: async ({ sourceNode, targetNode, label }: { sourceNode: ParsedNode; targetNode: ParsedNode; label: string }) => {
      if (!label.trim()) throw new Error('请填写 Label')
      if (!/^[a-zA-Z0-9-]{2,32}$/.test(label.trim())) throw new Error('Label 只允许 [a-zA-Z0-9-] 长度 2-32')
      let targetClashConfig: any
      try { targetClashConfig = JSON.parse(targetNode.clash_config) } catch { throw new Error(t('toast.landingTargetParseError')) }
      // 用 target 节点的 clash_config 转成 xray outbound 定义(tag 留空,后端会用 routed:p<id>:<label> 覆盖)
      const outbound = clashConfigToOutbound(targetClashConfig, 'tmp')
      delete outbound.tag
      const res = await api.post('/api/admin/routed-outbound', {
        parent_node_id: sourceNode.id,
        label: label.trim(),
        outbound,
        node_name: `${sourceNode.node_name}-${label.trim()}`,
      })
      return res.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['nodes'] })
      toast.success('路由出站创建成功,套餐分配该节点的用户会自动开子账号')
      setLandingDialogOpen(false)
      setSourceNodeForLanding(null)
      setLandingRoutedLabel('')
      setLandingScope('all')
    },
    onError: (error: any) => {
      toast.error(error.message || error.response?.data?.error || '路由出站创建失败')
    },
  })

  // 选择服务器后通过 InboundWizard 创建入站，然后自动配置出站+路由
  const handleLandingInboundCreated = async (serverIds: number[], inbound: any, tag: string) => {
    if (!sourceNodeForLanding || serverIds.length === 0) return
    const serverId = serverIds[0]
    const trimmedTag = tag?.trim() || inbound.tag || ''
    if (!trimmedTag) { toast.error(t('toast.enterTag')); return }

    setLandingLoading(true)
    try {
      // 1. 在选定服务器创建入站
      const inboundRes = await api.post(`/api/admin/remote/inbounds?server_id=${serverId}`, {
        action: 'add',
        inbound: { ...inbound, tag: trimmedTag },
      })
      if (!inboundRes.data.success) throw new Error(inboundRes.data.message || t('toast.inboundCreateFailed'))

      // 2. 等待 NodeSyncListener 创建节点
      await new Promise(r => setTimeout(r, 800))
      await queryClient.invalidateQueries({ queryKey: ['nodes'] })
      const freshNodes = await queryClient.fetchQuery<{ nodes: ParsedNode[] }>({ queryKey: ['nodes'] })
      const serverName = remoteServers.find(s => s.id === serverId)?.name || ''
      const newNode = freshNodes?.nodes?.find(n => n.original_server === serverName && n.inbound_tag === trimmedTag)

      if (!newNode) {
        toast.warning(t('toast.inboundCreatedNoNode'))
        setLandingDialogOpen(false)
        return
      }

      // 4. 用新节点作为落地节点，配置源服务器出站+路由
      if (landingScope === 'routed') {
        if (!landingRoutedLabel.trim()) {
          toast.error('请先填写 Label')
          return
        }
        await addRoutedLandingMutation.mutateAsync({
          sourceNode: sourceNodeForLanding,
          targetNode: newNode,
          label: landingRoutedLabel,
        })
      } else {
        await addLandingNodeMutation.mutateAsync({
          sourceNode: sourceNodeForLanding,
          targetNode: newNode,
        })
      }
    } catch (error: any) {
      toast.error(error.message || t('toast.createLandingFailed'))
    } finally {
      setLandingLoading(false)
    }
  }

  // 创建链式代理节点
  const createRelayNodeMutation = useMutation({
    mutationFn: async ({ sourceNode, targetNode }: { sourceNode: ParsedNode; targetNode: ParsedNode }) => {
      let sourceClashConfig: Record<string, unknown>
      try {
        sourceClashConfig = JSON.parse(sourceNode.clash_config)
      } catch {
        throw new Error(t('toast.chainProxySourceParseError'))
      }
      const newNodeName = `${sourceNode.node_name} | ${targetNode.node_name}`
      const newClashConfig = { ...sourceClashConfig, name: newNodeName }
      const response = await api.post('/api/admin/nodes', {
        raw_url: sourceNode.raw_url,
        node_name: newNodeName,
        protocol: `${sourceNode.protocol}⇋${targetNode.protocol}`,
        parsed_config: JSON.stringify(newClashConfig),
        clash_config: JSON.stringify(newClashConfig),
        enabled: true,
        tag: '链式代理',
        chain_proxy_node_id: targetNode.id,
      })
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['nodes'] })
      toast.success(t('toast.chainProxyCreateSuccess'))
      setChainProxyDialogOpen(false)
      setSourceNodeForChainProxy(null)
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || t('toast.chainProxyCreateFailed'))
    },
  })

  // 从订阅获取节点
  const fetchSubscriptionMutation = useMutation({
    mutationFn: async ({ url, userAgent }: { url: string; userAgent: string }) => {
      const response = await api.post('/api/admin/nodes/fetch-subscription', {
        url,
        user_agent: userAgent
      })
      return response.data as { proxies: ClashProxy[]; count: number; suggested_tag?: string }
    },
    onSuccess: async (data, variables) => {
      // 优先使用后端返回的 suggested_tag（从 Content-Disposition 提取）
      // 其次使用 URL hostname
      let defaultTag = data.suggested_tag || ''
      if (!defaultTag) {
        try {
          const urlObj = new URL(variables.url)
          defaultTag = urlObj.hostname || t('importCard.subscription.defaultTag')
        } catch {
          defaultTag = t('importCard.subscription.defaultTag')
        }
      }

      // 将Clash节点转换为TempNode格式
      const parsed: TempNode[] = data.proxies.map((clashNode) => {
        if (skipCertVerify) clashNode['skip-cert-verify'] = true
        // Clash节点已经是标准格式，直接作为ProxyNode和ClashProxy使用
        const proxyNode: ProxyNode = {
          name: clashNode.name || t('nodeList.unknown'),
          type: clashNode.type || 'unknown',
          server: clashNode.server || '',
          port: clashNode.port || 0,
          ...clashNode,
        }
        const name = proxyNode.name || t('nodeList.unknown')
        const parsedProxy = cloneProxyWithName(proxyNode, name)
        const clashProxy = cloneProxyWithName(clashNode, name)

        return {
          id: Math.random().toString(36).substring(7),
          rawUrl: variables.url, // 使用订阅链接地址
          name,
          parsed: parsedProxy,
          clash: clashProxy,
          enabled: true,
          tag: subscriptionTag.trim() || defaultTag, // 添加标签信息
        }
      })

      setTempNodes(parsed)
      setCurrentTag('subscription') // 订阅导入

      // 如果用户没有设置标签，自动使用 suggested_tag 或服务器地址作为标签
      if (!subscriptionTag.trim()) {
        setSubscriptionTag(defaultTag)
      }

      toast.success(t('toast.importSuccess', { count: data.count }))

      // 保存外部订阅链接
      try {
        // 优先使用用户输入的标签，如果没有则使用 defaultTag（从 Content-Disposition 提取或域名）
        const finalTag = subscriptionTag.trim() || defaultTag
        await api.post('/api/user/external-subscriptions', {
          name: finalTag,
          url: variables.url,
          user_agent: variables.userAgent, // 保存 User-Agent
        })
        // 刷新外部订阅列表和流量数据
        queryClient.invalidateQueries({ queryKey: ['external-subscriptions'] })
        queryClient.invalidateQueries({ queryKey: ['traffic-summary'] })
      } catch (error) {
        // 如果保存失败（比如已经存在），忽略错误
        console.log('Failed to save external subscription (may already exist):', error)
      }
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || t('toast.subFetchFailed'))
    },
  })

  const handleParse = () => {
    const lines = input.split('\n').filter(line => line.trim())
    const parsed: TempNode[] = []

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.includes('://')) continue
      const parsedNode = parseProxyUrl(trimmed)
      const clashNode = parsedNode ? toClashProxy(parsedNode) : null
      if (skipCertVerify && clashNode) clashNode['skip-cert-verify'] = true
      const name = parsedNode?.name || clashNode?.name || t('nodeList.unknown')
      const normalizedParsed = cloneProxyWithName(parsedNode, name)
      const normalizedClash = cloneProxyWithName(clashNode, name)

      parsed.push({
        id: Math.random().toString(36).substring(7),
        rawUrl: trimmed,
        name,
        parsed: normalizedParsed,
        clash: normalizedClash,
        enabled: true,
        tag: manualTag.trim() || t('filter.manualInput'), // 添加标签信息
      })
    }

    setTempNodes(parsed)
    setCurrentTag('manual') // 手动输入
  }

  const handleSave = () => {
    if (tempNodes.length === 0) {
      toast.error(t('toast.noSavableNodes'))
      return
    }
    batchCreateMutation.mutate(tempNodes)
  }

  const handleToggle = (id: number) => {
    const node = savedNodes.find(n => n.id === id)
    if (node) {
      toggleMutation.mutate({ id, enabled: !node.enabled })
    }
  }

  const handleDelete = useCallback((id: number) => {
    deleteMutation.mutate(id)
  }, [deleteMutation])

  const handleDeleteTemp = useCallback((id: string) => {
    setTempNodes(prev => prev.filter(node => node.id !== id))
    toast.success(t('toast.tempNodeRemoved'))
  }, [])

  const handleNameEditStart = useCallback((node) => {
    setEditingNode({ id: node.id, value: node.name })
  }, [])

  const handleNameEditChange = useCallback((value: string) => {
    setEditingNode(prev => (prev ? { ...prev, value } : prev))
  }, [])

  const handleNameEditCancel = useCallback(() => {
    setEditingNode(null)
  }, [])

  const handleNameEditSubmit = useCallback((node) => {
    if (!editingNode) return
    const trimmed = editingNode.value.trim()
    if (!trimmed) {
      toast.error(t('toast.nodeNameEmpty'))
      return
    }
    if (trimmed === node.name) {
      setEditingNode(null)
      return
    }

    if (node.isSaved) {
      updateNodeNameMutation.mutate({ id: node.dbId, name: trimmed })
      return
    }

    setTempNodes(prev =>
      prev.map(item => {
        if (item.id !== node.id) return item
        return {
          ...item,
          name: trimmed,
          parsed: cloneProxyWithName(item.parsed, trimmed),
          clash: cloneProxyWithName(item.clash, trimmed),
        }
      }),
    )
    toast.success(t('toast.tempNodeNameUpdated'))
    setEditingNode(null)
  }, [editingNode, updateNodeNameMutation])

  const handleSetNodeFlag = useCallback((nodeId: string, flag: string) => {
    const savedNode = savedNodes.find(n => String(n.id) === nodeId)
    const tempNode = tempNodes.find(n => n.id === nodeId)

    if (savedNode) {
      const baseName = stripFlagEmoji(savedNode.node_name)
      const newName = `${flag} ${baseName}`
      updateNodeNameMutation.mutate({ id: savedNode.id, name: newName })
    } else if (tempNode) {
      const baseName = stripFlagEmoji(tempNode.name)
      const newName = `${flag} ${baseName}`
      setTempNodes(prev =>
        prev.map(item => {
          if (item.id !== nodeId) return item
          return {
            ...item,
            name: newName,
            parsed: cloneProxyWithName(item.parsed, newName),
            clash: cloneProxyWithName(item.clash, newName),
          }
        }),
      )
    }
  }, [savedNodes, tempNodes, updateNodeNameMutation])

  const handleClearAll = () => {
    clearAllMutation.mutate()
  }

  const handleFetchSubscription = () => {
    if (!subscriptionUrl.trim()) {
      toast.error(t('toast.enterSubUrl'))
      return
    }

    // 确定使用哪个 User-Agent
    const finalUserAgent = userAgent === 'custom' ? customUserAgent : userAgent

    if (userAgent === 'custom' && !customUserAgent.trim()) {
      toast.error(t('toast.enterCustomUserAgent'))
      return
    }

    fetchSubscriptionMutation.mutate({
      url: subscriptionUrl,
      userAgent: finalUserAgent
    })
  }

  // 合并保存的节点和临时节点用于显示
  const displayNodes = useMemo(() => {
    // 将保存的节点转换为显示格式
    const saved = savedNodes.map(n => {
      let parsed: ProxyNode | null = null
      let clash: ClashProxy | null = null
      try {
        if (n.parsed_config) parsed = JSON.parse(n.parsed_config)
        if (n.clash_config) clash = JSON.parse(n.clash_config)
      } catch (e) {
        // 解析失败，保持 null
      }
      const displayName = (n.node_name && n.node_name.trim()) || parsed?.name || t('nodeList.unknown')
      const parsedWithName = cloneProxyWithName(parsed, displayName)
      const clashWithName = cloneProxyWithName(clash, displayName)
      return {
        id: n.id.toString(),
        rawUrl: n.raw_url,
        name: displayName,
        parsed: parsedWithName,
        clash: clashWithName,
        enabled: n.enabled,
        tag: n.tag || t('filter.manualInput'),
        isSaved: true,
        dbId: n.id,
        dbNode: n,
      }
    })

    // 临时节点
    const temp = tempNodes.map(n => ({
      ...n,
      parsed: cloneProxyWithName(n.parsed, n.name),
      clash: cloneProxyWithName(n.clash, n.name),
      isSaved: false,
      dbId: 0,
    }))

    // 按 nodeOrder 排序已保存的节点
    const orderMap = new Map<number, number>()
    nodeOrder.forEach((id, index) => orderMap.set(id, index))

    const sortedSaved = [...saved].sort((a, b) => {
      const aOrder = orderMap.get(a.dbId) ?? Infinity
      const bOrder = orderMap.get(b.dbId) ?? Infinity
      return aOrder - bOrder
    })

    // 临时节点在前，已保存节点按排序顺序在后
    return [...temp, ...sortedSaved]
  }, [savedNodes, tempNodes, nodeOrder])

  // 拖拽开始处理：检测是否批量拖动
  const handleDragStart = useCallback((event: DragStartEvent) => {
    // 锁定 body 滚动
    document.body.style.overflow = 'hidden'
    document.body.style.touchAction = 'none'

    const { active } = event
    setActiveId(active.id as string)

    const savedDisplayNodes = displayNodes.filter(n => n.isSaved && n.dbId)
    const activeNode = savedDisplayNodes.find(n => n.id === active.id)

    // 如果拖动的节点在选中集合中，且选中了多个节点，则是批量拖动
    if (activeNode?.dbId && selectedNodeIds.has(activeNode.dbId) && selectedNodeIds.size > 1) {
      setBatchDraggingIds(new Set(selectedNodeIds))
    } else {
      setBatchDraggingIds(new Set())
    }
  }, [displayNodes, selectedNodeIds])

  // 拖拽结束处理（支持批量拖动）
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    // 恢复 body 滚动
    document.body.style.overflow = ''
    document.body.style.touchAction = ''

    const { active, over } = event

    // 清除拖动状态（无论结果如何都要清除）
    setActiveId(null)
    setBatchDraggingIds(new Set())

    if (!over || active.id === over.id) return

    // 获取当前显示的已保存节点（按当前顺序）
    const savedDisplayNodes = displayNodes.filter(n => n.isSaved && n.dbId)
    const activeNode = savedDisplayNodes.find(n => n.id === active.id)
    if (!activeNode) return

    const overIndex = savedDisplayNodes.findIndex(n => n.id === over.id)
    if (overIndex === -1) return

    // 判断是否批量拖动：拖拽的节点在选中集合中，且选中了多个节点
    const isDraggingSelected = activeNode.dbId && selectedNodeIds.has(activeNode.dbId)

    if (isDraggingSelected && selectedNodeIds.size > 1) {
      // 批量拖动逻辑
      const targetNode = savedDisplayNodes[overIndex]

      // 如果目标也是选中的节点，忽略操作
      if (targetNode.dbId && selectedNodeIds.has(targetNode.dbId)) return

      // 获取选中节点的ID（保持当前显示顺序）
      const selectedIds = savedDisplayNodes
        .filter(n => n.dbId && selectedNodeIds.has(n.dbId))
        .map(n => n.dbId!)

      // 获取未选中的节点
      const unselectedNodes = savedDisplayNodes.filter(n => !n.dbId || !selectedNodeIds.has(n.dbId))

      // 计算在目标位置之前还是之后插入
      const activeIndex = savedDisplayNodes.findIndex(n => n.id === active.id)
      const insertAfter = activeIndex < overIndex

      // 重新排列：将选中的节点作为整体插入到目标位置
      const newOrder: number[] = []
      for (const node of unselectedNodes) {
        if (node.dbId === targetNode.dbId && !insertAfter) {
          // 在目标之前插入
          newOrder.push(...selectedIds)
        }
        newOrder.push(node.dbId!)
        if (node.dbId === targetNode.dbId && insertAfter) {
          // 在目标之后插入
          newOrder.push(...selectedIds)
        }
      }

      setNodeOrder(newOrder)
      updateNodeOrderMutation.mutate(newOrder)
    } else {
      // 单节点拖动（保持原有逻辑）
      const activeIndex = savedDisplayNodes.findIndex(n => n.id === active.id)
      if (activeIndex === -1) return

      const currentIds = savedDisplayNodes.map(n => n.dbId!)
      const newOrderIds = arrayMove(currentIds, activeIndex, overIndex)

      setNodeOrder(newOrderIds)
      updateNodeOrderMutation.mutate(newOrderIds)
    }
  }, [displayNodes, selectedNodeIds, updateNodeOrderMutation])

  // 拖拽取消处理
  const handleDragCancel = useCallback(() => {
    setActiveId(null)
    setBatchDraggingIds(new Set())
  }, [])

  const filteredNodes = useMemo(() => {
    let nodes = displayNodes

    // 按协议筛选
    if (selectedProtocol !== 'all') {
      nodes = nodes.filter(node => node.parsed?.type === selectedProtocol)
    }

    // 按标签筛选
    if (tagFilter !== 'all') {
      nodes = nodes.filter(node => node.tag === tagFilter)
    }

    return nodes
  }, [displayNodes, selectedProtocol, tagFilter])

  const deferredFilteredNodes = useDeferredValue(filteredNodes)

  // 批量 TCPing 测试选中的节点
  const handleBatchTcping = useCallback(async () => {
    if (selectedNodeIds.size === 0) {
      toast.error(t('toast.selectNodeFirst'))
      return
    }

    // 获取选中的有效节点
    const selectedNodes = deferredFilteredNodes.filter(
      node => node.isSaved && node.dbId && selectedNodeIds.has(node.dbId) && node.parsed?.server && node.parsed?.port
    )

    if (selectedNodes.length === 0) {
      toast.error(t('toast.noValidServerAddress'))
      return
    }

    setBatchTcpingLoading(true)

    // 初始化所有选中节点的加载状态
    const initialResults: Record<string, { success: boolean; latency: number; error?: string; loading?: boolean }> = {}
    selectedNodes.forEach(node => {
      const nodeKey = String(node.dbId)
      initialResults[nodeKey] = { success: false, latency: 0, loading: true }
    })
    setTcpingResults(prev => ({ ...prev, ...initialResults }))

    try {
      // 构建批量请求
      const requests = selectedNodes.map(node => ({
        host: node.parsed!.server,
        port: node.parsed!.port,
        timeout: 5000
      }))

      const response = await api.post('/api/admin/tcping/batch', requests)
      const results = response.data as Array<{ success: boolean; latency: number; error?: string }>

      // 更新结果
      const newResults: Record<string, { success: boolean; latency: number; error?: string; loading?: boolean }> = {}
      selectedNodes.forEach((node, index) => {
        const nodeKey = String(node.dbId)
        const result = results[index]
        newResults[nodeKey] = {
          success: result.success,
          latency: result.latency,
          error: result.error,
          loading: false
        }
      })
      setTcpingResults(prev => ({ ...prev, ...newResults }))

      // 统计结果
      const successCount = results.filter(r => r.success).length
      const failCount = results.length - successCount
      if (failCount === 0) {
        toast.success(t('toast.allTestSuccess', { count: successCount }))
      } else {
        toast.info(t('toast.testResult', { success: successCount, fail: failCount }))
      }
    } catch (error) {
      // 标记所有节点测试失败
      const errorResults: Record<string, { success: boolean; latency: number; error?: string; loading?: boolean }> = {}
      selectedNodes.forEach(node => {
        const nodeKey = String(node.dbId)
        errorResults[nodeKey] = {
          success: false,
          latency: 0,
          error: error instanceof Error ? error.message : t('toast.testFailed'),
          loading: false
        }
      })
      setTcpingResults(prev => ({ ...prev, ...errorResults }))
      toast.error(t('toast.batchTestFailed'))
    } finally {
      setBatchTcpingLoading(false)
    }
  }, [selectedNodeIds, deferredFilteredNodes])

  // 获取要在 DragOverlay 中显示的节点
  const dragOverlayNodes = useMemo(() => {
    if (!activeId) return []

    const activeNode = deferredFilteredNodes.find(n => n.id === activeId)
    if (!activeNode) return []

    // 如果是批量拖动，返回所有选中的节点
    if (activeNode.dbId && selectedNodeIds.has(activeNode.dbId) && selectedNodeIds.size > 1) {
      return deferredFilteredNodes.filter(n => n.dbId && selectedNodeIds.has(n.dbId))
    }

    // 单节点拖动
    return [activeNode]
  }, [activeId, deferredFilteredNodes, selectedNodeIds])

  const protocolCounts = useMemo(() => {
    const counts: Record<string, number> = { all: displayNodes.length }
    for (const protocol of PROTOCOLS) {
      counts[protocol] = displayNodes.filter(n => n.parsed?.type === protocol).length
    }
    return counts
  }, [displayNodes])

  const tagCounts = useMemo(() => {
    const counts: Record<string, number> = { all: displayNodes.length }
    const tags = new Set<string>()
    displayNodes.forEach(node => {
      if (node.tag) {
        tags.add(node.tag)
        counts[node.tag] = (counts[node.tag] || 0) + 1
      }
    })
    return counts
  }, [displayNodes])

  // 提取所有唯一的标签
  const allUniqueTags = useMemo(() => {
    const tags = new Set<string>()
    savedNodes.forEach(node => {
      if (node.tag && node.tag.trim()) {
        tags.add(node.tag.trim())
      }
    })
    return Array.from(tags).sort()
  }, [savedNodes])

  // 当选中的筛选器对应的节点都被删除时，自动重置为 'all'
  // 注意：只有在节点数据加载完成后才执行检查，避免在初始化时错误重置从 localStorage 恢复的状态
  useEffect(() => {
    // 如果节点数据还没加载完成，不执行检查
    if (!nodesData) return

    // 检查 tagFilter
    if (tagFilter !== 'all' && (!tagCounts[tagFilter] || tagCounts[tagFilter] === 0)) {
      setTagFilter('all')
    }
    // 检查 selectedProtocol
    if (selectedProtocol !== 'all' && (!protocolCounts[selectedProtocol] || protocolCounts[selectedProtocol] === 0)) {
      setSelectedProtocol('all')
    }
  }, [nodesData, tagCounts, protocolCounts, tagFilter, selectedProtocol])

  return (
    <div className='min-h-svh bg-background'>
      <Topbar />
      <main className='mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 pt-24'>
        <section className='space-y-4'>
          <div>
            <h1 className='text-3xl font-semibold tracking-tight'>{t('page.title')}</h1>
            <p className='text-muted-foreground mt-2'>
              {t('page.description')}
            </p>
          </div>

          <Collapsible open={isInputCardExpanded} onOpenChange={setIsInputCardExpanded}>
            <Card>
              <CollapsibleTrigger asChild>
                <CardHeader className='cursor-pointer hover:bg-muted/50 transition-colors rounded-t-lg'>
                  <div className='flex items-center justify-between'>
                    <CardTitle>{t('importCard.title')}</CardTitle>
                    <div className='p-1.5 transition-all duration-200'>
                      <ChevronDown className={cn(
                        'h-5 w-5 transition-transform duration-200',
                        isInputCardExpanded ? 'rotate-180' : 'animate-bounce'
                      )} />
                    </div>
                  </div>
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent className='CollapsibleContent'>
                <CardContent>
                  <Tabs defaultValue='manual' className='w-full'>
                    <TabsList className='grid w-full grid-cols-2'>
                      <TabsTrigger value='manual'>{t('importCard.tabs.manual')}</TabsTrigger>
                      <TabsTrigger value='subscription'>{t('importCard.tabs.subscription')}</TabsTrigger>
                    </TabsList>

                    {(
                    <TabsContent value='manual' className='space-y-4 mt-4'>
                      <Textarea
                        placeholder={`vmess://eyJwcyI6IuWPsOa5vualviIsImFkZCI6ImV4YW1wbGUuY29tIiwicG9ydCI6IjQ0MyIsImlkIjoidXVpZCIsImFpZCI6IjAiLCJzY3kiOiJhdXRvIiwibmV0Ijoid3MiLCJ0bHMiOiJ0bHMifQ==
vless://uuid@example.com:443?type=ws&security=tls&path=/websocket#VLESS节点
trojan://password@example.com:443?sni=example.com#Trojan节点
anytls://password@example.com:443/?sni=example.com&fp=chrome&alpn=h2#AnyTLS节点`}
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        className='min-h-[200px] font-mono text-sm'
                      />
                      <div className='space-y-2'>
                        <Label htmlFor='manual-tag' className='text-sm font-medium'>
                          {t('importCard.manual.tagLabel')}
                        </Label>
                        <div className='flex items-center gap-4'>
                          <Input
                            id='manual-tag'
                            placeholder={t('importCard.manual.tagPlaceholder')}
                            value={manualTag}
                            onChange={(e) => setManualTag(e.target.value)}
                            className='font-mono text-sm flex-1'
                          />
                          <div className='flex items-center gap-2 shrink-0'>
                            <Switch
                              id='skip-cert-verify-manual'
                              checked={skipCertVerify}
                              onCheckedChange={setSkipCertVerify}
                            />
                            <Label htmlFor='skip-cert-verify-manual' className='text-sm whitespace-nowrap cursor-pointer'>
                              {t('importCard.manual.skipCertVerify')}
                            </Label>
                          </div>
                        </div>
                        <p className='text-xs text-muted-foreground'>
                          {t('importCard.manual.tagDescription')}
                        </p>
                      </div>
                      <div className='flex justify-end gap-2'>
                        <Button onClick={handleParse} disabled={!input.trim()} variant='outline'>
                          {t('importCard.manual.parseBtn')}
                        </Button>
                        <Button
                          onClick={handleSave}
                          disabled={tempNodes.length === 0 || batchCreateMutation.isPending}
                        >
                          {batchCreateMutation.isPending ? t('importCard.manual.savingBtn') : t('importCard.manual.saveBtn')}
                        </Button>
                      </div>
                    </TabsContent>
                    )}

                    <TabsContent value='subscription' className='space-y-4 mt-4'>
                      <div className='space-y-2'>
                        <Input
                          placeholder='https://example.com/api/clash/subscribe?token=xxx'
                          value={subscriptionUrl}
                          onChange={handleSubscriptionUrlChange}
                          className='font-mono text-sm'
                        />
                        <p className='text-xs text-muted-foreground'>
                          {t('importCard.subscription.urlDescription')}
                        </p>
                      </div>
                      <div className='flex items-center gap-2'>
                        <Label htmlFor='user-agent' className='whitespace-nowrap'>User-Agent:</Label>
                        <Select value={userAgent} onValueChange={handleUserAgentChange}>
                          <SelectTrigger id='user-agent' className='w-[200px]'>
                            <SelectValue placeholder={t('importCard.subscription.userAgentPlaceholder')} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value='clash.meta'>clash.meta</SelectItem>
                            <SelectItem value='clash-verge/v1.5.1'>clash-verge/v1.5.1</SelectItem>
                            <SelectItem value='Clash'>Clash</SelectItem>
                            <SelectItem value='custom'>{t('importCard.subscription.customUserAgent')}</SelectItem>
                          </SelectContent>
                        </Select>
                        {userAgent === 'custom' && (
                          <Input
                            placeholder={t('importCard.subscription.customUserAgentPlaceholder')}
                            value={customUserAgent}
                            onChange={handleCustomUserAgentChange}
                            className='font-mono text-sm flex-1'
                          />
                        )}
                      </div>
                      <div className='space-y-2'>
                        <Label htmlFor='subscription-tag' className='text-sm font-medium'>
                          {t('importCard.subscription.tagLabel')}
                        </Label>
                        <Input
                          id='subscription-tag'
                          placeholder={t('importCard.subscription.tagPlaceholder')}
                          value={subscriptionTag}
                          onChange={(e) => setSubscriptionTag(e.target.value)}
                          className='font-mono text-sm'
                        />
                        <p className='text-xs text-muted-foreground'>
                          {t('importCard.subscription.tagDescription')}
                        </p>
                      </div>
                      <div className='flex justify-end gap-2'>
                        <Button
                          onClick={handleFetchSubscription}
                          disabled={!subscriptionUrl.trim() || fetchSubscriptionMutation.isPending}
                          variant='outline'
                        >
                          {fetchSubscriptionMutation.isPending ? t('importCard.subscription.importingBtn') : t('importCard.subscription.importBtn')}
                        </Button>
                        <Button
                          onClick={handleSave}
                          disabled={tempNodes.length === 0 || batchCreateMutation.isPending}
                        >
                          {batchCreateMutation.isPending ? t('importCard.subscription.savingBtn') : t('importCard.subscription.saveBtn')}
                        </Button>
                      </div>
                    </TabsContent>
                  </Tabs>
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>

          {(
            <Card>
              <CardHeader>
                <div className='flex flex-col gap-4 md:flex-row md:items-center md:justify-between'>
                  <div>
                    <CardTitle>{t('nodeList.titleWithCount', { count: deferredFilteredNodes.length })}</CardTitle>
                    {isAdmin && <p className='mt-2 text-sm font-semibold text-destructive'>{t('nodeList.warning')}</p>}
                    {isAdmin ? (
                      <p className='mt-2 text-xs text-primary flex flex-wrap items-center gap-1'>
                        <Pencil className='h-4 w-4 inline' /> {t('nodeList.editNodeName')}
                        <img src={ExchangeIcon} alt='chain proxy' className='h-4 w-4 inline [filter:invert(63%)_sepia(45%)_saturate(1068%)_hue-rotate(327deg)_brightness(95%)_contrast(88%)]' /> {t('nodeList.chainProxy')}
                        <Flag className='h-4 w-4 inline' /> {t('nodeList.addRegionEmoji')}
                        <img src={IpIcon} alt='resolve IP' className='h-4 w-4 inline [filter:invert(63%)_sepia(45%)_saturate(1068%)_hue-rotate(327deg)_brightness(95%)_contrast(88%)]' /> {t('nodeList.resolveIp')}
                        <Undo2 className='h-4 w-4 inline' /> {t('nodeList.restoreDomain')}
                        <Eye className='h-4 w-4 inline' /> {t('nodeList.viewEditConfig')}
                        <Copy className='h-4 w-4 inline' /> {t('nodeList.copyUri')}
                        <Link2 className='h-4 w-4 inline' /> {t('nodeList.tempSubscription')}
                        <Activity className='h-4 w-4 inline' /> {t('nodeList.tcpingTest')}
                        <RouteIcon className='h-4 w-4 inline' /> {t('nodeList.specifyOutbound')}
                      </p>
                    ) : (
                      <p className='mt-2 text-xs text-primary flex flex-wrap items-center gap-1'>
                        <Activity className='h-4 w-4 inline' /> {t('nodeList.tcpingTest')}
                      </p>
                    )}
                  </div>
                  <div className={cn('flex flex-wrap gap-2 justify-end', !isAdmin && 'hidden')}>
                    <Button
                      variant='outline'
                      size='sm'
                      onClick={() => {
                        if (remoteServers.length === 0) {
                          toast.error(t('toast.noAvailableServer'))
                          return
                        }
                        setQuickCreateStep('inbound')
                        setQuickCreateResult(null)
                        const validCurrentServer = quickCreateServerId !== null && remoteServers.some(s => s.id === quickCreateServerId)
                        setQuickCreateServerId(validCurrentServer ? quickCreateServerId : remoteServers[0].id)
                        setQuickCreateServerDialogOpen(true)
                      }}
                    >
                      <Zap className='h-4 w-4 mr-1' />
                      {t('actions.addNode')}
                    </Button>
                    <Button
                      variant='outline'
                      size='sm'
                      onClick={() => setTunnelDialogOpen(true)}
                    >
                      <Cable className='h-4 w-4 mr-1' />
                      {t('actions.tunnelManager')}
                    </Button>
                    <Button
                      variant='outline'
                      size='sm'
                      onClick={() => setRoutedOutboundsDialogOpen(true)}
                    >
                      <RouteIcon className='h-4 w-4 mr-1' />
                      路由出站
                    </Button>
                    <Button
                      variant='outline'
                      size='sm'
                      onClick={() => { setSpeedDialogOpen(true); setSpeedDialogMin(false) }}
                    >
                      <Gauge className='h-4 w-4 mr-1' />
                      {t('speedtest.dialogTitle')}
                    </Button>
                    <Button
                      variant='outline'
                      size='sm'
                      onClick={() => {
                        toast.promise(
                          api.post('/api/admin/sync-external-subscriptions'),
                          {
                            loading: t('actions.syncingExternalSub'),
                            success: (response) => {
                              queryClient.invalidateQueries({ queryKey: ['nodes'] })
                              return response.data.message || t('actions.syncExternalSubSuccess')
                            },
                            error: (error) => error.response?.data?.error || t('toast.saveFailed')
                          }
                        )
                      }}
                    >
                      {t('actions.syncExternalSub')}
                    </Button>
                    {selectedNodeIds.size > 0 && (
                      <>
                        <Button
                          variant='default'
                          size='sm'
                          onClick={handleAddRegionEmoji}
                          disabled={addingRegionEmoji}
                        >
                          {addingRegionEmoji ? t('actions.addingEmoji') : t('actions.addEmojiWithCount', { count: selectedNodeIds.size })}
                        </Button>
                        <Button
                          variant='default'
                          size='sm'
                          onClick={() => {
                            // 获取选中节点的名称
                            const selectedNodes = savedNodes.filter(n => selectedNodeIds.has(n.id))
                            const names = selectedNodes.map(n => n.node_name).join('\n')
                            setBatchRenameText(names)
                            setBatchRenameDialogOpen(true)
                          }}
                        >
                          {t('actions.renameNameWithCount', { count: selectedNodeIds.size })}
                        </Button>
                        <Button
                          variant='default'
                          size='sm'
                          onClick={() => setBatchTagDialogOpen(true)}
                        >
                          {t('actions.renameTagWithCount', { count: selectedNodeIds.size })}
                        </Button>
                        <Button
                          variant='secondary'
                          size='sm'
                          onClick={() => {
                            setTempSubSingleNodeId(null) // 批量模式
                            setTempSubUrl('')
                            setTempSubDialogOpen(true)
                          }}
                        >
                          {t('actions.tempSubWithCount', { count: selectedNodeIds.size })}
                        </Button>
                        <Button
                          variant='outline'
                          size='sm'
                          onClick={handleBatchTcping}
                          disabled={batchTcpingLoading}
                        >
                          {batchTcpingLoading ? t('actions.testing') : t('actions.latencyTestWithCount', { count: selectedNodeIds.size })}
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant='destructive'
                              size='sm'
                            >
                              {t('actions.batchDeleteWithCount', { count: selectedNodeIds.size })}
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>{t('dialog.confirmBatchDelete')}</AlertDialogTitle>
                              <AlertDialogDescription>
                                {t('dialog.confirmBatchDeleteDesc', { count: selectedNodeIds.size })}
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>{t('actions.cancel', { ns: 'common' })}</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => {
                                  // 使用批量删除 API
                                  const ids = Array.from(selectedNodeIds)
                                  api.post('/api/admin/nodes/batch-delete', { node_ids: ids })
                                    .then((response) => {
                                      queryClient.invalidateQueries({ queryKey: ['nodes'] })
                                      setSelectedNodeIds(new Set())
                                      const { deleted, total } = response.data
                                      if (deleted === total) {
                                        toast.success(t('toast.batchDeleteSuccess', { count: deleted }))
                                      } else {
                                        toast.success(t('toast.batchDeletePartial', { deleted, total }))
                                      }
                                    })
                                    .catch((error) => {
                                      toast.error(error.response?.data?.error || t('toast.batchDeleteFailed'))
                                    })
                                }}
                              >
                                {t('dialog.confirmDeleteAction')}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </>
                    )}
                    {savedNodes.length > 0 && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant='destructive'
                            size='sm'
                            disabled={clearAllMutation.isPending}
                          >
                            {clearAllMutation.isPending ? t('actions.clearingAll') : t('actions.clearAll')}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{t('dialog.confirmClearAll')}</AlertDialogTitle>
                            <AlertDialogDescription>
                              {t('dialog.confirmClearAllDesc', { count: savedNodes.length })}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{t('actions.cancel', { ns: 'common' })}</AlertDialogCancel>
                            <AlertDialogAction onClick={handleClearAll}>
                              {t('dialog.clearAll')}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                    {savedNodes.length > 0 && (
                      <Button
                        variant='outline'
                        size='sm'
                        onClick={findDuplicateNodes}
                      >
                        {t('actions.deleteDuplicates')}
                      </Button>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className='space-y-4'>
                {/* 协议筛选按钮 */}
                <div className='space-y-3'>
                  <div>
                    <div className='text-sm font-medium mb-2'>{t('filter.byProtocol')}</div>
                    <div className='flex flex-wrap gap-2'>
                      <Button
                        size='sm'
                        variant={selectedProtocol === 'all' ? 'default' : 'outline'}
                        onClick={() => setSelectedProtocol('all')}
                      >
                        {t('filter.all')} ({protocolCounts.all})
                      </Button>
                      {PROTOCOLS.map(protocol => {
                        const count = protocolCounts[protocol] || 0
                        if (count === 0) return null
                        return (
                          <Button
                            key={protocol}
                            size='sm'
                            variant={selectedProtocol === protocol ? 'default' : 'outline'}
                            onClick={() => setSelectedProtocol(protocol)}
                          >
                            {protocol.toUpperCase()} ({count})
                          </Button>
                        )
                      })}
                    </div>
                  </div>

                  {/* 标签筛选按钮 */}
                  <div>
                    <div className='text-sm font-medium mb-2'>{t('filter.byTag')}</div>
                    <div className='flex flex-wrap gap-2'>
                      <Button
                        size='sm'
                        variant={tagFilter === 'all' ? 'default' : 'outline'}
                        onClick={() => {
                          setTagFilter('all')
                          // 计算应该选中的节点
                          const nodesToSelect = displayNodes
                            .filter(n => n.isSaved && n.dbId)
                            .filter(n => selectedProtocol === 'all' || n.dbNode?.protocol?.toLowerCase() === selectedProtocol)
                          const nodeIdsToSelect = new Set(nodesToSelect.map(n => n.dbId!))

                          // 如果当前选中的节点和应该选中的节点完全一致，则取消选中
                          const currentIds = Array.from(selectedNodeIds).sort()
                          const targetIds = Array.from(nodeIdsToSelect).sort()
                          if (tagFilter === 'all' && currentIds.length === targetIds.length &&
                              currentIds.every((id, i) => id === targetIds[i])) {
                            setSelectedNodeIds(new Set())
                          } else {
                            setSelectedNodeIds(nodeIdsToSelect)
                          }
                        }}
                      >
                        {t('filter.all')} ({tagCounts.all})
                      </Button>
                      {Object.keys(tagCounts).filter(tag => tag !== 'all' && tagCounts[tag] > 0).map(tag => (
                        <Button
                          key={tag}
                          size='sm'
                          variant={tagFilter === tag ? 'default' : 'outline'}
                          onClick={() => {
                            setTagFilter(tag)
                            // 计算应该选中的节点
                            const nodesToSelect = displayNodes
                              .filter(n => n.isSaved && n.dbId && n.dbNode?.tag === tag)
                              .filter(n => selectedProtocol === 'all' || n.dbNode?.protocol?.toLowerCase() === selectedProtocol)
                            const nodeIdsToSelect = new Set(nodesToSelect.map(n => n.dbId!))

                            // 如果当前选中的节点和应该选中的节点完全一致，则取消选中
                            const currentIds = Array.from(selectedNodeIds).sort()
                            const targetIds = Array.from(nodeIdsToSelect).sort()
                            if (tagFilter === tag && currentIds.length === targetIds.length &&
                                currentIds.every((id, i) => id === targetIds[i])) {
                              setSelectedNodeIds(new Set())
                            } else {
                              setSelectedNodeIds(nodeIdsToSelect)
                            }
                          }}
                        >
                          {tag} ({tagCounts[tag]})
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* 移动端卡片视图 (<768px) */}
                {!isTablet && (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                  onDragCancel={handleDragCancel}
                >
                  <SortableContext
                    items={deferredFilteredNodes.map(n => n.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <div className='space-y-3'>
                      {deferredFilteredNodes.length === 0 ? (
                        <Card>
                          <CardContent className='text-center text-muted-foreground py-8'>
                            {t('nodeList.noMatchingNodes')}
                          </CardContent>
                        </Card>
                      ) : (
                        deferredFilteredNodes.map(node => (
                          <SortableCard
                            key={node.id}
                            id={node.id}
                            isSaved={node.isSaved}
                            isBatchDragging={Boolean(node.dbId && batchDraggingIds.has(node.dbId))}
                            isSelected={node.isSaved && node.dbId ? selectedNodeIds.has(node.dbId) : false}
                            onClick={node.isSaved && node.dbId ? () => handleNodeSelect(node.dbId!) : undefined}
                          >
                            <CardContent className='p-3 space-y-2'>
                              {/* 头部：协议、节点名称、已保存标签 */}
                              <div className='flex items-start justify-between gap-2'>
                                <div className='flex-1 min-w-0'>
                                  <div className='flex items-center gap-2 mb-1'>
                                    {node.isSaved && (
                                      <DragHandle id={node.id} size='large' />
                                    )}
                                    {node.isSaved && node.dbId && (
                                      <Checkbox
                                        className='hidden sm:flex'
                                        checked={selectedNodeIds.has(node.dbId)}
                                        onCheckedChange={(checked) => {
                                          const newSet = new Set(selectedNodeIds)
                                          if (checked) {
                                            newSet.add(node.dbId!)
                                          } else {
                                            newSet.delete(node.dbId!)
                                          }
                                          setSelectedNodeIds(newSet)
                                        }}
                                      />
                                    )}
                                {node.parsed || node.dbNode?.protocol ? (
                                  <div className='flex flex-col items-start gap-0.5'>
                                    <Badge
                                      variant='outline'
                                      className={
                                        node.dbNode?.protocol?.includes('⇋')
                                          ? 'bg-pink-500/10 text-pink-700 border-pink-200 dark:text-pink-300 dark:border-pink-800'
                                          : PROTOCOL_COLORS[node.parsed?.type || node.dbNode?.protocol?.toLowerCase() || ''] || 'bg-gray-500/10'
                                      }
                                    >
                                      {node.dbNode?.protocol?.includes('⇋')
                                        ? node.dbNode.protocol.toUpperCase()
                                        : (node.parsed?.type || node.dbNode?.protocol || '').toUpperCase()}
                                    </Badge>
                                    {node.dbNode?.node_type === 'routed' && node.dbNode?.routed_outbound_tag && (
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <span className='text-[10px] text-indigo-600 dark:text-indigo-400 font-mono max-w-[110px] truncate'>
                                            ↳ {resolveRoutedDisplay(node.dbNode)}
                                          </span>
                                        </TooltipTrigger>
                                        <TooltipContent>
                                          <div className='text-xs'>路由出站: <span className='font-mono'>{node.dbNode.routed_outbound_tag}</span></div>
                                        </TooltipContent>
                                      </Tooltip>
                                    )}
                                  </div>
                                ) : (
                                  <Badge variant='destructive'>{t('nodeList.parseFailed')}</Badge>
                                )}
                                {node.isSaved && (
                                  <Check className='size-4 text-green-600' />
                                )}
                              </div>
                              {/* 节点名称 */}
                              {editingNode?.id === node.id ? (
                                <div className='flex items-center gap-1' onClick={(e) => e.stopPropagation()}>
                                  <Input
                                    value={editingNode.value}
                                    onChange={(event) => handleNameEditChange(event.target.value)}
                                    onKeyDown={(event) => {
                                      if (event.key === 'Enter') {
                                        event.preventDefault()
                                        handleNameEditSubmit(node)
                                      } else if (event.key === 'Escape') {
                                        event.preventDefault()
                                        handleNameEditCancel()
                                      }
                                    }}
                                    className='h-7 flex-1 min-w-0'
                                    autoFocus
                                  />
                                  <Button
                                    variant='ghost'
                                    size='icon'
                                    className='size-7 text-emerald-600 shrink-0'
                                    onClick={() => handleNameEditSubmit(node)}
                                    disabled={node.isSaved ? isUpdatingNodeName : false}
                                  >
                                    <Check className='size-3.5' />
                                  </Button>
                                  <Button
                                    variant='ghost'
                                    size='icon'
                                    className='size-7 text-muted-foreground shrink-0'
                                    onClick={handleNameEditCancel}
                                  >
                                    <X className='size-3.5' />
                                  </Button>
                                </div>
                              ) : (
                                <div>
                                  <div className='font-medium text-sm break-all line-clamp-2'><Twemoji>{node.name || t('nodeList.unknown')}</Twemoji></div>
                                  {isAdmin && getNodeServerName(node.dbNode) && (
                                    <div className='text-[11px] text-muted-foreground mt-0.5 truncate'>
                                      {getNodeServerName(node.dbNode)}
                                    </div>
                                  )}
                                </div>
                              )}
                              {renderForwardedBadge(node)}
                            </div>
                            {/* 编辑、交换按钮 */}
                            {editingNode?.id !== node.id && (
                              <div className='flex items-center gap-1 shrink-0' onClick={(e) => e.stopPropagation()}>
                                {(isAdmin || !node.isSaved) && (
                                <Button
                                  variant='ghost'
                                  size='icon'
                                  className='size-7 text-[#d97757] hover:text-[#c66647]'
                                  onClick={() => handleNameEditStart(node)}
                                      disabled={node.isSaved ? isUpdatingNodeName : false}
                                >
                                  <Pencil className='size-4' />
                                </Button>
                                )}
                                {isAdmin && (
                                <FlagEmojiPicker
                                  onSelect={(flag) => handleSetNodeFlag(node.id, flag)}
                                  onAutoDetect={node.isSaved && node.dbNode ? () => handleAddSingleNodeEmoji(node.dbNode!.id) : undefined}
                                  disabled={node.isSaved && node.dbNode ? addingEmojiForNode === node.dbNode.id : false}
                                  loading={node.isSaved && node.dbNode ? addingEmojiForNode === node.dbNode.id : false}
                                  currentFlag={hasRegionEmoji(node.name) ? node.name.match(/[\u{1F1E6}-\u{1F1FF}]{2}/u)?.[0] : undefined}
                                  className='size-7 text-[#d97757] hover:text-[#c66647]'
                                />
                                )}
                                {node.isSaved && node.dbNode && !node.dbNode.protocol.includes('⇋') && node.dbNode.inbound_tag && (isAdmin || userRoutedEnabled) && (
                                  <Button
                                    variant='ghost'
                                    size='icon'
                                    className='size-7 text-[#d97757] hover:text-[#c66647]'
                                    onClick={() => {
                                      setSourceNodeForLanding(node.dbNode)
                                      setLandingDialogOpen(true)
                                      setLandingStep('select')
                                      setLandingTab('nodes')
                                      setLandingFilterText('')
                                      // 普通用户只能用 routed 模式,且不能选服务器 tab
                                      if (!isAdmin) {
                                        setLandingScope('routed')
                                      }
                                    }}
                                  >
                                    <img
                                      src={ExchangeIcon}
                                      alt={t('tooltip.landingNode')}
                                      className='size-4 [filter:invert(63%)_sepia(45%)_saturate(1068%)_hue-rotate(327deg)_brightness(95%)_contrast(88%)]'
                                    />
                                  </Button>
                                )}
                                {renderUserRoutedDeleteBtn(node.dbNode)}
                                {isAdmin && node.isSaved && node.dbNode && !node.dbNode.protocol.includes('⇋') && node.dbNode.inbound_tag && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        variant='ghost'
                                        size='icon'
                                        className='size-7 text-[#d97757] hover:text-[#c66647]'
                                        onClick={() => {
                                          let serverName = node.dbNode!.original_server
                                          if (!serverName && node.dbNode!.tag?.startsWith('远程:')) {
                                            serverName = node.dbNode!.tag.slice(3)
                                          }
                                          const server = (remoteServersData?.servers || []).find(s => s.name === serverName)
                                          if (!server) { toast.error(t('toast.remoteServerNotFound')); return }
                                          setRoutingSourceNode(node.dbNode)
                                          setRoutingServerId(server.id)
                                          setRoutingServerName(server.name)
                                          setRoutingDialogOpen(true)
                                        }}
                                      >
                                        <RouteIcon className='size-4' />
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>{t('tooltip.nodeRouting')}</TooltipContent>
                                  </Tooltip>
                                )}
                                {node.isSaved && node.dbNode && !node.dbNode.protocol.includes('⇋') && !node.dbNode.inbound_tag && (isAdmin || userRoutedEnabled) && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        variant='ghost'
                                        size='icon'
                                        className='size-7 text-[#d97757] hover:text-[#c66647]'
                                        onClick={() => {
                                          setSourceNodeForChainProxy(node.dbNode)
                                          setChainProxyDialogOpen(true)
                                          setChainProxyFilterText('')
                                        }}
                                      >
                                        <img
                                          src={ExchangeIcon}
                                          alt={t('tooltip.chainProxy')}
                                          className='size-4 [filter:invert(63%)_sepia(45%)_saturate(1068%)_hue-rotate(327deg)_brightness(95%)_contrast(88%)]'
                                        />
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>{t('tooltip.chainProxy')}</TooltipContent>
                                  </Tooltip>
                                )}
                                {node.isSaved && node.dbId && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        variant='ghost'
                                        size='icon'
                                        className='size-7 text-[#d97757] hover:text-[#c66647]'
                                        onClick={() => {
                                          setTempSubSingleNodeId(node.dbId!)
                                          setTempSubUrl('')
                                          setTempSubDialogOpen(true)
                                        }}
                                      >
                                        <Link2 className='size-4' />
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>{t('tooltip.tempSubscription')}</TooltipContent>
                                  </Tooltip>
                                )}
                              </div>
                            )}
                          </div>

                          {/* 服务器地址和标签 */}
                          <div className='space-y-1.5'>
                            {node.parsed && (
                              <div className='flex items-center gap-2 flex-wrap text-xs'>
                                <span className='text-muted-foreground shrink-0'>{t('label.address')}</span>
                                <span className='font-mono break-all'>{node.parsed.server}:{node.parsed.port}</span>
                                {node.parsed.network && node.parsed.network !== 'tcp' && (
                                  <Badge variant='outline' className='text-xs'>
                                    {node.parsed.network}
                                  </Badge>
                                )}
                                {node.parsed.network === 'xhttp' && node.parsed.mode && (
                                  <Badge variant='outline' className='text-xs'>
                                    {node.parsed.mode}
                                  </Badge>
                                )}
                              </div>
                            )}
                            {(() => {
                              const tagText = getDisplayTag(node.dbNode, node.tag) ||
                                (currentTag === 'manual' ? manualTag.trim() || t('filter.manualInput')
                                  : currentTag === 'subscription' ? subscriptionTag.trim() || t('filter.subscriptionImport')
                                  : '')
                              if (!tagText) return null
                              return (
                                <div className='flex items-center gap-2 flex-wrap text-xs'>
                                  <span className='text-muted-foreground shrink-0'>{t('label.tag')}</span>
                                  <Badge variant='secondary' className='text-xs'>{tagText}</Badge>
                                </div>
                              )
                            })()}
                          </div>

                          {/* 操作按钮组 */}
                          <div className='flex items-center justify-center gap-2 pt-2 border-t' onClick={(e) => e.stopPropagation()}>
                            {node.clash && (
                              <Button
                                variant='outline'
                                size='sm'
                                className='flex-1'
                                onClick={(e) => {
                                  e.stopPropagation()
                                  if (node.isSaved && node.dbNode) {
                                    handleEditClashConfig(node.dbNode)
                                  } else if (!node.isSaved) {
                                    handleEditClashConfig(node)
                                  }
                                  setClashDialogOpen(true)
                                }}
                              >
                                <Eye className='size-4 mr-1' />
                                {t('actions.config')}
                              </Button>
                            )}
                            {node.clash && node.isSaved && (
                              <Button
                                variant='outline'
                                size='sm'
                                className='flex-1'
                                onClick={() => node.isSaved && handleCopyUri(node.dbNode!)}
                              >
                                <Copy className='size-4 mr-1' />
                                {t('actions.copy')}
                              </Button>
                            )}
                            {(isAdmin || !node.isSaved || (node.isSaved && node.dbNode?.created_by === profile?.username)) && (
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button
                                  variant='outline'
                                  size='sm'
                                  className='flex-1 text-destructive hover:text-destructive hover:bg-destructive/10'
                                  disabled={node.isSaved && isDeletingNode}
                                >
                                  {t('actions.delete')}
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>{t('dialog.confirmDelete')}</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    {t('dialog.confirmDeleteNode', { name: node.name || t('nodeList.unknown') })}
                                    {node.isSaved && t('dialog.cannotUndo')}
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>{t('actions.cancel', { ns: 'common' })}</AlertDialogCancel>
                                  <AlertDialogAction
                                    onClick={() => node.isSaved ? handleDelete(node.dbId) : handleDeleteTemp(node.id)}
                                  >
                                    {t('actions.delete')}
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                            )}
                          </div>
                        </CardContent>
                      </SortableCard>
                    ))
                  )}
                    </div>
                  </SortableContext>
                  {createPortal(
                    <DragOverlay dropAnimation={null}>
                      {activeId && (
                        <DragOverlayContent nodes={dragOverlayNodes} protocolColors={PROTOCOL_COLORS} />
                      )}
                    </DragOverlay>,
                    document.body
                  )}
                </DndContext>
                )}

                {/* 平板端和桌面端共享 DndContext */}
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                  onDragCancel={handleDragCancel}
                >
                  {/* 平板端表格视图 (768-1024px) - 和桌面一致，但服务器地址显示在节点名称下方 */}
                  {isTablet && !isDesktop && (
                  <div className='rounded-md border'>
                    <SortableContext
                    items={deferredFilteredNodes.map(n => n.id)}
                      strategy={verticalListSortingStrategy}
                    >
                    <Table className='w-full'>
                      <TableHeader>
                        <TableRow>
                          <TableHead style={{ width: '36px' }}></TableHead>
                          <TableHead style={{ width: '60px' }}>{t('columns.protocol')}</TableHead>
                          <TableHead>{t('columns.nodeName')}</TableHead>
                          {isAdmin && <TableHead style={{ width: '100px' }}>{t('columns.tag')}</TableHead>}
                          <TableHead style={{ width: '70px' }} className='text-center'>{t('columns.config')}</TableHead>
                        {isAdmin && <TableHead style={{ width: '70px' }} className='text-center'>{t('columns.actions')}</TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {deferredFilteredNodes.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={6} className='text-center text-muted-foreground py-8'>
                            {t('nodeList.noMatchingNodes')}
                          </TableCell>
                        </TableRow>
                      ) : (
                        deferredFilteredNodes.map(node => (
                          <SortableTableRow
                            key={node.id}
                            id={node.id}
                            isSaved={node.isSaved}
                            isBatchDragging={Boolean(node.dbId && batchDraggingIds.has(node.dbId))}
                            isSelected={node.isSaved && node.dbId ? selectedNodeIds.has(node.dbId) : false}
                            onClick={node.isSaved && node.dbId ? (e) => handleRowClick(e, node.dbId) : undefined}
                          >
                            <TableCell className='w-9 px-2'>
                              {node.isSaved && (
                                <DragHandle id={node.id} />
                              )}
                            </TableCell>
                            <TableCell>
                              {node.parsed || node.dbNode?.protocol ? (
                                <div className='flex flex-col items-start gap-0.5'>
                                  <Badge
                                    variant='outline'
                                    className={
                                      node.dbNode?.protocol?.includes('⇋')
                                        ? 'bg-pink-500/10 text-pink-700 border-pink-200 dark:text-pink-300 dark:border-pink-800'
                                        : PROTOCOL_COLORS[node.parsed?.type || node.dbNode?.protocol?.toLowerCase() || ''] || 'bg-gray-500/10'
                                    }
                                  >
                                    {node.dbNode?.protocol?.includes('⇋')
                                      ? node.dbNode.protocol.toUpperCase()
                                      : (node.parsed?.type || node.dbNode?.protocol || '').toUpperCase()}
                                  </Badge>
                                  {node.dbNode?.node_type === 'routed' && node.dbNode?.routed_outbound_tag && (
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <span className='text-[10px] text-indigo-600 dark:text-indigo-400 font-mono max-w-[110px] truncate'>
                                          ↳ {resolveRoutedDisplay(node.dbNode)}
                                        </span>
                                      </TooltipTrigger>
                                      <TooltipContent>
                                        <div className='text-xs'>路由出站: <span className='font-mono'>{node.dbNode.routed_outbound_tag}</span></div>
                                      </TooltipContent>
                                    </Tooltip>
                                  )}
                                </div>
                              ) : (
                                <Badge variant='destructive'>{t('nodeList.parseFailed')}</Badge>
                              )}
                            </TableCell>
                            <TableCell className='font-medium min-w-[200px] max-w-[300px]'>
                              {editingNode?.id === node.id ? (
                                <div className='min-w-0'>
                                  <div className='flex items-center gap-1'>
                                    <Input
                                      value={editingNode.value}
                                      onChange={(e) => handleNameEditChange(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                          e.preventDefault()
                                          handleNameEditSubmit(node)
                                        } else if (e.key === 'Escape') {
                                          e.preventDefault()
                                          handleNameEditCancel()
                                        }
                                      }}
                                      className='h-7 flex-1 min-w-0'
                                      autoFocus
                                      onClick={(e) => e.stopPropagation()}
                                    />
                                    <Button
                                      variant='ghost'
                                      size='icon'
                                      className='size-7 text-emerald-600 shrink-0'
                                      onClick={() => handleNameEditSubmit(node)}
                                      disabled={node.isSaved ? isUpdatingNodeName : false}
                                    >
                                      <Check className='size-3.5' />
                                    </Button>
                                    <Button
                                      variant='ghost'
                                      size='icon'
                                      className='size-7 text-muted-foreground shrink-0'
                                      onClick={handleNameEditCancel}
                                    >
                                      <X className='size-3.5' />
                                    </Button>
                                  </div>
                                  {/* 编辑时也保留服务器地址显示，避免行高变化 */}
                                  {node.parsed && (
                                    <div className='flex items-center gap-1 mt-0.5 text-xs text-muted-foreground'>
                                      <span className='font-mono truncate'>{node.parsed.server}:{node.parsed.port}</span>
                                      {node.parsed.network && node.parsed.network !== 'tcp' && (
                                        <Badge variant='outline' className='text-xs shrink-0'>
                                          {node.parsed.network}
                                        </Badge>
                                      )}
                                      {node.parsed.network === 'xhttp' && node.parsed.mode && (
                                        <Badge variant='outline' className='text-xs shrink-0'>
                                          {node.parsed.mode}
                                        </Badge>
                                      )}
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <div className='flex items-center gap-2 min-w-0'>
                                  <div className='flex-1 min-w-0'>
                                    <div className='flex items-center gap-1'>
                                      <span className='truncate'><Twemoji>{node.name || t('nodeList.unknown')}</Twemoji></span>
                                      {node.isSaved && (
                                        <Check className='size-4 text-green-600 shrink-0' />
                                      )}
                                      {renderForwardedBadge(node)}
                                    </div>
                                    {isAdmin && getNodeServerName(node.dbNode) && (
                                      <div className='text-[11px] text-muted-foreground mt-0.5 truncate'>
                                        {getNodeServerName(node.dbNode)}
                                      </div>
                                    )}
                                    {/* 服务器地址显示在节点名称下方 */}
                                    {node.parsed && (
                                      <div className='flex items-center gap-1 mt-0.5 text-xs text-muted-foreground'>
                                        <span className='font-mono truncate'>{node.parsed.server}:{node.parsed.port}</span>
                                        {node.parsed.network && node.parsed.network !== 'tcp' && (
                                          <Badge variant='outline' className='text-xs shrink-0'>
                                            {node.parsed.network}
                                          </Badge>
                                        )}
                                        {node.parsed.network === 'xhttp' && node.parsed.mode && (
                                          <Badge variant='outline' className='text-xs shrink-0'>
                                            {node.parsed.mode}
                                          </Badge>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                  {(isAdmin || !node.isSaved) && (
                                  <Button
                                    variant='ghost'
                                    size='icon'
                                    className='size-7 text-[#d97757] hover:text-[#c66647] shrink-0'
                                    onClick={() => handleNameEditStart(node)}
                                    disabled={node.isSaved ? isUpdatingNodeName : false}
                                  >
                                    <Pencil className='size-4' />
                                  </Button>
                                  )}
                                  {isAdmin && (
                                  <FlagEmojiPicker
                                    onSelect={(flag) => handleSetNodeFlag(node.id, flag)}
                                    onAutoDetect={node.isSaved && node.dbNode ? () => handleAddSingleNodeEmoji(node.dbNode!.id) : undefined}
                                    disabled={node.isSaved && node.dbNode ? addingEmojiForNode === node.dbNode.id : false}
                                    loading={node.isSaved && node.dbNode ? addingEmojiForNode === node.dbNode.id : false}
                                    currentFlag={hasRegionEmoji(node.name) ? node.name.match(/[\u{1F1E6}-\u{1F1FF}]{2}/u)?.[0] : undefined}
                                    className='size-7 text-[#d97757] hover:text-[#c66647] shrink-0'
                                  />
                                  )}
                                  {node.isSaved && node.dbNode && !node.dbNode.protocol.includes('⇋') && node.dbNode.inbound_tag && (isAdmin || userRoutedEnabled) && (
                                    <Button
                                      variant='ghost'
                                      size='icon'
                                      className='size-7 text-[#d97757] hover:text-[#c66647] shrink-0'
                                      onClick={() => {
                                        setSourceNodeForLanding(node.dbNode)
                                        setLandingDialogOpen(true)
                                        setLandingStep('select')
                                        setLandingTab('nodes')
                                        setLandingFilterText('')
                                        if (!isAdmin) {
                                          setLandingScope('routed')
                                        }
                                      }}
                                    >
                                      <img
                                        src={ExchangeIcon}
                                        alt={t('tooltip.landingNode')}
                                        className='size-4 [filter:invert(63%)_sepia(45%)_saturate(1068%)_hue-rotate(327deg)_brightness(95%)_contrast(88%)]'
                                      />
                                    </Button>
                                  )}
                                  {renderUserRoutedDeleteBtn(node.dbNode)}
                                  {isAdmin && node.isSaved && node.dbNode && !node.dbNode.protocol.includes('⇋') && node.dbNode.inbound_tag && (
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <Button
                                          variant='ghost'
                                          size='icon'
                                          className='size-7 text-[#d97757] hover:text-[#c66647] shrink-0'
                                          onClick={() => {
                                            let serverName = node.dbNode!.original_server
                                            if (!serverName && node.dbNode!.tag?.startsWith('远程:')) {
                                              serverName = node.dbNode!.tag.slice(3)
                                            }
                                            const server = (remoteServersData?.servers || []).find(s => s.name === serverName)
                                            if (!server) { toast.error(t('toast.remoteServerNotFound')); return }
                                            setRoutingSourceNode(node.dbNode)
                                            setRoutingServerId(server.id)
                                            setRoutingServerName(server.name)
                                            setRoutingDialogOpen(true)
                                          }}
                                        >
                                          <RouteIcon className='size-4' />
                                        </Button>
                                      </TooltipTrigger>
                                      <TooltipContent>{t('tooltip.nodeRouting')}</TooltipContent>
                                    </Tooltip>
                                  )}
                                  {node.isSaved && node.dbNode && !node.dbNode.protocol.includes('⇋') && !node.dbNode.inbound_tag && (isAdmin || userRoutedEnabled) && (
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <Button
                                          variant='ghost'
                                          size='icon'
                                          className='size-7 text-[#d97757] hover:text-[#c66647] shrink-0'
                                          onClick={() => {
                                            setSourceNodeForChainProxy(node.dbNode)
                                            setChainProxyDialogOpen(true)
                                            setChainProxyFilterText('')
                                          }}
                                        >
                                          <img
                                            src={ExchangeIcon}
                                            alt={t('tooltip.chainProxy')}
                                            className='size-4 [filter:invert(63%)_sepia(45%)_saturate(1068%)_hue-rotate(327deg)_brightness(95%)_contrast(88%)]'
                                          />
                                        </Button>
                                      </TooltipTrigger>
                                      <TooltipContent>{t('tooltip.chainProxy')}</TooltipContent>
                                    </Tooltip>
                                  )}
                                </div>
                              )}
                            </TableCell>
                            {isAdmin && (
                            <TableCell>
                              <div className='flex flex-wrap gap-1'>
                                {(() => {
                                  const tagText = getDisplayTag(node.dbNode, node.tag) ||
                                    (currentTag === 'manual' ? manualTag.trim() || t('filter.manualInput')
                                      : currentTag === 'subscription' ? subscriptionTag.trim() || t('filter.subscriptionImport')
                                      : '')
                                  if (!tagText) return null
                                  return (
                                    <Badge variant='secondary' className='text-xs max-w-[90px] truncate'>{tagText}</Badge>
                                  )
                                })()}
                              </div>
                            </TableCell>
                            )}
                            <TableCell className='text-center'>
                              {node.clash ? (
                                <div className='flex gap-1 justify-center'>
                                  <Button
                                    variant='ghost'
                                    size='icon'
                                    className='h-7 w-7'
                                    onClick={() => {
                                      if (node.isSaved && node.dbNode) {
                                        handleEditClashConfig(node.dbNode)
                                      } else if (!node.isSaved) {
                                        handleEditClashConfig(node)
                                      }
                                    }}
                                  >
                                    <Eye className='h-4 w-4' />
                                  </Button>
                                  {node.isSaved && (
                                    <Button
                                      variant='ghost'
                                      size='icon'
                                      className='h-7 w-7'
                                      title={t('tooltip.copyUri')}
                                      onClick={() => handleCopyUri(node.dbNode!)}
                                    >
                                      <Copy className='h-4 w-4' />
                                    </Button>
                                  )}
                                </div>
                              ) : (
                                <span className='text-xs text-muted-foreground'>-</span>
                              )}
                            </TableCell>
                            {isAdmin && (
                            <TableCell className='text-center'>
                              {(isAdmin || !node.isSaved || (node.isSaved && node.dbNode?.created_by === profile?.username)) && (
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button
                                    variant='ghost'
                                    size='sm'
                                    className='h-7 text-xs'
                                    disabled={node.isSaved && isDeletingNode}
                                  >
                                    {t('actions.delete')}
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>{t('dialog.confirmDelete')}</AlertDialogTitle>
                                    <AlertDialogDescription>
                                      {t('dialog.confirmDeleteNode', { name: node.name || t('nodeList.unknown') })}
                                      {node.isSaved && t('dialog.cannotUndo')}
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>{t('actions.cancel', { ns: 'common' })}</AlertDialogCancel>
                                    <AlertDialogAction
                                      onClick={() => node.isSaved ? handleDelete(node.dbId) : handleDeleteTemp(node.id)}
                                    >
                                      {t('actions.delete')}
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                              )}
                            </TableCell>
                            )}
                          </SortableTableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                  </SortableContext>
                </div>
                  )}

                  {/* 桌面端表格视图 (>=1024px) */}
                  {isDesktop && (
                  <div className='rounded-md border'>
                    <SortableContext
                      items={deferredFilteredNodes.map(n => n.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      <Table className='w-full'>
                        <TableHeader>
                          <TableRow>
                            <TableHead style={{ width: '36px' }}></TableHead>
                            <TableHead style={{ width: '90px' }}>{t('columns.protocol')}</TableHead>
                            <TableHead>{t('columns.nodeName')}</TableHead>
                            {isAdmin && <TableHead style={{ width: '120px' }}>{t('columns.tag')}</TableHead>}
                            <TableHead style={{ width: '280px', maxWidth: '280px' }}>{t('columns.serverAddress')}</TableHead>
                            <TableHead style={{ width: '80px' }} className='text-center'>{t('columns.config')}</TableHead>
                            {isAdmin && <TableHead style={{ width: '80px' }} className='text-center'>{t('columns.actions')}</TableHead>}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {deferredFilteredNodes.length === 0 ? (
                            <TableRow>
                              <TableCell colSpan={7} className='text-center text-muted-foreground py-8'>
                                {t('nodeList.noMatchingNodes')}
                              </TableCell>
                            </TableRow>
                          ) : (
                            deferredFilteredNodes.map(node => (
                          <SortableTableRow
                            key={node.id}
                            id={node.id}
                            isSaved={node.isSaved}
                            isBatchDragging={Boolean(node.dbId && batchDraggingIds.has(node.dbId))}
                            isSelected={node.isSaved && node.dbId ? selectedNodeIds.has(node.dbId) : false}
                            onClick={node.isSaved && node.dbId ? (e) => handleRowClick(e, node.dbId) : undefined}
                          >
                                <TableCell className='w-9 px-2'>
                                  {node.isSaved && (
                                    <DragHandle id={node.id} />
                                  )}
                                </TableCell>
                                <TableCell>
                              {node.parsed || node.dbNode?.protocol ? (
                                <div className='flex flex-col items-start gap-0.5'>
                                  <Badge
                                    variant='outline'
                                    className={
                                      node.dbNode?.protocol?.includes('⇋')
                                        ? 'bg-pink-500/10 text-pink-700 border-pink-200 dark:text-pink-300 dark:border-pink-800'
                                        : PROTOCOL_COLORS[node.parsed?.type || node.dbNode?.protocol?.toLowerCase() || ''] || 'bg-gray-500/10'
                                    }
                                  >
                                    {node.dbNode?.protocol?.includes('⇋')
                                      ? node.dbNode.protocol.toUpperCase()
                                      : (node.parsed?.type || node.dbNode?.protocol || '').toUpperCase()}
                                  </Badge>
                                  {node.dbNode?.node_type === 'routed' && node.dbNode?.routed_outbound_tag && (
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <span className='text-[10px] text-indigo-600 dark:text-indigo-400 font-mono max-w-[110px] truncate'>
                                          ↳ {resolveRoutedDisplay(node.dbNode)}
                                        </span>
                                      </TooltipTrigger>
                                      <TooltipContent>
                                        <div className='text-xs'>路由出站: <span className='font-mono'>{node.dbNode.routed_outbound_tag}</span></div>
                                      </TooltipContent>
                                    </Tooltip>
                                  )}
                                </div>
                              ) : (
                                <Badge variant='destructive'>{t('nodeList.parseFailed')}</Badge>
                              )}
                            </TableCell>
                            <TableCell className='font-medium min-w-[200px] max-w-[300px]'>
                              {editingNode?.id === node.id ? (
                                <div className='flex items-center gap-1'>
                                  <Input
                                    value={editingNode.value}
                                    onChange={(event) => handleNameEditChange(event.target.value)}
                                    onKeyDown={(event) => {
                                      if (event.key === 'Enter') {
                                        event.preventDefault()
                                        handleNameEditSubmit(node)
                                      } else if (event.key === 'Escape') {
                                        event.preventDefault()
                                        handleNameEditCancel()
                                      }
                                    }}
                                    className='h-7 flex-1 min-w-0'
                                    autoFocus
                                  />
                                  <Button
                                    variant='ghost'
                                    size='icon'
                                    className='size-7 text-emerald-600 shrink-0'
                                    onClick={() => handleNameEditSubmit(node)}
                                    disabled={node.isSaved ? isUpdatingNodeName : false}
                                  >
                                    <Check className='size-3.5' />
                                  </Button>
                                  <Button
                                    variant='ghost'
                                    size='icon'
                                    className='size-7 text-muted-foreground shrink-0'
                                    onClick={handleNameEditCancel}
                                  >
                                    <X className='size-3.5' />
                                  </Button>
                                </div>
                              ) : (
                                <div className='min-w-0'>
                                <div className='flex items-center gap-2 min-w-0'>
                                  <span className='truncate flex-1 min-w-0' title={node.name || t('nodeList.unknown')}><Twemoji>{node.name || t('nodeList.unknown')}</Twemoji></span>
                                  {node.isSaved && (
                                    <Check className='size-4 text-green-600 shrink-0' />
                                  )}
                                  {renderForwardedBadge(node)}
                                  {(isAdmin || !node.isSaved) && (
                                  <Button
                                    variant='ghost'
                                    size='icon'
                                    className='size-7 text-[#d97757] hover:text-[#c66647] shrink-0'
                                    onClick={() => handleNameEditStart(node)}
                                    disabled={node.isSaved ? isUpdatingNodeName : false}
                                  >
                                    <Pencil className='size-4' />
                                  </Button>
                                  )}
                                  {node.isSaved && node.dbNode && !node.dbNode.protocol.includes('⇋') && node.dbNode.inbound_tag && (isAdmin || userRoutedEnabled) && (
                                    <Button
                                      variant='ghost'
                                      size='icon'
                                      className='size-7 text-muted-foreground hover:text-foreground shrink-0'
                                      onClick={() => {
                                        setSourceNodeForLanding(node.dbNode)
                                        setLandingDialogOpen(true)
                                        setLandingStep('select')
                                        setLandingTab('nodes')
                                        setLandingFilterText('')
                                        if (!isAdmin) {
                                          setLandingScope('routed')
                                        }
                                      }}
                                    >
                                      <img
                                        src={ExchangeIcon}
                                        alt={t('tooltip.landingNode')}
                                        className='size-4 [filter:invert(63%)_sepia(45%)_saturate(1068%)_hue-rotate(327deg)_brightness(95%)_contrast(88%)]'
                                      />
                                    </Button>
                                  )}
                                  {renderUserRoutedDeleteBtn(node.dbNode)}
                                  {isAdmin && node.isSaved && node.dbNode && !node.dbNode.protocol.includes('⇋') && node.dbNode.inbound_tag && (
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <Button
                                          variant='ghost'
                                          size='icon'
                                          className='size-7 text-[#d97757] hover:text-[#c66647] shrink-0'
                                          onClick={() => {
                                            let serverName = node.dbNode!.original_server
                                            if (!serverName && node.dbNode!.tag?.startsWith('远程:')) {
                                              serverName = node.dbNode!.tag.slice(3)
                                            }
                                            const server = (remoteServersData?.servers || []).find(s => s.name === serverName)
                                            if (!server) { toast.error(t('toast.remoteServerNotFound')); return }
                                            setRoutingSourceNode(node.dbNode)
                                            setRoutingServerId(server.id)
                                            setRoutingServerName(server.name)
                                            setRoutingDialogOpen(true)
                                          }}
                                        >
                                          <RouteIcon className='size-4' />
                                        </Button>
                                      </TooltipTrigger>
                                      <TooltipContent>{t('tooltip.nodeRouting')}</TooltipContent>
                                    </Tooltip>
                                  )}
                                  {node.isSaved && node.dbNode && !node.dbNode.protocol.includes('⇋') && !node.dbNode.inbound_tag && (isAdmin || userRoutedEnabled) && (
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <Button
                                          variant='ghost'
                                          size='icon'
                                          className='size-7 text-[#d97757] hover:text-[#c66647] shrink-0'
                                          onClick={() => {
                                            setSourceNodeForChainProxy(node.dbNode)
                                            setChainProxyDialogOpen(true)
                                            setChainProxyFilterText('')
                                          }}
                                        >
                                          <img
                                            src={ExchangeIcon}
                                            alt={t('tooltip.chainProxy')}
                                            className='size-4 [filter:invert(63%)_sepia(45%)_saturate(1068%)_hue-rotate(327deg)_brightness(95%)_contrast(88%)]'
                                          />
                                        </Button>
                                      </TooltipTrigger>
                                      <TooltipContent>{t('tooltip.chainProxy')}</TooltipContent>
                                    </Tooltip>
                                  )}
                                  {isAdmin && (
                                  <FlagEmojiPicker
                                    onSelect={(flag) => handleSetNodeFlag(node.id, flag)}
                                    onAutoDetect={node.isSaved && node.dbNode ? () => handleAddSingleNodeEmoji(node.dbNode!.id) : undefined}
                                    disabled={node.isSaved && node.dbNode ? addingEmojiForNode === node.dbNode.id : false}
                                    loading={node.isSaved && node.dbNode ? addingEmojiForNode === node.dbNode.id : false}
                                    currentFlag={hasRegionEmoji(node.name) ? node.name.match(/[\u{1F1E6}-\u{1F1FF}]{2}/u)?.[0] : undefined}
                                    className='size-7 text-[#d97757] hover:text-[#c66647] shrink-0'
                                  />
                                  )}
                                </div>
                                {isAdmin && getNodeServerName(node.dbNode) && (
                                  <div className='text-[11px] text-muted-foreground mt-0.5 truncate'>
                                    {getNodeServerName(node.dbNode)}
                                  </div>
                                )}
                                </div>
                              )}
                            </TableCell>
                            {isAdmin && (
                            <TableCell>
                              <div className='flex flex-wrap gap-1'>
                                {(() => {
                                  const tagText = getDisplayTag(node.dbNode, node.tag) ||
                                    (currentTag === 'manual' ? manualTag.trim() || t('filter.manualInput')
                                      : currentTag === 'subscription' ? subscriptionTag.trim() || t('filter.subscriptionImport')
                                      : '')
                                  if (!tagText) return null
                                  return (
                                    <Badge
                                      variant='secondary'
                                      className='text-xs max-w-[120px] truncate'
                                      title={tagText}
                                    >
                                      {tagText}
                                    </Badge>
                                  )
                                })()}
                              </div>
                            </TableCell>
                            )}
                            <TableCell style={{ maxWidth: '280px' }}>
                              <div className='text-sm text-muted-foreground'>
                                {node.parsed ? (
                                  <div className='flex items-center gap-2 min-w-0'>
                                    <div className='min-w-0 flex-1'>
                                      <div className='font-mono truncate' title={`${node.parsed.server}:${node.parsed.port}`}>{node.parsed.server}:{node.parsed.port}</div>
                                      {node.parsed.network && node.parsed.network !== 'tcp' && (
                                        <div className='text-xs mt-1 flex items-center gap-1'>
                                          <Badge variant='outline' className='text-xs'>
                                            {node.parsed.network}
                                          </Badge>
                                          {node.parsed.network === 'xhttp' && node.parsed.mode && (
                                            <Badge variant='outline' className='text-xs'>
                                              {node.parsed.mode}
                                            </Badge>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                    {isAdmin && node.parsed?.server && (
                                      (() => {
                                        const nodeKey = node.isSaved ? String(node.dbId) : node.id
                                        const serverIsIp = isIpAddress(node.parsed.server)
                                        const hasOriginalServer = !node.isSaved && node.originalServer

                                        // 已保存的节点且服务器地址已经是IP，不显示按钮
                                        if (node.isSaved && serverIsIp) {
                                          return null
                                        }

                                        // 未保存的节点且有原始服务器地址，显示回退按钮
                                        if (hasOriginalServer) {
                                          return (
                                            <Button
                                              variant='ghost'
                                              size='sm'
                                              className='size-6 p-0 border border-orange-500/50 hover:border-orange-500 shrink-0'
                                              title={t('tooltip.restoreDomain')}
                                              onClick={() => restoreTempNodeServer(node.id)}
                                            >
                                              <Undo2 className='size-4 text-orange-500' />
                                            </Button>
                                          )
                                        }

                                        // 显示IP解析菜单或按钮
                                        return ipMenuState?.nodeId === nodeKey ? (
                                          <DropdownMenu open={true} onOpenChange={(open) => !open && setIpMenuState(null)}>
                                            <DropdownMenuTrigger asChild>
                                              <Button
                                                variant='ghost'
                                                size='sm'
                                                className='size-6 p-0 border border-primary/50 hover:border-primary shrink-0'
                                                title={t('tooltip.selectIp')}
                                              >
                                                <img
                                                  src={IpIcon}
                                                  alt='IP'
                                                  className='size-4 [filter:invert(63%)_sepia(45%)_saturate(1068%)_hue-rotate(327deg)_brightness(95%)_contrast(88%)]'
                                                />
                                              </Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align='start'>
                                              {ipMenuState.ips.map((ip) => (
                                                <DropdownMenuItem
                                                  key={ip}
                                                  onClick={() => {
                                                    if (node.isSaved && node.dbId) {
                                                      updateNodeServerMutation.mutate({
                                                        nodeId: node.dbId,
                                                        server: ip,
                                                      })
                                                    } else {
                                                      updateTempNodeServer(node.id, ip)
                                                      setIpMenuState(null)
                                                    }
                                                  }}
                                                >
                                                  <span className='font-mono'>{ip}</span>
                                                </DropdownMenuItem>
                                              ))}
                                            </DropdownMenuContent>
                                          </DropdownMenu>
                                        ) : (
                                          <Button
                                            variant='ghost'
                                            size='sm'
                                            className='size-6 p-0 border border-primary/50 hover:border-primary shrink-0'
                                            title={t('tooltip.resolveIp')}
                                            disabled={resolvingIpFor === nodeKey}
                                            onClick={() => handleResolveIp(node)}
                                          >
                                            <img
                                              src={IpIcon}
                                              alt='IP'
                                              className='size-4 [filter:invert(63%)_sepia(45%)_saturate(1068%)_hue-rotate(327deg)_brightness(95%)_contrast(88%)]'
                                            />
                                          </Button>
                                        )
                                      })()
                                    )}
                                    {isAdmin && node.isSaved && node.dbNode?.original_domain && (
                                      <Button
                                        variant='ghost'
                                        size='sm'
                                        className='size-6 p-0 border border-primary/50 hover:border-primary ml-1 shrink-0'
                                        title={t('tooltip.restoreDomain')}
                                        disabled={restoreNodeServerMutation.isPending}
                                        onClick={() => restoreNodeServerMutation.mutate(node.dbId)}
                                      >
                                        <Undo2 className='size-3' />
                                      </Button>
                                    )}
                                    {/* TCPing 延迟测试按钮 */}
                                    {node.parsed && (
                                      (() => {
                                        const nodeKey = node.isSaved ? String(node.dbId) : node.id
                                        const tcpingResult = tcpingResults[nodeKey]
                                        const isLoading = tcpingNodeId === nodeKey || tcpingResult?.loading

                                        // 测试成功后显示延迟数字
                                        if (tcpingResult?.success && !isLoading) {
                                          const latencyColor = tcpingResult.latency < 100
                                            ? 'border-green-500/50 hover:border-green-500 text-green-600'
                                            : tcpingResult.latency < 200
                                              ? 'border-orange-500/50 hover:border-orange-500 text-orange-500'
                                              : 'border-red-500/50 hover:border-red-500 text-red-500'
                                          return (
                                            <Tooltip>
                                              <TooltipTrigger asChild>
                                                <Button
                                                  variant='ghost'
                                                  size='sm'
                                                  className={`h-5 px-1 text-xs font-mono border shrink-0 ml-1 ${latencyColor}`}
                                                  onClick={() => handleTcping(node)}
                                                >
                                                  {tcpingResult.latency < 1000
                                                    ? `${Math.round(tcpingResult.latency)}ms`
                                                    : `${(tcpingResult.latency / 1000).toFixed(1)}s`}
                                                </Button>
                                              </TooltipTrigger>
                                              <TooltipContent>{t('tcping.retest')}</TooltipContent>
                                            </Tooltip>
                                          )
                                        }

                                        // 测试失败显示超时
                                        if (tcpingResult && !tcpingResult.success && !isLoading) {
                                          return (
                                            <Tooltip>
                                              <TooltipTrigger asChild>
                                                <Button
                                                  variant='ghost'
                                                  size='sm'
                                                  className='h-5 px-1 text-xs font-mono border border-red-500/50 hover:border-red-500 text-red-500 shrink-0 ml-1'
                                                  onClick={() => handleTcping(node)}
                                                >
                                                  {t('tcping.timeout')}
                                                </Button>
                                              </TooltipTrigger>
                                              <TooltipContent>{tcpingResult.error || t('toast.connectionTimeout')}</TooltipContent>
                                            </Tooltip>
                                          )
                                        }

                                        // 默认显示测试按钮
                                        return (
                                          <Tooltip>
                                            <TooltipTrigger asChild>
                                              <Button
                                                variant='ghost'
                                                size='sm'
                                                className='size-6 p-0 border border-primary/50 hover:border-primary ml-1 shrink-0'
                                                title={t('tcping.testBtn')}
                                                disabled={isLoading}
                                                onClick={() => handleTcping(node)}
                                              >
                                                {isLoading ? (
                                                  <Activity className='size-4 animate-pulse' />
                                                ) : (
                                                  <Activity className='size-4' />
                                                )}
                                              </Button>
                                            </TooltipTrigger>
                                            <TooltipContent>{t('tcping.tcpingTest')}</TooltipContent>
                                          </Tooltip>
                                        )
                                      })()
                                    )}
                                  </div>
                                ) : (
                                  '-'
                                )}
                              </div>
                            </TableCell>
                            <TableCell className='text-center'>
                              {node.clash ? (
                                <div className='flex gap-1 justify-center'>
                                  <Dialog
                                    open={clashDialogOpen && (
                                      (node.isSaved && editingClashConfig?.nodeId === node.dbNode?.id) ||
                                      (!node.isSaved && editingClashConfig?.nodeId === -1)
                                    )}
                                    onOpenChange={(open) => {
                                      setClashDialogOpen(open)
                                      if (!open) {
                                        // Dialog关闭后清理状态
                                        setTimeout(() => {
                                          setEditingClashConfig(null)
                                          setClashConfigError('')
                                          setJsonErrorLines([])
                                        }, 150) // 等待关闭动画完成
                                      }
                                    }}
                                  >
                                    <DialogTrigger asChild>
                                      <Button
                                        variant='ghost'
                                        size='icon'
                                        className='h-8 w-8'
                                        onClick={() => {
                                          if (node.isSaved && node.dbNode) {
                                            handleEditClashConfig(node.dbNode)
                                          } else if (!node.isSaved) {
                                            handleEditClashConfig(node)
                                          }
                                        }}
                                      >
                                        <Eye className='h-4 w-4' />
                                      </Button>
                                    </DialogTrigger>
                                    <DialogContent className='max-w-4xl sm:max-w-4xl max-h-[80vh] flex flex-col'>
                                    <DialogHeader>
                                      <DialogTitle>
                                        {editingClashConfig?.nodeId === -1 ? t('dialog.clashConfig.titleReadonly') : t('dialog.clashConfig.title')}
                                      </DialogTitle>
                                      <DialogDescription>
                                        <Twemoji>{node.name || t('nodeList.unknown')}</Twemoji>
                                        {editingClashConfig?.nodeId === -1 && ` - ${t('dialog.clashConfig.saveAfterCreate')}`}
                                      </DialogDescription>
                                    </DialogHeader>
                                    <div className='mt-4 flex-1 flex flex-col gap-3 min-h-0'>
                                      <div className='flex-1 flex border rounded overflow-hidden bg-muted'>
                                        {/* 行号列 */}
                                        <div className='flex flex-col bg-muted-foreground/10 text-muted-foreground text-xs font-mono select-none py-3 px-2 text-right'>
                                          {editingClashConfig?.config.split('\n').map((_, i) => {
                                            const lineNum = i + 1
                                            const isErrorLine = jsonErrorLines.includes(lineNum)
                                            return (
                                              <div
                                                key={i}
                                                className={`leading-5 h-5 ${isErrorLine ? 'bg-destructive/20 text-destructive font-bold' : ''}`}
                                              >
                                                {lineNum}
                                              </div>
                                            )
                                          })}
                                        </div>
                                        {/* 文本编辑区 */}
                                        <Textarea
                                          value={editingClashConfig?.config || ''}
                                          onChange={(e) => handleClashConfigChange(e.target.value)}
                                          className='font-mono text-xs flex-1 min-h-[400px] resize-none border-0 rounded-none focus-visible:ring-0 leading-5'
                                          placeholder={t('dialog.clashConfig.inputPlaceholder')}
                                          readOnly={editingClashConfig?.nodeId === -1 || !isAdmin}
                                        />
                                      </div>
                                      {clashConfigError && (
                                        <div className='text-xs text-destructive bg-destructive/10 p-2 rounded'>
                                          {clashConfigError}
                                        </div>
                                      )}
                                      <div className='flex gap-2 justify-end'>
                                        <Button
                                          variant='outline'
                                          size='sm'
                                          onClick={() => setClashDialogOpen(false)}
                                        >
                                          {editingClashConfig?.nodeId === -1 ? t('dialog.clashConfig.close') : t('actions.cancel', { ns: 'common' })}
                                        </Button>
                                        {editingClashConfig?.nodeId !== -1 && isAdmin && (
                                          <Button
                                            size='sm'
                                            onClick={handleSaveClashConfig}
                                            disabled={!!clashConfigError || updateClashConfigMutation.isPending}
                                          >
                                            {updateClashConfigMutation.isPending ? t('actions.saving', { ns: 'common' }) : t('actions.save', { ns: 'common' })}
                                          </Button>
                                        )}
                                      </div>
                                    </div>
                                  </DialogContent>
                                </Dialog>
                                <Button
                                  variant='ghost'
                                  size='icon'
                                  className='h-8 w-8'
                                  title={t('tooltip.copyUri')}
                                  onClick={() => node.isSaved && handleCopyUri(node.dbNode!)}
                                >
                                  <Copy className='h-4 w-4' />
                                </Button>
                                <Button
                                  variant='ghost'
                                  size='icon'
                                  className='h-8 w-8'
                                  title={t('tooltip.tempSubscription')}
                                  onClick={() => {
                                    if (node.isSaved && node.dbId) {
                                      setTempSubSingleNodeId(node.dbId)
                                      setTempSubUrl('')
                                      setTempSubDialogOpen(true)
                                    }
                                  }}
                                >
                                  <Link2 className='h-4 w-4' />
                                </Button>
                              </div>
                              ) : (
                                <span className='text-xs text-muted-foreground'>-</span>
                              )}
                            </TableCell>
                            {isAdmin && (
                            <TableCell className='text-center'>
                              {(isAdmin || !node.isSaved || (node.isSaved && node.dbNode?.created_by === profile?.username)) && (
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button
                                    variant='ghost'
                                    size='sm'
                                    disabled={node.isSaved && isDeletingNode}
                                  >
                                    {t('actions.delete')}
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>{t('dialog.confirmDelete')}</AlertDialogTitle>
                                    <AlertDialogDescription>
                                      {t('dialog.confirmDeleteNode', { name: node.name || t('nodeList.unknown') })}
                                      {node.isSaved && t('dialog.cannotUndo')}
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>{t('actions.cancel', { ns: 'common' })}</AlertDialogCancel>
                                    <AlertDialogAction
                                      onClick={() => node.isSaved ? handleDelete(node.dbId) : handleDeleteTemp(node.id)}
                                    >
                                      {t('actions.delete')}
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                              )}
                                </TableCell>
                                )}
                              </SortableTableRow>
                            ))
                          )}
                        </TableBody>
                      </Table>
                    </SortableContext>
                  </div>
                  )}

                  {createPortal(
                    <DragOverlay dropAnimation={null}>
                      {activeId && (
                        <DragOverlayContent nodes={dragOverlayNodes} protocolColors={PROTOCOL_COLORS} />
                      )}
                    </DragOverlay>,
                    document.body
                  )}
                </DndContext>
              </CardContent>
            </Card>
          )}
        </section>
      </main>

      {/* Clash 配置对话框 - 独立于表格，供移动端和平板端使用 */}
      <Dialog
        open={clashDialogOpen && editingClashConfig !== null}
        onOpenChange={(open) => {
          setClashDialogOpen(open)
          if (!open) {
            setTimeout(() => {
              setEditingClashConfig(null)
              setClashConfigError('')
              setJsonErrorLines([])
            }, 150)
          }
        }}
      >
        <DialogContent className='max-w-4xl sm:max-w-4xl max-h-[80vh] flex flex-col'>
          <DialogHeader>
            <DialogTitle>
              {editingClashConfig?.nodeId === -1 ? t('dialog.clashConfig.titleReadonly') : t('dialog.clashConfig.title')}
            </DialogTitle>
            <DialogDescription>
              {editingClashConfig?.nodeId === -1 && t('dialog.clashConfig.saveAfterCreate')}
            </DialogDescription>
          </DialogHeader>
          <div className='mt-4 flex-1 flex flex-col gap-3 min-h-0'>
            <div className='flex-1 flex border rounded overflow-hidden bg-muted'>
              {/* 行号列 */}
              <div className='flex flex-col bg-muted-foreground/10 text-muted-foreground text-xs font-mono select-none py-3 px-2 text-right'>
                {editingClashConfig?.config.split('\n').map((_, i) => {
                  const lineNum = i + 1
                  const isErrorLine = jsonErrorLines.includes(lineNum)
                  return (
                    <div
                      key={i}
                      className={`leading-5 h-5 ${isErrorLine ? 'bg-destructive/20 text-destructive font-bold' : ''}`}
                    >
                      {lineNum}
                    </div>
                  )
                })}
              </div>
              {/* 文本编辑区 */}
              <Textarea
                value={editingClashConfig?.config || ''}
                onChange={(e) => handleClashConfigChange(e.target.value)}
                className='font-mono text-xs flex-1 min-h-[400px] resize-none border-0 rounded-none focus-visible:ring-0 leading-5'
                placeholder={t('dialog.clashConfig.inputPlaceholder')}
                readOnly={editingClashConfig?.nodeId === -1 || !isAdmin}
              />
            </div>
            {clashConfigError && (
              <div className='text-xs text-destructive bg-destructive/10 p-2 rounded'>
                {clashConfigError}
              </div>
            )}
            <div className='flex gap-2 justify-end'>
              <Button
                variant='outline'
                size='sm'
                onClick={() => setClashDialogOpen(false)}
              >
                {editingClashConfig?.nodeId === -1 ? t('dialog.clashConfig.close') : t('actions.cancel', { ns: 'common' })}
              </Button>
              {editingClashConfig?.nodeId !== -1 && isAdmin && (
                <Button
                  size='sm'
                  onClick={handleSaveClashConfig}
                  disabled={!!clashConfigError || updateClashConfigMutation.isPending}
                >
                  {updateClashConfigMutation.isPending ? t('actions.saving', { ns: 'common' }) : t('actions.save', { ns: 'common' })}
                </Button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* URI 手动复制对话框 */}
      <Dialog open={uriDialogOpen} onOpenChange={setUriDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('dialog.uriCopy.title')}</DialogTitle>
            <DialogDescription>
              {t('dialog.uriCopy.description')}
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-4 py-4'>
            <div className='p-3 bg-muted rounded-md'>
              <code className='text-xs break-all'>{uriContent}</code>
            </div>
            <div className='flex justify-end gap-2'>
              <Button
                variant='outline'
                onClick={() => setUriDialogOpen(false)}
              >
                {t('dialog.clashConfig.close')}
              </Button>
              <Button
                onClick={() => {
                  navigator.clipboard.writeText(uriContent).then(() => {
                    toast.success(t('toast.uriCopied'))
                    setUriDialogOpen(false)
                  }).catch(() => {
                    toast.error(t('dialog.uriCopy.copyFailedRetry'))
                  })
                }}
              >
                {t('dialog.uriCopy.retryBtn')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 落地节点对话框 */}
      <Dialog open={landingDialogOpen} onOpenChange={(open) => {
        setLandingDialogOpen(open)
        if (!open) {
          setLandingFilterText('')
          setLandingTagFilter('all')
          setLandingStep('select')
          setLandingServerId(null)
          setLandingScope('all')
          setLandingRoutedLabel('')
          setRoutedTargetNode(null)
        }
      }}>
        <DialogContent className={landingStep === 'create-inbound' ? 'max-w-[95vw] sm:max-w-[95vw] max-h-[90vh] overflow-y-auto' : 'max-w-2xl sm:max-w-2xl max-h-[80vh] overflow-y-auto'}>
          <DialogHeader>
            <DialogTitle>{landingStep === 'create-inbound' ? t('dialog.landing.createInboundTitle') : t('dialog.landing.addLandingTitle')}</DialogTitle>
            <DialogDescription>
              {landingStep === 'create-inbound'
                ? t('dialog.landing.createInboundDesc', { serverName: remoteServers.find(s => s.id === landingServerId)?.name || '', nodeName: sourceNodeForLanding?.node_name })
                : t('dialog.landing.addLandingDesc', { name: sourceNodeForLanding?.node_name })}
            </DialogDescription>
          </DialogHeader>

          {landingStep === 'select' ? (
            <>
              {/* 作用范围:管理员可在"整个节点"和"按用户(路由出站)"间切换;普通用户只能用路由出站 */}
              <div className='space-y-2 mb-3 p-3 rounded-md border bg-muted/30'>
                {isAdmin ? (
                  <>
                    <Label className='text-xs font-medium'>作用范围</Label>
                    <RadioGroup value={landingScope} onValueChange={(v) => setLandingScope(v as 'all' | 'routed')} className='gap-2'>
                      <div className='flex items-start gap-2'>
                        <RadioGroupItem value='all' id='scope-all' className='mt-0.5' />
                        <label htmlFor='scope-all' className='text-sm cursor-pointer'>
                          <div className='font-medium'>整个节点</div>
                          <div className='text-xs text-muted-foreground'>源 inbound 的所有用户共享此落地(现有行为)</div>
                        </label>
                      </div>
                      <div className='flex items-start gap-2'>
                        <RadioGroupItem value='routed' id='scope-routed' className='mt-0.5' />
                        <label htmlFor='scope-routed' className='text-sm cursor-pointer'>
                          <div className='font-medium'>按用户(路由出站)</div>
                          <div className='text-xs text-muted-foreground'>创建一个路由出站子节点;套餐里加入该子节点,绑定用户自动开子账号走此落地</div>
                        </label>
                      </div>
                    </RadioGroup>
                  </>
                ) : (
                  <div className='space-y-1'>
                    <Label className='text-xs font-medium'>路由出站(按用户)</Label>
                    {!userRoutedEnabled ? (
                      <p className='text-xs text-destructive'>管理员暂未开放路由出站功能</p>
                    ) : (
                      <>
                        <p className='text-xs text-muted-foreground'>
                          选择一个落地节点,系统会为你创建专属出站。
                          数量 {userRoutedQuota.used} / {userRoutedQuota.max} · 今日操作 {userRoutedDaily.used} / {userRoutedDaily.max}
                        </p>
                        {userRoutedQuotaExhausted && (
                          <p className='text-xs text-destructive'>已达数量上限,需删除旧的或联系管理员调整</p>
                        )}
                        {!userRoutedQuotaExhausted && userRoutedDailyExhausted && (
                          <p className='text-xs text-destructive'>今日操作次数已用完,请明天再试</p>
                        )}
                      </>
                    )}
                  </div>
                )}
                {landingScope === 'routed' && (
                  <div className='pt-2 space-y-2'>
                    <div className='space-y-1'>
                      <Label className='text-xs'>Label(用于生成 outbound tag)</Label>
                      <Input
                        value={landingRoutedLabel}
                        onChange={(e) => setLandingRoutedLabel(e.target.value)}
                        placeholder='选择目标节点后自动填 rout-<节点名>,也可手动改'
                        className='text-sm h-8'
                      />
                      <p className='text-[10px] text-muted-foreground'>[a-zA-Z0-9-] 长度 2-32</p>
                    </div>
                    {routedTargetNode && (
                      <div className='flex items-center justify-between gap-2 p-2 rounded-md bg-primary/5 border border-primary/20 text-xs'>
                        <div className='min-w-0'>
                          <div className='font-medium truncate'>已选目标:{routedTargetNode.node_name}</div>
                          <div className='text-muted-foreground truncate'>{routedTargetNode.protocol} · {routedTargetNode.original_server}</div>
                        </div>
                        <Button
                          size='sm'
                          className='shrink-0'
                          onClick={() => {
                            if (!sourceNodeForLanding) return
                            if (isAdmin) {
                              addRoutedLandingMutation.mutate({ sourceNode: sourceNodeForLanding, targetNode: routedTargetNode, label: landingRoutedLabel })
                            } else {
                              addUserRoutedLandingMutation.mutate({ sourceNode: sourceNodeForLanding, targetNode: routedTargetNode, label: landingRoutedLabel })
                            }
                          }}
                          disabled={
                            !landingRoutedLabel.trim() ||
                            addRoutedLandingMutation.isPending ||
                            addUserRoutedLandingMutation.isPending ||
                            (!isAdmin && (!userRoutedEnabled || userRoutedQuotaExhausted || userRoutedDailyExhausted))
                          }
                        >
                          {(addRoutedLandingMutation.isPending || addUserRoutedLandingMutation.isPending) ? '创建中...' : '创建路由出站'}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            <Tabs value={landingTab} onValueChange={(v) => setLandingTab(v as 'nodes' | 'servers')}>
              {isAdmin && (
                <TabsList className='w-full'>
                  <TabsTrigger value='nodes' className='flex-1'>{t('dialog.landing.tabNodes')}</TabsTrigger>
                  <TabsTrigger value='servers' className='flex-1'>{t('dialog.landing.tabServers')}</TabsTrigger>
                </TabsList>
              )}

              <TabsContent value='nodes' className='space-y-3 pt-2'>
                <Input
                  placeholder={t('dialog.landing.searchPlaceholder')}
                  value={landingFilterText}
                  onChange={(e) => setLandingFilterText(e.target.value)}
                  className='text-sm'
                />
                {/* 快捷标签筛选:把节点里出现过的 tag 列出来,点一下按 tag 过滤 */}
                {(() => {
                  const tags = Array.from(new Set(
                    savedNodes
                      .filter((n: any) => n.id !== sourceNodeForLanding?.id && !n.protocol.includes('⇋') && n.tag)
                      .map((n: any) => n.tag.trim())
                      .filter(Boolean),
                  )).sort()
                  if (tags.length === 0) return null
                  return (
                    <div className='flex flex-wrap gap-1.5'>
                      <Button size='sm' variant={landingTagFilter === 'all' ? 'default' : 'outline'} className='h-7 text-xs' onClick={() => setLandingTagFilter('all')}>全部</Button>
                      {tags.map((tg) => (
                        <Button key={tg} size='sm' variant={landingTagFilter === tg ? 'default' : 'outline'} className='h-7 text-xs' onClick={() => setLandingTagFilter(tg)}>{tg}</Button>
                      ))}
                    </div>
                  )
                })()}
                <p className='text-xs text-muted-foreground'>{t('dialog.landing.excludeHint')}</p>
                {(() => {
                  const filtered = savedNodes
                    .filter(n => n.id !== sourceNodeForLanding?.id)
                    .filter(n => !n.protocol.includes('⇋'))
                    .filter(n => landingTagFilter === 'all' || n.tag === landingTagFilter)
                    .filter(n => {
                      if (!landingFilterText.trim()) return true
                      const s = landingFilterText.toLowerCase()
                      return n.node_name.toLowerCase().includes(s) || n.protocol.toLowerCase().includes(s) || (n.tag && n.tag.toLowerCase().includes(s))
                    })
                  return filtered.length > 0 ? (
                    <div className={cn('space-y-2', landingScope === 'all' && routedTargetNode && 'pb-20')}>
                      {filtered.map((node) => {
                        let cfg: any = null
                        try { cfg = JSON.parse(node.clash_config) } catch {}
                        // Tunnel 匹配:tunnel.target 和 node.clash_config.server 可能是同一服务器的不同别名(domain vs IP),
                        // 严格字符串比较会漏判;按 port 相等 + 「tunnel target 落在 node 所在服务器的任一已知地址(ip/domain/pull_address)」放宽
                        const nodeServer: any = (remoteServersData?.servers || []).find((s: any) => s.name === node.original_server)
                        const nodeAliases = new Set<string>([cfg?.server, nodeServer?.ip_address, nodeServer?.domain, nodeServer?.pull_address].filter(Boolean))
                        const fwdTunnels = cfg?.port != null
                          ? tunnels.filter((x) => Number(x.target_port) === Number(cfg.port) && nodeAliases.has(x.target_address))
                          : []
                        return (
                        <Button
                          key={node.id}
                          variant='outline'
                          // 单选高亮 — 两种 scope 都通过 routedTargetNode 标记当前选中
                          className={cn(
                            'w-full justify-start text-left h-auto py-3',
                            routedTargetNode?.id === node.id && 'border-primary bg-primary/10 ring-1 ring-primary',
                          )}
                          onClick={() => {
                            if (!sourceNodeForLanding) return
                            // 不再点 1 次就触发 mutation,改为选中 → 用户点底部"确认"按钮
                            setRoutedTargetNode(node)
                            if (landingScope === 'routed') {
                              const slug = slugifyForLabel(node.node_name)
                              const auto = slug ? `rout-${slug}` : 'rout-node'
                              setLandingRoutedLabel(auto.length > 32 ? auto.slice(0, 32) : auto)
                            }
                          }}
                          disabled={addLandingNodeMutation.isPending || addRoutedLandingMutation.isPending || landingLoading}
                        >
                          <div className='flex flex-col gap-2 w-full items-start'>
                            <div className='flex items-center gap-2 w-full flex-wrap'>
                              <span className='font-medium'><Twemoji>{node.node_name}</Twemoji></span>
                              {fwdTunnels.length > 0 && (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Badge variant='outline' className='h-5 w-5 p-0 flex items-center justify-center shrink-0 border-orange-300 text-orange-600 dark:text-orange-400'>
                                      <Cable className='h-3 w-3' />
                                    </Badge>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <div className='space-y-0.5 text-xs'>
                                      <div className='font-medium'>被 tunnel 转发</div>
                                      {fwdTunnels.map((tn: any) => (
                                        <div key={`${tn.server_id}-${tn.tag}`} className='font-mono'>
                                          {tn.server_name}:{tn.listen_port} · {tn.tag}
                                        </div>
                                      ))}
                                    </div>
                                  </TooltipContent>
                                </Tooltip>
                              )}
                              <span className='text-xs text-muted-foreground'>{node.protocol} - {node.original_server}</span>
                            </div>
                            {node.tag && <Badge variant='secondary' className='text-xs'>{node.tag}</Badge>}
                          </div>
                        </Button>
                        )
                      })}
                    </div>
                  ) : (
                    <div className='text-center text-sm text-muted-foreground py-8'>
                      {landingFilterText.trim() ? t('dialog.landing.noMatchingNodes') : t('dialog.landing.noAvailableNodes')}
                    </div>
                  )
                })()}
                {/* 整个节点 scope 的确认按钮:选中后显示,sticky 到可滚动容器底部;列表加了 pb-20 留出空间避免遮挡 */}
                {landingScope === 'all' && routedTargetNode && (
                  <div className='flex items-center justify-between gap-2 p-2 rounded-md bg-primary/5 border border-primary/40 text-xs sticky bottom-0 shadow-lg backdrop-blur-sm'>
                    <div className='min-w-0'>
                      <div className='font-medium truncate'>已选目标:<Twemoji>{routedTargetNode.node_name}</Twemoji></div>
                      <div className='text-muted-foreground truncate'>{routedTargetNode.protocol} · {routedTargetNode.original_server}</div>
                    </div>
                    <Button
                      size='sm'
                      className='shrink-0'
                      onClick={() => {
                        if (!sourceNodeForLanding || !routedTargetNode) return
                        // 落地前看目标节点 server:port 是否被某条 tunnel 转发,有就弹框让用户选
                        let cfg: any = null
                        try { cfg = JSON.parse(routedTargetNode.clash_config) } catch {}
                        const targetServer: any = (remoteServersData?.servers || []).find((s: any) => s.name === routedTargetNode.original_server)
                        const targetAliases = new Set<string>([cfg?.server, targetServer?.ip_address, targetServer?.domain, targetServer?.pull_address].filter(Boolean))
                        if (cfg?.port != null) {
                          const tn = tunnels.find((x) => Number(x.target_port) === Number(cfg.port) && targetAliases.has(x.target_address))
                          if (tn) {
                            const tnSrv = (remoteServersData?.servers || []).find((s: any) => s.id === tn.server_id) as any
                            const tnHost = tnSrv?.domain || tnSrv?.ip_address || tnSrv?.pull_address || ''
                            if (tnHost) {
                              setLandingTunnelChoice({
                                tunnelHost: tnHost,
                                tunnelPort: Number(tn.listen_port),
                                tunnelServerName: tn.server_name || tnSrv?.name || '',
                                tunnelTag: tn.tag || '',
                                directAddress: cfg.server,
                                directPort: Number(cfg.port),
                              })
                              return
                            }
                          }
                        }
                        addLandingNodeMutation.mutate({ sourceNode: sourceNodeForLanding, targetNode: routedTargetNode })
                      }}
                      disabled={addLandingNodeMutation.isPending || landingLoading}
                    >
                      {addLandingNodeMutation.isPending ? '创建中...' : '确认落地'}
                    </Button>
                  </div>
                )}
              </TabsContent>

              {isAdmin && <TabsContent value='servers' className='space-y-4 pt-2'>
                <p className='text-xs text-muted-foreground'>{t('dialog.landing.serverHint')}</p>
                {(() => {
                  const sourceServerName = sourceNodeForLanding?.original_server
                  const available = remoteServers.filter(s => s.name !== sourceServerName)
                  return available.length > 0 ? (
                    <div className='space-y-2'>
                      {available.map((server) => (
                        <Button
                          key={server.id}
                          variant='outline'
                          className='w-full justify-start text-left h-auto py-3'
                          onClick={() => {
                            setLandingServerId(server.id)
                            setLandingStep('create-inbound')
                          }}
                        >
                          <div className='flex items-center gap-2'>
                            <span className='font-medium'>{server.name}</span>
                            {server.ip_address && <span className='text-xs text-muted-foreground'>{server.ip_address}</span>}
                          </div>
                        </Button>
                      ))}
                    </div>
                  ) : (
                    <div className='text-center text-sm text-muted-foreground py-8'>{t('dialog.landing.noOtherServers')}</div>
                  )
                })()}
              </TabsContent>}
            </Tabs>
            </>
          ) : (
            <div className='py-2'>
              {landingLoading ? (
                <div className='flex items-center justify-center gap-2 py-12 text-muted-foreground'>
                  <Loader2 className='h-5 w-5 animate-spin' />
                  {t('dialog.landing.configuringLanding')}
                </div>
              ) : (
                <InboundWizard
                  servers={remoteServers.map(s => ({ id: s.id, name: s.name, host: s.ip_address || s.pull_address || s.domain || '', port: 0 }))}
                  selectedServerIds={landingServerId ? [landingServerId] : []}
                  onCancel={() => setLandingStep('select')}
                  onSubmit={handleLandingInboundCreated}
                  skipServerSelection
                />
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* 落地节点 tunnel 二次确认:目标节点 server:port 命中 tunnel target → 让用户选直连 or 走 tunnel */}
      <AlertDialog open={!!landingTunnelChoice} onOpenChange={(o) => { if (!o) setLandingTunnelChoice(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>通过 Tunnel 落地?</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <div>目标节点 <span className="font-mono">{landingTunnelChoice?.directAddress}:{landingTunnelChoice?.directPort}</span> 同时有 tunnel 指向它:</div>
              <div className="rounded-md border bg-muted/40 p-2 text-xs font-mono">
                {landingTunnelChoice?.tunnelServerName} : {landingTunnelChoice?.tunnelPort} (tag: {landingTunnelChoice?.tunnelTag}) → {landingTunnelChoice?.directAddress}:{landingTunnelChoice?.directPort}
              </div>
              <div>选「通过 Tunnel」会把出站连接目标替换为 <span className="font-mono">{landingTunnelChoice?.tunnelHost}:{landingTunnelChoice?.tunnelPort}</span>;选「直连节点」保留原地址。</div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => {
              if (!sourceNodeForLanding || !routedTargetNode) return
              addLandingNodeMutation.mutate({ sourceNode: sourceNodeForLanding, targetNode: routedTargetNode })
              setLandingTunnelChoice(null)
            }}>直连节点</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              if (!sourceNodeForLanding || !routedTargetNode || !landingTunnelChoice) return
              addLandingNodeMutation.mutate({
                sourceNode: sourceNodeForLanding,
                targetNode: routedTargetNode,
                overrideTarget: { address: landingTunnelChoice.tunnelHost, port: landingTunnelChoice.tunnelPort },
              })
              setLandingTunnelChoice(null)
            }}>通过 Tunnel</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 链式代理对话框 */}
      <Dialog open={chainProxyDialogOpen} onOpenChange={(open) => {
        setChainProxyDialogOpen(open)
        if (!open) setChainProxyFilterText('')
      }}>
        <DialogContent className='max-w-2xl flex flex-col max-h-[80vh]'>
          <DialogHeader>
            <DialogTitle>{t('dialog.chainProxy.title')}</DialogTitle>
            <DialogDescription>
              {t('dialog.chainProxy.description', { name: sourceNodeForChainProxy?.node_name })}
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-2 shrink-0'>
            <Input
              placeholder={t('dialog.chainProxy.searchPlaceholder')}
              value={chainProxyFilterText}
              onChange={(e) => setChainProxyFilterText(e.target.value)}
              className='text-sm'
            />
            <p className='text-xs text-muted-foreground'>
              {t('dialog.chainProxy.excludeHint')}
            </p>
          </div>
          <div className='overflow-y-auto min-h-0 py-2'>
            {(() => {
              const filteredNodes = savedNodes
                .filter(node => node.id !== sourceNodeForChainProxy?.id)
                .filter(node => !node.protocol.includes('⇋'))
                .filter(node => {
                  if (!chainProxyFilterText.trim()) return true
                  const searchText = chainProxyFilterText.toLowerCase()
                  return (
                    node.node_name.toLowerCase().includes(searchText) ||
                    node.protocol.toLowerCase().includes(searchText) ||
                    (node.tag && node.tag.toLowerCase().includes(searchText))
                  )
                })

              return filteredNodes.length > 0 ? (
                <div className='space-y-2'>
                  {filteredNodes.map((node) => (
                    <Button
                      key={node.id}
                      variant='outline'
                      className='w-full justify-start text-left h-auto py-3'
                      onClick={() => {
                        if (sourceNodeForChainProxy) {
                          createRelayNodeMutation.mutate({
                            sourceNode: sourceNodeForChainProxy,
                            targetNode: node
                          })
                        }
                      }}
                      disabled={createRelayNodeMutation.isPending}
                    >
                      <div className='flex flex-col gap-2 w-full items-start'>
                        <div className='flex items-center gap-2 w-full flex-wrap'>
                          <span className='font-medium'>{node.node_name}</span>
                          <span className='text-xs text-muted-foreground'>
                            {node.protocol} - {node.original_server}
                          </span>
                        </div>
                        {node.tag && (
                          <Badge variant='secondary' className='text-xs'>
                            {node.tag}
                          </Badge>
                        )}
                      </div>
                    </Button>
                  ))}
                </div>
              ) : (
                <div className='text-center text-sm text-muted-foreground py-8'>
                  {chainProxyFilterText.trim() ? t('dialog.chainProxy.noMatch') : t('dialog.chainProxy.noNodes')}
                </div>
              )
            })()}
          </div>
        </DialogContent>
      </Dialog>

      {/* 批量修改标签对话框 */}
      <Dialog open={batchTagDialogOpen} onOpenChange={setBatchTagDialogOpen}>
        <DialogContent className='max-w-md'>
          <DialogHeader>
            <DialogTitle>{t('dialog.batchTag.title')}</DialogTitle>
            <DialogDescription>
              {t('dialog.batchTag.description', { count: selectedNodeIds.size })}
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-4 py-4'>
            {allUniqueTags.length > 0 && (
              <div className='space-y-2'>
                <Label className='text-sm font-medium'>{t('dialog.batchTag.quickSelect')}</Label>
                <div className='flex flex-wrap gap-2'>
                  {allUniqueTags.map((tag) => (
                    <Badge
                      key={tag}
                      variant='outline'
                      className='cursor-pointer hover:bg-primary hover:text-primary-foreground transition-colors'
                      onClick={() => setBatchTag(tag)}
                    >
                      {tag}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            <div className='space-y-2'>
              <Label htmlFor='batch-tag-input' className='text-sm font-medium'>
                {t('dialog.batchTag.tagNameLabel')}
              </Label>
              <Input
                id='batch-tag-input'
                placeholder={t('dialog.batchTag.tagNamePlaceholder')}
                value={batchTag}
                onChange={(e) => setBatchTag(e.target.value)}
                className='font-mono text-sm'
              />
            </div>
            <div className='flex justify-end gap-2 pt-2'>
              <Button
                variant='outline'
                onClick={() => {
                  setBatchTagDialogOpen(false)
                  setBatchTag('')
                }}
                disabled={batchUpdateTagMutation.isPending}
              >
                {t('actions.cancel', { ns: 'common' })}
              </Button>
              <Button
                onClick={() => {
                  if (!batchTag.trim()) {
                    toast.error(t('toast.enterTagName'))
                    return
                  }
                  const nodeIds = Array.from(selectedNodeIds)
                  batchUpdateTagMutation.mutate({
                    nodeIds,
                    tag: batchTag.trim(),
                  })
                }}
                disabled={batchUpdateTagMutation.isPending || !batchTag.trim()}
              >
                {batchUpdateTagMutation.isPending ? t('actions.saving', { ns: 'common' }) : t('actions.save', { ns: 'common' })}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 批量修改名称对话框 */}
      <Dialog open={batchRenameDialogOpen} onOpenChange={setBatchRenameDialogOpen}>
        <DialogContent className='max-w-3xl max-h-[80vh] flex flex-col'>
          <DialogHeader>
            <DialogTitle>{t('dialog.batchRename.title')}</DialogTitle>
            <DialogDescription>
              {t('dialog.batchRename.description', { count: selectedNodeIds.size })}
            </DialogDescription>
          </DialogHeader>
          <div className='flex-1 space-y-4 py-4 min-h-0 flex flex-col'>
            {/* 搜索替换工具 */}
            <div className='grid grid-cols-3 gap-2 grid-cols-[1fr_1fr_auto] items-end'>
              <div className='space-y-2'>
                <Label htmlFor='find-text' className='text-sm font-medium'>
                  {t('dialog.batchRename.findLabel')}
                </Label>
                <Input
                  id='find-text'
                  placeholder={t('dialog.batchRename.findPlaceholder')}
                  value={findText}
                  onChange={(e) => setFindText(e.target.value)}
                  className='text-sm'
                />
              </div>
              <div className='space-y-2'>
                <Label htmlFor='replace-text' className='text-sm font-medium'>
                  {t('dialog.batchRename.replaceLabel')}
                </Label>
                <div className='flex gap-2'>
                  <Input
                    id='replace-text'
                    placeholder={t('dialog.batchRename.replacePlaceholder')}
                    value={replaceText}
                    onChange={(e) => setReplaceText(e.target.value)}
                    className='text-sm'
                  />
                </div>
              </div>
              <Button
                size='sm'
                variant='outline'
                onClick={() => {
                  if (!findText) {
                    toast.error(t('toast.enterFindContent'))
                    return
                  }
                  const replaced = batchRenameText.split('\n').map(line =>
                    line.replace(new RegExp(findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), replaceText)
                  ).join('\n')
                  setBatchRenameText(replaced)
                  toast.success(t('toast.replaceDone'))
                }}
                >
                {t('dialog.batchRename.replaceBtn')}
              </Button>
            </div>

            {/* 前缀后缀工具 */}
            <div className='grid grid-cols-3 gap-2 grid-cols-[1fr_1fr_auto] items-end'>
              <div className='space-y-2'>
                <Label htmlFor='prefix-text' className='text-sm font-medium'>
                  {t('dialog.batchRename.prefixLabel')}
                </Label>
                <Input
                  id='prefix-text'
                  placeholder={t('dialog.batchRename.prefixPlaceholder')}
                  value={prefixText}
                  onChange={(e) => setPrefixText(e.target.value)}
                  className='text-sm'
                />
              </div>
              <div className='space-y-2'>
                <Label htmlFor='suffix-text' className='text-sm font-medium'>
                  {t('dialog.batchRename.suffixLabel')}
                </Label>
                <Input
                  id='suffix-text'
                  placeholder={t('dialog.batchRename.suffixPlaceholder')}
                  value={suffixText}
                  onChange={(e) => setSuffixText(e.target.value)}
                  className='text-sm'
                />
              </div>
              <Button
                size='sm'
                variant='outline'
                onClick={() => {
                  if (!prefixText && !suffixText) {
                    toast.error(t('toast.enterPrefixOrSuffix'))
                    return
                  }
                  const updated = batchRenameText.split('\n').map(line =>
                    line ? `${prefixText}${line}${suffixText}` : line
                  ).join('\n')
                  setBatchRenameText(updated)
                  setPrefixText('')
                  setSuffixText('')
                  toast.success(t('toast.appliedPrefixSuffix'))
                }}
              >
                {t('dialog.batchRename.applyBtn')}
              </Button>
            </div>

            {/* 名称编辑区 */}
            <div className='flex-1 space-y-2 min-h-0 flex flex-col'>
              <Label htmlFor='batch-rename-text' className='text-sm font-medium'>
                {t('dialog.batchRename.nodeNamesLabel', { count: batchRenameText.split('\n').length })}
              </Label>
              <Textarea
                id='batch-rename-text'
                value={batchRenameText}
                onChange={(e) => setBatchRenameText(e.target.value)}
                className='font-mono text-sm flex-1 min-h-[300px] resize-none'
                placeholder={t('dialog.batchRename.nodeNamesPlaceholder')}
              />
              {/* <p className='text-xs text-muted-foreground'>
                支持多行编辑，使用上方的查找替换功能批量修改文本
              </p> */}
            </div>

            {/* 操作按钮 */}
            <div className='flex justify-end gap-2 pt-2'>
              <Button
                variant='outline'
                onClick={() => {
                  setBatchRenameDialogOpen(false)
                  setBatchRenameText('')
                  setFindText('')
                  setReplaceText('')
                  setPrefixText('')
                  setSuffixText('')
                }}
                disabled={batchRenameMutation.isPending}
              >
                {t('actions.cancel', { ns: 'common' })}
              </Button>
              <Button
                onClick={() => {
                  const newNames = batchRenameText.split('\n').map(line => line.trim()).filter(line => line)
                  const nodeIds = Array.from(selectedNodeIds)

                  if (newNames.length === 0) {
                    toast.error(t('toast.enterNodeNames'))
                    return
                  }

                  if (newNames.length !== nodeIds.length) {
                    toast.error(t('toast.nameCountMismatch', { nameCount: newNames.length, nodeCount: nodeIds.length }))
                    return
                  }

                  // 构建更新请求
                  const updates = nodeIds.map((nodeId, index) => ({
                    node_id: nodeId,
                    new_name: newNames[index]
                  }))

                  batchRenameMutation.mutate(updates)
                }}
                disabled={batchRenameMutation.isPending || !batchRenameText.trim()}
              >
                {batchRenameMutation.isPending ? t('actions.saving', { ns: 'common' }) : t('dialog.batchRename.confirmBtn')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 删除重复节点对话框 */}
      <Dialog open={duplicateDialogOpen} onOpenChange={setDuplicateDialogOpen}>
        <DialogContent className='max-w-2xl max-h-[80vh] flex flex-col'>
          <DialogHeader>
            <DialogTitle>{t('dialog.duplicates.title')}</DialogTitle>
            <DialogDescription>
              {t('dialog.duplicates.description', { groupCount: duplicateGroups.length, deleteCount: duplicateGroups.reduce((sum, g) => sum + g.nodes.length - 1, 0) })}
            </DialogDescription>
          </DialogHeader>
          <div className='flex-1 overflow-y-auto space-y-4 py-4'>
            {duplicateGroups.map((group, groupIndex) => (
              <div key={groupIndex} className='border rounded-lg p-3 space-y-2'>
                <div className='flex items-center justify-between'>
                  <span className='text-sm font-medium'>
                    {t('dialog.duplicates.groupTitle', { index: groupIndex + 1, count: group.nodes.length })}
                  </span>
                  <Badge variant='secondary'>
                    {t('dialog.duplicates.willDelete', { count: group.nodes.length - 1 })}
                  </Badge>
                </div>
                <div className='space-y-1'>
                  {[...group.nodes]
                    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
                    .map((node, nodeIndex) => (
                      <div
                        key={node.id}
                        className={`flex items-center justify-between text-sm p-2 rounded ${
                          nodeIndex === 0
                            ? 'bg-green-500/10 border border-green-500/20'
                            : 'bg-red-500/10 border border-red-500/20'
                        }`}
                      >
                        <div className='flex items-center gap-2 flex-1 min-w-0'>
                          <Badge variant='outline' className='shrink-0'>
                            {node.protocol.toUpperCase()}
                          </Badge>
                          <span className='truncate'>{node.node_name}</span>
                          {node.tag && (
                            <Badge variant='secondary' className='shrink-0'>
                              {node.tag}
                            </Badge>
                          )}
                        </div>
                        <span className={`text-xs shrink-0 ml-2 ${nodeIndex === 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {nodeIndex === 0 ? t('dialog.duplicates.keep') : t('dialog.duplicates.deleteLabel')}
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            ))}
          </div>
          <div className='flex justify-end gap-2 pt-4 border-t'>
            <Button
              variant='outline'
              onClick={() => {
                setDuplicateDialogOpen(false)
                setDuplicateGroups([])
              }}
              disabled={deletingDuplicates}
            >
              {t('actions.cancel', { ns: 'common' })}
            </Button>
            <Button
              variant='destructive'
              onClick={handleDeleteDuplicates}
              disabled={deletingDuplicates}
            >
              {deletingDuplicates ? t('dialog.duplicates.deletingBtn') : t('dialog.duplicates.confirmDeleteBtn', { count: duplicateGroups.reduce((sum, g) => sum + g.nodes.length - 1, 0) })}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 临时订阅对话框 */}
      <Dialog
        open={tempSubDialogOpen}
        onOpenChange={(open) => {
          setTempSubDialogOpen(open)
          if (!open) {
            setTempSubUrl('')
            setTempSubSingleNodeId(null)
          }
        }}
      >
        <DialogContent className='max-w-md'>
          <DialogHeader>
            <DialogTitle>{t('dialog.tempSub.title')}</DialogTitle>
            <DialogDescription>
              {tempSubSingleNodeId !== null
                ? t('dialog.tempSub.descriptionSingle', { name: savedNodes.find(n => n.id === tempSubSingleNodeId)?.node_name || t('nodeList.unknown') })
                : t('dialog.tempSub.descriptionBatch', { count: selectedNodeIds.size })
              }
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-4 py-4'>
            <div className='grid grid-cols-2 gap-4'>
              <div className='space-y-2'>
                <Label htmlFor='temp-sub-max-access' className='text-sm font-medium'>
                  {t('dialog.tempSub.maxAccessLabel')}
                </Label>
                <Input
                  id='temp-sub-max-access'
                  type='number'
                  min={1}
                  max={100}
                  value={tempSubMaxAccess}
                  onChange={(e) => setTempSubMaxAccess(parseInt(e.target.value) || 1)}
                  className='text-sm'
                />
              </div>
              <div className='space-y-2'>
                <Label htmlFor='temp-sub-expire' className='text-sm font-medium'>
                  {t('dialog.tempSub.expireLabel')}
                </Label>
                <Input
                  id='temp-sub-expire'
                  type='number'
                  min={10}
                  max={3600}
                  value={tempSubExpireSeconds}
                  onChange={(e) => setTempSubExpireSeconds(parseInt(e.target.value) || 60)}
                  className='text-sm'
                />
              </div>
            </div>
            <div className='space-y-2'>
              <Label className='text-sm font-medium'>{t('dialog.tempSub.linkLabel')}</Label>
              <div className='flex gap-2'>
                <Input
                  value={tempSubGenerating ? t('dialog.tempSub.generatingLink') : tempSubUrl}
                  readOnly
                  placeholder={t('dialog.tempSub.linkPlaceholder')}
                  className='text-sm font-mono'
                />
                {tempSubUrl && !tempSubGenerating && (
                  <Button
                    variant='outline'
                    size='icon'
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(tempSubUrl)
                        toast.success(t('toast.linkCopied'))
                        setTempSubDialogOpen(false)
                        setTempSubUrl('')
                        setTempSubSingleNodeId(null)
                      } catch {
                        toast.error(t('toast.copyFailed'))
                      }
                    }}
                  >
                    <Copy className='h-4 w-4' />
                  </Button>
                )}
              </div>
              {tempSubUrl && !tempSubGenerating && (
                <p className='text-xs text-muted-foreground'>
                  {t('dialog.tempSub.linkExpireHint', { seconds: tempSubExpireSeconds, count: tempSubMaxAccess })}
                </p>
              )}
            </div>
            <div className='flex justify-end pt-2'>
              <Button
                variant='outline'
                onClick={() => {
                  setTempSubDialogOpen(false)
                  setTempSubUrl('')
                  setTempSubSingleNodeId(null)
                }}
              >
                {t('dialog.clashConfig.close')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 添加节点：服务器选择 Dialog */}
      <Dialog
        open={quickCreateServerDialogOpen}
        onOpenChange={setQuickCreateServerDialogOpen}
      >
        <DialogContent className='sm:max-w-md'>
          <DialogHeader>
            <DialogTitle>{t('dialog.serverSelect.title')}</DialogTitle>
            <DialogDescription>{t('dialog.serverSelect.description')}</DialogDescription>
          </DialogHeader>
          <div className='space-y-2 py-2'>
            {remoteServers.map((server) => (
              <Button
                key={server.id}
                type='button'
                variant={quickCreateServerId === server.id ? 'default' : 'outline'}
                className='w-full justify-start'
                disabled={!server.xray_running}
                onClick={() => setQuickCreateServerId(server.id)}
              >
                {server.name}
                {!server.xray_running && <span className='ml-auto text-xs text-destructive'>{t('dialog.serverSelect.xrayNotReady')}</span>}
              </Button>
            ))}
          </div>
          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              onClick={() => setQuickCreateServerDialogOpen(false)}
            >
              {t('actions.cancel', { ns: 'common' })}
            </Button>
            <Button
              type='button'
              disabled={quickCreateServerId === null}
              onClick={() => {
                if (quickCreateServerId === null) return
                setQuickCreateServerDialogOpen(false)
                setQuickCreateOpen(true)
              }}
            >
              {t('actions.next', { ns: 'common' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 添加节点 Dialog */}
      <Dialog open={quickCreateOpen} onOpenChange={(open) => {
        if (!open) {
          setQuickCreateOpen(false)
          if (quickCreateStep === 'done') {
            queryClient.invalidateQueries({ queryKey: ['nodes'] })
          }
        }
      }}>
        <DialogContent className={cn(
          'max-h-[90vh] overflow-hidden flex flex-col',
          quickCreateStep === 'inbound' ? 'w-[95vw] !max-w-none md:w-[90vw] lg:w-[80vw] sm:max-w-none' : 'sm:max-w-md'
        )}>
          <DialogHeader>
            <DialogTitle>
              {quickCreateStep === 'inbound' && t('dialog.quickCreate.addNodeTitle')}
              {quickCreateStep === 'done' && t('dialog.quickCreate.doneTitle')}
            </DialogTitle>
            <DialogDescription>
              {quickCreateStep === 'inbound' && t('dialog.quickCreate.configInbound')}
              {quickCreateStep === 'done' && t('dialog.quickCreate.doneDescription')}
            </DialogDescription>
          </DialogHeader>

          {quickCreateStep === 'inbound' && (
            <div className='flex-1 overflow-y-auto'>
              <InboundWizard
                servers={remoteServers.map(s => ({ id: s.id, name: s.name, host: s.ip_address || s.pull_address || s.domain || '', port: 0 }))}
                selectedServerIds={quickCreateServerId ? [quickCreateServerId] : []}
                onCancel={() => setQuickCreateOpen(false)}
                onSubmit={handleQuickCreateSubmit}
                skipServerSelection={true}
              />
              {quickCreateLoading && (
                <div className='absolute inset-0 bg-background/60 flex items-center justify-center'>
                  <p className='text-sm text-muted-foreground'>{t('toast.creatingInboundOutbound')}</p>
                </div>
              )}
            </div>
          )}

          {quickCreateStep === 'done' && quickCreateResult && (
            <div className='space-y-4 py-2'>
              <div className='space-y-2 text-sm'>
                <div className='flex items-center gap-2'>
                  <CheckCircle2 className='h-4 w-4 text-green-500' />
                  <span>{t('dialog.quickCreate.inboundCreated', { count: quickCreateResult.serverCount })} <Badge variant='secondary'>{quickCreateResult.inboundTag}</Badge></span>
                </div>
                <div className='flex items-center gap-2'>
                  <CheckCircle2 className='h-4 w-4 text-green-500' />
                  <span>{t('dialog.quickCreate.nodesSynced')}</span>
                </div>
              </div>
              <div className='flex gap-2 justify-end'>
                <Button
                  size='sm'
                  onClick={() => {
                    setQuickCreateOpen(false)
                    queryClient.invalidateQueries({ queryKey: ['nodes'] })
                  }}
                >
                  {t('dialog.quickCreate.doneBtn')}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      {routingSourceNode && routingServerId && (
        <NodeRoutingDialog
          open={routingDialogOpen}
          onOpenChange={setRoutingDialogOpen}
          node={routingSourceNode}
          serverId={routingServerId}
          serverName={routingServerName}
          allNodes={savedNodes}
        />
      )}
      <TunnelManagerDialog
        open={tunnelDialogOpen}
        onOpenChange={setTunnelDialogOpen}
      />
      <Dialog open={routedOutboundsDialogOpen} onOpenChange={setRoutedOutboundsDialogOpen}>
        <DialogContent className='sm:max-w-5xl max-h-[85vh] overflow-y-auto'>
          <DialogHeader>
            <DialogTitle>路由出站管理</DialogTitle>
          </DialogHeader>
          <RoutedOutboundsPanel showHeader={false} />
        </DialogContent>
      </Dialog>
      <SpeedTestDialog
        open={speedDialogOpen}
        nodes={savedNodesSorted}
        onMinimize={() => { setSpeedDialogOpen(false); setSpeedDialogMin(true) }}
        onClose={() => { setSpeedDialogOpen(false); setSpeedDialogMin(false) }}
      />
      {/* 收起态:屏幕右侧垂直居中悬浮按钮,点击重新打开测速工作台 */}
      {speedDialogMin && !speedDialogOpen && (
        <button
          type='button'
          onClick={() => { setSpeedDialogOpen(true); setSpeedDialogMin(false) }}
          title={t('speedtest.dialogTitle')}
          className='fixed right-0 top-1/2 z-50 -translate-y-1/2 rounded-l-lg bg-[#d97757] px-2 py-3 text-white shadow-lg hover:bg-[#c66647]'
        >
          <Gauge className='h-5 w-5' />
        </button>
      )}
    </div>
  )
}
