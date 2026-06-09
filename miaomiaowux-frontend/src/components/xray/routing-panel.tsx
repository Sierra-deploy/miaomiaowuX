// @ts-nocheck
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { RefreshCw, Trash2, Plus, ChevronDown, GripVertical, Scale, Pencil } from 'lucide-react'
import {
  DndContext, PointerSensor, useSensor, useSensors, closestCenter, type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, useSortable, verticalListSortingStrategy, arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Button } from '@/components/ui/button'
import { EmptyStateCard } from '@/components/ui/empty-state'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api } from '@/lib/api'
import { handleServerError } from '@/lib/handle-server-error'
import { type Balancer, normalizeBalancers, balancerStrategyLabel } from '@/lib/xray-balancer'
import { clashConfigToOutbound, matchNodeToExistingOutbound } from '@/lib/xray-config-generator'
import { X as XIcon } from 'lucide-react'
import { BalancerManagerDialog } from './balancer-manager-dialog'

interface RoutingRule {
  type?: string; domain?: string[]; ip?: string[]; protocol?: string[]
  port?: string | number; sourcePort?: string | number; network?: string
  source?: string[]; user?: string[]; inboundTag?: string[]
  outboundTag?: string; balancerTag?: string; marktag?: string; attrs?: string
}

// Balancer 类型与 buildObservatory/normalizeBalancers/toXrayBalancers 见 @/lib/xray-balancer(与节点路由共用)。

interface RoutingPanelProps {
  serverId: number
  serverName: string
  isRemote: boolean
  xrayMode?: 'external' | 'embedded'
}

function getRuleDisplayInfo(rule: RoutingRule, t: (key: string) => string) {
  if (rule.protocol?.length) return { ruleType: 'protocol', matchCondition: rule.protocol.join(', ') }
  if (rule.domain?.length) return { ruleType: 'domain', matchCondition: rule.domain.length > 2 ? `${rule.domain.slice(0, 2).join(', ')} +${rule.domain.length - 2}` : rule.domain.join(', ') }
  if (rule.ip?.length) return { ruleType: 'ip', matchCondition: rule.ip.length > 2 ? `${rule.ip.slice(0, 2).join(', ')} +${rule.ip.length - 2}` : rule.ip.join(', ') }
  if (rule.inboundTag?.length) return { ruleType: 'inboundTag', matchCondition: rule.inboundTag.join(', ') }
  if (rule.port) return { ruleType: 'port', matchCondition: String(rule.port) }
  if (rule.sourcePort) return { ruleType: t('routing.sourcePort'), matchCondition: String(rule.sourcePort) }
  if (rule.network) return { ruleType: 'network', matchCondition: rule.network }
  return { ruleType: t('routing.unknown'), matchCondition: '' }
}

function useQuickRules() {
  const { t } = useTranslation('xray')
  return useMemo(() => ({
    ban_bt: { name: t('routing.banBt'), rule: { type: 'field', protocol: ['bittorrent'], marktag: 'ban_bt', outboundTag: 'block' }, needSelectOutbound: false },
    ban_geoip_cn: { name: t('routing.banGeoipCn'), rule: { type: 'field', ip: ['geoip:cn'], marktag: 'ban_geoip_cn', outboundTag: 'block' }, needSelectOutbound: false },
    fix_openai: { name: t('routing.fixOpenai'), rule: { type: 'field', domain: ['geosite:openai'], marktag: 'fix_openai', outboundTag: 'direct' }, needSelectOutbound: false },
    ban_private: { name: t('routing.banPrivate'), rule: { type: 'field', ip: ['geoip:private'], marktag: 'ban_private', outboundTag: 'block' }, needSelectOutbound: false },
    rfc_emby: { name: 'RFC EMBY', rule: { type: 'field', domain: ['rfc.uhdnow.com'], network: 'tcp', marktag: 'rfc_emby' }, needSelectOutbound: true },
    tiktok_unlock: { name: t('routing.tiktokUnlock').split(' (')[0], rule: { type: 'field', domain: ['geosite:tiktok'], marktag: 'tiktok_unlock' }, needSelectOutbound: true },
    // 防止送中:Google / Meta 的中国大陆 PoP 经常被错路到中国境内服务器,走 WARP-v4 直连 Cloudflare 边缘解决。
    // 仅在本机已添加 warp-v4 出站时,在快捷菜单中显示此项(由 routing-panel useQuery 判定)。
    warp_anti_china: { name: t('routing.warpAntiChina'), rule: { type: 'field', domain: ['geosite:google', 'geosite:meta'], marktag: 'warp_anti_china', outboundTag: 'warp-v4' }, needSelectOutbound: false },
  }), [t])
}

function outboundBadgeVariant(tag: string) {
  if (tag === 'block') return 'destructive' as const
  if (tag === 'direct' || tag === 'freedom') return 'default' as const
  return 'secondary' as const
}

