// @ts-nocheck
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Edit2, RefreshCw, Trash2, Plus, Package } from 'lucide-react'

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
  speed_limit_mbps: number
  device_limit: number
  traffic_mode: string
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
  speed_limit_mbps: number
  device_limit: number
  traffic_mode: string
}

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
    speed_limit_mbps: 0,
    device_limit: 0,
    traffic_mode: 'oneway',
  })

  const { data: packagesData, isLoading } = useQuery({
    queryKey: ['packages'],
    queryFn: async () => {
      const response = await api.get('/api/admin/packages')
      return response.data
    },
  })

  const { data: nodesData } = useQuery({
    queryKey: ['nodes'],
    queryFn: async () => {
      const response = await api.get('/api/admin/nodes')
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
      speed_limit_mbps: 0,
      device_limit: 0,
      traffic_mode: 'oneway',
    })
  }

  const handleCreate = () => {
    setIsCreateDialogOpen(true)
    resetForm()
  }

  const handleEdit = (pkg: PackageTemplate) => {
    setEditingPackage(pkg)
    setFormData({
      id: pkg.id,
      name: pkg.name,
      description: pkg.description || '',
      traffic_limit_gb: pkg.traffic_limit_gb,
      cycle_days: pkg.cycle_days,
      nodes: pkg.nodes || [],
      speed_limit_mbps: pkg.speed_limit_mbps || 0,
      device_limit: pkg.device_limit || 0,
      traffic_mode: pkg.traffic_mode || 'oneway',
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

  return (
    <div className="container mx-auto py-8 px-4 pt-24">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold mb-2">{t('page.title')}</h1>
          <p className="text-gray-600">
            {t('page.description')}
          </p>
        </div>
        <Button onClick={handleCreate}>
          <Plus className="h-4 w-4 mr-2" />
          {t('buttons.createTemplate')}
        </Button>
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
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {packages.map((pkg: PackageTemplate) => (
            <Card key={pkg.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <CardTitle className="text-lg truncate">
                      {pkg.name}
                    </CardTitle>
                    {pkg.description && (
                      <CardDescription className="mt-1">
                        {pkg.description}
                      </CardDescription>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {pkg.traffic_mode === 'twoway' && (
                      <Badge variant="outline" className="border-orange-500 text-orange-600 dark:text-orange-400">{t('card.twoway')}</Badge>
                    )}
                    <Badge variant="secondary">{pkg.traffic_limit_gb} GB</Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{t('card.trafficQuota')}</span>
                  <span className="text-sm font-medium">{pkg.traffic_limit_gb} GB</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{t('card.cycleDays')}</span>
                  <span className="text-sm font-medium">{t('card.cycleDaysValue', { days: pkg.cycle_days })}</span>
                </div>
                {(pkg.speed_limit_mbps > 0 || pkg.device_limit > 0) && (
                  <div className="flex items-center gap-3 flex-wrap">
                    {pkg.speed_limit_mbps > 0 && (
                      <div className="flex items-center gap-1">
                        <span className="text-sm text-muted-foreground">{t('card.speedLimit')}</span>
                        <span className="text-sm font-medium">{pkg.speed_limit_mbps} Mbps</span>
                      </div>
                    )}
                    {pkg.device_limit > 0 && (
                      <div className="flex items-center gap-1">
                        <span className="text-sm text-muted-foreground">{t('card.deviceLimit')}</span>
                        <span className="text-sm font-medium">{pkg.device_limit}</span>
                      </div>
                    )}
                  </div>
                )}
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
          ))}
        </div>
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
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingPackage ? t('dialog.editTitle') : t('dialog.createTitle')}</DialogTitle>
            <DialogDescription>
              {editingPackage ? t('dialog.editDesc') : t('dialog.createDesc')}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit}>
            <div className="space-y-4 py-4">
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

              <ProFeatureGate feature="limiter">
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

              <div className="space-y-2">
                <Label>{t('dialog.relatedNodes')}</Label>
                <div className="border rounded-md p-3 max-h-48 overflow-y-auto space-y-2">
                  {nodes.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t('dialog.noNodes')}</p>
                  ) : (
                    nodes.map((node: any) => {
                      const isInternal = Boolean(node.inbound_tag)
                      return (
                        <div key={node.id} className="flex items-center space-x-2">
                          <Checkbox
                            id={`node-${node.id}`}
                            checked={formData.nodes.includes(node.id)}
                            onCheckedChange={(checked) => {
                              if (checked) {
                                setFormData({ ...formData, nodes: [...formData.nodes, node.id] })
                              } else {
                                setFormData({ ...formData, nodes: formData.nodes.filter((id) => id !== node.id) })
                              }
                            }}
                          />
                          <Label htmlFor={`node-${node.id}`} className="cursor-pointer flex-1 flex items-center gap-1.5">
                            <Badge variant={isInternal ? 'default' : 'outline'} className={`text-[10px] px-1 py-0 shrink-0 ${isInternal ? '' : 'border-amber-500 text-amber-600 dark:text-amber-400'}`}>
                              {isInternal ? t('dialog.nodeInternal') : t('dialog.nodeExternal')}
                            </Badge>
                            {node.node_name}
                          </Label>
                        </div>
                      )
                    })
                  )}
                </div>
                <p className="text-xs text-gray-500">
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
