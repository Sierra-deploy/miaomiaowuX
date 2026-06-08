// @ts-nocheck
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Edit2, RefreshCw, Trash2, Eye, Plus, AlertTriangle, ArrowRight } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'

import { InboundWizard } from '@/components/xray/inbound-wizard'
import { Button } from '@/components/ui/button'
import {
  Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle,
} from '@/components/ui/card'
import { EmptyStateCard } from '@/components/ui/empty-state'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { api } from '@/lib/api'
import { handleServerError } from '@/lib/handle-server-error'
import { ArrayField } from '@/components/xray/array-field'
import { clientFields } from '@/lib/xray-form-fields'
import type { XrayInbound } from '@/lib/xray-presets'

interface InboundItem {
  server_id: number
  server_name: string
  inbound: XrayInbound
}

interface InboundPanelProps {
  serverId: number
  serverName: string
  federationPrefix?: string
}

export function InboundPanel({ serverId, serverName, federationPrefix }: InboundPanelProps) {
  const { t } = useTranslation('xray')
  const { t: tc } = useTranslation('common')
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const [editingInbound, setEditingInbound] = useState<InboundItem | null>(null)
  const [viewingInbound, setViewingInbound] = useState<XrayInbound | null>(null)
  const [editedUsers, setEditedUsers] = useState<any[]>([])
  const [isWizardDialogOpen, setIsWizardDialogOpen] = useState(false)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [deletingInbound, setDeletingInbound] = useState<InboundItem | null>(null)

  const { data: inboundsData, isLoading } = useQuery({
    queryKey: ['remote-inbounds', serverId, serverName],
    queryFn: async () => {
      const response = await api.get(`/api/admin/remote/inbounds?server_id=${serverId}`)
      const inbounds = response.data.inbounds || []
      return {
        success: true,
        inbounds: inbounds.map((inbound: any) => ({
          server_id: serverId,
          server_name: serverName,
          inbound,
        })),
      }
    },
  })

  const remoteUpdateInboundMutation = useMutation({
    mutationFn: async ({ inbound }: { inbound: XrayInbound }) => {
      await api.post(`/api/admin/remote/inbounds?server_id=${serverId}`, {
        action: 'remove', tag: inbound.tag,
      })
      const response = await api.post(`/api/admin/remote/inbounds?server_id=${serverId}`, {
        action: 'add', inbound,
      })
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['remote-inbounds', serverId] })
      toast.success(t('inbounds.inboundUpdated'))
      setEditingInbound(null)
    },
    onError: handleServerError,
  })

  const remoteDeleteMutation = useMutation({
    mutationFn: async ({ inbound }: { inbound: XrayInbound }) => {
      const response = await api.post(`/api/admin/remote/inbounds?server_id=${serverId}`, {
        action: 'remove', tag: inbound.tag,
      })
      return response.data
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['remote-inbounds', serverId] })
      data.success ? toast.success(data.message || t('inbounds.inboundDeleted')) : toast.error(data.message || t('inbounds.inboundDeleteFailed'))
    },
    onError: handleServerError,
  })

  const remoteAddInboundMutation = useMutation({
    mutationFn: async ({ inbound }: { inbound: XrayInbound }) => {
      const response = await api.post(`/api/admin/remote/inbounds?server_id=${serverId}`, {
        action: 'add', inbound,
      })
      return response.data
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['remote-inbounds', serverId] })
      data.success ? toast.success(data.message || t('inbounds.inboundAdded')) : toast.error(data.message || t('inbounds.inboundAddFailed'))
    },
    onError: handleServerError,
  })

  const handleEdit = (item: InboundItem) => {
    setEditingInbound(item)
    const inbound = item.inbound
    let users = []
    if (inbound.settings?.clients) users = inbound.settings.clients
    else if (inbound.settings?.accounts) users = inbound.settings.accounts
    setEditedUsers(users)
  }

  const handleDelete = (item: InboundItem) => {
    setDeletingInbound(item)
    setIsDeleteDialogOpen(true)
  }

  const confirmDelete = () => {
    if (deletingInbound) remoteDeleteMutation.mutate({ inbound: deletingInbound.inbound })
    setIsDeleteDialogOpen(false)
    setDeletingInbound(null)
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!editingInbound) return
    const inbound = editingInbound.inbound
    const updatedSettings = { ...inbound.settings }
    if (inbound.settings?.clients) updatedSettings.clients = editedUsers
    else if (inbound.settings?.accounts) updatedSettings.accounts = editedUsers
    remoteUpdateInboundMutation.mutate({ inbound: { ...inbound, settings: updatedSettings } })
  }

  const handleInboundSubmit = async (serverIds: number[], inbound: XrayInbound, tag: string) => {
    let trimmedTag = tag?.trim() || inbound.tag || ''
    if (!trimmedTag) { toast.error(t('inbounds.fillTag')); return }
    // 分享服务器:统一加前缀,避免与拥有方已有入站 tag 冲突
    if (federationPrefix && !trimmedTag.startsWith(federationPrefix)) {
      trimmedTag = federationPrefix + trimmedTag
    }
    try {
      await remoteAddInboundMutation.mutateAsync({ inbound: { ...inbound, tag: trimmedTag } })
      toast.success(t('inbounds.inboundAddedToRemote'))
      setIsWizardDialogOpen(false)
    } catch {}
  }

  const inbounds = inboundsData?.inbounds || []
  const filteredInbounds = useMemo(() => inbounds.filter((item: InboundItem) => item.inbound.tag !== 'api'), [inbounds])
  const usedPorts = useMemo(() => inbounds.map((item: InboundItem) => Number(item.inbound.port)).filter(Boolean), [inbounds])

  const getUserCount = (inbound: XrayInbound) => {
    if (Array.isArray(inbound.settings?.clients)) return inbound.settings.clients.length
    if (Array.isArray(inbound.settings?.accounts)) return inbound.settings.accounts.length
    return 0
  }

  const getUserFields = (protocol: string) => {
    const protocolKey = protocol === 'shadowsocks' ? 'Shadowsocks2022' :
      protocol === 'socks' ? 'Socks5' : protocol === 'http' ? 'HTTP' :
      protocol === 'tunnel' ? 'Dokodemo' : protocol === 'hysteria' ? 'Hysteria2' :
      protocol.charAt(0).toUpperCase() + protocol.slice(1)
    return clientFields[protocolKey] || []
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {t('inbounds.configCount', { name: serverName, count: filteredInbounds.length })}
        </p>
        <Button size="sm" onClick={() => setIsWizardDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-1" />{t('inbounds.addInbound')}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground rounded-md border border-dashed px-3 py-2">
        提示：入站随节点联动管理。删除入站对应的节点后，入站会自动删除。
      </p>

      {isLoading ? (
        <div className="text-center py-8">
          <RefreshCw className="h-6 w-6 animate-spin mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">{tc('actions.loading')}</p>
        </div>
      ) : filteredInbounds.length === 0 ? (
        <EmptyStateCard title={t('inbounds.noInbounds')} description={t('inbounds.noInboundsDescShort')} />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
          {filteredInbounds.map((item: InboundItem) => (
            <Card key={`${item.server_id}-${item.inbound.tag}`}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base truncate">{item.inbound.tag}</CardTitle>
                  <Badge variant="secondary" className="text-xs">{item.inbound.protocol}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-1.5 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">{t('inbounds.portLabel')}</span><span>{item.inbound.port}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t('inbounds.userCount')}</span><span>{getUserCount(item.inbound)}</span></div>
                {item.inbound.listen && <div className="flex justify-between"><span className="text-muted-foreground">{t('inbounds.listenAddress')}</span><span>{item.inbound.listen}</span></div>}
              </CardContent>
              <CardFooter className="flex gap-1.5 pt-2">
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setViewingInbound(item.inbound)}><Eye className="h-3 w-3 mr-1" />{tc('actions.view')}</Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      {/* Edit Dialog */}
      <Dialog open={!!editingInbound} onOpenChange={(open) => !open && setEditingInbound(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('inbounds.editInbound')} - {editingInbound?.inbound.tag}</DialogTitle>
            <DialogDescription>{t('inbounds.editInboundUsers')}</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit}>
            <div className="space-y-4 py-4">
              <div className="space-y-2"><label className="text-sm font-medium">{t('inbounds.protocolLabel')}</label><div className="text-sm text-muted-foreground">{editingInbound?.inbound.protocol}</div></div>
              <div className="space-y-2"><label className="text-sm font-medium">{t('inbounds.portLabel')}</label><div className="text-sm text-muted-foreground">{editingInbound?.inbound.port}</div></div>
              {editingInbound && (
                <ArrayField
                  label={editingInbound.inbound.protocol === 'socks' || editingInbound.inbound.protocol === 'http' ? t('inbounds.accounts') : t('inbounds.users')}
                  fields={getUserFields(editingInbound.inbound.protocol)}
                  values={editedUsers}
                  onChange={setEditedUsers}
                  addButtonText={editingInbound.inbound.protocol === 'socks' || editingInbound.inbound.protocol === 'http' ? t('inbounds.addAccount') : t('inbounds.addUser')}
                  showUserSelect={true}
                  required
                />
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditingInbound(null)}>{tc('actions.cancel')}</Button>
              <Button type="submit" disabled={remoteUpdateInboundMutation.isPending}>{remoteUpdateInboundMutation.isPending ? tc('actions.saving') : tc('actions.save')}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* View Dialog */}
      <Dialog open={!!viewingInbound} onOpenChange={(open) => !open && setViewingInbound(null)}>
        <DialogContent className="max-w-3xl max-h-[90vh]">
          <DialogHeader>
            <DialogTitle>{t('inbounds.viewInbound')} - {viewingInbound?.tag}</DialogTitle>
            <DialogDescription>{t('inbounds.viewInboundJson')}</DialogDescription>
          </DialogHeader>
          <div className="overflow-auto max-h-[60vh]">
            <pre className="bg-gray-50 dark:bg-gray-900 p-4 rounded-lg text-xs">{JSON.stringify(viewingInbound, null, 2)}</pre>
          </div>
          <DialogFooter><Button onClick={() => setViewingInbound(null)}>{tc('actions.close')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Inbound Wizard Dialog */}
      <Dialog open={isWizardDialogOpen} onOpenChange={setIsWizardDialogOpen}>
        <DialogContent className="w-[95vw] !max-w-none md:w-[90vw] lg:w-[80vw] max-h-[90vh] overflow-hidden sm:max-w-none flex flex-col">
          <DialogHeader>
            <DialogTitle>{t('inbounds.addInboundWizard')}</DialogTitle>
            <DialogDescription>{t('inbounds.addInboundWizardDescShort')}</DialogDescription>
          </DialogHeader>
          {/* 废弃提示:此入口不走节点链路(不带节点名/emoji 国旗/倍率),未来会移除。引导用户改走「节点管理 → 添加节点」。*/}
          <div className="shrink-0 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2.5 text-sm">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 mt-0.5" />
              <div className="flex-1 min-w-0 space-y-1">
                <div className="font-medium text-amber-900 dark:text-amber-200">
                  {t('inbounds.addInboundDeprecatedTitle')}
                </div>
                <div className="text-amber-800/90 dark:text-amber-300/90 text-xs leading-relaxed">
                  {t('inbounds.addInboundDeprecatedBody')}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0 h-7 text-xs border-amber-500/60 hover:bg-amber-500/20"
                onClick={() => {
                  setIsWizardDialogOpen(false)
                  navigate({ to: '/nodes' })
                }}
              >
                {t('inbounds.addInboundDeprecatedGo')}
                <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            <InboundWizard servers={[]} selectedServerIds={[serverId]} onCancel={() => setIsWizardDialogOpen(false)} onSubmit={handleInboundSubmit} skipServerSelection={true} usedPorts={usedPorts} />
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('inbounds.confirmDeleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('inbounds.confirmDeleteDesc', { tag: deletingInbound?.inbound.tag })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeletingInbound(null)}>{tc('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="bg-red-600 hover:bg-red-700">{tc('actions.confirmDelete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