function SortableRuleItem({ rule, index, isSelected, onClick, t, quickRules, isMmwxManaged }: {
  rule: RoutingRule; index: number; isSelected: boolean; onClick: () => void; t: (key: string) => string; quickRules: any; isMmwxManaged?: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `rule-${index}` })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }
  const { ruleType, matchCondition } = getRuleDisplayInfo(rule, t)
  const friendlyName = rule.marktag ? (Object.values(quickRules).find((p: any) => p.rule.marktag === rule.marktag) as any)?.name || rule.marktag : null
  return (
    <div
      ref={setNodeRef} style={style}
      className={`flex items-center gap-1.5 py-2 px-2 rounded-md border text-sm cursor-pointer transition-colors ${isSelected ? 'border-primary bg-primary/5' : 'bg-card hover:bg-accent/50'} ${isMmwxManaged ? 'border-l-4 border-l-primary/70' : ''}`}
      onClick={onClick}
    >
      <button className='shrink-0 cursor-grab active:cursor-grabbing touch-none text-muted-foreground hover:text-foreground' {...attributes} {...listeners}>
        <GripVertical className='size-3.5' />
      </button>
      <Badge variant='outline' className='shrink-0 text-xs'>{ruleType}</Badge>
      {isMmwxManaged && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant='secondary' className='shrink-0 text-[10px] px-1 py-0 bg-primary/10 text-primary border-primary/30'>妙妙屋X</Badge>
          </TooltipTrigger>
          <TooltipContent><div className='text-xs max-w-xs'>此规则由妙妙屋X路由出站功能自动添加和管理,请勿在此手动编辑或删除</div></TooltipContent>
        </Tooltip>
      )}
      <span className='flex-1 min-w-0 truncate text-xs' title={matchCondition}>
        {friendlyName ? <span className='font-medium'>{friendlyName}: </span> : null}
        {matchCondition || '-'}
      </span>
      <span className='text-muted-foreground text-xs'>→</span>
      <Badge variant={outboundBadgeVariant(rule.outboundTag || '')} className='shrink-0 text-xs'>
        {rule.outboundTag || t('routing.notSet')}
      </Badge>
    </div>
  )
}

