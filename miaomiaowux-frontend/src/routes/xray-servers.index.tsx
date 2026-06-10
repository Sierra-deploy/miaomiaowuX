// @ts-nocheck
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, useRef, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Plus, RefreshCw, Search, Trash2, Download, Cog, ChevronDown, Terminal, Play, Square, RotateCcw, Copy, Pencil, X, Settings, Wifi, Radio, Eye, ArrowUpCircle, Globe, CheckCircle, XCircle, Loader2, AlertTriangle, Lock, LockOpen, Share2, GripVertical, Bug, History } from 'lucide-react'
import { XraySnapshotHistoryDialog } from '@/components/xray/xray-snapshot-history-dialog'
import { RecoveryStatusBanner } from '@/components/xray/recovery-status-banner'
import { DndContext, PointerSensor, TouchSensor, KeyboardSensor, useSensor, useSensors, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useIsMobile } from '@/hooks/use-mobile'
import { ViewToggle, type ViewMode } from '@/components/ui/view-toggle'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useLicenseUsage } from '@/hooks/use-license'
import { formatBytes as formatTraffic, formatSpeed } from '@/lib/format'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import { Twemoji } from '@/components/twemoji'

import { InboundPanel } from '@/components/xray/inbound-panel'
import { OutboundPanel } from '@/components/xray/outbound-panel'
import { ShareServerDialog } from '@/components/xray/share-server-dialog'
import { AddSharedServerDialog } from '@/components/xray/add-shared-server-dialog'
import { RoutingPanel } from '@/components/xray/routing-panel'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@/components/ui/sheet'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyStateCard } from '@/components/ui/empty-state'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { TableCard } from '@/components/ui/table-card'
import { api } from '@/lib/api'
import { handleServerError } from '@/lib/handle-server-error'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'

interface XraySystemConfig {
  metrics_enabled: boolean
  metrics_listen: string
  stats_enabled: boolean
  grpc_enabled: boolean
  grpc_port: number
}

interface RemoteServerInboundInfo {
  tag: string
  protocol: string
  port: number
  uplink: number
  downlink: number
}

interface RemoteServer {
  id: number
  name: string
  token: string
  status: 'pending' | 'connected' | 'offline'
  last_heartbeat?: string
  ip_address?: string
  domain?: string
  connection_mode: 'push' | 'pull' | 'websocket' | 'http' | 'auto'
  pull_address?: string
  pull_port?: number
  listen_port?: number    // Agent HTTP 监听端口(0 = 用默认 23889)
  pull_token?: string
  last_pull_at?: string
  push_fail_count?: number
  fallback_to_pull?: boolean
  fallback_at?: string
  ws_connected?: boolean
  traffic_limit?: number
  traffic_used?: number
  traffic_reset_day?: number
  steal_mode?: string
  xray_mode?: 'external' | 'embedded'
  warp_installed?: boolean
  time_offset_seconds?: number
  inbounds?: RemoteServerInboundInfo[]
  current_upload_speed?: number
  current_download_speed?: number
  speed_updated_at?: string
  encrypted?: boolean
  created_at: string
  updated_at: string
}

function getTrafficPercent(used: number, limit: number): number {
  if (limit === 0) return 0
  return (used / limit) * 100
}

// buildRemoteInstallCommand 按当前 server 字段组装 install URL。
//
// 必须带上 xray_mode / steal_self 等参数 — 不带会让 install.sh 默认装 external xray + 不装 nginx,
// 跟用户在创建 dialog 里选的偷自己/embedded 等配置漂移,典型表现是 agent 起来后 status=offline、
// scan_result=xray_running=false。详情 Dialog 和恢复 Popover 之前都只带了 token,被踩坑过。
function buildRemoteInstallCommand(server: { token: string; xray_mode?: string; steal_mode?: string; listen_port?: number }, masterOrigin: string): string {
  const qs = new URLSearchParams()
  qs.set('token', server.token)
  if (server.xray_mode === 'embedded') qs.set('xray_mode', 'embedded')
  // steal_mode in (tunnel, fallback) 视为开了"偷自己" — install.sh 收到 steal_self=1 才装 nginx
  if (server.steal_mode === 'tunnel' || server.steal_mode === 'fallback') {
    qs.set('steal_self', '1')
    qs.set('front_service', 'xray')
  }
  if (server.listen_port && server.listen_port > 0) qs.set('listen_port', String(server.listen_port))
  return `curl -fsSL '${masterOrigin}/api/remote/install.sh?${qs.toString()}' | bash`
}

