// @ts-nocheck
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Edit2, RefreshCw, Trash2, Plus, Package, Network, Gauge, FileText, ArrowLeftRight, ArrowRight, Info as InfoIcon } from 'lucide-react'

import { ProFeatureGate } from '@/components/pro-feature-gate'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { EmptyStateCard } from '@/components/ui/empty-state'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ViewToggle, type ViewMode } from '@/components/ui/view-toggle'
import { useIsMobile } from '@/hooks/use-mobile'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api } from '@/lib/api'
import { handleServerError } from '@/lib/handle-server-error'

export const Route = createFileRoute('/packages/')({
  component: PackagesPage,
})

interface PackageTemplate {
  id: number
  name: string
  description: string
  traffic_limit_gb: number
  cycle_days: number
  is_reset: boolean
  reset_day: number
  nodes: number[]
  node_multipliers?: Record<string, number>
  node_speed_limits?: Record<string, number>
  node_device_limits?: Record<string, number>
  speed_limit_mbps: number
  device_limit: number
  traffic_mode: string
  template_filename: string
  created_at: string
  updated_at: string
}

interface PackageFormData {
  id?: number
  name: string
  description: string
  traffic_limit_gb: number
  cycle_days: number
  nodes: number[]
  node_multipliers: Record<number, number> // node_id → 倍率;默认 1 不写入
  node_speed_limits: Record<number, number>  // node_id → Mbps;不在 map 表示沿用 speed_limit_mbps,0 = 显式不限速
  node_device_limits: Record<number, number> // 同上
  speed_limit_mbps: number
  device_limit: number
  traffic_mode: string
  template_filename: string
}

interface RuleTemplateEntry {
  name: string
  filename: string
}

// Select 的 value 不允许空字符串(Radix 限制),用这个 sentinel 表示"使用系统默认"。
const TEMPLATE_DEFAULT_SENTINEL = '__system_default__'