export function RoutingPanel({ serverId, serverName, isRemote, xrayMode }: RoutingPanelProps) {
  const { t } = useTranslation('xray')
  const { t: tc } = useTranslation('common')
  const QUICK_RULES = useQuickRules()
  const queryClient = useQueryClient()

  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [deletingIndex, setDeletingIndex] = useState<number | null>(null)
  const [isOutboundSelectDialogOpen, setIsOutboundSelectDialogOpen] = useState(false)
  const [pendingRule, setPendingRule] = useState<{ rule: any } | null>(null)
  const [selectedOutbound, setSelectedOutbound] = useState('')
  const [isCustomRuleDialogOpen, setIsCustomRuleDialogOpen] = useState(false)
  // editingIndex: null=添加模式,number=编辑模式(rules 数组中的索引)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [customDomain, setCustomDomain] = useState('')
  const [customIp, setCustomIp] = useState('')
  const [customProtocol, setCustomProtocol] = useState('')
  const [customPort, setCustomPort] = useState('')
  const [customSourcePort, setCustomSourcePort] = useState('')
  const [customNetwork, setCustomNetwork] = useState('')
  const [customSource, setCustomSource] = useState('')
  const [customUser, setCustomUser] = useState('')
  // 入站现已支持多选(从服务器入站列表选)+ 自定义 tag(兼容老用法);存储为字符串数组
  const [customInboundTag, setCustomInboundTag] = useState<string[]>([])
  const [customInboundTagInput, setCustomInboundTagInput] = useState('') // 自定义 tag 输入框临时态
  const [customAttrs, setCustomAttrs] = useState('')
  const [customOutbound, setCustomOutbound] = useState('')
  const [customMarktag, setCustomMarktag] = useState('')

  // 负载均衡器管理(弹窗为共享组件 BalancerManagerDialog)
  const [isBalancerDialogOpen, setIsBalancerDialogOpen] = useState(false)

  const routingQueryKey = isRemote ? ['remote-routing', serverId] : ['xray-routing', serverId]
  const outboundsQueryKey = isRemote ? ['remote-outbounds', serverId] : ['xray-outbounds']

  const { data: localServersData } = useQuery({
    queryKey: ['xray-servers'],
    queryFn: async () => (await api.get('/api/admin/xray-servers')).data,
    enabled: !isRemote,
  })
  const localServer = !isRemote ? (localServersData?.servers?.find((s: any) => s.is_primary) || localServersData?.servers?.[0]) : null
  const localServerId = localServer?.id ?? null

  const { data: routingData, isLoading: routingLoading } = useQuery({
    queryKey: routingQueryKey,
    queryFn: async () => {
      if (isRemote) {
        const res = await api.get(`/api/admin/remote/routing?server_id=${serverId}`)
        return res.data as { success: boolean; routing: { domainStrategy?: string; rules?: RoutingRule[] } }
      }
      if (!localServerId) return { rules: [] }
      return (await api.get(`/api/admin/xray-servers/routing?server_id=${localServerId}`)).data
    },
    enabled: isRemote || localServerId !== null,
  })

  const { data: outboundsData, isLoading: outboundsLoading } = useQuery({
    queryKey: outboundsQueryKey,
    queryFn: async () => {
      if (isRemote) {
        const res = await api.get(`/api/admin/remote/outbounds?server_id=${serverId}`)
        return res.data as { success: boolean; outbounds: any[] }
      }
      return (await api.get('/api/admin/xray-servers/outbounds')).data
    },
    enabled: isRemote || localServerId !== null,
  })

  // 是否有 warp-v4 出站 → 控制"防止送中"快捷规则是否在菜单里显示。
  // 通过 useMemo 避免 outboundsData 引用稳定但内部变化时反复计算。
  const hasWarpOutbound = useMemo(() => {
    const list = (outboundsData?.outbounds || []) as Array<{ tag?: string }>
    return list.some((o) => o?.tag === 'warp-v4')
  }, [outboundsData])

  // 服务器现有入站(自定义规则的 inboundTag 多选项来源)
  const { data: inboundsData } = useQuery({
    queryKey: isRemote ? ['remote-inbounds', serverId] : ['xray-inbounds', localServerId],
    queryFn: async () => {
      if (isRemote) {
        const res = await api.get(`/api/admin/remote/inbounds?server_id=${serverId}`)
        return res.data as { inbounds: any[] }
      }
      if (!localServerId) return { inbounds: [] }
      return (await api.get(`/api/admin/xray-servers/inbounds?server_id=${localServerId}`)).data
    },
    enabled: isRemote || localServerId !== null,
  })
  const inboundsList = useMemo(() => {
    const list = inboundsData?.inbounds || []
    // 过滤掉 api / 内部入站
    return list.filter((i: any) => i?.tag && i.tag !== 'api')
  }, [inboundsData])

  // 全部节点(自定义规则的出站可选"节点列表中的节点")
  const { data: nodesData } = useQuery({
    queryKey: ['nodes'],
    queryFn: async () => (await api.get('/api/admin/nodes')).data as { nodes: any[] },
  })
  const nodes = useMemo(() => {
    const out: { id: number; name: string; protocol: string; clash: any }[] = []
    for (const n of nodesData?.nodes || []) {
      try {
        const c = JSON.parse(n.clash_config || '{}')
        if (c && c.server && c.port) {
          out.push({ id: n.id, name: n.node_name, protocol: n.protocol || c.type || '', clash: c })
        }
      } catch { /* 跳过解析失败的节点 */ }
    }
    return out
  }, [nodesData])

  // 妙妙屋 X routed 节点产生的 outboundTag 集合 — routing rule 的 outboundTag 命中即视为系统管理,
  // 不允许用户编辑/删除(改了会让套餐分配 / 路由出站子账号失效)。
  const mmwxRoutedTags = useMemo(() => {
    const set = new Set<string>()
    for (const n of nodesData?.nodes || []) {
      if (n.node_type === 'routed' && n.routed_outbound_tag) {
        set.add(n.routed_outbound_tag)
      }
    }
    return set
  }, [nodesData])
  const isMmwxManagedRule = (r: RoutingRule) =>
    !!r.outboundTag && mmwxRoutedTags.has(r.outboundTag)

  const rawRules: RoutingRule[] = useMemo(() => {
    if (isRemote) return routingData?.routing?.rules || []
    return routingData?.rules || []
  }, [routingData, isRemote])

  // 基础设施路由:api(主控管理通道) + tunnel-in(steal-self 模式的伪装隧道入站)。
  // 这俩规则不由用户配置、用户改了会破坏 agent 通信 / 偷自己功能 → UI 里完全不显示也不允许编辑。
  // reorder 路径(reorderMutation)也得把它们原样保留 prepend 回去。
  const isPreservedRule = (r: RoutingRule) =>
    r.outboundTag === 'api' || r.inboundTag?.includes('api') || r.inboundTag?.includes('tunnel-in')
  const rules = useMemo(() => rawRules.filter(r => !isPreservedRule(r)), [rawRules])

  const outbounds = useMemo(() => {
    if (isRemote) return outboundsData?.outbounds || []
    if (!outboundsData?.outbounds || !localServerId) return []
    return outboundsData.outbounds.filter((item: any) => item.server_id === localServerId).map((item: any) => item.outbound)
  }, [outboundsData, isRemote, localServerId])

  const balancers: Balancer[] = useMemo(() => {
    return normalizeBalancers(isRemote ? routingData?.routing?.balancers : routingData?.balancers)
  }, [routingData, isRemote])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const sortableIds = useMemo(() => rules.map((_, i) => `rule-${i}`), [rules])

  const restartXray = async () => {
    if (!isRemote) return
    try { await api.post(`/api/admin/remote/services/control?server_id=${serverId}`, { service: 'xray', action: 'restart' }) } catch {}
  }

  const findRawIndex = useCallback((filteredIndex: number) => {
    const rule = rules[filteredIndex]
    return rawRules.indexOf(rule)
  }, [rules, rawRules])

  const addRuleMutation = useMutation({
    mutationFn: async (rule: any) => {
      if (isRemote) return (await api.post(`/api/admin/remote/routing?server_id=${serverId}`, { action: 'add_rule', rule })).data
      return (await api.post('/api/admin/xray-servers/routing', { action: 'add', server_id: localServerId, rule })).data
    },
    onSuccess: async (data) => {
      queryClient.invalidateQueries({ queryKey: routingQueryKey })
      if (data.success) { await restartXray(); toast.success(isRemote ? t('routing.ruleAdded') : (data.message || t('routing.ruleAddedLocal'))) }
      else toast.error(data.message || t('routing.addFailed'))
    },
    onError: handleServerError,
  })

  // 编辑模式:复用 'set' action 把整个 rules 数组发回去,只替换 editingIndex 那条
  // (没有 update_rule action,这是最稳的实现 — agent 端不用改)
  const updateRuleMutation = useMutation({
    mutationFn: async ({ index, rule }: { index: number; rule: RoutingRule }) => {
      const rawIdx = findRawIndex(index)
      if (rawIdx < 0) throw new Error(t('routing.ruleNotFound'))
      const newRawRules = [...rawRules]
      newRawRules[rawIdx] = rule
      if (isRemote) return (await api.post(`/api/admin/remote/routing?server_id=${serverId}`, { action: 'set', routing: { ...routingData?.routing, rules: newRawRules } })).data
      return (await api.post('/api/admin/xray-servers/routing', { action: 'set', server_id: localServerId, rules: newRawRules })).data
    },
    onSuccess: async (data) => {
      queryClient.invalidateQueries({ queryKey: routingQueryKey })
      if (data?.success !== false) { await restartXray(); toast.success(t('routing.ruleUpdated')) }
      else toast.error(data.message || t('routing.updateFailed'))
    },
    onError: handleServerError,
  })

  const removeRuleMutation = useMutation({
    mutationFn: async ({ index, rule }: { index: number; rule: RoutingRule }) => {
      if (isRemote) return (await api.post(`/api/admin/remote/routing?server_id=${serverId}`, { action: 'remove_rule', index: findRawIndex(index) })).data
      return (await api.post('/api/admin/xray-servers/routing', { action: 'remove', server_id: localServerId, marktag: rule.marktag, rule })).data
    },
    onSuccess: async (data) => {
      queryClient.invalidateQueries({ queryKey: routingQueryKey })
      if (data.success) { await restartXray(); toast.success(isRemote ? t('routing.ruleDeleted') : (data.message || t('routing.ruleDeletedLocal'))) }
      else toast.error(data.message || t('routing.deleteFailed'))
      setSelectedIndex(null)
    },
    onError: handleServerError,
  })

  const reorderMutation = useMutation({
    mutationFn: async (newRules: RoutingRule[]) => {
      if (!isRemote) return { success: false, message: t('routing.localSortNotSupported') }
      const preservedRules = rawRules.filter(isPreservedRule)
      return (await api.post(`/api/admin/remote/routing?server_id=${serverId}`, { action: 'set', routing: { ...routingData?.routing, rules: [...preservedRules, ...newRules] } })).data
    },
    onSuccess: async (data) => {
      queryClient.invalidateQueries({ queryKey: routingQueryKey })
      if (data.success) { await restartXray(); toast.success(t('routing.orderUpdated')) }
      else toast.error(data.message || t('routing.orderFailed'))
    },
    onError: handleServerError,
  })

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIdx = sortableIds.indexOf(String(active.id))
    const newIdx = sortableIds.indexOf(String(over.id))
    if (oldIdx === -1 || newIdx === -1) return
    reorderMutation.mutate(arrayMove([...rules], oldIdx, newIdx))
    if (selectedIndex === oldIdx) setSelectedIndex(newIdx)
    else if (selectedIndex !== null) {
      if (oldIdx < selectedIndex && newIdx >= selectedIndex) setSelectedIndex(selectedIndex - 1)
      else if (oldIdx > selectedIndex && newIdx <= selectedIndex) setSelectedIndex(selectedIndex + 1)
    }
  }

  const handleQuickAdd = (key: string) => {
    const preset = QUICK_RULES[key as keyof typeof QUICK_RULES]
    if (!preset) return
    if (preset.needSelectOutbound) {
      setPendingRule({ rule: { ...preset.rule } }); setSelectedOutbound(''); setIsOutboundSelectDialogOpen(true)
    } else addRuleMutation.mutate(preset.rule)
  }

  const handleConfirmOutbound = () => {
    if (!pendingRule || !selectedOutbound) return
    addRuleMutation.mutate({ ...pendingRule.rule, outboundTag: selectedOutbound })
    setIsOutboundSelectDialogOpen(false); setPendingRule(null)
  }

  const resetCustomForm = () => {
    setCustomDomain(''); setCustomIp(''); setCustomProtocol(''); setCustomPort('')
    setCustomSourcePort(''); setCustomNetwork(''); setCustomSource(''); setCustomUser('')
    setCustomInboundTag([]); setCustomInboundTagInput(''); setCustomAttrs(''); setCustomOutbound(''); setCustomMarktag('')
  }

  // 预填表单 = 把一条 rule 反向回填到 dialog 各字段。编辑入口调用。
  const openEditDialog = (idx: number) => {
    const rule = rules[idx]
    if (!rule) return
    setEditingIndex(idx)
    setCustomDomain((rule.domain || []).join(', '))
    setCustomIp((rule.ip || []).join(', '))
    setCustomProtocol((rule.protocol || []).join(', '))
    setCustomPort(rule.port ? String(rule.port) : '')
    setCustomSourcePort(rule.sourcePort ? String(rule.sourcePort) : '')
    setCustomNetwork(rule.network || '')
    setCustomSource((rule.source || []).join(', '))
    setCustomUser((rule.user || []).join(', '))
    setCustomInboundTag(rule.inboundTag || [])
    setCustomInboundTagInput('')
    setCustomAttrs(rule.attrs || '')
    setCustomMarktag(rule.marktag || '')
    // 编辑时 customOutbound 是已 resolve 的 tag(node:/balancer: 前缀只在添加流程里有,编辑回填用 plain tag)
    setCustomOutbound(rule.balancerTag ? `balancer:${rule.balancerTag}` : (rule.outboundTag || ''))
    setIsCustomRuleDialogOpen(true)
  }

  // customOutbound 三种取值:
  //   'foo'           ->  outboundTag = foo
  //   'balancer:foo'  ->  balancerTag = foo
  //   'node:<id>'     ->  按 id 找节点;若服务器已有等价出站直接复用,否则先建出站再加规则
  const handleAddCustomRule = async () => {
    if (!customOutbound) { toast.error(t('routing.selectOutboundRequired')); return }

    let resolvedOutboundTag: string | null = null
    let resolvedBalancerTag: string | null = null

    if (customOutbound.startsWith('balancer:')) {
      resolvedBalancerTag = customOutbound.slice('balancer:'.length)
    } else if (customOutbound.startsWith('node:')) {
      // 节点出站:先尝试在现有出站里找等价的;没有就根据节点 clash 配置建一个,然后用其 tag
      if (!isRemote) {
        toast.error(t('routing.nodeOutboundRemoteOnly'))
        return
      }
      const nodeId = parseInt(customOutbound.slice('node:'.length), 10)
      const node = nodes.find(n => n.id === nodeId)
      if (!node) { toast.error(t('routing.nodeNotFound')); return }

      const matched = matchNodeToExistingOutbound(node.clash, outbounds)
      if (matched) {
        resolvedOutboundTag = matched
      } else {
        // 自动建出站(tag 用 node-<id>-<protocol>),失败直接返回
        try {
          const tag = `node-${nodeId}-${(node.clash.type || node.protocol || 'proxy').toLowerCase()}`
          const ob = clashConfigToOutbound(node.clash, tag)
          const res = await api.post(
            `/api/admin/remote/outbounds?server_id=${serverId}`,
            { action: 'add', outbound: ob },
          )
          if (!res.data?.success) {
            toast.error(res.data?.message || t('routing.addOutboundFailed'))
            return
          }
          resolvedOutboundTag = tag
          toast.success(t('routing.outboundAutoAdded', { tag }))
          queryClient.invalidateQueries({ queryKey: outboundsQueryKey })
        } catch (e: any) {
          handleServerError(e, t('routing.addOutboundFailed'))
          return
        }
      }
    } else {
      resolvedOutboundTag = customOutbound
    }

    const rule: any = { type: 'field' }
    if (resolvedBalancerTag) rule.balancerTag = resolvedBalancerTag
    else if (resolvedOutboundTag) rule.outboundTag = resolvedOutboundTag

    const split = (v: string) => v.split(',').map(s => s.trim()).filter(Boolean)
    if (customDomain.trim()) rule.domain = split(customDomain)
    if (customIp.trim()) rule.ip = split(customIp)
    if (customProtocol.trim()) rule.protocol = split(customProtocol)
    if (customPort.trim()) rule.port = customPort.trim()
    if (customSourcePort.trim()) rule.sourcePort = customSourcePort.trim()
    if (customNetwork.trim()) rule.network = customNetwork.trim()
    if (customSource.trim()) rule.source = split(customSource)
    if (customUser.trim()) rule.user = split(customUser)
    // 入站:多选数组 + 临时输入框里的自定义 tag 合并
    const inboundTags: string[] = [...customInboundTag]
    if (customInboundTagInput.trim()) inboundTags.push(...split(customInboundTagInput))
    if (inboundTags.length) rule.inboundTag = inboundTags
    if (customAttrs.trim()) rule.attrs = customAttrs.trim()
    if (customMarktag.trim()) rule.marktag = customMarktag.trim()
    if (!rule.domain && !rule.ip && !rule.protocol && !rule.port && !rule.sourcePort && !rule.network && !rule.source && !rule.user && !rule.inboundTag && !rule.attrs) {
      toast.error(t('routing.fillAtLeastOne')); return
    }
    if (editingIndex !== null) {
      updateRuleMutation.mutate({ index: editingIndex, rule })
    } else {
      addRuleMutation.mutate(rule)
    }
    setIsCustomRuleDialogOpen(false); resetCustomForm(); setEditingIndex(null)
  }

  const isLoading = routingLoading || outboundsLoading
  const selectedRule = selectedIndex !== null ? rules[selectedIndex] : null
  const getFriendlyName = (rule: RoutingRule) => {
    if (!rule.marktag) return null
    const preset = Object.values(QUICK_RULES).find((p: any) => p.rule.marktag === rule.marktag) as any
    return preset ? preset.name : rule.marktag
  }

  return (
    <>
      <div className='space-y-3'>
        <div className='flex items-center justify-between'>
          <p className='text-sm text-muted-foreground'>{t('routing.routingRules', { count: rules.length })}{isRemote && ` · ${t('routing.canDragSort')}`}</p>
          <div className='flex items-center gap-2'>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size='sm'><Plus className='size-4 mr-1' />{t('routing.quickAdd')}<ChevronDown className='size-4 ml-1' /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align='end' className='w-56'>
                <DropdownMenuItem onClick={() => handleQuickAdd('ban_bt')}>{t('routing.banBt')}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleQuickAdd('ban_geoip_cn')}>{t('routing.banGeoipCn')}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleQuickAdd('fix_openai')}>{t('routing.fixOpenai')}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleQuickAdd('ban_private')}>{t('routing.banPrivate')}</DropdownMenuItem>
                {/* 防止送中 — 仅在 server 已添加 warp-v4 出站时显示;避免点击后 outboundTag 命中不到出站被回落到 default */}
                {/* WARP 出站只在内联 Xray 上可用,外置 Xray 没注入 wireguard 能力 → 防止送中也不显示 */}
                {hasWarpOutbound && xrayMode !== 'external' && (
                  <DropdownMenuItem onClick={() => handleQuickAdd('warp_anti_china')}>{t('routing.warpAntiChina')}</DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => handleQuickAdd('rfc_emby')}>{t('routing.rfcEmby')}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleQuickAdd('tiktok_unlock')}>{t('routing.tiktokUnlock')}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant='outline' size='sm' onClick={() => { resetCustomForm(); setIsCustomRuleDialogOpen(true) }}>
              <Plus className='size-4 mr-1' />{t('routing.customRule')}
            </Button>
            {isRemote && (
              <Button variant='outline' size='sm' onClick={() => setIsBalancerDialogOpen(true)}>
                <Scale className='size-4 mr-1' />{t('routing.balancer')}{balancers.length > 0 ? ` (${balancers.length})` : ''}
              </Button>
            )}
          </div>
        </div>

        {isLoading ? (
          <div className='text-center py-8'>
            <RefreshCw className='size-6 animate-spin mx-auto mb-2' />
            <p className='text-sm text-muted-foreground'>{tc('actions.loading')}</p>
          </div>
        ) : rules.length === 0 ? (
          <EmptyStateCard title={t('routing.noRules')} description={t('routing.noRulesDesc')} />
        ) : (
          <div className='flex gap-3' style={{ minHeight: 300 }}>
            <div className='w-[40%] shrink-0 space-y-1.5 overflow-y-auto max-h-[60vh] pr-1'>
              {/* 负载均衡器:上方独立段,只读展示。详细管理走 LB Manager Dialog。 */}
              {balancers.length > 0 && (
                <div className='mb-2 pb-2 border-b'>
                  <div className='text-[10px] uppercase tracking-wide text-muted-foreground mb-1 px-1 flex items-center gap-1'>
                    <Scale className='size-3' /> {t('routing.balancer')} ({balancers.length})
                  </div>
                  <div className='space-y-1'>
                    {balancers.map((b) => (
                      <div
                        key={`bal-${b.tag}`}
                        className='rounded-md border bg-muted/30 px-2 py-1 text-xs cursor-default'
                        onClick={() => setIsBalancerDialogOpen(true)}
                        title={t('routing.balancer') + ': ' + b.tag}
                      >
                        <div className='flex items-center justify-between gap-2'>
                          <span className='font-medium truncate'>⚖ {b.tag}</span>
                          <Badge variant='outline' className='text-[9px] px-1 py-0 shrink-0' title={balancerStrategyLabel(t, b.strategy)}>{b.strategy}</Badge>
                        </div>
                        <div className='text-muted-foreground text-[10px] truncate'>
                          {(b.selector || []).join(', ')}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className='text-[10px] uppercase tracking-wide text-muted-foreground mt-2 mb-1 px-1'>
                    {t('routing.title')}
                  </div>
                </div>
              )}
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
                  {rules.map((rule, i) => (
                    <SortableRuleItem key={`rule-${i}`} rule={rule} index={i} isSelected={selectedIndex === i} onClick={() => setSelectedIndex(i)} t={t} quickRules={QUICK_RULES} isMmwxManaged={isMmwxManagedRule(rule)} />
                  ))}
                </SortableContext>
              </DndContext>
            </div>
            <div className='flex-1 min-w-0 border rounded-lg p-4 bg-card overflow-y-auto max-h-[60vh]'>
              {selectedRule ? (
                <div className='space-y-4'>
                  <div className='flex items-center justify-between'>
                    <h4 className='font-medium text-sm flex items-center gap-2'>
                      {getFriendlyName(selectedRule) || t('routing.rule', { index: selectedIndex! + 1 })}
                      {isMmwxManagedRule(selectedRule) && (
                        <Badge variant='secondary' className='text-[10px] px-1.5 py-0 bg-primary/10 text-primary border-primary/30'>妙妙屋X 管理</Badge>
                      )}
                    </h4>
                    {!isMmwxManagedRule(selectedRule) && (
                      <div className='flex gap-2'>
                        <Button variant='outline' size='sm' className='h-7 text-xs' onClick={() => openEditDialog(selectedIndex!)}>
                          <Pencil className='size-3 mr-1' />{tc('actions.edit')}
                        </Button>
                        <Button variant='outline' size='sm' className='h-7 text-xs text-red-600 hover:text-red-700' onClick={() => setDeletingIndex(selectedIndex)}>
                          <Trash2 className='size-3 mr-1' />{tc('actions.delete')}
                        </Button>
                      </div>
                    )}
                  </div>
                  {isMmwxManagedRule(selectedRule) && (
                    <div className='rounded-md bg-primary/5 border border-primary/20 px-3 py-2 text-xs text-muted-foreground'>
                      此规则由妙妙屋X路由出站功能添加和管理。要修改请去节点管理页面操作对应的路由出站节点;要删除请先在节点管理里删除使用此 outbound 的 routed 节点。
                    </div>
                  )}
                  <div className='space-y-2 text-sm'>
                    {selectedRule.domain?.length && <div><span className='text-muted-foreground'>domain: </span><span className='break-all'>{selectedRule.domain.join(', ')}</span></div>}
                    {selectedRule.ip?.length && <div><span className='text-muted-foreground'>ip: </span><span className='break-all'>{selectedRule.ip.join(', ')}</span></div>}
                    {selectedRule.protocol?.length && <div><span className='text-muted-foreground'>protocol: </span>{selectedRule.protocol.join(', ')}</div>}
                    {selectedRule.port && <div><span className='text-muted-foreground'>port: </span>{String(selectedRule.port)}</div>}
                    {selectedRule.sourcePort && <div><span className='text-muted-foreground'>sourcePort: </span>{String(selectedRule.sourcePort)}</div>}
                    {selectedRule.network && <div><span className='text-muted-foreground'>network: </span>{selectedRule.network}</div>}
                    {selectedRule.source?.length && <div><span className='text-muted-foreground'>source: </span>{selectedRule.source.join(', ')}</div>}
                    {selectedRule.user?.length && <div><span className='text-muted-foreground'>user: </span>{selectedRule.user.join(', ')}</div>}
                    {selectedRule.inboundTag?.length && <div><span className='text-muted-foreground'>inboundTag: </span>{selectedRule.inboundTag.join(', ')}</div>}
                    {selectedRule.attrs && <div><span className='text-muted-foreground'>attrs: </span>{selectedRule.attrs}</div>}
                    {selectedRule.balancerTag
                      ? <div><span className='text-muted-foreground'>balancerTag: </span><Badge variant='secondary' className='text-xs'>⚖ {selectedRule.balancerTag}</Badge></div>
                      : <div><span className='text-muted-foreground'>outboundTag: </span><Badge variant={outboundBadgeVariant(selectedRule.outboundTag || '')} className='text-xs'>{selectedRule.outboundTag || t('routing.notSet')}</Badge></div>}
                    {selectedRule.marktag && <div><span className='text-muted-foreground'>marktag: </span>{selectedRule.marktag}</div>}
                  </div>
                  <div>
                    <p className='text-xs text-muted-foreground mb-1'>JSON</p>
                    <pre className='bg-muted p-3 rounded-md text-xs overflow-auto max-h-48'>{JSON.stringify(selectedRule, null, 2)}</pre>
                  </div>
                </div>
              ) : (
                <div className='flex items-center justify-center h-full text-sm text-muted-foreground'>{t('routing.clickToView')}</div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Select Outbound */}
      <Dialog open={isOutboundSelectDialogOpen} onOpenChange={setIsOutboundSelectDialogOpen}>
        <DialogContent className='max-w-md'>
          <DialogHeader><DialogTitle>{t('routing.selectOutbound')}</DialogTitle></DialogHeader>
          <Select value={selectedOutbound} onValueChange={setSelectedOutbound}>
            <SelectTrigger><SelectValue placeholder={t('routing.selectOutboundPlaceholder')} /></SelectTrigger>
            <SelectContent>
              {outbounds.map((o: any) => <SelectItem key={o.tag} value={o.tag}>{o.tag} ({o.protocol})</SelectItem>)}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant='outline' onClick={() => setIsOutboundSelectDialogOpen(false)}>{tc('actions.cancel')}</Button>
            <Button onClick={handleConfirmOutbound} disabled={!selectedOutbound}>{tc('actions.confirm')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Custom Rule */}
      <Dialog open={isCustomRuleDialogOpen} onOpenChange={(open) => { setIsCustomRuleDialogOpen(open); if (!open) { setEditingIndex(null); resetCustomForm() } }}>
        {/* placeholder 整体调淡 + 斜体 — 之前 muted-foreground 在某些主题下跟用户输入字符颜色接近,
            打开编辑/添加路由时分不清是空 placeholder 还是已有内容 */}
        <DialogContent className='max-w-lg max-h-[85vh] flex flex-col [&_input::placeholder]:text-muted-foreground/50 [&_textarea::placeholder]:text-muted-foreground/50 [&_input::placeholder]:italic [&_textarea::placeholder]:italic'>
          <DialogHeader><DialogTitle>{editingIndex !== null ? t('routing.editRule') : t('routing.addCustomRule')}</DialogTitle><DialogDescription>{t('routing.customRuleDesc')}</DialogDescription></DialogHeader>
          <div className='flex-1 overflow-y-auto space-y-3 py-2'>
            <div className='grid grid-cols-2 gap-3'>
              <div className='space-y-1'>
                <Label className='text-xs'>domain</Label>
                <Textarea placeholder='geosite:openai, example.com' value={customDomain} onChange={e => setCustomDomain(e.target.value)} className='text-xs min-h-[60px]' />
              </div>
              <div className='space-y-1'>
                <Label className='text-xs'>ip</Label>
                <Textarea placeholder='geoip:cn, 10.0.0.0/8' value={customIp} onChange={e => setCustomIp(e.target.value)} className='text-xs min-h-[60px]' />
              </div>
            </div>
            <div className='grid grid-cols-3 gap-3'>
              <div className='space-y-1'>
                <Label className='text-xs'>protocol</Label>
                <Input placeholder='bittorrent, http' value={customProtocol} onChange={e => setCustomProtocol(e.target.value)} className='text-xs' />
              </div>
              <div className='space-y-1'>
                <Label className='text-xs'>port</Label>
                <Input placeholder='80, 443, 1000-2000' value={customPort} onChange={e => setCustomPort(e.target.value)} className='text-xs' />
              </div>
              <div className='space-y-1'>
                <Label className='text-xs'>{t('routing.sourcePort')}</Label>
                <Input placeholder={t('routing.sourcePort')} value={customSourcePort} onChange={e => setCustomSourcePort(e.target.value)} className='text-xs' />
              </div>
            </div>
            <div className='grid grid-cols-3 gap-3'>
              <div className='space-y-1'>
                <Label className='text-xs'>network</Label>
                <Select value={customNetwork} onValueChange={setCustomNetwork}>
                  <SelectTrigger className='text-xs'><SelectValue placeholder={t('routing.noLimit')} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value='tcp'>tcp</SelectItem>
                    <SelectItem value='udp'>udp</SelectItem>
                    <SelectItem value='tcp,udp'>tcp,udp</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className='space-y-1'>
                <Label className='text-xs'>source</Label>
                <Input placeholder='source IP' value={customSource} onChange={e => setCustomSource(e.target.value)} className='text-xs' />
              </div>
              <div className='space-y-1'>
                <Label className='text-xs'>user</Label>
                <Input placeholder='user' value={customUser} onChange={e => setCustomUser(e.target.value)} className='text-xs' />
              </div>
            </div>
            {/* 入站标签:独占一行,Select + 自定义 tag 各占半宽,够呼吸 */}
            <div className='space-y-1'>
              <Label className='text-xs'>{t('routing.inboundTag')}</Label>
              <div className='space-y-1.5'>
                {customInboundTag.length > 0 && (
                  <div className='flex flex-wrap gap-1'>
                    {customInboundTag.map(tag => (
                      <Badge key={tag} variant='secondary' className='text-[10px] gap-1'>
                        {tag}
                        <button
                          type='button'
                          className='hover:text-destructive'
                          onClick={() => setCustomInboundTag(prev => prev.filter(t => t !== tag))}
                        >
                          <XIcon className='size-3' />
                        </button>
                      </Badge>
                    ))}
                  </div>
                )}
                <div className='grid grid-cols-2 gap-2'>
                  <Select value='' onValueChange={(v) => {
                    if (v && !customInboundTag.includes(v)) setCustomInboundTag(prev => [...prev, v])
                  }}>
                    <SelectTrigger className='text-xs'>
                      <SelectValue placeholder={inboundsList.length ? t('routing.selectInbound') : t('routing.noInbounds')} />
                    </SelectTrigger>
                    <SelectContent>
                      {inboundsList.filter((i: any) => !customInboundTag.includes(i.tag)).map((i: any) => (
                        <SelectItem key={i.tag} value={i.tag}>{i.tag} ({i.protocol}:{i.port})</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    placeholder={t('routing.customInboundTagPlaceholder')}
                    value={customInboundTagInput}
                    onChange={e => setCustomInboundTagInput(e.target.value)}
                    className='text-xs'
                  />
                </div>
              </div>
            </div>
            {/* 属性匹配 | 标记 并排,出站独占一行(选项多,需要宽度) */}
            <div className='grid grid-cols-2 gap-3'>
              <div className='space-y-1'>
                <Label className='text-xs'>{t('routing.attrMatch')}</Label>
                <Input placeholder={t('routing.attrMatch')} value={customAttrs} onChange={e => setCustomAttrs(e.target.value)} className='text-xs' />
              </div>
              <div className='space-y-1'>
                <Label className='text-xs'>{t('routing.mark')}</Label>
                <Input placeholder='marktag' value={customMarktag} onChange={e => setCustomMarktag(e.target.value)} className='text-xs' />
              </div>
            </div>
            <div className='space-y-1'>
              <Label className='text-xs'>{t('routing.outbound')} *</Label>
              <Select value={customOutbound} onValueChange={setCustomOutbound}>
                <SelectTrigger className='text-xs'><SelectValue placeholder={t('routing.selectOutboundPlaceholder')} /></SelectTrigger>
                <SelectContent>
                  {/* 服务器现有出站 */}
                  {outbounds.length > 0 && (
                    <div className='px-2 py-1 text-[10px] uppercase text-muted-foreground'>{t('routing.groupServerOutbounds')}</div>
                  )}
                  {outbounds.map((o: any) => <SelectItem key={o.tag} value={o.tag}>{o.tag} ({o.protocol})</SelectItem>)}
                  {/* 负载均衡器 */}
                  {balancers.length > 0 && (
                    <div className='px-2 py-1 text-[10px] uppercase text-muted-foreground'>{t('routing.groupBalancers')}</div>
                  )}
                  {balancers.map((b) => <SelectItem key={`bal-${b.tag}`} value={`balancer:${b.tag}`}>⚖ {b.tag} ({t('routing.balancer')})</SelectItem>)}
                  {/* 节点列表(选中后若服务器没有等价出站会自动创建) */}
                  {isRemote && nodes.length > 0 && (
                    <div className='px-2 py-1 text-[10px] uppercase text-muted-foreground'>{t('routing.groupNodes')}</div>
                  )}
                  {isRemote && nodes.map(n => (
                    <SelectItem key={`node:${n.id}`} value={`node:${n.id}`}>
                      🔗 {n.name} ({n.protocol}:{n.clash.port})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant='outline' onClick={() => { setIsCustomRuleDialogOpen(false); setEditingIndex(null); resetCustomForm() }}>{tc('actions.cancel')}</Button>
            <Button onClick={handleAddCustomRule} disabled={!customOutbound}>{editingIndex !== null ? tc('actions.save') : t('routing.addBtn')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Balancers (负载均衡器) - 共享组件 */}
      <BalancerManagerDialog
        open={isBalancerDialogOpen}
        onOpenChange={setIsBalancerDialogOpen}
        serverId={serverId}
        routing={routingData?.routing}
        outbounds={outbounds}
        onSaved={async () => { queryClient.invalidateQueries({ queryKey: routingQueryKey }); await restartXray() }}
      />

      {/* Delete Confirm */}
      <AlertDialog open={deletingIndex !== null} onOpenChange={o => !o && setDeletingIndex(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('routing.confirmDeleteRule')}</AlertDialogTitle>
            <AlertDialogDescription>{t('routing.confirmDeleteRuleDesc')}{isRemote ? ` ${t('routing.deleteAutoRestart')}` : ` ${t('routing.deleteIrreversible')}`}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tc('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction className='bg-red-600 hover:bg-red-700' onClick={() => {
              if (deletingIndex !== null) removeRuleMutation.mutate({ index: deletingIndex, rule: rules[deletingIndex] })
              setDeletingIndex(null)
            }}>{t('routing.confirmDelete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