// SortableServerCard / SortableServerRow:dnd-kit 包装层。把当前迭代项变成可拖动的 sortable,
// 通过 render prop 把拖动把手 props 传给消费方,消费方决定把 GripVertical 按钮挂哪里。
// 注意 TouchSensor + touch-none 必须同时存在,iPad / 手机长按拖动才能生效。
// IPCell:固定列宽 + truncate 省略号;hover 通过 Tooltip 显示完整 IP(双栈时分多行)。
function IPCell({ raw }: { raw: string }) {
  const ips = (raw || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (ips.length === 0) return <span className='text-xs text-muted-foreground'>-</span>
  const display = ips.join('  ·  ')
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className='max-w-[140px] truncate font-mono text-xs text-muted-foreground cursor-default'>
            {display}
          </div>
        </TooltipTrigger>
        <TooltipContent className='font-mono text-[11px]'>
          {ips.map((ip) => <div key={ip}>{ip}</div>)}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function SortableServerCard({ id, children }: { id: number; children: (dragHandle: any, isDragging: boolean) => React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }
  return (
    <div ref={setNodeRef} style={style} className={isDragging ? 'z-50 relative' : ''}>
      {children({ ...attributes, ...listeners }, isDragging)}
    </div>
  )
}

function SortableServerRow({ id, children }: { id: number; children: (dragHandle: any, isDragging: boolean) => React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }
  return (
    <TableRow ref={setNodeRef as any} style={style} className={isDragging ? 'bg-muted/40' : ''}>
      {children({ ...attributes, ...listeners }, isDragging)}
    </TableRow>
  )
}

export const Route = createFileRoute('/xray-servers/')({
  component: XrayServersPage,
})

function XrayServersPage() {
  const { t } = useTranslation('xray')
  const { t: tc } = useTranslation('common')
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { data: licenseUsage } = useLicenseUsage()
  const serversAtLimit = Boolean(licenseUsage?.usage?.servers && licenseUsage.usage.servers.current >= licenseUsage.usage.servers.max)
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false)
  const [shareServer, setShareServer] = useState<{ id: number; name: string } | null>(null)
  const isMobile = useIsMobile()
  const [viewModeRaw, setViewMode] = useState<ViewMode>(() => (localStorage.getItem('servers-view-mode') as ViewMode) || 'card')
  // 手机端无视用户选择,强制卡片模式 —— table 在手机端体验差且不便拖动
  const viewMode: ViewMode = isMobile ? 'card' : viewModeRaw
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const [formData, setFormData] = useState({
    name: '',
    traffic_limit_gb: '',
    traffic_used_gb: '',
    traffic_reset_day: '1',
  })
  const [isXrayRawConfigDialogOpen, setIsXrayRawConfigDialogOpen] = useState(false)
  const [xrayRawConfig, setXrayRawConfig] = useState('')
  const [xrayRawConfigLoading, setXrayRawConfigLoading] = useState(false)
  const [xrayRawConfigServerId, setXrayRawConfigServerId] = useState<number | null>(null)
  const [xrayRawConfigServerName, setXrayRawConfigServerName] = useState('')
  // xray 配置历史 Dialog
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false)
  const [historyServerId, setHistoryServerId] = useState<number | null>(null)
  const [historyServerName, setHistoryServerName] = useState('')
  const [historyPreviewId, setHistoryPreviewId] = useState<number | null>(null)
  const [historyPreviewConfig, setHistoryPreviewConfig] = useState('')
  const [isTerminalDialogOpen, setIsTerminalDialogOpen] = useState(false)
  const [terminalTitle, setTerminalTitle] = useState('')
  const [terminalOutput, setTerminalOutput] = useState('')
  const [terminalRunning, setTerminalRunning] = useState(false)
  const terminalRef = useRef<HTMLDivElement>(null)
  const [remoteServerName, setRemoteServerName] = useState('')
  const [generatedToken, setGeneratedToken] = useState('')
  const [installCommand, setInstallCommand] = useState('')
  // 添加 server 后,用 server.id 在 remoteServersData 里查它的 status。一旦变成 connected,
  // 自动关闭 add dialog — 用户就不需要手动点"完成"了,且明确知道安装成功。
  const [createdServerId, setCreatedServerId] = useState<number | null>(null)
  const [isGeneratingToken, setIsGeneratingToken] = useState(false)
  const [pullAddress, setPullAddress] = useState('')
  const [pullPort, setPullPort] = useState('23889')
  const [pullToken, setPullToken] = useState('')
  const [createStealSelf, setCreateStealSelf] = useState(false)
  const [createFrontService, setCreateFrontService] = useState<'xray' | 'nginx'>('xray')
  const [createStealMode, setCreateStealMode] = useState<'tunnel' | 'fallback'>('tunnel')
  const [createUse443, setCreateUse443] = useState(false)
  const [createDomain, setCreateDomain] = useState('')
  const [domainAutoFilled, setDomainAutoFilled] = useState(false)
  const [createXrayMode, setCreateXrayMode] = useState<'external' | 'embedded'>('external')
  // 服务器层流量统计规则:both(上+下,默认)/ upload(仅上行)/ download(仅下行)
  // 影响节点流量聚合方向,用户流量仍按套餐 traffic_mode 走
  const [createTrafficStatsMode, setCreateTrafficStatsMode] = useState<'both' | 'upload' | 'download'>('both')
  const [createSiteType, setCreateSiteType] = useState<'static' | 'proxy'>('static')
  const [createSiteValue, setCreateSiteValue] = useState('')
  const [isAddWebsiteDialogOpen, setIsAddWebsiteDialogOpen] = useState(false)
  const [addWebsiteServerId, setAddWebsiteServerId] = useState<number | null>(null)
  const [addWebsiteDomain, setAddWebsiteDomain] = useState('')
  const [addWebsiteSiteType, setAddWebsiteSiteType] = useState<'static' | 'proxy'>('static')
  const [addWebsiteSiteValue, setAddWebsiteSiteValue] = useState('')
  const [addWebsiteValidating, setAddWebsiteValidating] = useState(false)
  const [addWebsiteValidResult, setAddWebsiteValidResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const [addWebsiteSubmitting, setAddWebsiteSubmitting] = useState(false)
  // 一键升级所有 agent
  type UpgradeProgress = { name: string; status: 'pending' | 'running' | 'success' | 'error'; log: string; message?: string }
  const [isUpgradeAllDialogOpen, setIsUpgradeAllDialogOpen] = useState(false)
  const [upgradeAllProgress, setUpgradeAllProgress] = useState<Record<number, UpgradeProgress>>({})
  const [upgradeAllRunning, setUpgradeAllRunning] = useState(false)
  const [isDeleteRemoteServerDialogOpen, setIsDeleteRemoteServerDialogOpen] = useState(false)
  const [deletingRemoteServerId, setDeletingRemoteServerId] = useState<number | null>(null)
  // 安装/卸载服务 dialog — 替代原 InstallPopover,从 Agent 下拉里触发,卡片底部不再有第三个按钮
  // 让所有卡片 footer 维持 2 按钮(Xray 配置 + Agent),高度统一。
  // Dialog inline 渲染,state 必须放 page 顶层 — 之前抽成 InstallServiceDialog 组件定义在 page 函数内部,
  // 每次父组件 re-render 都是新函数引用 → React 视为新组件 → unmount/remount → 一 hover 就闪烁循环开/关。
  const [installDialogServerId, setInstallDialogServerId] = useState<number | null>(null)
  const [installWithNginx, setInstallWithNginx] = useState('yes')
  const [selectedRemoteServer, setSelectedRemoteServer] = useState<RemoteServer | null>(null)
  const [isRemoteServerDetailDialogOpen, setIsRemoteServerDetailDialogOpen] = useState(false)
  const [isRemoteManageDialogOpen, setIsRemoteManageDialogOpen] = useState(false)
  const [managingRemoteServer, setManagingRemoteServer] = useState<RemoteServer | null>(null)
  const [remoteServicesStatus, setRemoteServicesStatus] = useState<{
    xray?: { installed: boolean; running: boolean; version?: string };
    nginx?: { installed: boolean; running: boolean; version?: string };
  } | null>(null)
  const [remoteServicesLoading, setRemoteServicesLoading] = useState(false)
  const [remoteServicesStatusMap, setRemoteServicesStatusMap] = useState<Record<number, {
    xray?: { installed: boolean; running: boolean; version?: string };
    nginx?: { installed: boolean; running: boolean; version?: string };
    loading?: boolean;
    loaded?: boolean;
  }>>({})
  const [isEditRemoteServerDialogOpen, setIsEditRemoteServerDialogOpen] = useState(false)
  const [editingRemoteServer, setEditingRemoteServer] = useState<RemoteServer | null>(null)
  const [remoteFormData, setRemoteFormData] = useState({
    name: '',
    pull_address: '',
    domain: '',
    traffic_limit_gb: '',
    traffic_used_gb: '',
    traffic_reset_day: '',
    steal_mode: 'default',
    xray_mode: 'embedded',
    traffic_stats_mode: 'both' as 'both' | 'upload' | 'download',
  })
  const [configServer, setConfigServer] = useState<{ type: 'remote'; server: RemoteServer } | null>(null)
  const [remoteXraySystemConfig, setRemoteXraySystemConfig] = useState<XraySystemConfig>({
    metrics_enabled: false,
    metrics_listen: '127.0.0.1:38889',
    stats_enabled: false,
    grpc_enabled: false,
    grpc_port: 46736,
  })
  const [remoteXraySystemConfigLoading, setRemoteXraySystemConfigLoading] = useState(false)
  const [isSyncNodesDialogOpen, setIsSyncNodesDialogOpen] = useState(false)
  const [syncingServerId, setSyncingServerId] = useState<number | null>(null)
  const [syncServerHost, setSyncServerHost] = useState('')
  const [syncForceOverride, setSyncForceOverride] = useState(false)

  const getAuthToken = () => useAuthStore.getState().auth.accessToken

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight
    }
  }, [terminalOutput])

  const { data: remoteServersData, isLoading } = useQuery({
    queryKey: ['remote-servers'],
    queryFn: async () => {
      const response = await api.get('/api/admin/remote-servers')
      return response.data
    },
    refetchInterval: 3000,
  })

  // 老 Agent BUG 检测:批量查所有 connected & 非联邦 server 的 agent-version-info。
  // queryKey 跟 AgentVersionIndicator 完全一致,共享 react-query cache,不产生额外网络请求。
  // 任一 current < 0.2.0 → 标题旁出现红色 BUG 按钮,点击展示升级指引。
  const upgradeBugServers = useMemo<any[]>(() => {
    return ((remoteServersData?.servers ?? []) as any[]).filter(
      (s) => s && s.id && !s.is_federated && s.status === 'connected',
    )
  }, [remoteServersData])
  const agentVersionResults = useQueries({
    queries: upgradeBugServers.map((s) => ({
      queryKey: ['agent-version-info', s.id],
      queryFn: async () => {
        const resp = await api.get(`/api/admin/remote/agent/version-info?server_id=${s.id}`)
        return resp.data as { current?: string }
      },
      staleTime: 5 * 60 * 1000,
      retry: false,
    })),
  })
  const compareSemver = (a: string, b: string): number => {
    const pa = a.split('.').map((x) => parseInt(x, 10) || 0)
    const pb = b.split('.').map((x) => parseInt(x, 10) || 0)
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
    return 0
  }
  const hasOldAgent = useMemo(() => {
    for (const q of agentVersionResults) {
      const cur = ((q.data as any)?.current ?? '').trim()
      if (cur && compareSemver(cur, '0.2.0') < 0) return true
    }
    return false
  }, [agentVersionResults])
  const [agentBugDialogOpen, setAgentBugDialogOpen] = useState(false)
  const AGENT_UPGRADE_CMD = 'bash <(curl -sL https://raw.githubusercontent.com/iluobei/mmw-agent/refs/heads/main/scripts/upgrade-agent.sh)'

  const { data: masterUrlData } = useQuery({
    queryKey: ['master-url'],
    queryFn: async () => {
      const response = await api.get('/api/admin/system-settings/master-url')
      return response.data as { success: boolean; master_url: string }
    },
    staleTime: 5 * 60 * 1000,
  })

  const masterOrigin = masterUrlData?.master_url || window.location.origin

  const { data: masterCertData } = useQuery({
    queryKey: ['master-cert-status'],
    queryFn: async () => {
      const response = await api.get('/api/admin/master-cert-status')
      return response.data as { success: boolean; domain: string; https_enabled: boolean }
    },
    staleTime: 5 * 60 * 1000,
  })

  // 拖动结束后,带乐观更新地把新顺序持久化到后端;后端按 ids 数组写 sort_order
  const reorderRemoteServersMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      const response = await api.post('/api/admin/remote-servers/reorder', { ids })
      return response.data
    },
    onMutate: async (ids: number[]) => {
      await queryClient.cancelQueries({ queryKey: ['remote-servers'] })
      const previous = queryClient.getQueryData<any>(['remote-servers'])
      if (previous?.servers) {
        const byId = new Map<number, any>(previous.servers.map((s: any) => [s.id, s]))
        const reordered = ids.map(id => byId.get(id)).filter(Boolean)
        queryClient.setQueryData(['remote-servers'], { ...previous, servers: reordered })
      }
      return { previous }
    },
    onError: (err, _ids, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(['remote-servers'], ctx.previous)
      handleServerError(err as any)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['remote-servers'] }),
  })

  const handleServerDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = remoteServers.findIndex((s: RemoteServer) => s.id === Number(active.id))
    const newIndex = remoteServers.findIndex((s: RemoteServer) => s.id === Number(over.id))
    if (oldIndex < 0 || newIndex < 0) return
    const next = arrayMove(remoteServers, oldIndex, newIndex)
    reorderRemoteServersMutation.mutate(next.map((s: RemoteServer) => s.id))
  }

  const saveXrayRawConfigMutation = useMutation({
    // 保存前先调 agent test-config 预检 — 失败直接 toast,不下发到 agent 写盘,
    // 杜绝坏配置覆盖正常 config 引发 xray 重启失败的事故。
    // agent 端 setXrayConfig 仍有第二道 test 兜底(force=false 默认),双保险。
    mutationFn: async ({ serverId, config }: { serverId: number; config: string }) => {
      const testResp = await api.post(`/api/admin/remote/xray/test-config?server_id=${serverId}`, { config })
      const testData = testResp.data as { ok?: boolean; error?: string; output?: string; method?: string }
      if (!testData?.ok) {
        const detail = [testData?.error, testData?.output].filter(Boolean).join(' | ')
        throw new Error(`${t('servers.xrayConfigTestFailed') || 'xray config 测试未通过'} (${testData?.method || 'xray'}): ${detail || 'unknown'}`)
      }
      const response = await api.post(`/api/admin/remote/xray/config?server_id=${serverId}`, { config })
      return response.data
    },
    onSuccess: (data) => { data.success ? toast.success(t('servers.xrayConfigSaved')) : toast.error(data.message || t('servers.saveFailed')) },
    onError: (err: any) => {
      if (err?.message && !err?.response) {
        toast.error(err.message)
        return
      }
      handleServerError(err)
    },
  })

  const createRemoteServerMutation = useMutation({
    mutationFn: async (data: { name: string; traffic_limit?: number; traffic_used_offset?: number; traffic_reset_day?: number; connection_mode?: string; pull_address?: string; pull_port?: number; listen_port?: number; pull_token?: string; steal_self?: boolean; front_service?: 'xray' | 'nginx'; domain?: string; use_443?: boolean; traffic_stats_mode?: 'both' | 'upload' | 'download' }) => {
      const response = await api.post('/api/admin/remote-servers/create', data)
      return response.data
    },
    onSuccess: (data) => {
      if (data.success) {
        setGeneratedToken(data.server?.token || '')
        setPullToken(data.server?.pull_token || '')
        setInstallCommand(data.install_command || '')
        if (data.server?.id) setCreatedServerId(data.server.id)
        queryClient.invalidateQueries({ queryKey: ['remote-servers'] })
        if (data.is_local) {
          toast.success(t('servers.localServerDetected'))
        } else {
          toast.success(t('servers.serverCreated'))
        }
      } else { toast.error(data.message || t('servers.createFailed')) }
      setIsGeneratingToken(false)
    },
    onError: (error) => { setIsGeneratingToken(false); handleServerError(error) },
  })

  const deleteRemoteServerMutation = useMutation({
    mutationFn: async (id: number) => { const response = await api.post('/api/admin/remote-servers/delete', { id }); return response.data },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['remote-servers'] }); toast.success(t('servers.serverDeleted')) },
    onError: handleServerError,
  })

  const updateRemoteServerMutation = useMutation({
    mutationFn: async (data: { id: number; name: string; pull_address?: string; domain?: string; traffic_limit: number; traffic_used?: number; traffic_reset_day: number; connection_mode?: string; xray_mode?: string; listen_port?: number }) => {
      const response = await api.put('/api/admin/remote-servers/update', data)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['remote-servers'] })
      setIsEditRemoteServerDialogOpen(false)
      setEditingRemoteServer(null)
      setRemoteFormData({ name: '', pull_address: '', domain: '', traffic_limit_gb: '', traffic_used_gb: '', traffic_reset_day: '', steal_mode: 'default', xray_mode: 'embedded', traffic_stats_mode: 'both' })
      toast.success(t('servers.serverUpdated'))
    },
    onError: handleServerError,
  })

  const updateConnectionModeMutation = useMutation({
    mutationFn: async (data: { id: number; connection_mode: string }) => {
      const servers = remoteServersData?.servers || []
      const server = servers.find((s: RemoteServer) => s.id === data.id)
      if (!server) throw new Error(t('servers.serverNotFound'))
      const response = await api.put('/api/admin/remote-servers/update', { id: data.id, name: server.name, traffic_limit: server.traffic_limit || 0, traffic_reset_day: server.traffic_reset_day || 0, connection_mode: data.connection_mode })
      return response.data
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['remote-servers'] }); toast.success(t('servers.connectionModeUpdated')) },
    onError: handleServerError,
  })

  const remoteServiceControlMutation = useMutation({
    mutationFn: async ({ serverId, service, action }: { serverId: number, service: 'xray' | 'nginx', action: 'start' | 'stop' | 'restart' }) => {
      const response = await api.post(`/api/admin/remote/services/control?server_id=${serverId}`, { service, action })
      const data = response.data
      if (data && data.success === false) {
        throw new Error(data.error || data.message || data.msg || t('servers.serviceControlFailed'))
      }
      return data
    },
    onSuccess: (data, variables) => {
      if (managingRemoteServer) loadRemoteServicesStatus(managingRemoteServer.id)
      const actionText = variables.action === 'start' ? t('servers.actionStart') : variables.action === 'stop' ? t('servers.actionStop') : t('servers.actionRestart')
      toast.success(t('servers.serviceStarted', { service: variables.service === 'xray' ? 'Xray' : 'Nginx', action: actionText }))
    },
    onError: (error, variables) => {
      const serviceName = variables.service === 'xray' ? 'Xray' : 'Nginx'
      const actionText = variables.action === 'start' ? t('servers.actionStart') : variables.action === 'stop' ? t('servers.actionStop') : t('servers.actionRestart')
      if (error instanceof Error && !(error as any).response) {
        toast.error(`${serviceName} ${actionText}${t('servers.failed')}: ${error.message}`)
      } else {
        handleServerError(error)
      }
    },
  })

  const updateRemoteXraySystemConfigMutation = useMutation({
    mutationFn: async (config: XraySystemConfig & { server_id: number }) => {
      const response = await api.post(`/api/admin/remote/xray/system-config?server_id=${config.server_id}`, config)
      return response.data
    },
    onSuccess: (data) => {
      if (data.success) { toast.success(t('servers.remoteXrayConfigUpdated')); setIsXrayRawConfigDialogOpen(false); setConfigServer(null) }
      else { toast.error(data.message || t('servers.configUpdateFailed')) }
    },
    onError: handleServerError,
  })

  const syncNodesMutation = useMutation({
    mutationFn: async ({ serverId, serverHost, forceOverride }: { serverId: number, serverHost: string, forceOverride: boolean }) => {
      const response = await api.post(`/api/admin/remote/sync-nodes?server_id=${serverId}`, { server_host: serverHost, force_override: forceOverride })
      return response.data
    },
    onSuccess: (data) => {
      setIsSyncNodesDialogOpen(false); setSyncingServerId(null); setSyncServerHost(''); setSyncForceOverride(false)
      if (data.synced_count > 0) { toast.success(data.message || t('servers.nodeSyncSuccess')); if (data.synced_tags?.length > 0) toast.info(t('servers.syncedTags', { tags: data.synced_tags.join(', ') })) }
      else if (data.skipped_count > 0) { toast.warning(data.message || t('servers.nodeSyncNoNew')) }
      else { toast.info(t('servers.noSyncableInbound')) }
      if (data.errors?.length > 0) { data.errors.slice(0, 3).forEach((err: string) => toast.error(err)); if (data.errors.length > 3) toast.error(t('servers.moreErrors', { count: data.errors.length - 3 })) }
    },
    onError: handleServerError,
  })

  const deployStealSelfMutation = useMutation({
    mutationFn: async (serverId: number) => { const response = await api.post(`/api/admin/remote/deploy-steal-self?server_id=${serverId}`); return response.data },
    onSuccess: () => { toast.success(t('servers.configDeployed')) },
    onError: handleServerError,
  })

  const switchStealModeMutation = useMutation({
    mutationFn: async ({ serverId, stealMode }: { serverId: number; stealMode: string }) => {
      const response = await api.post(`/api/admin/remote/switch-steal-mode?server_id=${serverId}`, { steal_mode: stealMode })
      return response.data
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['remote-servers'] })
      queryClient.invalidateQueries({ queryKey: ['nodes'] })
      toast.success(data.message || t('servers.modeSwitch'))
    },
    onError: handleServerError,
  })

  const remoteScanMutation = useMutation({
    mutationFn: async (serverId: number) => { const response = await api.post(`/api/admin/remote/scan?server_id=${serverId}`); return { ...response.data, serverId } },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['remote-servers'] }); queryClient.invalidateQueries({ queryKey: ['nodes'] })
      loadRemoteServerStatusToCache(data.serverId, true)
      if (data.xray_running) {
        let message = data.message || t('servers.scanComplete')
        if (data.synced_count > 0 && (data.claimed_count > 0 || data.created_count > 0)) {
          message = t('servers.scanSyncedWithClaim', { claimed: data.claimed_count ?? 0, created: data.created_count ?? 0 })
        }
        else if (data.synced_count > 0 && data.synced_tags?.length > 0) message = t('servers.scanSynced', { count: data.synced_count, tags: data.synced_tags.join(', ') })
        else if (data.synced_count === 0 && data.skipped_count > 0) message = t('servers.scanSkipped', { count: data.skipped_count })
        toast.success(message)
      } else { toast.info(data.message || t('servers.scanComplete')) }
    },
    onError: handleServerError,
  })

  // --- END MUTATIONS ---

  const streamRemoteOp = async (url: string, title: string, onComplete?: () => void) => {
    setTerminalTitle(title); setTerminalOutput(''); setTerminalRunning(true); setIsTerminalDialogOpen(true)
    try {
      const token = getAuthToken()
      const response = await fetch(url, { method: 'POST', headers: { 'MM-Authorization': token || '', 'Content-Type': 'application/json' } })
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)
      const reader = response.body?.getReader()
      const decoder = new TextDecoder()
      if (!reader) throw new Error('No reader available')
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        for (const line of text.split('\n')) {
          if (!line.startsWith('data: ')) continue
          try {
            const data = JSON.parse(line.slice(6))
            if (data.type === 'output') { setTerminalOutput(prev => prev + data.data.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '') + '\n') }
            else if (data.type === 'complete') { setTerminalRunning(false); setTerminalOutput(prev => prev + '\n✅ ' + data.message); toast.success(data.message); onComplete?.() }
            else if (data.type === 'error') { setTerminalRunning(false); setTerminalOutput(prev => prev + '\n❌ ' + data.message); toast.error(data.message) }
          } catch { /* incomplete JSON chunk */ }
        }
      }
    } catch (error: any) { setTerminalRunning(false); setTerminalOutput(prev => prev + '\n❌ ' + t('servers.requestFailed', { error: error?.message || t('servers.unknownError') })); toast.error(t('servers.failedSuffix', { title })) }
  }

  const handleRemoteInstallXray = (serverId: number) => streamRemoteOp(`/api/admin/remote/xray/install-stream?server_id=${serverId}`, t('servers.installXray'), () => { loadRemoteServerStatusToCache(serverId, true); if (managingRemoteServer) loadRemoteServicesStatus(managingRemoteServer.id) })
  const handleRemoteRemoveXray = (serverId: number) => streamRemoteOp(`/api/admin/remote/xray/remove-stream?server_id=${serverId}`, t('servers.removeXray'), () => { loadRemoteServerStatusToCache(serverId, true); if (managingRemoteServer) loadRemoteServicesStatus(managingRemoteServer.id) })
  const handleRemoteInstallNginx = (serverId: number) => streamRemoteOp(`/api/admin/remote/nginx/install-stream?server_id=${serverId}`, t('servers.installNginx'), () => { loadRemoteServerStatusToCache(serverId, true); if (managingRemoteServer) loadRemoteServicesStatus(managingRemoteServer.id) })
  const handleRemoteRemoveNginx = (serverId: number) => streamRemoteOp(`/api/admin/remote/nginx/remove-stream?server_id=${serverId}`, t('servers.removeNginx'), () => { loadRemoteServerStatusToCache(serverId, true); if (managingRemoteServer) loadRemoteServicesStatus(managingRemoteServer.id) })
  const handleAgentUpgrade = (serverId: number) => streamRemoteOp(
    `/api/admin/remote/agent/upgrade-stream?server_id=${serverId}`,
    t('servers.upgradeAgentAction'),
    () => {
      // 升级流结束后立刻刷:agent 重启窗口里 xray 状态查询会落空 → 灰色化,缓存 5min 不刷新版本号也不更新。
      // 用 invalidate + 主动 refetch 双保险,5s 后再做一次让 agent 真正起来后的版本能拿到。
      queryClient.invalidateQueries({ queryKey: ['agent-version-info', serverId] })
      loadRemoteServerStatusToCache(serverId, true)
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['agent-version-info', serverId] })
        loadRemoteServerStatusToCache(serverId, true)
      }, 5000)
    }
  )

  // 单台 agent 升级 stream,把进度写进 upgradeAllProgress[serverId]。返回是否成功。供"一键升级所有 agent"复用。
  const streamUpgradeOneAgent = async (serverId: number): Promise<boolean> => {
    setUpgradeAllProgress(prev => ({ ...prev, [serverId]: { ...prev[serverId], status: 'running' } }))
    let ok = true
    try {
      const token = getAuthToken()
      const response = await fetch(`/api/admin/remote/agent/upgrade-stream?server_id=${serverId}`, {
        method: 'POST', headers: { 'MM-Authorization': token || '', 'Content-Type': 'application/json' },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const reader = response.body?.getReader()
      const decoder = new TextDecoder()
      if (!reader) throw new Error('No reader available')
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        for (const line of text.split('\n')) {
          if (!line.startsWith('data: ')) continue
          try {
            const data = JSON.parse(line.slice(6))
            if (data.type === 'output') {
              setUpgradeAllProgress(prev => ({ ...prev, [serverId]: { ...prev[serverId], log: prev[serverId].log + data.data.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '') + '\n' } }))
            } else if (data.type === 'complete') {
              setUpgradeAllProgress(prev => ({ ...prev, [serverId]: { ...prev[serverId], status: 'success', message: data.message } }))
            } else if (data.type === 'error') {
              ok = false
              setUpgradeAllProgress(prev => ({ ...prev, [serverId]: { ...prev[serverId], status: 'error', message: data.message } }))
            }
          } catch { /* incomplete JSON chunk */ }
        }
      }
      // stream 正常结束但没收到 complete/error,兜底标记成功
      setUpgradeAllProgress(prev => {
        const cur = prev[serverId]
        if (cur && cur.status === 'running') return { ...prev, [serverId]: { ...cur, status: 'success' } }
        return prev
      })
      // 升级流跑完(成功或失败)立刻 invalidate 这台服务器的 version-info 缓存。
      // 5s 后再 invalidate 一次,等 agent 真正重启 + 主控 probe 拿到新版本号 → chip 文案 + 红点自动更新。
      // 不加这两次 invalidate 的话,前端 staleTime=5min/refetchInterval=10min,
      // 升级后最坏 10min 才能看到新版本号。
      queryClient.invalidateQueries({ queryKey: ['agent-version-info', serverId] })
      loadRemoteServerStatusToCache(serverId, true)
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['agent-version-info', serverId] })
        loadRemoteServerStatusToCache(serverId, true)
      }, 5000)
      return ok
    } catch (error: any) {
      setUpgradeAllProgress(prev => ({ ...prev, [serverId]: { ...prev[serverId], status: 'error', message: error?.message || t('servers.unknownError') } }))
      // 失败也 invalidate,可能部分步骤成功了 / 用户重试观察版本号变化
      queryClient.invalidateQueries({ queryKey: ['agent-version-info', serverId] })
      return false
    }
  }

  // 一键升级所有 agent:并行触发,每台机器自己跑 SSE 升级流互不阻塞。
  // GitHub release CDN 单 IP 多并发拉同一个 binary 不会限流(各服务器是不同 IP),
  // 之前担心的"限流"是误判 — 改回串行的代价是 N 台 × ~10s,客户端体验差。
  const handleUpgradeAllAgents = async () => {
    const targets = remoteServers
    if (targets.length === 0) return
    const initial: Record<number, UpgradeProgress> = {}
    for (const s of targets) initial[s.id] = { name: s.name, status: 'pending', log: '' }
    setUpgradeAllProgress(initial)
    setIsUpgradeAllDialogOpen(true)
    setUpgradeAllRunning(true)
    // Promise.all + 单独 catch,失败一台不影响其他台继续
    const results = await Promise.all(
      targets.map(async (s) => {
        try {
          return await streamUpgradeOneAgent(s.id)
        } catch {
          return false
        }
      }),
    )
    const failed = results.filter((ok) => !ok).length
    setUpgradeAllRunning(false)
    if (failed === 0) toast.success(t('servers.upgradeAllDone', { count: targets.length }))
    else toast.error(t('servers.upgradeAllPartial', { failed, total: targets.length }))
  }
  const handleAgentUninstall = (serverId: number) => streamRemoteOp(`/api/admin/remote/agent/uninstall-stream?server_id=${serverId}`, t('servers.uninstallAgentAction'))

  const resetAddWebsiteDialog = () => { setAddWebsiteDomain(''); setAddWebsiteSiteType('static'); setAddWebsiteSiteValue(''); setAddWebsiteValidating(false); setAddWebsiteValidResult(null); setAddWebsiteSubmitting(false) }
  const validateWebsite = async () => {
    if (!addWebsiteServerId || !addWebsiteSiteValue.trim()) return
    setAddWebsiteValidating(true); setAddWebsiteValidResult(null)
    try {
      const res = await api.post('/api/admin/remote/website/validate', { server_id: addWebsiteServerId, site_type: addWebsiteSiteType, site_value: addWebsiteSiteValue.trim() })
      setAddWebsiteValidResult({ ok: res.data.success, msg: res.data.message })
    } catch { setAddWebsiteValidResult({ ok: false, msg: t('servers.validateFailed') }) }
    finally { setAddWebsiteValidating(false) }
  }
  const submitAddWebsite = async () => {
    if (!addWebsiteServerId || !addWebsiteDomain.trim() || !addWebsiteSiteValue.trim()) { toast.error(t('servers.fillComplete')); return }
    setAddWebsiteSubmitting(true)
    try {
      const res = await api.post('/api/admin/remote/website/add', { server_id: addWebsiteServerId, domain: addWebsiteDomain.trim(), site_type: addWebsiteSiteType, site_value: addWebsiteSiteValue.trim() })
      if (res.data.success) { toast.success(t('servers.websiteAdded')); setIsAddWebsiteDialogOpen(false); resetAddWebsiteDialog() }
      else { toast.error(res.data.message || t('servers.websiteAddFailed')) }
    } catch (error) { handleServerError(error) }
    finally { setAddWebsiteSubmitting(false) }
  }

  const checkSameIP = async (address: string) => {
    if (!address.trim()) return
    try {
      const res = await api.get(`/api/admin/check-same-ip?address=${encodeURIComponent(address.trim())}`)
      if (res.data.same_ip && res.data.https_enabled) {
        setCreateDomain(res.data.master_domain)
        setDomainAutoFilled(true)
        setCreateSiteType('proxy')
        setCreateSiteValue('http://127.0.0.1:12889')
      }
    } catch {}
  }

  const handleSmartInstall = async (serverId: number, withNginx: boolean) => {
    const status = remoteServicesStatusMap[serverId]
    const xrayInstalled = status?.xray?.installed
    const nginxInstalled = status?.nginx?.installed
    if (withNginx) {
      if (!xrayInstalled && !nginxInstalled) { await handleRemoteInstallXray(serverId); await handleRemoteInstallNginx(serverId) }
      else if (xrayInstalled && !nginxInstalled) { await handleRemoteInstallNginx(serverId) }
      else if (!xrayInstalled && nginxInstalled) { await handleRemoteInstallXray(serverId) }
      else { toast.info(t('servers.bothInstalled')) }
    } else {
      if (!xrayInstalled) { await handleRemoteInstallXray(serverId) } else { toast.info(t('servers.xrayInstalled')) }
    }
  }

  const handleSmartUninstall = async (serverId: number) => {
    const status = remoteServicesStatusMap[serverId]
    if (status?.nginx?.installed) await handleRemoteRemoveNginx(serverId)
    if (status?.xray?.installed) await handleRemoteRemoveXray(serverId)
  }

  const loadXrayRawConfig = async (serverId: number) => {
    setXrayRawConfigLoading(true)
    try {
      const response = await api.get(`/api/admin/remote/xray/config?server_id=${serverId}`)
      if (response.data.success) { try { setXrayRawConfig(JSON.stringify(JSON.parse(response.data.config), null, 2)) } catch { setXrayRawConfig(response.data.config || '') } }
      else { toast.error(response.data.message || t('servers.configLoadFailed')) }
    } catch (error) { handleServerError(error) } finally { setXrayRawConfigLoading(false) }
  }

  const handleOpenXrayRawConfig = (server: { id: number; name: string }) => {
    setXrayRawConfigServerId(server.id); setXrayRawConfigServerName(server.name); setIsXrayRawConfigDialogOpen(true); loadXrayRawConfig(server.id)
  }

  const loadRemoteXraySystemConfig = async (serverId: number) => {
    setRemoteXraySystemConfigLoading(true)
    try { const response = await api.get(`/api/admin/remote/xray/system-config?server_id=${serverId}`); if (response.data.success && response.data.config) setRemoteXraySystemConfig(response.data.config) }
    catch (error) { handleServerError(error) } finally { setRemoteXraySystemConfigLoading(false) }
  }

  const handleOpenRemoteXrayConfig = (server: RemoteServer) => {
    setConfigServer({ type: 'remote', server }); setXrayRawConfigServerId(server.id); setXrayRawConfigServerName(server.name)
    setIsXrayRawConfigDialogOpen(true); loadXrayRawConfig(server.id); loadRemoteServicesStatus(server.id); loadRemoteXraySystemConfig(server.id)
  }

  const handleSaveXrayConfig = () => {
    if (!configServer) return
    updateRemoteXraySystemConfigMutation.mutate({ server_id: configServer.server.id, ...remoteXraySystemConfig })
  }

  const loadRemoteServicesStatus = async (serverId: number) => {
    setRemoteServicesLoading(true)
    try { const response = await api.get(`/api/admin/remote/services/status?server_id=${serverId}`); if (response.data.success) setRemoteServicesStatus({ xray: response.data.xray, nginx: response.data.nginx }) }
    catch (error) { handleServerError(error) } finally { setRemoteServicesLoading(false) }
  }

  const handleEditRemoteServer = (server: RemoteServer) => {
    setEditingRemoteServer(server)
    setRemoteFormData({ name: server.name, pull_address: server.pull_address || server.ip_address || '', domain: server.domain || '', traffic_limit_gb: server.traffic_limit ? (server.traffic_limit / 1024 / 1024 / 1024).toFixed(2) : '', traffic_used_gb: server.traffic_used ? (server.traffic_used / 1024 / 1024 / 1024).toFixed(2) : '', traffic_reset_day: server.traffic_reset_day?.toString() || '', steal_mode: server.steal_mode || 'default', xray_mode: server.xray_mode || 'external', listen_port: server.listen_port ? String(server.listen_port) : '', traffic_stats_mode: ((server as any).traffic_stats_mode === 'upload' || (server as any).traffic_stats_mode === 'download') ? (server as any).traffic_stats_mode : 'both' } as any)
    setIsEditRemoteServerDialogOpen(true)
  }

  const handleSubmitRemoteServerEdit = () => {
    if (!editingRemoteServer) return
    const oldMode = editingRemoteServer.steal_mode || 'default'
    const newMode = remoteFormData.steal_mode
    if (oldMode !== newMode && editingRemoteServer.status === 'connected') {
      switchStealModeMutation.mutate({ serverId: editingRemoteServer.id, stealMode: newMode })
    }
    const trafficLimitGb = parseFloat(remoteFormData.traffic_limit_gb) || 0
    const trafficUsedGb = parseFloat(remoteFormData.traffic_used_gb)
    const trafficUsedBytes = !isNaN(trafficUsedGb) ? Math.round(trafficUsedGb * 1024 * 1024 * 1024) : undefined
    const lpRaw = (remoteFormData as any).listen_port
    const newListenPort = lpRaw ? parseInt(lpRaw) : 0
    const oldListenPort = editingRemoteServer.listen_port || 0
    if (newListenPort !== oldListenPort) {
      const confirmMsg = newListenPort === 0
        ? t('servers.listenPortRestoreConfirm', { defaultValue: '将清空 Agent 端口设置(恢复默认 23889),Agent 会重启并短暂掉线,确定继续吗?' })
        : t('servers.listenPortChangeConfirm', { port: newListenPort, defaultValue: '将把 Agent 监听端口改为 {{port}},Agent 会重启并短暂掉线,确定继续吗?' })
      if (!confirm(confirmMsg)) return
    }
    updateRemoteServerMutation.mutate({ id: editingRemoteServer.id, name: remoteFormData.name, pull_address: remoteFormData.pull_address || undefined, domain: remoteFormData.domain, traffic_limit: trafficLimitGb > 0 ? Math.floor(trafficLimitGb * 1024 * 1024 * 1024) : 0, traffic_used: trafficUsedBytes, traffic_reset_day: parseInt(remoteFormData.traffic_reset_day) || 0, xray_mode: remoteFormData.xray_mode, listen_port: newListenPort, traffic_stats_mode: remoteFormData.traffic_stats_mode } as any)
  }

  const loadRemoteServerStatusToCache = async (serverId: number, forceReload = false) => {
    if (!forceReload && (remoteServicesStatusMap[serverId]?.loaded || remoteServicesStatusMap[serverId]?.loading)) return
    // 首次加载才显示 loading 文案;强刷(15s 定时 / 操作后)走静默,避免 UI 每隔 15s 闪一下"加载中"
    const isInitial = !remoteServicesStatusMap[serverId]?.loaded
    if (isInitial) {
      setRemoteServicesStatusMap(prev => ({ ...prev, [serverId]: { ...prev[serverId], loading: true, loaded: false } }))
    }
    try {
      const response = await api.get(`/api/admin/remote/services/status?server_id=${serverId}`)
      if (response.data.success) setRemoteServicesStatusMap(prev => ({ ...prev, [serverId]: { xray: response.data.xray, nginx: response.data.nginx, loading: false, loaded: true } }))
    } catch {
      if (isInitial) setRemoteServicesStatusMap(prev => ({ ...prev, [serverId]: { loading: false, loaded: true } }))
    }
  }

  useEffect(() => {
    const servers: RemoteServer[] = remoteServersData?.servers || []
    servers.filter((s: RemoteServer) => s.status === 'connected').forEach((server: RemoteServer) => { loadRemoteServerStatusToCache(server.id) })
  }, [remoteServersData])

  // 每 15s 后台静默刷新所有 connected 服务器的 xray/nginx 状态。
  // 仅对当前在 connected 的服务器拉,避免对离线机器无谓重试。
  // forceReload=true 绕过 loaded 缓存,保证拿到最新值。
  useEffect(() => {
    const timer = setInterval(() => {
      const servers: RemoteServer[] = remoteServersData?.servers || []
      servers
        .filter((s: RemoteServer) => s.status === 'connected')
        .forEach((server: RemoteServer) => { loadRemoteServerStatusToCache(server.id, true) })
    }, 15_000)
    return () => clearInterval(timer)
  }, [remoteServersData])

  const remoteServers: RemoteServer[] = remoteServersData?.servers || []

  // 快速筛选:'all' 全部 / 'online' 仅 connected / 'offline' 非 connected(含 pending/disconnected)。
  // pending 归到"离线"侧 — 用户视角"还没连上 = 离线"。
  const [statusFilter, setStatusFilter] = useState<'all' | 'online' | 'offline'>('all')
  const { onlineCount, offlineCount } = useMemo(() => {
    let on = 0, off = 0
    for (const s of remoteServers) {
      if (s.status === 'connected') on++
      else off++
    }
    return { onlineCount: on, offlineCount: off }
  }, [remoteServers])
  const filteredServers = useMemo(() => {
    if (statusFilter === 'online') return remoteServers.filter((s) => s.status === 'connected')
    if (statusFilter === 'offline') return remoteServers.filter((s) => s.status !== 'connected')
    return remoteServers
  }, [remoteServers, statusFilter])

  const handleGenerateToken = () => {
    if (!remoteServerName.trim()) { toast.error(t('servers.enterServerName')); return }
    if (createUse443 && !createDomain.trim()) { toast.error(t('servers.use443NeedsDomain')); return }
    const trafficLimitBytes = formData.traffic_limit_gb ? Math.round(parseFloat(formData.traffic_limit_gb) * 1024 * 1024 * 1024) : 0
    const trafficUsedOffsetBytes = formData.traffic_used_gb ? Math.round(parseFloat(formData.traffic_used_gb) * 1024 * 1024 * 1024) : 0
    const trafficResetDay = formData.traffic_reset_day ? parseInt(formData.traffic_reset_day) : 0
    setIsGeneratingToken(true)
    createRemoteServerMutation.mutate({ name: remoteServerName, traffic_limit: trafficLimitBytes, traffic_used_offset: trafficUsedOffsetBytes, traffic_reset_day: trafficResetDay, connection_mode: 'auto', pull_address: pullAddress || undefined, pull_port: pullPort ? parseInt(pullPort) : undefined, listen_port: pullPort ? parseInt(pullPort) : undefined /* "Agent 端口"既是 pull 模式的 pull_port,也是 websocket 模式下主控连接 agent 的端口,语义一致,两个字段同时填 */, pull_token: pullToken || undefined, steal_self: createStealSelf, front_service: createFrontService, domain: createDomain.trim() || undefined, use_443: createUse443 || undefined, steal_mode: createStealSelf ? createStealMode : undefined, site_type: createStealSelf ? createSiteType : undefined, site_value: createStealSelf ? createSiteValue : undefined, xray_mode: createXrayMode, traffic_stats_mode: createTrafficStatsMode } as any)
  }

  const clipboardCopy = useCopyToClipboard()
  const copyToClipboard = (text: string, label: string) => clipboardCopy(text, { success: t('servers.copied', { label }), failure: t('servers.copyFailed') })

  const resetAddDialog = () => {
    setRemoteServerName(''); setGeneratedToken(''); setInstallCommand(''); setIsGeneratingToken(false); setCreatedServerId(null)
    setPullAddress(''); setPullPort('23889'); setPullToken(''); setCreateStealSelf(false); setCreateFrontService('xray'); setCreateStealMode('tunnel'); setCreateUse443(false); setCreateDomain(''); setDomainAutoFilled(false); setCreateSiteType('static'); setCreateSiteValue(''); setCreateXrayMode('external'); setCreateTrafficStatsMode('both')
    setFormData({ ...formData, traffic_limit_gb: '', traffic_used_gb: '', traffic_reset_day: '1' })
  }

  // dialog 打开 + 已生成 token 后,轮询 remoteServers(每 3s,跟现有 query 共享)。
  // 新 server 一旦 status=connected,自动关 dialog + toast 提示 — 用户安装脚本跑完
  // 不用手动点"完成"。
  useEffect(() => {
    if (!isAddDialogOpen || createdServerId === null) return
    const servers = (remoteServersData?.servers ?? []) as RemoteServer[]
    const target = servers.find((s) => s.id === createdServerId)
    if (target && target.status === 'connected') {
      toast.success(`服务器「${target.name}」已连接`)
      setIsAddDialogOpen(false)
      resetAddDialog()
    }
  }, [isAddDialogOpen, createdServerId, remoteServersData])

  const handleDeleteRemoteServer = (id: number) => { setDeletingRemoteServerId(id); setIsDeleteRemoteServerDialogOpen(true) }
  const confirmDeleteRemoteServer = () => { if (deletingRemoteServerId !== null) deleteRemoteServerMutation.mutate(deletingRemoteServerId); setIsDeleteRemoteServerDialogOpen(false); setDeletingRemoteServerId(null) }

  // --- END HELPERS ---

  const RemoteServerStatusBadge = ({ status }: { status: string }) => {
    const statusConfig = { pending: { label: t('servers.pending'), variant: 'secondary' as const }, connected: { label: t('servers.online'), variant: 'default' as const }, offline: { label: t('servers.offline'), variant: 'destructive' as const } }
    const config = statusConfig[status as keyof typeof statusConfig] || statusConfig.pending
    return <Badge variant={config.variant}>{config.label}</Badge>
  }

  const RemoteServiceStatusIndicator = ({ status, name, serverId, isEmbedded, isFederated }: { status?: { installed: boolean; running: boolean; version?: string }, name: string, serverId: number, isEmbedded?: boolean, isFederated?: boolean }) => {
    const [open, setOpen] = useState(false)
    const timeoutRef = useRef<ReturnType<typeof setTimeout>>()
    const serviceName = name.toLowerCase() as 'xray' | 'nginx'
    // 重启进行中:用 mutation.variables 精准识别本次操作的目标(同页面有多个 indicator,
    // 全局 isPending 没法分辨是哪一台/哪个服务的重启)。
    const isRestarting = remoteServiceControlMutation.isPending
      && remoteServiceControlMutation.variables?.serverId === serverId
      && remoteServiceControlMutation.variables?.service === serviceName
      && remoteServiceControlMutation.variables?.action === 'restart'
    // 分享服务器(联邦):服务由拥有方控制,这里仅展示状态、不提供启停控制
    if (isFederated) {
      const running = !!status?.running
      return (<div className={cn("flex items-center gap-1.5 text-xs px-2 py-1 rounded", running ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400")}><div className={cn("w-2 h-2 rounded-full", running ? "bg-green-500" : "bg-gray-400")} />{name}</div>)
    }
    const handleOpen = () => { clearTimeout(timeoutRef.current); if (status?.installed || isEmbedded) setOpen(true) }
    const handleClose = () => { timeoutRef.current = setTimeout(() => setOpen(false), 150) }
    const handleControl = (action: 'start' | 'stop' | 'restart') => {
      setOpen(false)
      remoteServiceControlMutation.mutate({ serverId, service: serviceName, action }, { onSuccess: () => loadRemoteServerStatusToCache(serverId, true) })
    }
    if (!status?.installed && !isEmbedded) {
      return (<div className="flex items-center gap-1.5 text-xs px-2 py-1 rounded bg-red-50 text-red-500 dark:bg-red-900/20 dark:text-red-400"><X className="w-3 h-3" />{name}</div>)
    }
    if (isEmbedded && !status?.installed) {
      return (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <div className="flex items-center gap-1.5 text-xs px-2 py-1 rounded cursor-pointer transition-colors bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700" onMouseEnter={handleOpen} onMouseLeave={handleClose}>
              <div className="w-2 h-2 rounded-full bg-gray-400" />{name}
            </div>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-2" side="top" sideOffset={6} onMouseEnter={handleOpen} onMouseLeave={handleClose} onOpenAutoFocus={(e) => e.preventDefault()}>
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs text-green-600 hover:text-green-700" onClick={() => handleControl('start')} disabled={remoteServiceControlMutation.isPending}><Play className="w-3 h-3 mr-1" />{t('servers.tryStartXray')}</Button>
          </PopoverContent>
        </Popover>
      )
    }
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <div className={cn("flex items-center gap-1.5 text-xs px-2 py-1 rounded cursor-pointer transition-colors", status.running ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/50" : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700")} onMouseEnter={handleOpen} onMouseLeave={handleClose}>
            {isRestarting
              ? <Loader2 className={cn("w-3 h-3 animate-spin", status.running ? "text-green-700 dark:text-green-400" : "text-gray-500 dark:text-gray-400")} />
              : <div className={cn("w-2 h-2 rounded-full", status.running ? "bg-green-500" : "bg-gray-400")} />
            }{name}
          </div>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-2" side="top" sideOffset={6} onMouseEnter={handleOpen} onMouseLeave={handleClose} onOpenAutoFocus={(e) => e.preventDefault()}>
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => handleControl('restart')} disabled={remoteServiceControlMutation.isPending}><RotateCcw className="w-3 h-3 mr-1" />{t('servers.restartBtn')}</Button>
            {status.running ? (
              <Button variant="outline" size="sm" className="h-7 px-2 text-xs text-red-600 hover:text-red-700" onClick={() => handleControl('stop')} disabled={remoteServiceControlMutation.isPending}><Square className="w-3 h-3 mr-1" />{t('servers.stopBtn')}</Button>
            ) : (
              <Button variant="outline" size="sm" className="h-7 px-2 text-xs text-green-600 hover:text-green-700" onClick={() => handleControl('start')} disabled={remoteServiceControlMutation.isPending}><Play className="w-3 h-3 mr-1" />{t('servers.startBtn')}</Button>
            )}
          </div>
        </PopoverContent>
      </Popover>
    )
  }

  // AgentVersionIndicator
  // 旁路于 RemoteServiceStatusIndicator 展示 agent 版本号 + 升级提示。
  //   - 已知版本:显示 "agent v0.1.2";有新版时附右上角红点
  //   - 未知版本(老 agent 不返回):显示 "agent ?",一直带红点(强烈建议升级)
  //   - 仅 connected 状态的非联邦服务器需要,联邦的 agent 由对端管理
  // 点击 → 走现有 handleAgentUpgrade(SSE 升级流)
  const AgentVersionIndicator = ({ serverId, isFederated }: { serverId: number; isFederated?: boolean }) => {
    const { data } = useQuery({
      queryKey: ['agent-version-info', serverId],
      queryFn: async () => {
        const resp = await api.get(`/api/admin/remote/agent/version-info?server_id=${serverId}`)
        return resp.data as { current?: string; latest?: string; upgrade_available?: boolean; current_error?: string; latest_error?: string }
      },
      enabled: !isFederated,
      staleTime: 5 * 60 * 1000,
      refetchInterval: 10 * 60 * 1000,
      retry: false,
    })
    if (isFederated) return null
    const current = data?.current?.trim() || ''
    const upgradeAvailable = !!data?.upgrade_available
    const label = current ? `v${current}` : '?'
    const tooltipLines: string[] = []
    tooltipLines.push(`当前: ${current ? 'v' + current : '未知 (老版本 Agent 未上报)'}`)
    if (data?.latest) tooltipLines.push(`GitHub 最新: v${data.latest}`)
    tooltipLines.push(upgradeAvailable ? '点击升级' : '点击重新下载 latest 并重装')
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type='button'
            onClick={() => handleAgentUpgrade(serverId)}
            className={cn(
              'relative flex items-center gap-1.5 text-xs px-2 py-1 rounded transition-colors cursor-pointer',
              upgradeAvailable
                ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 hover:bg-amber-200 dark:hover:bg-amber-900/50'
                : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700',
            )}
          >
            <ArrowUpCircle className='w-3 h-3' />
            {label}
            {upgradeAvailable && (
              <span className='absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500 ring-1 ring-background' />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent>
          <div className='space-y-0.5 text-xs'>
            {tooltipLines.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        </TooltipContent>
      </Tooltip>
    )
  }

  const InstallPopover = ({ serverId, compact, isEmbedded }: { serverId: number; compact?: boolean; isEmbedded?: boolean }) => {
    const [open, setOpen] = useState(false)
    const [withNginx, setWithNginx] = useState('yes')
    const status = remoteServicesStatusMap[serverId]
    const xrayInstalled = status?.xray?.installed
    const xrayRunning = status?.xray?.running
    const nginxInstalled = status?.nginx?.installed
    const bothInstalled = xrayInstalled && nginxInstalled
    // 列表(compact)模式下:状态未拉到 / 正在加载 时不渲染按钮 —— 否则等数据回来后按钮消失会触发动作列横向抖动
    if (compact && (!status || status.loading)) return null
    if (isEmbedded && (xrayInstalled && xrayRunning)) return null
    if (isEmbedded) {
      const handleStartXray = () => {
        remoteServiceControlMutation.mutate({ serverId, service: 'xray', action: 'start' }, { onSuccess: () => loadRemoteServerStatusToCache(serverId, true) })
      }
      return compact ? (
        <Button variant="outline" size="sm" className="h-7 px-2 text-green-600 hover:text-green-700" onClick={handleStartXray} disabled={remoteServiceControlMutation.isPending}><Play className="h-3.5 w-3.5" /></Button>
      ) : (
        <Button variant="outline" size="sm" className="flex-1 min-w-0 text-green-600 hover:text-green-700" onClick={handleStartXray} disabled={remoteServiceControlMutation.isPending}><Play className="mr-1 h-3.5 w-3.5 shrink-0" /><span className="truncate">{t('servers.tryStartXray')}</span></Button>
      )
    }
    const getInstallDesc = () => {
      if (withNginx === 'yes') {
        if (!xrayInstalled && !nginxInstalled) return t('servers.willInstallBoth')
        if (xrayInstalled && !nginxInstalled) return t('servers.willInstallNginx')
        if (!xrayInstalled && nginxInstalled) return t('servers.willInstallXray')
        return t('servers.bothInstalled')
      }
      return !xrayInstalled ? t('servers.willInstallXray') : t('servers.xrayInstalled')
    }
    const canInstall = withNginx === 'yes' ? !bothInstalled : !xrayInstalled
    const canUninstall = xrayInstalled || nginxInstalled
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          {compact ? (
            <Button variant="outline" size="sm" className="h-7 px-2"><Download className="h-3.5 w-3.5" /><ChevronDown className="h-3 w-3 ml-1" /></Button>
          ) : (
            <Button variant="outline" size="sm" className="flex-1 min-w-0"><Download className="mr-1 h-3.5 w-3.5 shrink-0" /><span className="truncate">{t('servers.install')}</span><ChevronDown className="ml-1 h-3.5 w-3.5 shrink-0" /></Button>
          )}
        </PopoverTrigger>
        <PopoverContent className="w-56 p-3" align="start">
          <div className="space-y-3">
            <div className="text-sm font-medium">{t('servers.installService')}</div>
            <RadioGroup value={withNginx} onValueChange={setWithNginx}>
              <div className="flex items-center gap-2"><RadioGroupItem value="yes" id={`nginx-yes-${serverId}`} /><Label htmlFor={`nginx-yes-${serverId}`} className="text-sm cursor-pointer">{t('servers.iWantStealSelf')}</Label></div>
              <div className="flex items-center gap-2"><RadioGroupItem value="no" id={`nginx-no-${serverId}`} /><Label htmlFor={`nginx-no-${serverId}`} className="text-sm cursor-pointer">{t('servers.xrayOnly')}</Label></div>
            </RadioGroup>
            <div className="text-xs text-muted-foreground">{getInstallDesc()}</div>
            <div className="flex gap-2">
              <Button size="sm" className="flex-1 h-7 text-xs" disabled={terminalRunning || !canInstall} onClick={() => { setOpen(false); handleSmartInstall(serverId, withNginx === 'yes') }}><Download className="h-3 w-3 mr-1" />{t('servers.install')}</Button>
              {canUninstall && (<Button variant="outline" size="sm" className="h-7 text-xs text-red-600 hover:text-red-700" disabled={terminalRunning} onClick={() => { setOpen(false); handleSmartUninstall(serverId) }}><Trash2 className="h-3 w-3 mr-1" />{t('servers.uninstall')}</Button>)}
            </div>
          </div>
        </PopoverContent>
      </Popover>
    )
  }

  // --- END SUB-COMPONENTS ---

  return (
    <div className="container mx-auto py-8 px-4 pt-24">
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-3xl font-bold">{t('servers.title')}</h1>
          {hasOldAgent && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type='button'
                  onClick={() => setAgentBugDialogOpen(true)}
                  className='inline-flex items-center justify-center h-8 w-8 rounded-md bg-red-100 text-red-600 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50 transition-colors animate-pulse'
                  aria-label='Agent BUG 升级提示'
                >
                  <Bug className='h-4 w-4' />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <div className='text-xs max-w-xs'>检测到部分服务器 Agent 版本 &lt; 0.2.0,存在恶性 BUG 无法通过主控升级。点击查看升级指引。</div>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        <p className="text-gray-600">{t('servers.desc')}</p>
      </div>

      <Dialog open={agentBugDialogOpen} onOpenChange={setAgentBugDialogOpen}>
        <DialogContent className='max-w-xl'>
          <DialogHeader>
            <DialogTitle className='flex items-center gap-2 text-red-600'>
              <Bug className='h-5 w-5' /> Agent 紧急升级
            </DialogTitle>
            <DialogDescription>
              非常抱歉,当前 Agent 有恶性 BUG 无法升级版本,请尝试在服务器上执行以下命令升级到 0.2.0 版本,后续可使用主控一键更新。
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-2'>
            <div className='flex items-start gap-2 rounded-md border bg-muted/40 p-3'>
              <code className='flex-1 text-xs font-mono break-all whitespace-pre-wrap select-all'>{AGENT_UPGRADE_CMD}</code>
              <Button
                size='sm'
                variant='outline'
                className='shrink-0'
                onClick={() => copyToClipboard(AGENT_UPGRADE_CMD, '升级命令')}
              >
                <Copy className='h-3.5 w-3.5 mr-1' /> 复制
              </Button>
            </div>
            <p className='text-xs text-muted-foreground'>
              SSH 登录受影响服务器后粘贴执行即可。升级完成后刷新本页面,BUG 提示会自动消失。
            </p>
          </div>
        </DialogContent>
      </Dialog>
      <div className="flex flex-wrap gap-4 mb-6">
        <ViewToggle view={viewMode} onViewChange={(v) => { setViewMode(v); localStorage.setItem('servers-view-mode', v) }} />
        <Dialog open={isAddDialogOpen} onOpenChange={(open) => { setIsAddDialogOpen(open); if (!open) resetAddDialog() }}>
          <DialogTrigger asChild><Button disabled={serversAtLimit} title={serversAtLimit ? t('license.serverLimitReached', { current: licenseUsage?.usage?.servers?.current, max: licenseUsage?.usage?.servers?.max, ns: 'common' }) : undefined}><Plus className="mr-2 h-4 w-4" />{t('servers.addServer')}</Button></DialogTrigger>
          <DialogContent className="w-[95vw] md:w-[75vw] lg:w-[60vw] max-w-4xl max-h-[85vh] overflow-y-auto overflow-x-hidden">
            <DialogHeader>
              <DialogTitle>{t('servers.addRemoteServer')}</DialogTitle>
              <DialogDescription>{t('servers.addRemoteServerDesc')}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="remote-name">{t('servers.serverName')}</Label>
                <div className="flex gap-2">
                  <Input id="remote-name" value={remoteServerName} onChange={(e) => setRemoteServerName(e.target.value)} placeholder={t('servers.serverNamePlaceholder')} disabled={!!generatedToken} />
                  <Button onClick={handleGenerateToken} disabled={!remoteServerName.trim() || isGeneratingToken || !!generatedToken}>{isGeneratingToken ? t('servers.generating') : t('servers.generateToken')}</Button>
                </div>
              </div>
              {/* 安装命令置顶 — 用户填表填到一半看不到底部命令,容易关掉 dialog 后重打开从详情页拿
                  不带参数的命令而踩坑(只带 token → 装 external xray + 不装 nginx) */}
              {generatedToken && (
                <div className="grid gap-2 p-4 border-2 border-primary/40 bg-primary/5 rounded-lg">
                  <Label htmlFor="install-command-top" className="text-sm font-semibold">{t('servers.installCommand')}</Label>
                  <div className="flex gap-2 min-w-0">
                    <Textarea id="install-command-top" value={installCommand} readOnly className="font-mono text-xs h-[80px] resize-none min-w-0" />
                    <Button variant="outline" size="icon" className="shrink-0" onClick={() => copyToClipboard(installCommand, t('servers.installCommand'))}><Copy className="h-4 w-4" /></Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t('servers.tokenDesc')}</p>
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 bg-muted/50 rounded-lg">
                <div className="grid gap-2"><Label htmlFor="pull-address">{t('servers.serverAddress')}</Label><Input id="pull-address" value={pullAddress} onChange={(e) => setPullAddress(e.target.value)} onBlur={(e) => { if (createStealSelf) checkSameIP(e.target.value) }} placeholder={t('servers.serverAddressPlaceholder')} disabled={!!generatedToken} /></div>
                <div className="grid gap-2"><Label htmlFor="pull-port">{t('servers.agentPort')}</Label><Input id="pull-port" type="number" value={pullPort} onChange={(e) => setPullPort(e.target.value)} placeholder="23889" disabled={!!generatedToken} /></div>
                <div className="grid gap-2"><Label htmlFor="pull-token">{t('servers.agentAuthToken')}</Label><Input id="pull-token" value={pullToken} onChange={(e) => setPullToken(e.target.value)} placeholder={t('servers.autoGenerated')} disabled={!!generatedToken} readOnly={!!generatedToken} /></div>
                <div className="grid gap-2"><Label htmlFor="add-traffic-limit">{t('servers.trafficLimit')}</Label><Input id="add-traffic-limit" type="number" step="0.01" placeholder={t('servers.trafficLimitPlaceholder')} value={formData.traffic_limit_gb} onChange={(e) => setFormData({ ...formData, traffic_limit_gb: e.target.value })} disabled={!!generatedToken} /></div>
                <div className="grid gap-2"><Label htmlFor="add-traffic-used">{t('servers.usedTraffic')}</Label><Input id="add-traffic-used" type="number" step="0.01" placeholder={t('servers.usedTrafficPlaceholder')} value={formData.traffic_used_gb} onChange={(e) => setFormData({ ...formData, traffic_used_gb: e.target.value })} disabled={!!generatedToken} /></div>
                <div className="grid gap-2"><Label htmlFor="add-reset-day">{t('servers.resetDay')}</Label><Input id="add-reset-day" type="number" min="1" max="31" placeholder={t('servers.resetDayPlaceholder')} value={formData.traffic_reset_day} onChange={(e) => setFormData({ ...formData, traffic_reset_day: e.target.value })} disabled={!!generatedToken} /></div>
              </div>
              <div className="grid gap-2 p-4 border rounded-lg">
                <Label>{t('servers.xrayMode')}</Label>
                <RadioGroup value={createXrayMode} onValueChange={(value) => setCreateXrayMode(value as 'external' | 'embedded')} className="flex gap-4">
                  <div className="flex items-center gap-2"><RadioGroupItem value="external" id="create-xray-mode-external" disabled={!!generatedToken} /><Label htmlFor="create-xray-mode-external" className="text-sm cursor-pointer">{t('servers.xrayModeExternal')}</Label></div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="embedded" id="create-xray-mode-embedded" disabled={!!generatedToken} />
                    <Label htmlFor="create-xray-mode-embedded" className="text-sm cursor-pointer">{t('servers.xrayModeEmbedded')}</Label>
                    <TooltipProvider><Tooltip><TooltipTrigger asChild>
                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold cursor-default select-none shadow-sm border bg-gradient-to-r from-amber-400 to-yellow-300 text-amber-900 border-amber-300/60 shadow-amber-200/50">
                        <svg className="h-2.5 w-2.5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" /></svg>
                        Pro
                      </span>
                    </TooltipTrigger><TooltipContent>{t('servers.xrayModeEmbeddedProHint')}</TooltipContent></Tooltip></TooltipProvider>
                    <TooltipProvider><Tooltip><TooltipTrigger asChild>
                      <span className="inline-flex items-center justify-center rounded-full h-5 w-5 cursor-default select-none border-2 border-orange-500 text-orange-600 italic font-serif text-[10px] font-bold leading-none">W</span>
                    </TooltipTrigger><TooltipContent>{t('servers.xrayModeEmbeddedWarpHint')}</TooltipContent></Tooltip></TooltipProvider>
                  </div>
                </RadioGroup>
                <p className="text-xs text-muted-foreground">{createXrayMode === 'external' ? t('servers.xrayModeExternalDesc') : t('servers.xrayModeEmbeddedDesc')}</p>
              </div>
              <div className="grid gap-2 p-4 border rounded-lg">
                <Label>流量统计规则</Label>
                <RadioGroup value={createTrafficStatsMode} onValueChange={(v) => setCreateTrafficStatsMode(v as 'both' | 'upload' | 'download')} className="flex gap-4">
                  <div className="flex items-center gap-2"><RadioGroupItem value="both" id="create-stats-mode-both" disabled={!!generatedToken} /><Label htmlFor="create-stats-mode-both" className="text-sm cursor-pointer">上行 + 下行</Label></div>
                  <div className="flex items-center gap-2"><RadioGroupItem value="upload" id="create-stats-mode-upload" disabled={!!generatedToken} /><Label htmlFor="create-stats-mode-upload" className="text-sm cursor-pointer">仅上行</Label></div>
                  <div className="flex items-center gap-2"><RadioGroupItem value="download" id="create-stats-mode-download" disabled={!!generatedToken} /><Label htmlFor="create-stats-mode-download" className="text-sm cursor-pointer">仅下行</Label></div>
                </RadioGroup>
                <p className="text-xs text-muted-foreground">控制该服务器节点流量的统计方向。用户流量按套餐配置的单向/双向规则单独计算,不受此设置影响。</p>
              </div>
              <div className="grid gap-3 p-4 border rounded-lg">
                <div className="flex items-center justify-between"><Label htmlFor="create-steal-self" className="cursor-pointer">{t('servers.stealSelf')}</Label><Switch id="create-steal-self" checked={createStealSelf} onCheckedChange={(checked) => { setCreateStealSelf(checked); if (checked) { setCreateUse443(true); if (pullAddress.trim()) checkSameIP(pullAddress) } else { setCreateUse443(false); setCreateDomain('') } }} disabled={!!generatedToken} /></div>
                {createStealSelf && (
                  <>
                    <div className="grid gap-2">
                      <Label>{t('servers.frontSelect')}</Label>
                      <RadioGroup value={createFrontService} onValueChange={(value) => setCreateFrontService(value as 'xray' | 'nginx')} className="flex gap-4">
                        <div className="flex items-center gap-2"><RadioGroupItem value="xray" id="create-front-xray" disabled={!!generatedToken} /><Label htmlFor="create-front-xray" className="text-sm cursor-pointer">xray</Label></div>
                        <div className="flex items-center gap-2 opacity-60"><RadioGroupItem value="nginx" id="create-front-nginx" disabled /><Label htmlFor="create-front-nginx" className="text-sm cursor-not-allowed">{t('servers.frontSelectNginxUnavailable')}</Label></div>
                      </RadioGroup>
                      <p className="text-xs text-muted-foreground">{t('servers.stealSelfDesc')}</p>
                    </div>
                    <div className="grid gap-2">
                      <Label>{t('servers.deployMode')}</Label>
                      <RadioGroup value={createStealMode} onValueChange={(value) => setCreateStealMode(value as 'tunnel' | 'fallback')} className="flex gap-4">
                        <div className="flex items-center gap-2"><RadioGroupItem value="tunnel" id="steal-mode-tunnel" disabled={!!generatedToken} /><Label htmlFor="steal-mode-tunnel" className="text-sm cursor-pointer">{t('servers.tunnelMode')}</Label></div>
                        <div className="flex items-center gap-2"><RadioGroupItem value="fallback" id="steal-mode-fallback" disabled={!!generatedToken} /><Label htmlFor="steal-mode-fallback" className="text-sm cursor-pointer">{t('servers.fallbackMode')}</Label></div>
                      </RadioGroup>
                      <p className="text-xs text-muted-foreground">{createStealMode === 'tunnel' ? t('servers.tunnelModeDesc') : t('servers.fallbackModeDesc')}</p>
                    </div>
                    <div className="flex items-center justify-between"><Label htmlFor="create-use-443" className="cursor-pointer">{t('servers.use443')}</Label><Switch id="create-use-443" checked={createUse443} onCheckedChange={(checked) => { setCreateUse443(checked); if (!checked) setCreateDomain('') }} disabled={!!generatedToken || createStealSelf} /></div>
                    {createUse443 && (
                      <div className="grid gap-2">
                        <Label htmlFor="create-domain">{t('servers.domain')} <span className="text-destructive">*</span></Label>
                        <Input id="create-domain" value={createDomain} onChange={(e) => { setCreateDomain(e.target.value); setDomainAutoFilled(false) }} placeholder="e.g. us1.example.com" disabled={!!generatedToken} />
                        {domainAutoFilled ? (
                          <p className="text-xs text-blue-600">{t('servers.domainAutoFilled')}</p>
                        ) : (
                          <p className="text-xs text-muted-foreground">{t('servers.domainDesc')}</p>
                        )}
                      </div>
                    )}
                    <div className="grid gap-2">
                      <Label>{t('servers.siteType')}</Label>
                      <div className="flex gap-2">
                        <Button type="button" size="sm" variant={createSiteType === 'static' ? 'default' : 'outline'} onClick={() => setCreateSiteType('static')} disabled={!!generatedToken} className="flex-1">{t('servers.staticPage')}</Button>
                        <Button type="button" size="sm" variant={createSiteType === 'proxy' ? 'default' : 'outline'} onClick={() => setCreateSiteType('proxy')} disabled={!!generatedToken} className="flex-1">{t('servers.reverseProxy')}</Button>
                      </div>
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="create-site-value">{createSiteType === 'static' ? t('servers.staticPath') : t('servers.reverseProxyAddress')}</Label>
                      <Input id="create-site-value" value={createSiteValue} onChange={(e) => setCreateSiteValue(e.target.value)} placeholder={createSiteType === 'static' ? t('servers.staticPathPlaceholder') : t('servers.reverseProxyPlaceholder')} disabled={!!generatedToken} />
                    </div>
                  </>
                )}
              </div>
            </div>
            <DialogFooter><Button variant="outline" onClick={() => { setIsAddDialogOpen(false); resetAddDialog() }}>{generatedToken ? t('servers.complete') : tc('actions.cancel')}</Button></DialogFooter>
          </DialogContent>
        </Dialog>
        {/* 两个按钮捆绑:mobile 时 wrapper 自己是 flex-row 让它们共占一行(各 flex-1 平分宽度);
            sm+ 用 contents 让 wrapper 透明,按钮回归外层 flex-wrap 的子项,跟桌面端原行为一致 */}
        <div className="flex gap-2 w-full sm:contents">
          <AddSharedServerDialog buttonClassName="flex-1 sm:flex-initial" />
          <Button variant="outline" className="flex-1 sm:flex-initial" disabled={remoteServers.length === 0 || upgradeAllRunning} onClick={handleUpgradeAllAgents} title={t('servers.upgradeAllAgentsTip')}>
            {upgradeAllRunning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ArrowUpCircle className="mr-2 h-4 w-4" />}
            {t('servers.upgradeAllAgents')}
          </Button>
        </div>
        {/* 快速筛选 — ml-auto 推到行尾右对齐;点击当前激活的按钮再切回 'all' */}
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant={statusFilter === 'online' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setStatusFilter(statusFilter === 'online' ? 'all' : 'online')}
          >
            <span className="w-2 h-2 rounded-full bg-green-500 mr-1.5" />
            {t('servers.online')}
            <Badge variant="secondary" className="ml-1.5 px-1.5 py-0 h-5 text-xs">{onlineCount}</Badge>
          </Button>
          <Button
            variant={statusFilter === 'offline' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setStatusFilter(statusFilter === 'offline' ? 'all' : 'offline')}
          >
            <span className="w-2 h-2 rounded-full bg-red-500 mr-1.5" />
            {t('servers.offline')}
            <Badge variant="secondary" className="ml-1.5 px-1.5 py-0 h-5 text-xs">{offlineCount}</Badge>
          </Button>
        </div>
      </div>

      {/* --- VIEWS --- */}
      {isLoading ? (
        <div className="text-center py-8"><RefreshCw className="h-8 w-8 animate-spin mx-auto mb-2" /><p className="text-gray-600">{tc('actions.loading')}</p></div>
      ) : remoteServers.length === 0 ? (
        <EmptyStateCard title={t('servers.noServers')} description={t('servers.noServersDesc')} />
      ) : viewMode === 'card' ? (
        <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleServerDragEnd}>
          <SortableContext items={filteredServers.map((s: RemoteServer) => s.id)} strategy={verticalListSortingStrategy}>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredServers.map((server: RemoteServer) => {
            const remoteStatus = remoteServicesStatusMap[server.id]
            return (
              <SortableServerCard key={`remote-${server.id}`} id={server.id}>
              {(dragHandle) => (
              <Card className={cn('min-w-0 overflow-hidden h-full flex flex-col', server.status !== 'connected' ? 'cursor-pointer hover:border-primary/50 transition-colors' : '')} onClick={() => { if (server.status !== 'connected') { setSelectedRemoteServer(server); setIsRemoteServerDetailDialogOpen(true) } }}>
                <CardHeader className="pb-3 min-w-0 flex-1">
                  <div className="flex flex-col gap-1.5 min-w-0">
                    <div className="flex items-center justify-between gap-2 min-w-0">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <button {...dragHandle} onClick={(e) => e.stopPropagation()} className="shrink-0 cursor-grab active:cursor-grabbing touch-none text-muted-foreground hover:text-foreground p-1 -ml-1" title={t('servers.dragToReorder', { defaultValue: '拖动排序' })}>
                          <GripVertical className="h-4 w-4" />
                        </button>
                        <div className={cn("w-3 h-3 rounded-full flex-shrink-0", server.status === 'connected' ? "bg-green-500" : server.status === 'pending' ? "bg-yellow-500" : "bg-red-500")} title={server.status === 'connected' ? t('servers.online') : server.status === 'pending' ? t('servers.pending') : t('servers.offline')} />
                        <CardTitle className="text-lg truncate min-w-0"><Twemoji>{server.name}</Twemoji></CardTitle>
                        {!server.is_federated && (<RecoveryStatusBanner serverId={server.id} serverName={server.name} serverStatus={server.status} />)}
                      </div>
                      <Button variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); handleDeleteRemoteServer(server.id) }} className="h-8 w-8 shrink-0 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950" title={t('servers.deleteServer')}><X className="h-4 w-4" /></Button>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-1.5 min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                        <span className="hidden sm:inline-flex"><RemoteServerStatusBadge status={server.status} /></span>
                        {server.status === 'connected' && (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                {server.encrypted
                                  ? <Lock className="h-3.5 w-3.5 text-green-500 flex-shrink-0 cursor-help" />
                                  : <LockOpen className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0 cursor-help" />}
                              </TooltipTrigger>
                              <TooltipContent>
                                {server.encrypted ? '主控与 Agent 之间通信已加密(端到端会话加密)' : '主控与 Agent 通信未加密(老版本 Agent 不支持,建议升级)'}
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                        {Math.abs(server.time_offset_seconds ?? 0) > 10 && (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <AlertTriangle className="h-4 w-4 text-yellow-500 cursor-help flex-shrink-0" />
                              </TooltipTrigger>
                              <TooltipContent>{t('servers.timeOffsetWarning')}</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                        {server.fallback_to_pull && (<Badge variant="secondary" className="text-xs bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200 shrink-0">{t('servers.degraded')}</Badge>)}
                        {server.steal_mode && (<Badge variant="outline" className="text-xs shrink-0">{server.steal_mode === 'fallback' ? t('servers.fallbackLabel') : server.steal_mode === 'tunnel' ? t('servers.tunnelLabel') : t('servers.stealModeDefault')}</Badge>)}
                        {/* 已装 WARP 的 agent — 圆形空心 W 标识(放在 xray_mode 前面) */}
                        {server.warp_installed && (
                          <Badge variant="outline"
                            className="shrink-0 border-2 border-orange-500 text-orange-600 dark:border-orange-400 dark:text-orange-400 font-bold rounded-full h-5 w-5 p-0 flex items-center justify-center bg-orange-50 dark:bg-orange-950/30"
                            title="WARP installed">
                            <span className="text-[10px] leading-none italic" style={{ fontFamily: 'serif' }}>W</span>
                          </Badge>
                        )}
                        <Badge variant="outline" className={cn("text-xs shrink-0", server.xray_mode === 'embedded' ? "border-blue-300 text-blue-700 dark:border-blue-700 dark:text-blue-400" : "border-gray-300 text-gray-600 dark:border-gray-600 dark:text-gray-400")}>{server.xray_mode === 'embedded' ? t('servers.xrayModeEmbedded') : t('servers.xrayModeExternal')}</Badge>
                      </div>
                      <div className="flex items-center gap-1 shrink-0 justify-end">
                        {server.is_federated && (<Badge variant="outline" className="text-xs shrink-0 border-purple-300 text-purple-700 dark:border-purple-700 dark:text-purple-400">分享</Badge>)}
                        {!server.is_federated && (<Button variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); setShareServer({ id: server.id, name: server.name }) }} className="h-8 w-8 text-muted-foreground hover:text-primary hover:bg-muted" title="分享服务器（PRO）"><Share2 className="h-4 w-4" /></Button>)}
                        {server.status === 'connected' && (<Button variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); remoteScanMutation.mutate(server.id) }} disabled={remoteScanMutation.isPending} className="h-8 w-8 text-muted-foreground hover:text-primary hover:bg-muted" title={t('servers.scan')}><Search className={cn("h-4 w-4", remoteScanMutation.isPending && "animate-spin")} /></Button>)}
                        {!server.is_federated && server.status !== 'connected' && (
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  // 用户打开 Popover 即视为意图恢复 → 标记 expect_recovery,agent 一连上就自动下发 current snapshot
                                  api.post(`/api/admin/xray-snapshots/expect-recovery?server_id=${server.id}`).catch(handleServerError)
                                }}
                                className="h-8 w-8 text-muted-foreground hover:text-amber-600 hover:bg-muted"
                                title="恢复到新服务器"
                              >
                                <RotateCcw className="h-4 w-4" />
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-[420px] p-4" align="end" onClick={(e) => e.stopPropagation()}>
                              <div className="space-y-3">
                                <div className="text-sm font-semibold">恢复到新服务器</div>
                                <p className="text-xs text-muted-foreground leading-relaxed">
                                  原服务器已离线。在新 VPS 上以 root 执行下面命令安装 Agent。Agent 连上主控后,会自动下发最后一次成功的 xray 配置,无需手动恢复。
                                </p>
                                <div className="flex gap-2">
                                  <Input
                                    value={buildRemoteInstallCommand(server, masterOrigin)}
                                    readOnly
                                    className="font-mono text-xs"
                                  />
                                  <Button
                                    variant="outline"
                                    size="icon"
                                    className="shrink-0"
                                    onClick={() => copyToClipboard(buildRemoteInstallCommand(server, masterOrigin), '安装命令')}
                                  >
                                    <Copy className="h-4 w-4" />
                                  </Button>
                                </div>
                                <div className="flex items-center justify-between pt-1 border-t">
                                  <div className="flex items-center gap-2">
                                    <Switch checked disabled />
                                    <Label className="text-sm cursor-default">自动下发备份配置</Label>
                                  </div>
                                  <span className="text-xs text-muted-foreground">默认开启,不可关闭</span>
                                </div>
                              </div>
                            </PopoverContent>
                          </Popover>
                        )}
                        {!server.is_federated && (<Button variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); handleEditRemoteServer(server) }} className="h-8 w-8 text-muted-foreground hover:text-primary hover:bg-muted" title={t('servers.editServer')}><Pencil className="h-4 w-4" /></Button>)}
                      </div>
                    </div>
                  </div>
                  <CardDescription className="text-xs text-muted-foreground flex flex-wrap items-center gap-2 min-w-0">
                    <span>{server.ip_address || t('servers.waitConnection')}</span>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-5 px-1.5 text-xs gap-1" onClick={(e) => e.stopPropagation()}>
                          {server.connection_mode === 'websocket' && <Wifi className="h-3 w-3" />}
                          {server.connection_mode === 'http' && <Radio className="h-3 w-3" />}
                          {server.connection_mode === 'pull' && <RefreshCw className="h-3 w-3" />}
                          {(server.connection_mode === 'auto' || !server.connection_mode) && <Settings className="h-3 w-3" />}
                          <span className="hidden sm:inline">{server.connection_mode === 'websocket' ? t('servers.websocketMode') : server.connection_mode === 'http' ? t('servers.httpMode') : server.connection_mode === 'pull' ? t('servers.pullMode') : t('servers.autoMode')}</span>
                          <ChevronDown className="h-3 w-3" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-40">
                        {(['auto', 'websocket', 'http', 'pull'] as const).map(mode => (
                          <DropdownMenuItem key={mode} onClick={(e) => { e.stopPropagation(); updateConnectionModeMutation.mutate({ id: server.id, connection_mode: mode }) }}>
                            {mode === 'auto' && <Settings className="mr-2 h-4 w-4" />}{mode === 'websocket' && <Wifi className="mr-2 h-4 w-4" />}{mode === 'http' && <Radio className="mr-2 h-4 w-4" />}{mode === 'pull' && <RefreshCw className="mr-2 h-4 w-4" />}
                            {mode === 'auto' ? t('servers.autoMode') : mode === 'websocket' ? t('servers.websocketMode') : mode === 'http' ? t('servers.httpMode') : t('servers.pullMode')}
                            {(server.connection_mode === mode || (!server.connection_mode && mode === 'auto')) && <span className="ml-auto">✓</span>}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    {server.status === 'connected' && (
                      <span className={cn("inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium", server.ws_connected ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" : server.fallback_to_pull ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400" : "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400")}>
                        {server.ws_connected ? <><Wifi className="h-2.5 w-2.5" />WS</> : server.fallback_to_pull ? <><RefreshCw className="h-2.5 w-2.5" />{t('servers.pullMode')}</> : <><Radio className="h-2.5 w-2.5" />HTTP</>}
                      </span>
                    )}
                    {/* Xray / Nginx / Agent 版本指示器并入 IP 行末尾,省一行高度 */}
                    <RemoteServiceStatusIndicator status={remoteStatus?.xray} name="Xray" serverId={server.id} isEmbedded={server.xray_mode === 'embedded'} isFederated={server.is_federated} />
                    {remoteStatus?.nginx?.installed && (<RemoteServiceStatusIndicator status={remoteStatus?.nginx} name="Nginx" serverId={server.id} isFederated={server.is_federated} />)}
                    {server.status === 'connected' && <AgentVersionIndicator serverId={server.id} isFederated={server.is_federated} />}
                    {remoteStatus?.loading && (<span className="text-xs text-muted-foreground">{t('servers.loadingStatus')}</span>)}
                  </CardDescription>
                  {/* 紧凑信息块:实时网速单行(横排上下行) + 流量统计 + 心跳全部塞到同一面板,
                      去除原先两个独立卡片的重复 padding/边距,避免大面积空白。
                      min-w-0 + overflow-hidden 防止子内容撑出卡片(手机窄屏出现的右侧溢出问题) */}
                  <div className="mt-3 rounded-lg bg-muted/50 px-3 py-2.5 space-y-2.5 min-w-0 overflow-hidden">
                    {/* 实时网速 — 单行 inline;flex-wrap 让窄屏数值过长时自动换行,而不是把整行撑出去 */}
                    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs">
                      <div className="flex items-center gap-1.5 text-muted-foreground min-w-0">
                        <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M2 12h20M7 7l5-5 5 5M7 17l5 5 5-5" /></svg>
                        <span className="truncate">{t('servers.realtimeSpeed')}</span>
                      </div>
                      {(server.current_upload_speed !== undefined && server.current_upload_speed > 0) || (server.current_download_speed !== undefined && server.current_download_speed > 0) ? (
                        <div className="flex items-center gap-3 font-mono tabular-nums min-w-0">
                          <span className="text-green-600 dark:text-green-400 whitespace-nowrap">↑ {formatSpeed(server.current_upload_speed || 0)}</span>
                          <span className="text-blue-600 dark:text-blue-400 whitespace-nowrap">↓ {formatSpeed(server.current_download_speed || 0)}</span>
                        </div>
                      ) : (
                        <span className="font-mono text-muted-foreground">
                          {server.status === 'connected' ? t('servers.waitingData') : server.status === 'pending' ? t('servers.pendingShort') : t('servers.offline')}
                        </span>
                      )}
                    </div>

                    {/* 流量统计 */}
                    <div className="border-t border-border/40 pt-2 space-y-1.5">
                      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs">
                        <div className="flex items-center gap-1.5 text-muted-foreground min-w-0">
                          <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /><path d="M9 12l2 2 4-4" /></svg>
                          <span className="truncate">{t('servers.trafficStats')}</span>
                        </div>
                        <span className="font-mono font-medium break-all min-w-0 text-right">
                          {server.traffic_limit && server.traffic_limit > 0
                            ? `${formatTraffic(server.traffic_used || 0)} / ${formatTraffic(server.traffic_limit)}`
                            : `${formatTraffic(server.traffic_used || 0)} · ${t('servers.unlimited')}`}
                        </span>
                      </div>
                      {server.traffic_limit > 0 ? (
                        <>
                          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                            <div className={cn("h-full rounded-full transition-all", getTrafficPercent(server.traffic_used || 0, server.traffic_limit) > 90 ? "bg-red-500" : getTrafficPercent(server.traffic_used || 0, server.traffic_limit) > 70 ? "bg-yellow-500" : "bg-primary")} style={{ width: `${Math.min(getTrafficPercent(server.traffic_used || 0, server.traffic_limit), 100)}%` }} />
                          </div>
                          {!!server.traffic_reset_day && server.traffic_reset_day > 0 && (
                            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                              <span>{t('servers.resetLabel')}</span>
                              <span>{t('servers.monthlyReset', { day: server.traffic_reset_day })}</span>
                            </div>
                          )}
                        </>
                      ) : (
                        // 无限流量场景:进度条 100% 填满 + 彩虹渐变横向流动,保持卡片高度与有限额机器对齐;重置日改为"无需重置"
                        <>
                          <div className="h-1.5 rounded-full overflow-hidden">
                            <div className="h-full w-full rounded-full rainbow-flow-bar" />
                          </div>
                          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                            <span>{t('servers.resetLabel')}</span>
                            <span>{t('servers.noResetNeeded', { defaultValue: '无需重置' })}</span>
                          </div>
                        </>
                      )}
                    </div>

                    {/* 最后心跳 - 移进同一面板底部,小字 muted */}
                    {server.last_heartbeat && (
                      <div className="border-t border-border/40 pt-1.5 text-[11px] text-muted-foreground">
                        {t('servers.lastHeartbeat')}: {new Date(server.last_heartbeat).toLocaleString()}
                      </div>
                    )}
                  </div>
                </CardHeader>
                <CardFooter className="flex flex-wrap gap-2 pt-3 mt-auto">
                  {server.status === 'connected' && (
                    <>
                      {/* InstallPopover 已合并进 Agent 下拉:外置 xray 时显示"安装/卸载服务"菜单项 */}
                      {server.xray_mode !== 'embedded' && !server.is_federated && !(remoteStatus?.xray?.installed) && (
                        // 新装机:还没装过 xray 又是外置模式 → Agent 下拉不显示,这里给一个安装按钮 fallback
                        <Button variant="outline" size="sm" className="flex-1 min-w-0" onClick={(e) => { e.stopPropagation(); setInstallDialogServerId(server.id) }}><Download className="mr-1 h-3.5 w-3.5 shrink-0" /><span className="truncate">{t('servers.install')}</span></Button>
                      )}
                      {(remoteStatus?.xray?.installed || server.xray_mode === 'embedded') && (<Button variant="outline" size="sm" className="flex-1 min-w-0" onClick={(e) => { e.stopPropagation(); handleOpenRemoteXrayConfig(server) }}><Cog className="h-4 w-4 mr-1" />{t('servers.xrayConfig')}</Button>)}
                      {!server.is_federated && (remoteStatus?.xray?.installed || server.xray_mode === 'embedded') && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild><Button variant="outline" size="sm" className="flex-1 min-w-0" title={t('servers.agentManagement')}><Settings className="mr-1 h-3.5 w-3.5 shrink-0" /><span className="truncate">Agent</span></Button></DropdownMenuTrigger>
                          <DropdownMenuContent align="start">
                            {server.xray_mode !== 'embedded' && (
                              <>
                                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setInstallDialogServerId(server.id) }}><Download className="mr-2 h-4 w-4" />{t('servers.installService')}</DropdownMenuItem>
                                <DropdownMenuSeparator />
                              </>
                            )}
                            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setSyncingServerId(server.id); setSyncServerHost(server.ip_address || ''); setIsSyncNodesDialogOpen(true) }}><RefreshCw className="mr-2 h-4 w-4" />{t('servers.syncNodes')}</DropdownMenuItem>
                            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setHistoryServerId(server.id); setHistoryServerName(server.name); setHistoryPreviewId(null); setHistoryPreviewConfig(''); setHistoryDialogOpen(true) }}><History className="mr-2 h-4 w-4" />配置历史</DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation()
                                if (!confirm(`确定要把默认配置下发到 ${server.name} 吗?\n会覆盖 Agent 当前的 xray 配置并重启 xray。`)) return
                                deployStealSelfMutation.mutate(server.id)
                              }}
                              disabled={deployStealSelfMutation.isPending}
                            >
                              <Download className="mr-2 h-4 w-4" />{deployStealSelfMutation.isPending ? '下发中...' : '下发默认配置'}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setAddWebsiteServerId(server.id); setIsAddWebsiteDialogOpen(true) }}><Globe className="mr-2 h-4 w-4" />{t('servers.addWebsite')}</DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleAgentUpgrade(server.id) }}><ArrowUpCircle className="mr-2 h-4 w-4" />{t('servers.upgradeAgent')}</DropdownMenuItem>
                            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleAgentUninstall(server.id) }} className="text-red-600"><Trash2 className="mr-2 h-4 w-4" />{t('servers.uninstallAgent')}</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </>
                  )}
                </CardFooter>
              </Card>
              )}
              </SortableServerCard>
            )
          })}
        </div>
          </SortableContext>
        </DndContext>
      ) : (
        <TableCard>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8 p-0" />
                <TableHead className="min-w-[200px]">{t('servers.nameCol')}</TableHead>
                <TableHead>{t('servers.connectionMode')}</TableHead>
                <TableHead className="w-[140px] max-w-[140px]">{t('servers.ipAddress')}</TableHead>
                <TableHead className="min-w-[100px] w-[100px]">{t('servers.speedCol')}</TableHead>
                <TableHead>{t('servers.trafficCol')}</TableHead>
                <TableHead className="min-w-[230px] w-[230px]">{t('servers.serviceCol')}</TableHead>
                <TableHead className="text-right min-w-[200px] w-[200px]">{t('servers.actionsCol')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleServerDragEnd}>
                <SortableContext items={filteredServers.map((s: RemoteServer) => s.id)} strategy={verticalListSortingStrategy}>
              {filteredServers.map((server: RemoteServer) => {
                const remoteStatus = remoteServicesStatusMap[server.id]
                return (
                  <SortableServerRow key={`remote-${server.id}`} id={server.id}>
                  {(dragHandle) => (<>
                    <TableCell className="w-8 p-0 text-center">
                      <button {...dragHandle} className="cursor-grab active:cursor-grabbing touch-none text-muted-foreground hover:text-foreground p-1 inline-flex" title={t('servers.dragToReorder', { defaultValue: '拖动排序' })}>
                        <GripVertical className="h-4 w-4" />
                      </button>
                    </TableCell>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <div className={cn("w-2.5 h-2.5 rounded-full flex-shrink-0", server.status === 'connected' ? "bg-green-500" : server.status === 'pending' ? "bg-yellow-500" : "bg-red-500")} />
                        <div className="min-w-0 flex-1">
                          {/* 名称左对齐,其它徽章 / 图标整体右对齐 */}
                          <div className="flex items-center gap-2 justify-between">
                            <span className={cn("truncate", server.status !== 'connected' && 'cursor-pointer hover:text-primary')} onClick={() => { if (server.status !== 'connected') { setSelectedRemoteServer(server); setIsRemoteServerDetailDialogOpen(true) } }}><Twemoji>{server.name}</Twemoji></span>
                            <div className="flex flex-wrap items-center justify-end gap-1.5 shrink-0">
                              <RemoteServerStatusBadge status={server.status} />
                              {server.status === 'connected' && (
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      {server.encrypted
                                        ? <Lock className="h-3 w-3 text-green-500 flex-shrink-0 cursor-help" />
                                        : <LockOpen className="h-3 w-3 text-muted-foreground flex-shrink-0 cursor-help" />}
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      {server.encrypted ? '主控与 Agent 之间通信已加密(端到端会话加密)' : '主控与 Agent 通信未加密(老版本 Agent 不支持,建议升级)'}
                                    </TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              )}
                              {Math.abs(server.time_offset_seconds ?? 0) > 10 && (
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <AlertTriangle className="h-4 w-4 text-yellow-500 cursor-help flex-shrink-0" />
                                    </TooltipTrigger>
                                    <TooltipContent>{t('servers.timeOffsetWarning')}</TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              )}
                              {server.fallback_to_pull && (<Badge variant="secondary" className="text-xs bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200">{t('servers.degraded')}</Badge>)}
                              {server.steal_mode && (<Badge variant="outline" className="text-xs">{server.steal_mode === 'fallback' ? t('servers.fallbackLabel') : server.steal_mode === 'tunnel' ? t('servers.tunnelLabel') : t('servers.stealModeDefault')}</Badge>)}
                            </div>
                          </div>
                          {/* 第 2 行:Xray 模式 badge + 心跳时间,移出顶部徽章组释放右侧名称空间 */}
                          <div className="flex items-center gap-2 mt-0.5">
                            {server.warp_installed && (
                              <Badge variant="outline" className="shrink-0 border-2 border-orange-500 text-orange-600 dark:border-orange-400 dark:text-orange-400 font-bold rounded-full h-4 w-4 p-0 flex items-center justify-center bg-orange-50 dark:bg-orange-950/30" title="WARP installed">
                                <span className="text-[9px] leading-none italic" style={{ fontFamily: 'serif' }}>W</span>
                              </Badge>
                            )}
                            <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0 shrink-0", server.xray_mode === 'embedded' ? "border-blue-300 text-blue-700 dark:border-blue-700 dark:text-blue-400" : "border-gray-300 text-gray-600 dark:border-gray-600 dark:text-gray-400")}>{server.xray_mode === 'embedded' ? t('servers.xrayModeEmbedded') : t('servers.xrayModeExternal')}</Badge>
                            {server.last_heartbeat && (<span className="text-xs text-muted-foreground truncate">{t('servers.heartbeatLabel')}: {new Date(server.last_heartbeat).toLocaleString()}</span>)}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs gap-1">
                            {server.connection_mode === 'websocket' && <Wifi className="h-3 w-3" />}{server.connection_mode === 'http' && <Radio className="h-3 w-3" />}{server.connection_mode === 'pull' && <RefreshCw className="h-3 w-3" />}{(server.connection_mode === 'auto' || !server.connection_mode) && <Settings className="h-3 w-3" />}
                            <span>{server.connection_mode === 'websocket' ? 'WS' : server.connection_mode === 'http' ? 'HTTP' : server.connection_mode === 'pull' ? t('servers.pullMode') : t('servers.autoMode')}</span><ChevronDown className="h-3 w-3" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-40">
                          {(['auto', 'websocket', 'http', 'pull'] as const).map(mode => (
                            <DropdownMenuItem key={mode} onClick={() => updateConnectionModeMutation.mutate({ id: server.id, connection_mode: mode })}>
                              {mode === 'auto' && <Settings className="mr-2 h-4 w-4" />}{mode === 'websocket' && <Wifi className="mr-2 h-4 w-4" />}{mode === 'http' && <Radio className="mr-2 h-4 w-4" />}{mode === 'pull' && <RefreshCw className="mr-2 h-4 w-4" />}
                              {mode === 'auto' ? t('servers.autoMode') : mode === 'websocket' ? t('servers.websocketMode') : mode === 'http' ? t('servers.httpMode') : t('servers.pullMode')}
                              {(server.connection_mode === mode || (!server.connection_mode && mode === 'auto')) && <span className="ml-auto">✓</span>}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                    <TableCell className="text-muted-foreground"><IPCell raw={server.ip_address || ''} /></TableCell>
                    <TableCell className="min-w-[100px] w-[100px] tabular-nums">
                      {server.status === 'connected' && ((server.current_upload_speed || server.current_download_speed) ? (
                        <div className="text-xs space-y-0.5">
                          <div className="text-green-600 dark:text-green-400">↑ {formatSpeed(server.current_upload_speed || 0)}</div>
                          <div className="text-blue-600 dark:text-blue-400">↓ {formatSpeed(server.current_download_speed || 0)}</div>
                        </div>
                      ) : (<span className="text-xs text-muted-foreground">-</span>))}
                      {server.status !== 'connected' && <span className="text-xs text-muted-foreground">-</span>}
                    </TableCell>
                    <TableCell>
                      {server.traffic_limit && server.traffic_limit > 0 ? (
                        <div className="min-w-[100px]">
                          <div className="text-xs text-muted-foreground mb-1">{formatTraffic(server.traffic_used || 0)} / {formatTraffic(server.traffic_limit)}</div>
                          <div className="h-1.5 bg-muted rounded-full overflow-hidden"><div className={cn("h-full rounded-full", getTrafficPercent(server.traffic_used || 0, server.traffic_limit) > 90 ? "bg-red-500" : getTrafficPercent(server.traffic_used || 0, server.traffic_limit) > 70 ? "bg-yellow-500" : "bg-green-500")} style={{ width: `${Math.min(getTrafficPercent(server.traffic_used || 0, server.traffic_limit), 100)}%` }} /></div>
                          {!!server.traffic_reset_day && server.traffic_reset_day > 0 && (<div className="text-xs text-muted-foreground mt-0.5">{t('servers.monthlyResetFull', { day: server.traffic_reset_day })}</div>)}
                        </div>
                      ) : (
                        <div className="min-w-[100px]">
                          <div className="text-xs text-muted-foreground mb-1">{formatTraffic(server.traffic_used || 0)} · {t('servers.unlimited')}</div>
                          <div className="h-1.5 rounded-full overflow-hidden"><div className="h-full w-full rounded-full rainbow-flow-bar" /></div>
                          <div className="text-xs text-muted-foreground mt-0.5">{t('servers.noResetNeeded', { defaultValue: '无需重置' })}</div>
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="min-w-[170px] w-[170px]">
                      <div className="flex items-center gap-3 min-h-[1.5rem]">
                        {server.status !== 'connected' ? (
                          <span className="text-xs text-muted-foreground">{t('servers.notConnected')}</span>
                        ) : remoteStatus?.loading ? (
                          <span className="inline-block h-4 w-[140px] rounded animate-pulse bg-muted" />
                        ) : (
                          <>
                            <RemoteServiceStatusIndicator status={remoteStatus?.xray} name="Xray" serverId={server.id} isEmbedded={server.xray_mode === 'embedded'} isFederated={server.is_federated} />
                            {remoteStatus?.nginx?.installed && (<RemoteServiceStatusIndicator status={remoteStatus?.nginx} name="Nginx" serverId={server.id} isFederated={server.is_federated} />)}
                            {server.status === 'connected' && <AgentVersionIndicator serverId={server.id} isFederated={server.is_federated} />}
                          </>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right min-w-[200px] w-[200px]">
                      <div className="flex justify-end gap-1">
                        {server.status === 'connected' && (
                          <>
                            {/* 同 card view:外置 xray 还没装时给安装按钮 fallback,装好后入口挪到 Agent 下拉 */}
                            {server.xray_mode !== 'embedded' && !server.is_federated && !(remoteStatus?.xray?.installed) && (
                              <Button variant="outline" size="icon" className="h-7 w-7 p-0" onClick={() => setInstallDialogServerId(server.id)} title={t('servers.install')}><Download className="h-3.5 w-3.5" /></Button>
                            )}
                            {(remoteStatus?.xray?.installed || server.xray_mode === 'embedded') && (<Button variant="outline" size="icon" className="h-7 w-7 p-0" onClick={() => handleOpenRemoteXrayConfig(server)} title={t('servers.xrayConfig')}><img src="/images/xray.svg" alt="Xray" className="h-4 w-4 dark:invert" /></Button>)}
                            {!server.is_federated && (remoteStatus?.xray?.installed || server.xray_mode === 'embedded') && (
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild><Button variant="outline" size="icon" className="h-7 w-7 p-0" title={t('servers.agentManagement')}><Settings className="h-3.5 w-3.5" /></Button></DropdownMenuTrigger>
                                <DropdownMenuContent>
                                  {server.xray_mode !== 'embedded' && (
                                    <>
                                      <DropdownMenuItem onClick={() => setInstallDialogServerId(server.id)}><Download className="mr-2 h-4 w-4" />{t('servers.installService')}</DropdownMenuItem>
                                      <DropdownMenuSeparator />
                                    </>
                                  )}
                                  <DropdownMenuItem onClick={() => { setSyncingServerId(server.id); setSyncServerHost(server.ip_address || ''); setIsSyncNodesDialogOpen(true) }}><RefreshCw className="mr-2 h-4 w-4" />{t('servers.syncNodes')}</DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => { setHistoryServerId(server.id); setHistoryServerName(server.name); setHistoryPreviewId(null); setHistoryPreviewConfig(''); setHistoryDialogOpen(true) }}><History className="mr-2 h-4 w-4" />配置历史</DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    onClick={() => {
                                      if (!confirm(`确定要把默认配置下发到 ${server.name} 吗?\n会覆盖 Agent 当前的 xray 配置并重启 xray。`)) return
                                      deployStealSelfMutation.mutate(server.id)
                                    }}
                                    disabled={deployStealSelfMutation.isPending}
                                  >
                                    <Download className="mr-2 h-4 w-4" />{deployStealSelfMutation.isPending ? '下发中...' : '下发默认配置'}
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem onClick={() => { setAddWebsiteServerId(server.id); setIsAddWebsiteDialogOpen(true) }}><Globe className="mr-2 h-4 w-4" />{t('servers.addWebsite')}</DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem onClick={() => handleAgentUpgrade(server.id)}><ArrowUpCircle className="mr-2 h-4 w-4" />{t('servers.upgradeAgent')}</DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => handleAgentUninstall(server.id)} className="text-red-600"><Trash2 className="mr-2 h-4 w-4" />{t('servers.uninstallAgent')}</DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            )}
                            {!server.is_federated && (<Button variant="ghost" size="icon" className="h-7 w-7 p-0" onClick={() => setShareServer({ id: server.id, name: server.name })} title="分享服务器（PRO）"><Share2 className="h-3.5 w-3.5" /></Button>)}
                            <Button variant="ghost" size="icon" className="h-7 w-7 p-0" onClick={() => remoteScanMutation.mutate(server.id)} disabled={remoteScanMutation.isPending} title={t('servers.scan')}><Search className={cn("h-3.5 w-3.5", remoteScanMutation.isPending && "animate-spin")} /></Button>
                          </>
                        )}
                        {!server.is_federated && (<Button variant="ghost" size="icon" className="h-7 w-7 p-0" onClick={() => handleEditRemoteServer(server)} title={t('servers.editServer')}><Pencil className="h-3.5 w-3.5" /></Button>)}
                        <Button variant="ghost" size="icon" className="h-7 w-7 p-0 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950" onClick={() => handleDeleteRemoteServer(server.id)} title={t('servers.deleteServer')}><X className="h-3.5 w-3.5" /></Button>
                      </div>
                    </TableCell>
                  </>)}
                  </SortableServerRow>
                )
              })}
                </SortableContext>
              </DndContext>
            </TableBody>
          </Table>
        </TableCard>
      )}

      {/* Terminal Dialog */}
      <Dialog open={isTerminalDialogOpen} onOpenChange={(open) => { if (!terminalRunning) setIsTerminalDialogOpen(open) }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Terminal className="h-5 w-5" />{terminalTitle}</DialogTitle>
            <DialogDescription>{terminalRunning ? t('servers.executing') : t('servers.executionDone')}</DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <div ref={terminalRef} className="bg-zinc-900 text-zinc-100 p-4 rounded-lg text-sm font-mono overflow-auto max-h-[400px] whitespace-pre-wrap break-all">
              {terminalOutput}{terminalRunning && <span className="animate-pulse">▌</span>}
            </div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setIsTerminalDialogOpen(false)} disabled={terminalRunning}>{terminalRunning ? t('servers.executingBtn') : tc('actions.close')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Xray Config Dialog —— 桌面端 Dialog,手机端全屏 Sheet(side='bottom' h-[100dvh])。
          复用同一份 Tabs/Panel 子树,只换外层容器和 Header 包装 */}
      {(() => {
        const handleOpenChange = (open: boolean) => { setIsXrayRawConfigDialogOpen(open); if (!open) setConfigServer(null) }
        const tabsTree = (
          <Tabs defaultValue="config" className="flex-1 flex flex-col min-h-0">
            <TabsList className={cn(
              'flex-shrink-0 w-full',
              isMobile ? 'grid grid-cols-4 gap-1 h-auto' : 'justify-start'
            )}>
              <TabsTrigger value="config">{t('servers.configManagement')}</TabsTrigger>
              <TabsTrigger value="inbounds">{t('servers.inboundManagement')}</TabsTrigger>
              <TabsTrigger value="outbounds">{t('servers.outboundManagement')}</TabsTrigger>
              <TabsTrigger value="routing">{t('servers.routingManagement')}</TabsTrigger>
            </TabsList>
            <TabsContent value="config" className="flex-1 flex flex-col min-h-0 mt-2">
              {configServer?.type === 'remote' && (
                <div className="flex flex-wrap items-center gap-x-6 gap-y-3 pb-3 border-b mb-3 flex-shrink-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">{t('servers.serviceControl')}</span>
                    <Button variant="outline" size="sm" onClick={() => remoteServiceControlMutation.mutate({ serverId: configServer.server.id, service: 'xray', action: 'start' })} disabled={remoteServiceControlMutation.isPending || remoteServicesStatus?.xray?.running}><Play className="h-4 w-4 mr-1" />{t('servers.startBtn')}</Button>
                    <Button variant="outline" size="sm" onClick={() => remoteServiceControlMutation.mutate({ serverId: configServer.server.id, service: 'xray', action: 'stop' })} disabled={remoteServiceControlMutation.isPending || !remoteServicesStatus?.xray?.running}><Square className="h-4 w-4 mr-1" />{t('servers.stopBtn')}</Button>
                    <Button variant="outline" size="sm" onClick={() => remoteServiceControlMutation.mutate({ serverId: configServer.server.id, service: 'xray', action: 'restart' })} disabled={remoteServiceControlMutation.isPending}><RotateCcw className="h-4 w-4 mr-1" />{t('servers.restartBtn')}</Button>
                  </div>
                  {remoteServicesLoading ? (<RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />) : (
                    <Badge variant={remoteServicesStatus?.xray?.running ? 'default' : 'secondary'}>
                      {remoteServicesStatus?.xray?.installed ? (remoteServicesStatus?.xray?.running ? t('servers.running') : t('servers.stopped')) : t('servers.notInstalled')}
                      {remoteServicesStatus?.xray?.version ? ` (${remoteServicesStatus.xray.version})` : ''}
                    </Badge>
                  )}
                  <div className="flex items-center gap-4 flex-wrap">
                    {!remoteXraySystemConfigLoading && (
                      <>
                        <label className="flex items-center gap-1.5 text-sm"><Switch checked={remoteXraySystemConfig.metrics_enabled} onCheckedChange={(checked) => setRemoteXraySystemConfig(prev => ({ ...prev, metrics_enabled: checked }))} />{t('servers.metricsStats')}</label>
                        <label className="flex items-center gap-1.5 text-sm"><Switch checked={remoteXraySystemConfig.stats_enabled} onCheckedChange={(checked) => setRemoteXraySystemConfig(prev => ({ ...prev, stats_enabled: checked }))} />{t('servers.trafficStatsConfig')}</label>
                        <label className="flex items-center gap-1.5 text-sm"><Switch checked={remoteXraySystemConfig.grpc_enabled} onCheckedChange={(checked) => setRemoteXraySystemConfig(prev => ({ ...prev, grpc_enabled: checked }))} />gRPC</label>
                      </>
                    )}
                  </div>
                </div>
              )}
              <div className="flex-1 flex flex-col min-h-0">
                {xrayRawConfigLoading ? (<div className="flex items-center justify-center flex-1 bg-muted rounded-lg"><RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" /></div>) : (
                  <Textarea value={xrayRawConfig} onChange={(e) => setXrayRawConfig(e.target.value)} className="font-mono text-sm flex-1 resize-none" placeholder={t('servers.xrayConfigPlaceholder')} />
                )}
              </div>
              {/* 实时 JSON 格式检测 + 一键格式化;不阻塞保存,只是给提示。错误时显示具体位置 / 信息。 */}
              {(() => {
                if (xrayRawConfigLoading) return null
                let parseErr = ''
                if (xrayRawConfig.trim() !== '') {
                  try { JSON.parse(xrayRawConfig) } catch (e: any) { parseErr = e?.message || 'JSON 解析失败' }
                }
                return (
                  <div className={cn('flex items-center justify-between gap-2 pt-2 text-xs flex-shrink-0', parseErr ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400')}>
                    <div className="flex items-center gap-1.5 min-w-0">
                      {parseErr ? (
                        <>
                          <XCircle className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">JSON 格式错误: {parseErr}</span>
                        </>
                      ) : (
                        <>
                          <CheckCircle className="h-3.5 w-3.5 shrink-0" />
                          <span>JSON 格式正确</span>
                        </>
                      )}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 shrink-0"
                      onClick={() => {
                        try {
                          setXrayRawConfig(JSON.stringify(JSON.parse(xrayRawConfig), null, 2))
                          toast.success('已格式化')
                        } catch {
                          toast.error('JSON 格式错误,无法格式化')
                        }
                      }}
                      disabled={!!parseErr || !xrayRawConfig.trim()}
                    >
                      格式化
                    </Button>
                  </div>
                )
              })()}
              <div className="flex justify-end gap-2 pt-3 flex-shrink-0">
                <Button onClick={() => { if (xrayRawConfigServerId === null) return; try { JSON.parse(xrayRawConfig) } catch { toast.error(t('servers.jsonFormatError')); return }; saveXrayRawConfigMutation.mutate({ serverId: xrayRawConfigServerId, config: xrayRawConfig }); if (configServer?.type === 'remote') handleSaveXrayConfig() }} disabled={saveXrayRawConfigMutation.isPending || updateRemoteXraySystemConfigMutation.isPending || xrayRawConfigLoading}>
                  {(saveXrayRawConfigMutation.isPending || updateRemoteXraySystemConfigMutation.isPending) ? t('servers.saving') : t('servers.saveConfig')}
                </Button>
              </div>
            </TabsContent>
            <TabsContent value="inbounds" className="flex-1 overflow-y-auto mt-2">
              {xrayRawConfigServerId !== null && (<InboundPanel serverId={xrayRawConfigServerId} serverName={xrayRawConfigServerName} federationPrefix={remoteServers.find((s: RemoteServer) => s.id === xrayRawConfigServerId)?.federation_prefix || ''} />)}
            </TabsContent>
            <TabsContent value="outbounds" className="flex-1 overflow-y-auto mt-2">
              {xrayRawConfigServerId !== null && (<OutboundPanel serverId={xrayRawConfigServerId} serverName={xrayRawConfigServerName} xrayMode={remoteServers.find((s: RemoteServer) => s.id === xrayRawConfigServerId)?.xray_mode as 'external' | 'embedded' | undefined} />)}
            </TabsContent>
            <TabsContent value="routing" className="flex-1 overflow-y-auto mt-2">
              {xrayRawConfigServerId !== null && (<RoutingPanel serverId={xrayRawConfigServerId} serverName={xrayRawConfigServerName} isRemote={true} xrayMode={remoteServers.find((s: RemoteServer) => s.id === xrayRawConfigServerId)?.xray_mode as 'external' | 'embedded' | undefined} />)}
            </TabsContent>
          </Tabs>
        )
        if (isMobile) {
          return (
            <Sheet open={isXrayRawConfigDialogOpen} onOpenChange={handleOpenChange}>
              <SheetContent side="bottom" className="h-[100dvh] w-full max-w-none flex flex-col p-0 gap-0">
                <SheetHeader className="flex-shrink-0 px-4 pt-4 pb-2 border-b text-left">
                  <SheetTitle>{t('servers.xrayManagement')} - {xrayRawConfigServerName}</SheetTitle>
                  <SheetDescription>{t('servers.xrayManagementDesc')}</SheetDescription>
                </SheetHeader>
                <div className="flex-1 flex flex-col min-h-0 px-4 pb-4 pt-2">
                  {tabsTree}
                </div>
              </SheetContent>
            </Sheet>
          )
        }
        return (
          <Dialog open={isXrayRawConfigDialogOpen} onOpenChange={handleOpenChange}>
            <DialogContent className="w-[50vw] h-[85vh] flex flex-col overflow-hidden sm:max-w-none">
              <DialogHeader className="flex-shrink-0">
                <DialogTitle>{t('servers.xrayManagement')} - {xrayRawConfigServerName}</DialogTitle>
                <DialogDescription>{t('servers.xrayManagementDesc')}</DialogDescription>
              </DialogHeader>
              {tabsTree}
            </DialogContent>
          </Dialog>
        )
      })()}

      {/* Delete Remote Server Confirm */}
      <AlertDialog open={isDeleteRemoteServerDialogOpen} onOpenChange={setIsDeleteRemoteServerDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>{t('servers.confirmDeleteServer')}</AlertDialogTitle><AlertDialogDescription>{t('servers.deleteServerTokenWarning')}</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel onClick={() => setDeletingRemoteServerId(null)}>{tc('actions.cancel')}</AlertDialogCancel><AlertDialogAction onClick={confirmDeleteRemoteServer} className="bg-red-600 hover:bg-red-700">{tc('actions.confirmDelete')}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* REMAINING_DIALOGS */}

      {/* Remote Server Detail Dialog */}
      <Dialog open={isRemoteServerDetailDialogOpen} onOpenChange={setIsRemoteServerDetailDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{selectedRemoteServer?.status === 'offline' ? t('servers.serverOffline') : t('servers.serverInstallInfo')}</DialogTitle>
            <DialogDescription>{selectedRemoteServer?.status === 'offline' ? t('servers.serverOfflineDesc') : t('servers.serverOfflineDescDetailed')}</DialogDescription>
          </DialogHeader>
          {selectedRemoteServer && (
            <div className="space-y-4">
              {selectedRemoteServer.status === 'offline' && (
                <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-4 rounded-lg">
                  <div className="flex items-center gap-2 text-red-700 dark:text-red-400 font-medium mb-2"><div className="w-3 h-3 rounded-full bg-red-500" />{t('servers.serverOffline')}</div>
                  <p className="text-sm text-red-600 dark:text-red-400">{t('servers.lastHeartbeatTime', { time: selectedRemoteServer.last_heartbeat ? new Date(selectedRemoteServer.last_heartbeat).toLocaleString() : t('servers.neverConnected') })}</p>
                </div>
              )}
              <div className="space-y-2"><Label>{t('servers.serverName')}</Label><div className="text-sm font-medium"><Twemoji>{selectedRemoteServer.name}</Twemoji></div></div>
              {selectedRemoteServer.status === 'offline' && (
                <div className="space-y-2">
                  <Label className="text-base font-semibold">{t('servers.startService')}</Label>
                  <div className="bg-muted p-3 rounded-md"><pre className="text-xs font-mono whitespace-pre-wrap">{`# Check service status\nsystemctl status mmwx\n\n# Start service\nsystemctl start mmwx\n\n# View logs\njournalctl -u mmwx -f`}</pre></div>
                  <Button variant="outline" size="sm" onClick={() => copyToClipboard('systemctl start mmwx', t('servers.copyStartCommand'))}><Copy className="h-4 w-4 mr-2" />{t('servers.copyStartCommand')}</Button>
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="detail-token">Token</Label>
                <div className="flex gap-2"><Input id="detail-token" value={selectedRemoteServer.token} readOnly className="font-mono text-sm" /><Button variant="outline" size="icon" onClick={() => copyToClipboard(selectedRemoteServer.token, 'Token')}><Copy className="h-4 w-4" /></Button></div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="detail-install-command">{selectedRemoteServer.status === 'offline' ? t('servers.reinstallCommand') : t('servers.oneClickInstall')}</Label>
                <div className="flex gap-2"><Input id="detail-install-command" value={buildRemoteInstallCommand(selectedRemoteServer, masterOrigin)} readOnly className="font-mono text-xs" /><Button variant="outline" size="icon" onClick={() => copyToClipboard(buildRemoteInstallCommand(selectedRemoteServer, masterOrigin), t('servers.installCommand'))}><Copy className="h-4 w-4" /></Button></div>
                <p className="text-xs text-muted-foreground">{selectedRemoteServer.status === 'offline' ? t('servers.offlineReinstallHint') : t('servers.onlineInstallHint')}</p>
              </div>
              <div className="space-y-2">
                <Label>{t('servers.manualConfig')}</Label>
                <div className="bg-muted p-3 rounded-md"><pre className="text-xs font-mono whitespace-pre-wrap">{`# Config file: /etc/mmwx/config.yaml\nmode: remote\nmaster_server: ${window.location.origin}\nremote_token: ${selectedRemoteServer.token}`}</pre></div>
                <Button variant="outline" size="sm" onClick={() => copyToClipboard(`mode: remote\nmaster_server: ${window.location.origin}\nremote_token: ${selectedRemoteServer.token}`, t('servers.manualConfig'))}><Copy className="h-4 w-4 mr-2" />{t('servers.copyConfig')}</Button>
              </div>
            </div>
          )}
          <DialogFooter><Button variant="outline" onClick={() => setIsRemoteServerDetailDialogOpen(false)}>{tc('actions.close')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Remote Server Dialog */}
      <Dialog open={isEditRemoteServerDialogOpen} onOpenChange={(open) => { setIsEditRemoteServerDialogOpen(open); if (!open) { setEditingRemoteServer(null); setRemoteFormData({ name: '', pull_address: '', domain: '', traffic_limit_gb: '', traffic_used_gb: '', traffic_reset_day: '', steal_mode: 'default', xray_mode: 'external', traffic_stats_mode: 'both' }) } }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{t('servers.editRemoteServer')}</DialogTitle><DialogDescription>{t('servers.editRemoteServerDesc')}</DialogDescription></DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2"><Label htmlFor="edit-remote-name">{t('servers.serverName')}</Label><Input id="edit-remote-name" value={remoteFormData.name} onChange={(e) => setRemoteFormData({ ...remoteFormData, name: e.target.value })} placeholder={t('servers.serverNamePlaceholder')} /></div>
            <div className="grid gap-2"><Label htmlFor="edit-remote-pull-address">{t('servers.serverAddress')}</Label><Input id="edit-remote-pull-address" value={remoteFormData.pull_address} onChange={(e) => setRemoteFormData({ ...remoteFormData, pull_address: e.target.value })} placeholder={t('servers.serverAddressPlaceholder')} /></div>
            <div className="grid gap-2"><Label htmlFor="edit-remote-domain">{t('servers.domainOptional')}</Label><Input id="edit-remote-domain" value={remoteFormData.domain} onChange={(e) => setRemoteFormData({ ...remoteFormData, domain: e.target.value })} placeholder="example.com" /><p className="text-xs text-muted-foreground">{t('servers.domainHint')}</p></div>
            <div className="grid gap-2">
              <Label htmlFor="edit-remote-listen-port">{t('servers.agentPort')}</Label>
              <Input id="edit-remote-listen-port" type="number" min={1024} max={65535} placeholder="23889"
                value={(remoteFormData as any).listen_port || ''}
                onChange={(e) => setRemoteFormData({ ...remoteFormData, listen_port: e.target.value } as any)} />
              <p className="text-xs text-muted-foreground">{t('servers.agentPortEditHint', { defaultValue: '修改后会通知 Agent 改配置并重启,短暂掉线属于正常现象;留空恢复默认 23889。' })}</p>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="grid gap-2"><Label htmlFor="edit-remote-traffic-limit">{t('servers.trafficLimit')}</Label><Input id="edit-remote-traffic-limit" type="number" step="0.01" placeholder={t('servers.trafficLimitPlaceholder')} value={remoteFormData.traffic_limit_gb} onChange={(e) => setRemoteFormData({ ...remoteFormData, traffic_limit_gb: e.target.value })} /></div>
              <div className="grid gap-2"><Label htmlFor="edit-remote-traffic-used">{t('servers.usedTraffic')}</Label><Input id="edit-remote-traffic-used" type="number" step="0.01" placeholder={t('servers.usedTrafficPlaceholder')} value={remoteFormData.traffic_used_gb} onChange={(e) => setRemoteFormData({ ...remoteFormData, traffic_used_gb: e.target.value })} /></div>
              <div className="grid gap-2"><Label htmlFor="edit-remote-reset-day">{t('servers.resetDay')}</Label><Input id="edit-remote-reset-day" type="number" min="1" max="31" placeholder={t('servers.resetDayPlaceholder')} value={remoteFormData.traffic_reset_day} onChange={(e) => setRemoteFormData({ ...remoteFormData, traffic_reset_day: e.target.value })} /></div>
            </div>
            <div className="grid gap-2">
              <Label>{t('servers.xrayMode')}</Label>
              <RadioGroup value={remoteFormData.xray_mode} onValueChange={(value) => setRemoteFormData({ ...remoteFormData, xray_mode: value })} className="flex gap-4">
                <div className="flex items-center gap-2"><RadioGroupItem value="external" id="edit-xray-mode-external" /><Label htmlFor="edit-xray-mode-external" className="text-sm cursor-pointer">{t('servers.xrayModeExternal')}</Label></div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="embedded" id="edit-xray-mode-embedded" />
                  <Label htmlFor="edit-xray-mode-embedded" className="text-sm cursor-pointer">{t('servers.xrayModeEmbedded')}</Label>
                  <TooltipProvider><Tooltip><TooltipTrigger asChild>
                    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold cursor-default select-none shadow-sm border bg-gradient-to-r from-amber-400 to-yellow-300 text-amber-900 border-amber-300/60 shadow-amber-200/50">
                      <svg className="h-2.5 w-2.5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" /></svg>
                      Pro
                    </span>
                  </TooltipTrigger><TooltipContent>{t('servers.xrayModeEmbeddedProHint')}</TooltipContent></Tooltip></TooltipProvider>
                  <TooltipProvider><Tooltip><TooltipTrigger asChild>
                    <span className="inline-flex items-center justify-center rounded-full h-5 w-5 cursor-default select-none border-2 border-orange-500 text-orange-600 italic font-serif text-[10px] font-bold leading-none">W</span>
                  </TooltipTrigger><TooltipContent>{t('servers.xrayModeEmbeddedWarpHint')}</TooltipContent></Tooltip></TooltipProvider>
                </div>
              </RadioGroup>
              <p className="text-xs text-muted-foreground">{remoteFormData.xray_mode === 'external' ? t('servers.xrayModeExternalDesc') : t('servers.xrayModeEmbeddedDesc')}</p>
            </div>
            <div className="grid gap-2">
              <Label>流量统计规则</Label>
              <RadioGroup value={remoteFormData.traffic_stats_mode} onValueChange={(v) => setRemoteFormData({ ...remoteFormData, traffic_stats_mode: v as 'both' | 'upload' | 'download' })} className="flex gap-4">
                <div className="flex items-center gap-2"><RadioGroupItem value="both" id="edit-stats-mode-both" /><Label htmlFor="edit-stats-mode-both" className="text-sm cursor-pointer">上行 + 下行</Label></div>
                <div className="flex items-center gap-2"><RadioGroupItem value="upload" id="edit-stats-mode-upload" /><Label htmlFor="edit-stats-mode-upload" className="text-sm cursor-pointer">仅上行</Label></div>
                <div className="flex items-center gap-2"><RadioGroupItem value="download" id="edit-stats-mode-download" /><Label htmlFor="edit-stats-mode-download" className="text-sm cursor-pointer">仅下行</Label></div>
              </RadioGroup>
              <p className="text-xs text-muted-foreground">影响该服务器节点流量的统计方向。用户流量按套餐 traffic_mode 单独算,不受影响。</p>
            </div>
            {editingRemoteServer?.status === 'connected' && editingRemoteServer?.steal_mode && (
              <div className="grid gap-2">
                <Label>{t('servers.deployMode')}</Label>
                <RadioGroup value={remoteFormData.steal_mode} onValueChange={(value) => setRemoteFormData({ ...remoteFormData, steal_mode: value })} className="flex gap-4">
                  <div className="flex items-center gap-2"><RadioGroupItem value="tunnel" id="edit-steal-tunnel" /><Label htmlFor="edit-steal-tunnel" className="text-sm cursor-pointer">Tunnel</Label></div>
                  <div className="flex items-center gap-2"><RadioGroupItem value="fallback" id="edit-steal-fallback" /><Label htmlFor="edit-steal-fallback" className="text-sm cursor-pointer">{t('servers.fallbackLabel')}</Label></div>
                  <div className="flex items-center gap-2"><RadioGroupItem value="default" id="edit-steal-default" /><Label htmlFor="edit-steal-default" className="text-sm cursor-pointer">{t('servers.stealModeDefault')}</Label></div>
                </RadioGroup>
                <p className="text-xs text-muted-foreground">{remoteFormData.steal_mode === 'tunnel' ? t('servers.tunnelModeDesc') : remoteFormData.steal_mode === 'fallback' ? t('servers.fallbackModeDesc') : t('servers.stealModeDefaultDesc')}</p>
                {remoteFormData.steal_mode !== (editingRemoteServer?.steal_mode || 'tunnel') && (<p className="text-xs text-yellow-600 dark:text-yellow-400">{t('servers.stealModeSwitchWarning')}</p>)}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditRemoteServerDialogOpen(false)} disabled={updateRemoteServerMutation.isPending || switchStealModeMutation.isPending}>{tc('actions.cancel')}</Button>
            <Button onClick={handleSubmitRemoteServerEdit} disabled={updateRemoteServerMutation.isPending || switchStealModeMutation.isPending || !remoteFormData.name.trim()}>{(updateRemoteServerMutation.isPending || switchStealModeMutation.isPending) ? tc('actions.saving') : tc('actions.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remote Manage Dialog */}
      <Dialog open={isRemoteManageDialogOpen} onOpenChange={(open) => { setIsRemoteManageDialogOpen(open); if (!open) { setManagingRemoteServer(null); setRemoteServicesStatus(null) } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{t('servers.remoteServerManagement')}</DialogTitle><DialogDescription>{t('servers.manageRemoteService', { name: managingRemoteServer?.name || '' })}</DialogDescription></DialogHeader>
          {remoteServicesLoading ? (<div className="flex items-center justify-center py-8"><RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" /></div>) : (
            <div className="space-y-6 py-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2"><h4 className="font-medium">Xray</h4>{remoteServicesStatus?.xray?.installed ? (<Badge variant={remoteServicesStatus.xray.running ? 'default' : 'secondary'}>{remoteServicesStatus.xray.running ? t('servers.running') : t('servers.stopped')}</Badge>) : (<Badge variant="outline">{t('servers.notInstalled')}</Badge>)}</div>
                  {remoteServicesStatus?.xray?.version && (<span className="text-xs text-muted-foreground">{remoteServicesStatus.xray.version}</span>)}
                </div>
                <div className="flex flex-wrap gap-2">
                  {remoteServicesStatus?.xray?.installed ? (
                    <>
                      <Button variant="outline" size="sm" onClick={() => managingRemoteServer && remoteServiceControlMutation.mutate({ serverId: managingRemoteServer.id, service: 'xray', action: 'start' })} disabled={remoteServiceControlMutation.isPending || remoteServicesStatus?.xray?.running}><Play className="h-4 w-4 mr-1" />{t('servers.startBtn')}</Button>
                      <Button variant="outline" size="sm" onClick={() => managingRemoteServer && remoteServiceControlMutation.mutate({ serverId: managingRemoteServer.id, service: 'xray', action: 'stop' })} disabled={remoteServiceControlMutation.isPending || !remoteServicesStatus?.xray?.running}><Square className="h-4 w-4 mr-1" />{t('servers.stopBtn')}</Button>
                      <Button variant="outline" size="sm" onClick={() => managingRemoteServer && remoteServiceControlMutation.mutate({ serverId: managingRemoteServer.id, service: 'xray', action: 'restart' })} disabled={remoteServiceControlMutation.isPending}><RotateCcw className="h-4 w-4 mr-1" />{t('servers.restartBtn')}</Button>
                      <Button variant="outline" size="sm" className="text-red-600 hover:text-red-700" onClick={() => managingRemoteServer && handleRemoteRemoveXray(managingRemoteServer.id)} disabled={terminalRunning}><Trash2 className="h-4 w-4 mr-1" />{t('servers.uninstall')}</Button>
                    </>
                  ) : (<Button variant="outline" size="sm" onClick={() => managingRemoteServer && handleRemoteInstallXray(managingRemoteServer.id)} disabled={terminalRunning}><Download className="h-4 w-4 mr-1" />{t('servers.installXray')}</Button>)}
                </div>
              </div>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2"><h4 className="font-medium">Nginx</h4>{remoteServicesStatus?.nginx?.installed ? (<Badge variant={remoteServicesStatus.nginx.running ? 'default' : 'secondary'}>{remoteServicesStatus.nginx.running ? t('servers.running') : t('servers.stopped')}</Badge>) : (<Badge variant="outline">{t('servers.notInstalled')}</Badge>)}</div>
                  {remoteServicesStatus?.nginx?.version && (<span className="text-xs text-muted-foreground">{remoteServicesStatus.nginx.version}</span>)}
                </div>
                <div className="flex flex-wrap gap-2">
                  {remoteServicesStatus?.nginx?.installed ? (
                    <>
                      <Button variant="outline" size="sm" onClick={() => managingRemoteServer && remoteServiceControlMutation.mutate({ serverId: managingRemoteServer.id, service: 'nginx', action: 'start' })} disabled={remoteServiceControlMutation.isPending || remoteServicesStatus?.nginx?.running}><Play className="h-4 w-4 mr-1" />{t('servers.startBtn')}</Button>
                      <Button variant="outline" size="sm" onClick={() => managingRemoteServer && remoteServiceControlMutation.mutate({ serverId: managingRemoteServer.id, service: 'nginx', action: 'stop' })} disabled={remoteServiceControlMutation.isPending || !remoteServicesStatus?.nginx?.running}><Square className="h-4 w-4 mr-1" />{t('servers.stopBtn')}</Button>
                      <Button variant="outline" size="sm" onClick={() => managingRemoteServer && remoteServiceControlMutation.mutate({ serverId: managingRemoteServer.id, service: 'nginx', action: 'restart' })} disabled={remoteServiceControlMutation.isPending}><RotateCcw className="h-4 w-4 mr-1" />{t('servers.restartBtn')}</Button>
                      <Button variant="outline" size="sm" className="text-red-600 hover:text-red-700" onClick={() => managingRemoteServer && handleRemoteRemoveNginx(managingRemoteServer.id)} disabled={terminalRunning}><Trash2 className="h-4 w-4 mr-1" />{t('servers.uninstall')}</Button>
                    </>
                  ) : (<Button variant="outline" size="sm" onClick={() => managingRemoteServer && handleRemoteInstallNginx(managingRemoteServer.id)} disabled={terminalRunning}><Download className="h-4 w-4 mr-1" />{t('servers.installNginx')}</Button>)}
                </div>
              </div>
              {managingRemoteServer && (
                <div className="border-t pt-4 space-y-2">
                  <h4 className="font-medium text-sm">{t('servers.serverInfo')}</h4>
                  <div className="text-xs text-muted-foreground space-y-1">
                    <p>IP: {managingRemoteServer.ip_address || t('servers.unknown')}</p>
                    {managingRemoteServer.last_heartbeat && (<p>{t('servers.lastHeartbeat')}: {new Date(managingRemoteServer.last_heartbeat).toLocaleString()}</p>)}
                  </div>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => managingRemoteServer && loadRemoteServicesStatus(managingRemoteServer.id)} disabled={remoteServicesLoading}><RefreshCw className={cn("h-4 w-4 mr-1", remoteServicesLoading && "animate-spin")} />{t('servers.refreshStatus')}</Button>
            <Button variant="outline" onClick={() => setIsRemoteManageDialogOpen(false)}>{tc('actions.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 一键升级所有 Agent — 进度 Dialog */}
      <Dialog open={isUpgradeAllDialogOpen} onOpenChange={(open) => { if (!upgradeAllRunning) setIsUpgradeAllDialogOpen(open) }}>
        <DialogContent className="w-[95vw] md:w-[70vw] max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><ArrowUpCircle className="h-5 w-5" />{t('servers.upgradeAllAgents')}</DialogTitle>
            <DialogDescription>{t('servers.upgradeAllAgentsProgressDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {Object.entries(upgradeAllProgress).map(([sid, p]) => (
              <details key={sid} className="rounded-md border px-3 py-2 text-sm">
                <summary className="flex items-center justify-between cursor-pointer list-none">
                  <span className="font-medium truncate mr-3">{p.name}</span>
                  <span className="shrink-0 flex items-center gap-1">
                    {p.status === 'pending' && <span className="text-muted-foreground text-xs">{t('servers.upgradeStatusPending')}</span>}
                    {p.status === 'running' && <><Loader2 className="h-4 w-4 animate-spin text-primary" /><span className="text-primary text-xs">{t('servers.upgradeStatusRunning')}</span></>}
                    {p.status === 'success' && <><CheckCircle className="h-4 w-4 text-green-500" /><span className="text-green-500 text-xs">{t('servers.upgradeStatusSuccess')}</span></>}
                    {p.status === 'error' && <><XCircle className="h-4 w-4 text-red-500" /><span className="text-red-500 text-xs">{p.message || t('servers.upgradeStatusError')}</span></>}
                  </span>
                </summary>
                {p.log && <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all bg-muted/50 rounded p-2 text-xs font-mono">{p.log}</pre>}
              </details>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={upgradeAllRunning} onClick={() => setIsUpgradeAllDialogOpen(false)}>
              {upgradeAllRunning ? t('servers.upgradeAllRunning') : tc('actions.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 安装/卸载服务 dialog(Agent 下拉触发,替代原 InstallPopover) — inline 渲染避免重复挂载 */}
      <Dialog open={installDialogServerId !== null} onOpenChange={(o) => { if (!o) { setInstallDialogServerId(null); setInstallWithNginx('yes') } }}>
        <DialogContent className="max-w-sm">
          {(() => {
            const sid = installDialogServerId
            if (sid === null) return null
            const status = remoteServicesStatusMap[sid]
            const xrayInstalled = status?.xray?.installed
            const nginxInstalled = status?.nginx?.installed
            const bothInstalled = xrayInstalled && nginxInstalled
            const srv = remoteServers.find(s => s.id === sid)
            const desc = installWithNginx === 'yes'
              ? (!xrayInstalled && !nginxInstalled ? t('servers.willInstallBoth')
                : (xrayInstalled && !nginxInstalled) ? t('servers.willInstallNginx')
                : (!xrayInstalled && nginxInstalled) ? t('servers.willInstallXray')
                : t('servers.bothInstalled'))
              : (!xrayInstalled ? t('servers.willInstallXray') : t('servers.xrayInstalled'))
            const canInstall = installWithNginx === 'yes' ? !bothInstalled : !xrayInstalled
            const canUninstall = xrayInstalled || nginxInstalled
            const close = () => { setInstallDialogServerId(null); setInstallWithNginx('yes') }
            return (
              <>
                <DialogHeader>
                  <DialogTitle>{t('servers.installService')}{srv ? ` — ${srv.name}` : ''}</DialogTitle>
                </DialogHeader>
                <div className="space-y-3 py-2">
                  <RadioGroup value={installWithNginx} onValueChange={setInstallWithNginx}>
                    <div className="flex items-center gap-2"><RadioGroupItem value="yes" id={`dlg-nginx-yes-${sid}`} /><Label htmlFor={`dlg-nginx-yes-${sid}`} className="text-sm cursor-pointer">{t('servers.iWantStealSelf')}</Label></div>
                    <div className="flex items-center gap-2"><RadioGroupItem value="no" id={`dlg-nginx-no-${sid}`} /><Label htmlFor={`dlg-nginx-no-${sid}`} className="text-sm cursor-pointer">{t('servers.xrayOnly')}</Label></div>
                  </RadioGroup>
                  <div className="text-xs text-muted-foreground">{desc}</div>
                </div>
                <DialogFooter>
                  {canUninstall && (<Button variant="outline" size="sm" className="text-red-600 hover:text-red-700" disabled={terminalRunning} onClick={() => { close(); handleSmartUninstall(sid) }}><Trash2 className="h-3.5 w-3.5 mr-1" />{t('servers.uninstall')}</Button>)}
                  <Button variant="outline" onClick={close}>{tc('actions.cancel')}</Button>
                  <Button disabled={terminalRunning || !canInstall} onClick={() => { close(); handleSmartInstall(sid, installWithNginx === 'yes') }}><Download className="h-3.5 w-3.5 mr-1" />{t('servers.install')}</Button>
                </DialogFooter>
              </>
            )
          })()}
        </DialogContent>
      </Dialog>

      {/* Sync Nodes Dialog */}
      <Dialog open={isSyncNodesDialogOpen} onOpenChange={setIsSyncNodesDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('servers.syncToNodes')}</DialogTitle><DialogDescription>{t('servers.syncToNodesDesc')}</DialogDescription></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="sync-server-host">{t('servers.serverHost')}</Label>
              <Input id="sync-server-host" placeholder={t('servers.syncServerHostPlaceholder')} value={syncServerHost} onChange={(e) => setSyncServerHost(e.target.value)} />
              <p className="text-xs text-muted-foreground">{t('servers.syncServerHostHint')}</p>
            </div>
            <div className="flex items-center justify-between">
              <div className="space-y-0.5"><Label htmlFor="sync-force-override">{t('servers.forceOverrideLabel')}</Label><p className="text-xs text-muted-foreground">{t('servers.forceOverrideDesc')}</p></div>
              <Switch id="sync-force-override" checked={syncForceOverride} onCheckedChange={setSyncForceOverride} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setIsSyncNodesDialogOpen(false); setSyncingServerId(null); setSyncServerHost(''); setSyncForceOverride(false) }}>{tc('actions.cancel')}</Button>
            <Button onClick={() => { if (syncingServerId && syncServerHost) syncNodesMutation.mutate({ serverId: syncingServerId, serverHost: syncServerHost, forceOverride: syncForceOverride }) }} disabled={!syncServerHost || syncNodesMutation.isPending}>{syncNodesMutation.isPending ? t('servers.syncing') : t('servers.startSync')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isAddWebsiteDialogOpen} onOpenChange={(open) => { if (!open) { setIsAddWebsiteDialogOpen(false); resetAddWebsiteDialog() } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Globe className="h-5 w-5" />{t('servers.addWebsiteDialog')}</DialogTitle>
            <DialogDescription>{t('servers.addWebsiteDesc')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="add-website-domain">{t('servers.websiteDomain')} <span className="text-destructive">*</span></Label>
              <Input id="add-website-domain" value={addWebsiteDomain} onChange={(e) => setAddWebsiteDomain(e.target.value)} placeholder={t('servers.domainPlaceholder')} />
            </div>
            <div className="grid gap-2">
              <Label>{t('servers.siteType')}</Label>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant={addWebsiteSiteType === 'static' ? 'default' : 'outline'} onClick={() => { setAddWebsiteSiteType('static'); setAddWebsiteValidResult(null) }} className="flex-1">{t('servers.staticPage')}</Button>
                <Button type="button" size="sm" variant={addWebsiteSiteType === 'proxy' ? 'default' : 'outline'} onClick={() => { setAddWebsiteSiteType('proxy'); setAddWebsiteValidResult(null) }} className="flex-1">{t('servers.reverseProxy')}</Button>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="add-website-value">{addWebsiteSiteType === 'static' ? t('servers.staticPath') : t('servers.reverseProxyAddress')} <span className="text-destructive">*</span></Label>
              <div className="flex gap-2">
                <Input id="add-website-value" value={addWebsiteSiteValue} onChange={(e) => { setAddWebsiteSiteValue(e.target.value); setAddWebsiteValidResult(null) }} placeholder={addWebsiteSiteType === 'static' ? t('servers.staticPathPlaceholder') : t('servers.reverseProxyPlaceholder')} className="flex-1" />
                <Button type="button" variant="outline" size="sm" onClick={validateWebsite} disabled={addWebsiteValidating || !addWebsiteSiteValue.trim()}>
                  {addWebsiteValidating ? <Loader2 className="h-4 w-4 animate-spin" /> : t('servers.validate')}
                </Button>
              </div>
              {addWebsiteValidResult && (
                <div className={`flex items-center gap-1.5 text-xs ${addWebsiteValidResult.ok ? 'text-green-600' : 'text-red-600'}`}>
                  {addWebsiteValidResult.ok ? <CheckCircle className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                  {addWebsiteValidResult.msg}
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setIsAddWebsiteDialogOpen(false); resetAddWebsiteDialog() }}>{tc('actions.cancel')}</Button>
            <Button onClick={submitAddWebsite} disabled={addWebsiteSubmitting || !addWebsiteDomain.trim() || !addWebsiteSiteValue.trim()}>{addWebsiteSubmitting ? t('servers.adding') : tc('actions.add')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ShareServerDialog server={shareServer} onClose={() => setShareServer(null)} />

      <XraySnapshotHistoryDialog
        open={historyDialogOpen}
        onOpenChange={(o) => { setHistoryDialogOpen(o); if (!o) { setHistoryPreviewId(null); setHistoryPreviewConfig('') } }}
        serverId={historyServerId}
        serverName={historyServerName}
        previewId={historyPreviewId}
        previewConfig={historyPreviewConfig}
        onPreview={(id, cfg) => { setHistoryPreviewId(id); setHistoryPreviewConfig(cfg) }}
      />
    </div>
  )
}