function PackagesPage() {
  const queryClient = useQueryClient()
  const { t } = useTranslation('packages')
  const [editingPackage, setEditingPackage] = useState<PackageTemplate | null>(null)
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  const [formData, setFormData] = useState<PackageFormData>({
    name: '',
    description: '',
    traffic_limit_gb: 100,
    cycle_days: 30,
    nodes: [],
    node_multipliers: {},
    node_speed_limits: {},
    node_device_limits: {},
    speed_limit_mbps: 0,
    device_limit: 0,
    traffic_mode: 'oneway',
    template_filename: '',
  })

  const { data: templatesData } = useQuery({
    // 用独立 key,避免跟模板管理页(routes/templates.index.tsx)的 ['rule-templates'] 串缓存 ——
    // 那边期望 templates:string[],这里是 {name, filename}[],缓存共享后会让模板管理页把对象直接
    // 渲染成 React children,触发 #31 "Objects are not valid as a React child"。
    queryKey: ['template-v3-list'],
    queryFn: async () => {
      const response = await api.get('/api/admin/template-v3')
      return response.data as { templates?: RuleTemplateEntry[] }
    },
  })
  const ruleTemplates: RuleTemplateEntry[] = templatesData?.templates ?? []

  const { data: packagesData, isLoading } = useQuery({
    queryKey: ['packages'],
    queryFn: async () => {
      const response = await api.get('/api/admin/packages')
      return response.data
    },
  })

  const { data: nodesData } = useQuery({
    queryKey: ['nodes', 'include-private'],
    queryFn: async () => {
      // include_private=1:套餐管理需要 id→name 全量映射,默认接口会过滤掉 routed_owner='user'
      // 等用户私有节点,导致 tooltip 显示 fallback "node-272"。该参数仅 admin 视角生效。
      const response = await api.get('/api/admin/nodes?include_private=1')
      return response.data
    },
  })

  // 复用节点管理页的 user-config.node_order,保证此 dialog 里节点顺序与节点管理一致
  const { data: userConfigData } = useQuery({
    queryKey: ['user-config'],
    queryFn: async () => {
      const response = await api.get('/api/user/config')
      return response.data as { node_order?: number[] }
    },
  })

  const nodes = useMemo(() => {
    const raw = nodesData?.nodes || []
    const order = userConfigData?.node_order || []
    if (order.length === 0) return raw
    const idx = new Map<number, number>()
    order.forEach((id, i) => idx.set(id, i))
    return [...raw].sort((a: any, b: any) => {
      const ai = idx.get(a.id) ?? Number.POSITIVE_INFINITY
      const bi = idx.get(b.id) ?? Number.POSITIVE_INFINITY
      return ai - bi
    })
  }, [nodesData, userConfigData])

  // node_id → node info(用于卡片 hover tooltip 反查节点名)
  const nodeMap = useMemo(() => {
    const m = new Map<number, any>()
    for (const n of nodes) {
      m.set(n.id, n)
    }
    return m
  }, [nodes])

  // 卡片 / 列表 视图切换;手机端强制 card
  const isMobile = useIsMobile()
  const [viewModeRaw, setViewMode] = useState<ViewMode>(() => (localStorage.getItem('packages-view-mode') as ViewMode) || 'card')
  const viewMode: ViewMode = isMobile ? 'card' : viewModeRaw

  const createMutation = useMutation({
    mutationFn: async (data: PackageFormData) => {
      const response = await api.post('/api/admin/packages/create', data)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['packages'] })
      toast.success(t('toast.createSuccess'))
      setIsCreateDialogOpen(false)
      resetForm()
    },
    onError: handleServerError,
  })

  const updateMutation = useMutation({
    mutationFn: async (data: PackageFormData) => {
      const response = await api.post('/api/admin/packages/update', data)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['packages'] })
      toast.success(t('toast.updateSuccess'))
      setEditingPackage(null)
      resetForm()
    },
    onError: handleServerError,
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const response = await api.post('/api/admin/packages/' + id, { id })
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['packages'] })
      toast.success(t('toast.deleteSuccess'))
    },
    onError: handleServerError,
  })

  const resetForm = () => {
    setFormData({
      name: '',
      description: '',
      traffic_limit_gb: 100,
      cycle_days: 30,
      is_reset: false,
      reset_day: 1,
      nodes: [],
      node_multipliers: {},
      node_speed_limits: {},
      node_device_limits: {},
      speed_limit_mbps: 0,
      device_limit: 0,
      traffic_mode: 'oneway',
      template_filename: '',
    } as PackageFormData)
  }

  const handleCreate = () => {
    setIsCreateDialogOpen(true)
    resetForm()
  }

  const handleEdit = (pkg: PackageTemplate) => {
    setEditingPackage(pkg)
    // 后端 JSON 的 node_multipliers map key 是字符串(JSON 规范),前端转回 number 方便用
    const mults: Record<number, number> = {}
    if (pkg.node_multipliers) {
      for (const [k, v] of Object.entries(pkg.node_multipliers)) {
        mults[Number(k)] = v
      }
    }
    const speedLimits: Record<number, number> = {}
    if (pkg.node_speed_limits) {
      for (const [k, v] of Object.entries(pkg.node_speed_limits)) {
        speedLimits[Number(k)] = v
      }
    }
    const deviceLimits: Record<number, number> = {}
    if (pkg.node_device_limits) {
      for (const [k, v] of Object.entries(pkg.node_device_limits)) {
        deviceLimits[Number(k)] = v
      }
    }
    setFormData({
      id: pkg.id,
      name: pkg.name,
      description: pkg.description || '',
      traffic_limit_gb: pkg.traffic_limit_gb,
      cycle_days: pkg.cycle_days,
      nodes: pkg.nodes || [],
      node_multipliers: mults,
      node_speed_limits: speedLimits,
      node_device_limits: deviceLimits,
      speed_limit_mbps: pkg.speed_limit_mbps || 0,
      device_limit: pkg.device_limit || 0,
      traffic_mode: pkg.traffic_mode || 'oneway',
      template_filename: pkg.template_filename || '',
    })
  }

  const handleDelete = (id: number, name: string) => {
    if (confirm(t('dialog.confirmDelete', { name }))) {
      deleteMutation.mutate(id)
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    if (!formData.name) {
      toast.error(t('toast.nameRequired'))
      return
    }

    if (formData.traffic_limit_gb <= 0) {
      toast.error(t('toast.trafficPositive'))
      return
    }

    if (formData.cycle_days <= 0) {
      toast.error(t('toast.cyclePositive'))
      return
    }

    const hasExternalNode = formData.nodes.length > 0 && formData.nodes.some((id) => {
      const node = nodes.find((n: any) => n.id === id)
      return node && !node.inbound_tag
    })
    if (hasExternalNode) {
      toast.warning(t('toast.externalNodeWarning'))
    }

    if (editingPackage) {
      updateMutation.mutate(formData)
    } else {
      createMutation.mutate(formData)
    }
  }

  const packages = packagesData?.packages || []

  // 套餐模板 filename → 显示名;不在列表里时退回 filename
  const templateLabel = (filename: string | undefined): string => {
    if (!filename) return t('card.templateDefault', { defaultValue: '系统默认' })
    const found = ruleTemplates.find((rt) => rt.filename === filename)
    return found?.name || filename
  }

  // 节点 id → 套餐对该节点的实际限速值(显示用):pkg.node_speed_limits[id] ?? pkg.speed_limit_mbps
  const nodeSpeedFor = (pkg: PackageTemplate, nodeId: number): number => {
    const map = pkg.node_speed_limits || {}
    const k = String(nodeId)
    if (k in map) return Number(map[k])
    return pkg.speed_limit_mbps || 0
  }
  const nodeDeviceFor = (pkg: PackageTemplate, nodeId: number): number => {
    const map = pkg.node_device_limits || {}
    const k = String(nodeId)
    if (k in map) return Number(map[k])
    return pkg.device_limit || 0
  }
  // 该套餐有多少个节点单独设置了 per-node 限速 / 客户端数
  const perNodeCount = (pkg: PackageTemplate): number => {
    const a = Object.keys(pkg.node_speed_limits || {}).length
    const b = Object.keys(pkg.node_device_limits || {}).length
    return Math.max(a, b)
  }
  const fmtSpeed = (v: number): string => (v > 0 ? `${v} Mbps` : t('card.unlimited', { defaultValue: '不限速' }))
  const fmtDevice = (v: number): string => (v > 0 ? String(v) : t('card.unlimited', { defaultValue: '不限' }))

  // 节点列表 tooltip 内容(节点名 + per-node 限速/客户端数;若该节点有套餐覆盖则高亮显示)
  const renderNodeTooltip = (pkg: PackageTemplate) => {
    const nodeIds = pkg.nodes || []
    if (nodeIds.length === 0) {
      return <div className="text-xs">{t('card.allNodes', { defaultValue: '不选 = 套餐可使用所有节点' })}</div>
    }
    return (
      <div className="space-y-1 max-h-[60vh] overflow-y-auto">
        {nodeIds.map((id) => {
          const n = nodeMap.get(id)
          // 后端 List/GetPackage 已经静默过滤孤儿 id 了,正常不会走到 fallback;
          // 兜底文案:节点真删了 / 加载竞态 → 明确显示"已删除"提示而不是 "node-272" 这种迷惑文案
          const name = n?.node_name || t('card.deletedNode', { id, defaultValue: `(已删除 #${id})` })
          const speed = nodeSpeedFor(pkg, id)
          const device = nodeDeviceFor(pkg, id)
          const speedKey = String(id)
          const hasSpeedOverride = pkg.node_speed_limits && speedKey in pkg.node_speed_limits
          const hasDeviceOverride = pkg.node_device_limits && speedKey in pkg.node_device_limits
          return (
            <div key={id} className="flex items-center justify-between gap-3 text-[11px] py-0.5">
              <span className="truncate max-w-[200px]">{name}</span>
              <span className="flex items-center gap-1.5 shrink-0 tabular-nums">
                <span className={hasSpeedOverride ? 'text-primary font-medium' : 'text-muted-foreground'}>
                  ↓ {fmtSpeed(speed)}
                </span>
                <span className="text-muted-foreground">|</span>
                <span className={hasDeviceOverride ? 'text-primary font-medium' : 'text-muted-foreground'}>
                  {fmtDevice(device)}
                </span>
              </span>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="container mx-auto py-8 px-4 pt-24">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold mb-2">{t('page.title')}</h1>
          <p className="text-gray-600">
            {t('page.description')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!isMobile && (
            <ViewToggle view={viewMode} onViewChange={(v) => { setViewMode(v); localStorage.setItem('packages-view-mode', v) }} />
          )}
          <Button onClick={handleCreate}>
            <Plus className="h-4 w-4 mr-2" />
            {t('buttons.createTemplate')}
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="text-center py-8">
          <RefreshCw className="h-8 w-8 animate-spin mx-auto mb-2" />
          <p className="text-gray-600">{t('actions.loading', { ns: 'common' })}</p>
        </div>
      ) : packages.length === 0 ? (
        <EmptyStateCard
          icon={<Package className="h-12 w-12 text-gray-400" />}
          title={t('empty.title')}
          actions={(
            <Button onClick={handleCreate}>
              <Plus className="h-4 w-4 mr-2" />
              {t('empty.createFirst')}
            </Button>
          )}
        />
      ) : viewMode === 'card' ? (
        <TooltipProvider delayDuration={150}>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {packages.map((pkg: PackageTemplate) => {
              const perNode = perNodeCount(pkg)
              const nodeCount = pkg.nodes?.length || 0
              return (
                <Card key={pkg.id}>
                  <CardHeader>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <CardTitle className="text-lg truncate">
                          {pkg.name}
                        </CardTitle>
                        {pkg.description && (
                          <CardDescription className="mt-1 line-clamp-2">
                            {pkg.description}
                          </CardDescription>
                        )}
                      </div>
                      <Badge variant="secondary" className="shrink-0">{pkg.traffic_limit_gb} GB</Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2.5 text-sm">
                    {/* 流量周期 + 流量统计方式同一行 */}
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">{t('card.cycleDays')}</span>
                      <span className="font-medium">{t('card.cycleDaysValue', { days: pkg.cycle_days })}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground flex items-center gap-1.5">
                        {pkg.traffic_mode === 'twoway' ? <ArrowLeftRight className="h-3.5 w-3.5" /> : <ArrowRight className="h-3.5 w-3.5" />}
                        {t('card.trafficMode', { defaultValue: '流量统计' })}
                      </span>
                      <span className="font-medium">
                        {pkg.traffic_mode === 'twoway'
                          ? t('card.twowayLabel', { defaultValue: '双向 ×2' })
                          : t('card.onewayLabel', { defaultValue: '单向' })}
                      </span>
                    </div>
                    {/* 套餐模板 */}
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground flex items-center gap-1.5">
                        <FileText className="h-3.5 w-3.5" />
                        {t('card.template', { defaultValue: '订阅模板' })}
                      </span>
                      <span className="font-medium truncate max-w-[160px]">{templateLabel(pkg.template_filename)}</span>
                    </div>
                    {/* 限速配置 */}
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground flex items-center gap-1.5">
                        <Gauge className="h-3.5 w-3.5" />
                        {t('card.limits', { defaultValue: '限速配置' })}
                      </span>
                      <span className="font-medium flex items-center gap-1.5">
                        {fmtSpeed(pkg.speed_limit_mbps)} · {pkg.device_limit > 0 ? t('card.deviceN', { n: pkg.device_limit, defaultValue: `${pkg.device_limit} 设备` }) : t('card.deviceUnlimited', { defaultValue: '设备不限' })}
                        {perNode > 0 && (
                          <Badge variant="outline" className="text-[10px] px-1 py-0 border-primary text-primary">
                            {t('card.perNodeOverride', { count: perNode, defaultValue: `${perNode} 节点单独配置` })}
                          </Badge>
                        )}
                      </span>
                    </div>
                    {/* 节点数(hover tooltip) */}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="flex items-center justify-between cursor-help">
                          <span className="text-muted-foreground flex items-center gap-1.5">
                            <Network className="h-3.5 w-3.5" />
                            {t('card.nodeCount', { defaultValue: '关联节点' })}
                          </span>
                          <span className="font-medium flex items-center gap-1">
                            {nodeCount > 0 ? nodeCount : t('card.allNodes', { defaultValue: '全部节点' })}
                            <InfoIcon className="h-3 w-3 text-muted-foreground/60" />
                          </span>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="left" className="max-w-md p-3">
                        {renderNodeTooltip(pkg)}
                      </TooltipContent>
                    </Tooltip>
                  </CardContent>
                  <CardFooter className="flex gap-2 flex-wrap">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleEdit(pkg)}
                    >
                      <Edit2 className="h-4 w-4 mr-1" />
                      {t('actions.edit', { ns: 'common' })}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleDelete(pkg.id, pkg.name)}
                      className="text-red-600 hover:text-red-700"
                    >
                      <Trash2 className="h-4 w-4 mr-1" />
                      {t('actions.delete', { ns: 'common' })}
                    </Button>
                  </CardFooter>
                </Card>
              )
            })}
          </div>
        </TooltipProvider>
      ) : (
        // 列表视图
        <TooltipProvider delayDuration={150}>
          <div className="border rounded-md overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('list.name', { defaultValue: '套餐名' })}</TableHead>
                  <TableHead className="text-right">{t('list.traffic', { defaultValue: '流量' })}</TableHead>
                  <TableHead className="text-right">{t('list.cycle', { defaultValue: '周期' })}</TableHead>
                  <TableHead>{t('list.mode', { defaultValue: '统计' })}</TableHead>
                  <TableHead>{t('list.template', { defaultValue: '模板' })}</TableHead>
                  <TableHead>{t('list.limits', { defaultValue: '限速' })}</TableHead>
                  <TableHead className="text-right">{t('list.nodes', { defaultValue: '节点' })}</TableHead>
                  <TableHead className="text-right">{t('list.actions', { defaultValue: '操作' })}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {packages.map((pkg: PackageTemplate) => {
                  const perNode = perNodeCount(pkg)
                  const nodeCount = pkg.nodes?.length || 0
                  return (
                    <TableRow key={pkg.id}>
                      <TableCell>
                        <div className="font-medium">{pkg.name}</div>
                        {pkg.description && (
                          <div className="text-xs text-muted-foreground line-clamp-1">{pkg.description}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{pkg.traffic_limit_gb} GB</TableCell>
                      <TableCell className="text-right tabular-nums">{pkg.cycle_days} {t('list.daysUnit', { defaultValue: '天' })}</TableCell>
                      <TableCell>
                        {pkg.traffic_mode === 'twoway'
                          ? t('card.twowayLabel', { defaultValue: '双向 ×2' })
                          : t('card.onewayLabel', { defaultValue: '单向' })}
                      </TableCell>
                      <TableCell className="text-xs truncate max-w-[140px]">{templateLabel(pkg.template_filename)}</TableCell>
                      <TableCell className="text-xs">
                        <div>{fmtSpeed(pkg.speed_limit_mbps)}</div>
                        <div className="text-muted-foreground">
                          {pkg.device_limit > 0 ? t('card.deviceN', { n: pkg.device_limit, defaultValue: `${pkg.device_limit} 设备` }) : t('card.deviceUnlimited', { defaultValue: '设备不限' })}
                          {perNode > 0 && <span className="ml-1 text-primary">· {t('card.perNodeOverride', { count: perNode, defaultValue: `${perNode} 单独` })}</span>}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-flex items-center gap-1 cursor-help">
                              <Network className="h-3.5 w-3.5 text-muted-foreground" />
                              <span className="tabular-nums">{nodeCount > 0 ? nodeCount : '∞'}</span>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="left" className="max-w-md p-3">
                            {renderNodeTooltip(pkg)}
                          </TooltipContent>
                        </Tooltip>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => handleEdit(pkg)} title={t('actions.edit', { ns: 'common' })}>
                            <Edit2 className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="icon" variant="ghost" className="h-7 w-7 text-red-600 hover:text-red-700" onClick={() => handleDelete(pkg.id, pkg.name)} title={t('actions.delete', { ns: 'common' })}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </TooltipProvider>
      )}

      {/* Create/Edit Dialog */}
      <Dialog
        open={isCreateDialogOpen || !!editingPackage}
        onOpenChange={(open) => {
          if (!open) {
            setIsCreateDialogOpen(false)
            setEditingPackage(null)
            resetForm()
          }
        }}
      >
        <DialogContent className="w-[95vw] max-w-[95vw] sm:max-w-3xl md:max-w-5xl lg:max-w-6xl max-h-[90vh] flex flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>{editingPackage ? t('dialog.editTitle') : t('dialog.createTitle')}</DialogTitle>
            <DialogDescription>
              {editingPackage ? t('dialog.editDesc') : t('dialog.createDesc')}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="flex-1 flex flex-col overflow-hidden">
            {/* 桌面端左右两栏:左侧表单字段,右侧关联节点;移动端堆叠 */}
            <div className="flex-1 overflow-y-auto md:overflow-hidden grid grid-cols-1 md:grid-cols-2 gap-6 py-4 md:py-2 md:min-h-0">
              {/* 左栏:基础字段 */}
              <div className="space-y-4 md:overflow-y-auto md:pr-2">
              <div className="space-y-2">
                <Label htmlFor="name">{t('dialog.name')}</Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder={t('dialog.namePlaceholder')}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">{t('dialog.description')}</Label>
                <Textarea
                  id="description"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder={t('dialog.descriptionPlaceholder')}
                  rows={2}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="traffic_limit_gb">{t('dialog.trafficLimit')}</Label>
                <Input
                  id="traffic_limit_gb"
                  type="number"
                  min="1"
                  step="0.1"
                  value={formData.traffic_limit_gb}
                  onChange={(e) => setFormData({ ...formData, traffic_limit_gb: parseFloat(e.target.value) })}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label>{t('dialog.trafficMode')}</Label>
                <Select
                  value={formData.traffic_mode}
                  onValueChange={(value) => setFormData({ ...formData, traffic_mode: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="oneway">{t('dialog.trafficModeOneway')}</SelectItem>
                    <SelectItem value="twoway">{t('dialog.trafficModeTwoway')}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{t('dialog.trafficModeDesc')}</p>
              </div>

              <div className="space-y-2">
                <Label>{t('dialog.templateFilename')}</Label>
                <Select
                  value={formData.template_filename === '' ? TEMPLATE_DEFAULT_SENTINEL : formData.template_filename}
                  onValueChange={(value) =>
                    setFormData({
                      ...formData,
                      template_filename: value === TEMPLATE_DEFAULT_SENTINEL ? '' : value,
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={TEMPLATE_DEFAULT_SENTINEL}>
                      {t('dialog.templateFilenameDefault')}
                    </SelectItem>
                    {ruleTemplates.map((tpl) => (
                      <SelectItem key={tpl.filename} value={tpl.filename}>
                        {tpl.name} ({tpl.filename})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{t('dialog.templateFilenameDesc')}</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="cycle_days">{t('dialog.cycleDays')}</Label>
                <Input
                  id="cycle_days"
                  type="number"
                  min="1"
                  value={formData.cycle_days}
                  onChange={(e) => setFormData({ ...formData, cycle_days: parseInt(e.target.value) })}
                  required
                />
              </div>

              <ProFeatureGate feature="limiter" className="mt-3 mr-2">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="speed_limit_mbps">{t('dialog.speedLimit')}</Label>
                  <Input
                    id="speed_limit_mbps"
                    type="number"
                    min="0"
                    step="1"
                    value={formData.speed_limit_mbps}
                    onChange={(e) => setFormData({ ...formData, speed_limit_mbps: parseFloat(e.target.value) || 0 })}
                    placeholder={t('dialog.speedLimitPlaceholder')}
                  />
                  <p className="text-xs text-muted-foreground">{t('dialog.speedLimitDesc')}</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="device_limit">{t('dialog.deviceLimit')}</Label>
                  <Input
                    id="device_limit"
                    type="number"
                    min="0"
                    step="1"
                    value={formData.device_limit}
                    onChange={(e) => setFormData({ ...formData, device_limit: parseInt(e.target.value) || 0 })}
                    placeholder={t('dialog.deviceLimitPlaceholder')}
                  />
                  <p className="text-xs text-muted-foreground">{t('dialog.deviceLimitDesc')}</p>
                </div>
              </div>
              </ProFeatureGate>

              </div>

              {/* 右栏:关联节点(桌面端撑满高度,自身滚动;移动端跟左栏堆叠) */}
              <div className="space-y-2 flex flex-col md:overflow-hidden md:min-h-0">
                <div className="flex items-center justify-between gap-2">
                  <Label>{t('dialog.relatedNodes')}</Label>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {formData.nodes.length}/{nodes.length}
                  </span>
                </div>
                {nodes.length === 0 ? (
                  <div className="border rounded-md p-6 text-sm text-muted-foreground text-center">
                    {t('dialog.noNodes')}
                  </div>
                ) : (
                  <div className="border rounded-md overflow-y-auto flex-1 max-h-72 md:max-h-none bg-card">
                    {/* 表头:桌面端显示;mobile 改卡片渲染,无表头 */}
                    {!isMobile && (
                      <div className="sticky top-0 z-10 flex items-center gap-2 pl-2.5 pr-2 py-1.5 bg-muted/60 backdrop-blur-sm border-b text-[11px] font-medium text-muted-foreground">
                        <div className="w-4 shrink-0" />
                        <span className="flex-1">{t('dialog.nodeColumnName', { defaultValue: '节点' })}</span>
                        <span className="shrink-0 w-[72px] text-center">{t('dialog.nodeMultiplierHeader', { defaultValue: '流量倍率' })}</span>
                        <span className="shrink-0 w-[88px] text-center">{t('dialog.nodeSpeedLimitHeader', { defaultValue: '限速 Mbps' })}</span>
                        <span className="shrink-0 w-[72px] text-center">{t('dialog.nodeDeviceLimitHeader', { defaultValue: '客户端数' })}</span>
                      </div>
                    )}
                    <div className="divide-y">
                    {nodes.map((node: any) => {
                      const isInternal = Boolean(node.inbound_tag)
                      const isChecked = formData.nodes.includes(node.id)
                      const multiplier = formData.node_multipliers[node.id] ?? 1
                      // 点击卡片(mobile)/ checkbox 切换勾选,共用同一逻辑
                      const toggleChecked = (next: boolean) => {
                        if (next) {
                          setFormData({ ...formData, nodes: [...formData.nodes, node.id] })
                        } else {
                          const nextMults = { ...formData.node_multipliers }
                          const nextSpeed = { ...formData.node_speed_limits }
                          const nextDevice = { ...formData.node_device_limits }
                          delete nextMults[node.id]
                          delete nextSpeed[node.id]
                          delete nextDevice[node.id]
                          setFormData({
                            ...formData,
                            nodes: formData.nodes.filter((id) => id !== node.id),
                            node_multipliers: nextMults,
                            node_speed_limits: nextSpeed,
                            node_device_limits: nextDevice,
                          })
                        }
                      }
                      return (
                        <div
                          key={node.id}
                          className={`${
                            isMobile
                              ? `flex flex-col gap-2 p-3 ${isChecked ? 'ring-2 ring-primary ring-inset' : ''}`
                              : 'flex items-center gap-2 pl-2.5 pr-2 py-2'
                          } border-l-2 transition-colors ${
                            isChecked
                              ? 'border-l-primary bg-primary/5'
                              : 'border-l-transparent hover:bg-muted/40'
                          }`}
                        >
                          {/* mobile: 无 checkbox,整卡点击切换;desktop: checkbox + label */}
                          {!isMobile && (
                            <Checkbox
                              id={`node-${node.id}`}
                              checked={isChecked}
                              onCheckedChange={(c) => toggleChecked(Boolean(c))}
                              className='shrink-0'
                            />
                          )}
                          {isMobile ? (
                            /* mobile 头部点击区:点节点名/badge 区切勾选;数字框区在外面,自己不冒泡 */
                            <div
                              onClick={() => toggleChecked(!isChecked)}
                              className='flex items-center gap-1.5 flex-wrap min-w-0 cursor-pointer'
                            >
                              <Badge
                                variant={isInternal ? 'default' : 'outline'}
                                className={`text-[10px] px-1 py-0 shrink-0 ${
                                  isInternal ? '' : 'border-amber-500 text-amber-600 dark:text-amber-400'
                                }`}
                              >
                                {isInternal ? t('dialog.nodeInternal') : t('dialog.nodeExternal')}
                              </Badge>
                              {node.tag && (
                                <Badge variant='secondary' className='text-[10px] px-1 py-0 shrink-0'>
                                  {node.tag}
                                </Badge>
                              )}
                              <span className='font-medium text-sm truncate flex-1 min-w-0'>{node.node_name}</span>
                              {isChecked && <span className='text-[10px] text-primary font-semibold shrink-0'>✓ {t('dialog.nodeSelected', { defaultValue: '已选' })}</span>}
                            </div>
                          ) : (
                            <Label
                              htmlFor={`node-${node.id}`}
                              className='cursor-pointer flex items-center gap-1.5 min-w-0 text-sm font-normal flex-1'
                            >
                              <Badge
                                variant={isInternal ? 'default' : 'outline'}
                                className={`text-[10px] px-1 py-0 shrink-0 ${
                                  isInternal ? '' : 'border-amber-500 text-amber-600 dark:text-amber-400'
                                }`}
                              >
                                {isInternal ? t('dialog.nodeInternal') : t('dialog.nodeExternal')}
                              </Badge>
                              <span className='truncate'>{node.node_name}</span>
                            </Label>
                          )}
                          {/* 倍率列 — mobile: 上方 label + 全宽 input;桌面: 固定 72px 跟表头对齐 */}
                          <div className={`${isMobile ? 'flex flex-col gap-1 basis-[calc(33%-0.5rem)] grow' : 'flex items-center justify-end gap-0.5 shrink-0 w-[72px]'}`}>
                            {isMobile && (
                              <Label className='text-[10px] text-muted-foreground'>{t('dialog.nodeMultiplierHeader', { defaultValue: '流量倍率' })}</Label>
                            )}
                            {isChecked ? (
                              <div className='flex items-center gap-0.5'>
                                <Input
                                  type="number"
                                  step="0.1"
                                  min="0"
                                  max="99"
                                  value={multiplier}
                                  onChange={(e) => {
                                    const v = parseFloat(e.target.value)
                                    const nextMults = { ...formData.node_multipliers }
                                    if (!Number.isFinite(v) || v === 1) {
                                      delete nextMults[node.id]
                                    } else {
                                      nextMults[node.id] = v
                                    }
                                    setFormData({ ...formData, node_multipliers: nextMults })
                                  }}
                                  className={`no-spin h-7 px-1.5 text-xs text-right tabular-nums ${isMobile ? 'flex-1 w-full' : 'w-12'}`}
                                  aria-label={t('dialog.nodeMultiplier', { defaultValue: '流量倍率' })}
                                />
                                <span className="text-sm font-semibold text-primary leading-none select-none">×</span>
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground/50">—</span>
                            )}
                          </div>
                          {/* per-node 限速 — mobile: label+全宽 input;桌面: 固定 88px;占位符 = 套餐通用值 */}
                          <div className={`${isMobile ? 'flex flex-col gap-1 basis-[calc(33%-0.5rem)] grow' : 'flex items-center justify-end gap-0.5 shrink-0 w-[88px]'}`}>
                            {isMobile && (
                              <Label className='text-[10px] text-muted-foreground'>{t('dialog.nodeSpeedLimitHeader', { defaultValue: '限速 Mbps' })}</Label>
                            )}
                            {isChecked ? (
                              <Input
                                type="number"
                                step="1"
                                min="0"
                                value={formData.node_speed_limits[node.id] ?? ''}
                                placeholder={formData.speed_limit_mbps > 0 ? String(formData.speed_limit_mbps) : '∞'}
                                onChange={(e) => {
                                  const raw = e.target.value
                                  const nextSpeed = { ...formData.node_speed_limits }
                                  if (raw === '') {
                                    delete nextSpeed[node.id]
                                  } else {
                                    const v = parseFloat(raw)
                                    if (Number.isFinite(v) && v >= 0) {
                                      nextSpeed[node.id] = v
                                    }
                                  }
                                  setFormData({ ...formData, node_speed_limits: nextSpeed })
                                }}
                                className={`no-spin h-7 px-1.5 text-xs text-right tabular-nums ${isMobile ? 'w-full' : 'w-[72px]'}`}
                                aria-label={t('dialog.nodeSpeedLimit', { defaultValue: '节点限速 (Mbps)' })}
                              />
                            ) : (
                              <span className="text-xs text-muted-foreground/50">—</span>
                            )}
                          </div>
                          {/* per-node 客户端数 — mobile: label+全宽 input;桌面: 固定 72px */}
                          <div className={`${isMobile ? 'flex flex-col gap-1 basis-[calc(33%-0.5rem)] grow' : 'flex items-center justify-end gap-0.5 shrink-0 w-[72px]'}`}>
                            {isMobile && (
                              <Label className='text-[10px] text-muted-foreground'>{t('dialog.nodeDeviceLimitHeader', { defaultValue: '客户端数' })}</Label>
                            )}
                            {isChecked ? (
                              <Input
                                type="number"
                                step="1"
                                min="0"
                                value={formData.node_device_limits[node.id] ?? ''}
                                placeholder={formData.device_limit > 0 ? String(formData.device_limit) : '∞'}
                                onChange={(e) => {
                                  const raw = e.target.value
                                  const nextDevice = { ...formData.node_device_limits }
                                  if (raw === '') {
                                    delete nextDevice[node.id]
                                  } else {
                                    const v = parseInt(raw, 10)
                                    if (Number.isFinite(v) && v >= 0) {
                                      nextDevice[node.id] = v
                                    }
                                  }
                                  setFormData({ ...formData, node_device_limits: nextDevice })
                                }}
                                className={`no-spin h-7 px-1.5 text-xs text-right tabular-nums ${isMobile ? 'w-full' : 'w-[56px]'}`}
                                aria-label={t('dialog.nodeDeviceLimit', { defaultValue: '节点客户端数' })}
                              />
                            ) : (
                              <span className="text-xs text-muted-foreground/50">—</span>
                            )}
                          </div>
                        </div>
                      )
                    })}
                    </div>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  {t('dialog.nodesHint')}
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setIsCreateDialogOpen(false)
                  setEditingPackage(null)
                  resetForm()
                }}
              >
                {t('actions.cancel', { ns: 'common' })}
              </Button>
              <Button
                type="submit"
                disabled={createMutation.isPending || updateMutation.isPending}
              >
                {(createMutation.isPending || updateMutation.isPending) ? t('dialog.saving') : t('actions.save', { ns: 'common' })}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
