// @ts-nocheck
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Edit2, RefreshCw, Trash2, Eye, Plus, Import, Ban, ArrowRight, Cloud, ChevronDown } from 'lucide-react'

import { NodeSelectDialog } from '@/components/xray/node-select-dialog'
import { WarpModal } from '@/components/xray/warp-modal'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { clashConfigToOutbound } from '@/lib/xray-config-generator'
import { Button } from '@/components/ui/button'
import {
  Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle,
} from '@/components/ui/card'
import { EmptyStateCard } from '@/components/ui/empty-state'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api } from '@/lib/api'
import { handleServerError } from '@/lib/handle-server-error'
import type { XrayOutbound } from '@/lib/xray-presets'

interface OutboundItem {
  server_id: number
  server_name: string
  outbound: XrayOutbound
}

interface OutboundPanelProps {
  serverId: number
  serverName: string
}

export function OutboundPanel({ serverId, serverName }: OutboundPanelProps) {
  const { t } = useTranslation('xray')
  const { t: tc } = useTranslation('common')
  const queryClient = useQueryClient()

  const [editingFreedomOutbound, setEditingFreedomOutbound] = useState<OutboundItem | null>(null)
  const [freedomDomainStrategy, setFreedomDomainStrategy] = useState<string>('AsIs')
  const [viewingOutbound, setViewingOutbound] = useState<XrayOutbound | null>(null)
  const [isNodeSelectOpen, setIsNodeSelectOpen] = useState(false)
  const [isWarpModalOpen, setIsWarpModalOpen] = useState(false)
  // 初始展示默认出站(direct/block 等),按钮文字提示"隐藏默认",点一下才隐藏
  const [hideDefaultOutbounds, setHideDefaultOutbounds] = useState(false)

  const { data: outboundsData, isLoading } = useQuery({
    queryKey: ['remote-outbounds', serverId, serverName],
    queryFn: async () => {
      const response = await api.get(`/api/admin/remote/outbounds?server_id=${serverId}`)
      const outbounds = response.data.outbounds || []
      return {
        success: true,
        outbounds: outbounds.map((outbound: any) => ({
          server_id: serverId,
          server_name: serverName,
          outbound,
        })),
      }
    },
  })

  // 共享 nodes query(routing-panel 也用同 key,react-query 自动 dedup)。
  // 用于识别 outbound 是否被妙妙屋X路由出站功能引用 → 卡片打标 + 禁用删除。
  const { data: nodesData } = useQuery({
    queryKey: ['nodes'],
    queryFn: async () => (await api.get('/api/admin/nodes')).data as { nodes: any[] },
  })
  const mmwxRoutedTags = useMemo(() => {
    const set = new Set<string>()
    for (const n of nodesData?.nodes || []) {
      if (n.node_type === 'routed' && n.routed_outbound_tag) {
        set.add(n.routed_outbound_tag)
      }
    }
    return set
  }, [nodesData])
  const isMmwxManagedOutbound = (tag: string | undefined) => !!tag && mmwxRoutedTags.has(tag)

  const remoteUpdateOutboundMutation = useMutation({
    mutationFn: async ({ outbound }: { outbound: XrayOutbound }) => {
      // 优先尝试 agent 新加的 `update` 动作:持久化时原位置替换,前端列表不被甩到末尾。
      // 老版本 agent 不识别 update → 回落到 remove+add(顺序会变,但保证向后兼容,等用户升级 agent 后自动恢复保序)。
      try {
        const response = await api.post(`/api/admin/remote/outbounds?server_id=${serverId}`, {
          action: 'update', tag: outbound.tag, outbound,
        })
        if (response.data?.success) return response.data
        // 后端返回 success=false 也走回退路径
      } catch {
        // 老 agent: status 400,落到回退
      }
      await api.post(`/api/admin/remote/outbounds?server_id=${serverId}`, {
        action: 'remove', tag: outbound.tag,
      })
      const response = await api.post(`/api/admin/remote/outbounds?server_id=${serverId}`, {
        action: 'add', outbound,
      })
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['remote-outbounds', serverId] })
      toast.success(t('outbounds.outboundUpdated'))
      setEditingFreedomOutbound(null)
    },
    onError: handleServerError,
  })

  const remoteDeleteMutation = useMutation({
    mutationFn: async ({ outbound }: { outbound: XrayOutbound }) => {
      const response = await api.post(`/api/admin/remote/outbounds?server_id=${serverId}`, {
        action: 'remove', tag: outbound.tag,
      })
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['remote-outbounds', serverId] })
      toast.success(t('outbounds.outboundDeleted'))
    },
    onError: handleServerError,
  })

  const remoteAddOutboundMutation = useMutation({
    mutationFn: async ({ outbound }: { outbound: XrayOutbound }) => {
      const response = await api.post(`/api/admin/remote/outbounds?server_id=${serverId}`, {
        action: 'add', outbound,
      })
      return response.data
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['remote-outbounds', serverId] })
      data.success ? toast.success(data.message || t('outbounds.outboundAdded')) : toast.error(data.message || t('outbounds.outboundAddFailed'))
    },
    onError: handleServerError,
  })

  const handleDelete = (item: OutboundItem) => {
    if (confirm(t('outbounds.confirmDeletePrompt', { tag: item.outbound.tag }))) {
      remoteDeleteMutation.mutate({ outbound: item.outbound })
    }
  }

  const handleEditFreedom = (item: OutboundItem) => {
    setEditingFreedomOutbound(item)
    setFreedomDomainStrategy(item.outbound.settings?.domainStrategy || 'AsIs')
  }

  const handleFreedomSubmit = () => {
    if (!editingFreedomOutbound) return
    const outbound = editingFreedomOutbound.outbound
    const updatedSettings = { ...outbound.settings }
    if (freedomDomainStrategy && freedomDomainStrategy !== 'AsIs') {
      updatedSettings.domainStrategy = freedomDomainStrategy
    } else {
      delete updatedSettings.domainStrategy
    }
    remoteUpdateOutboundMutation.mutate({ outbound: { ...outbound, settings: updatedSettings } })
    setEditingFreedomOutbound(null)
  }

  // 快捷添加 freedom / blackhole — 不弹表单,默认 tag(direct / block),直接 POST。
  // 如果同 tag 已存在 — 给个递增后缀保证不冲突(direct-2 / block-2 …)。
  const handleAddSimpleOutbound = async (protocol: 'freedom' | 'blackhole') => {
    const baseTag = protocol === 'freedom' ? 'direct' : 'block'
    const usedTags = new Set((outboundsData?.outbounds || []).map((it: any) => it.outbound?.tag))
    let tag = baseTag
    let n = 2
    while (usedTags.has(tag)) {
      tag = `${baseTag}-${n}`
      n++
    }
    const outbound: XrayOutbound = { tag, protocol, settings: {} } as any
    try {
      await remoteAddOutboundMutation.mutateAsync({ outbound })
      toast.success(t('outbounds.outboundAddedToRemote', { defaultValue: '出站已添加到远程服务器' }))
    } catch {}
  }

  // 批量从节点导入:NodeSelectDialog 多选确认 → 跳过 wizard 表单,逐个生成 outbound + POST
  // 失败不影响其他;统一 toast 汇总结果
  const handleBulkOutboundImport = async (items: Array<{ node: any; clashConfig: any }>) => {
    let ok = 0
    const failed: string[] = []
    for (const { node, clashConfig } of items) {
      const tag = (clashConfig?.name || node.node_name || '').trim()
      if (!tag) { failed.push(`${node.node_name}: ${t('outbounds.fillTag')}`); continue }
      try {
        const outbound = clashConfigToOutbound(clashConfig, tag)
        const res = await api.post(`/api/admin/remote/outbounds?server_id=${serverId}`, {
          action: 'add', outbound,
        })
        if (res.data?.success) ok++
        else failed.push(`${node.node_name}: ${res.data?.message || '失败'}`)
      } catch (e: any) {
        failed.push(`${node.node_name}: ${e?.response?.data?.message || e?.message || '失败'}`)
      }
    }
    queryClient.invalidateQueries({ queryKey: ['remote-outbounds', serverId] })
    if (ok > 0 && failed.length === 0) {
      toast.success(t('outbounds.bulkImportSuccess', { defaultValue: '批量导入成功 {{count}} 个出站', count: ok }))
    } else if (ok > 0 && failed.length > 0) {
      toast.error(
        t('outbounds.bulkImportPartial', { defaultValue: '成功 {{ok}} 个 / 失败 {{fail}} 个', ok, fail: failed.length }) +
        ': ' + failed.slice(0, 3).join('; ') + (failed.length > 3 ? ' …' : ''),
      )
    } else {
      toast.error(
        t('outbounds.bulkImportFailed', { defaultValue: '批量导入失败' }) +
        ': ' + failed.slice(0, 3).join('; ') + (failed.length > 3 ? ' …' : ''),
      )
    }
    setIsNodeSelectOpen(false)
  }

  const outbounds = outboundsData?.outbounds || []
  const filteredOutbounds = useMemo(() => {
    if (!hideDefaultOutbounds) return outbounds
    return outbounds.filter((item: OutboundItem) => {
      const tag = item.outbound.tag?.toLowerCase()
      return tag !== 'block' && tag !== 'direct'
    })
  }, [outbounds, hideDefaultOutbounds])

  const getUserCount = (outbound: XrayOutbound) => {
    if (!outbound.settings) return 0
    if (outbound.protocol === 'freedom' || outbound.protocol === 'blackhole') return -1
    if (Array.isArray(outbound.settings.vnext) && outbound.settings.vnext.length > 0) {
      return Array.isArray(outbound.settings.vnext[0].users) ? outbound.settings.vnext[0].users.length : 0
    }
    if (Array.isArray(outbound.settings.servers)) return outbound.settings.servers.length
    return 0
  }

  const isSimpleOutbound = (protocol: string) => protocol === 'freedom' || protocol === 'blackhole'

  const getOutboundAddress = (outbound: XrayOutbound) => {
    let address = '-', port = '-'
    if (outbound.settings?.vnext?.[0]) {
      address = outbound.settings.vnext[0].address || '-'
      port = outbound.settings.vnext[0].port || '-'
    } else if (outbound.settings?.servers?.[0]) {
      address = outbound.settings.servers[0].address || '-'
      port = outbound.settings.servers[0].port || '-'
    }
    return { address, port }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {t('outbounds.remoteServerConfig', { name: serverName, count: filteredOutbounds.length })}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant={hideDefaultOutbounds ? 'default' : 'outline'}
            size="sm"
            onClick={() => setHideDefaultOutbounds(!hideDefaultOutbounds)}
          >
            {hideDefaultOutbounds ? t('outbounds.showDefault') : t('outbounds.hideDefault')}
          </Button>
          {/* 添加出站 — 下拉菜单 4 种类型,不再弹复杂 wizard */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm">
                <Plus className="h-4 w-4 mr-1" />{t('outbounds.addOutbound')}
                <ChevronDown className="h-3 w-3 ml-1 opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onClick={() => setIsNodeSelectOpen(true)}>
                <Import className="h-4 w-4 mr-2" />
                {t('outbounds.createFromNode')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleAddSimpleOutbound('freedom')}>
                <ArrowRight className="h-4 w-4 mr-2 text-green-600" />
                Freedom <span className="ml-1 text-xs text-muted-foreground">({t('outbounds.directOutbound')})</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleAddSimpleOutbound('blackhole')}>
                <Ban className="h-4 w-4 mr-2 text-red-500" />
                Blackhole <span className="ml-1 text-xs text-muted-foreground">({t('outbounds.blockOutbound')})</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setIsWarpModalOpen(true)}>
                <Cloud className="h-4 w-4 mr-2 text-orange-500" />
                {t('outbounds.warp.button')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {isLoading ? (
        <div className="text-center py-8">
          <RefreshCw className="h-6 w-6 animate-spin mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">{tc('actions.loading')}</p>
        </div>
      ) : filteredOutbounds.length === 0 ? (
        <EmptyStateCard title={t('outbounds.noOutbounds')} description={t('outbounds.noOutboundsDescShort')} />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
          {filteredOutbounds.map((item: OutboundItem) => {
            const outbound = item.outbound
            const { address, port } = getOutboundAddress(outbound)
            const mmwxManaged = isMmwxManagedOutbound(outbound.tag)
            return (
              <Card key={`${item.server_id}-${outbound.tag}`} className={mmwxManaged ? 'border-l-4 border-l-primary/70' : ''}>
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-base truncate flex items-center gap-1.5">
                      {outbound.tag}
                      {mmwxManaged && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge variant='secondary' className='text-[10px] px-1 py-0 bg-primary/10 text-primary border-primary/30'>妙妙屋X</Badge>
                          </TooltipTrigger>
                          <TooltipContent><div className='text-xs max-w-xs'>此出站由妙妙屋X路由出站功能添加和管理,请勿手动删除 — 删除会让对应 routed 节点 + 用户子账号失效。要清理请去节点管理删除使用此 outbound 的 routed 节点。</div></TooltipContent>
                        </Tooltip>
                      )}
                    </CardTitle>
                    <Badge variant="secondary" className="text-xs">{outbound.protocol}</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-1.5 text-sm">
                  {isSimpleOutbound(outbound.protocol) ? (
                    <>
                      {outbound.settings?.domainStrategy && (
                        <div className="flex justify-between"><span className="text-muted-foreground">{t('outbounds.domainStrategy')}</span><span>{outbound.settings.domainStrategy}</span></div>
                      )}
                      <div className="flex justify-between"><span className="text-muted-foreground">{t('outbounds.type')}</span><span>{outbound.protocol === 'freedom' ? t('outbounds.directOutbound') : t('outbounds.blockOutbound')}</span></div>
                    </>
                  ) : (
                    <>
                      <div className="flex justify-between"><span className="text-muted-foreground">{t('outbounds.address')}</span><span className="truncate max-w-[180px]" title={address as string}>{address}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">{t('outbounds.portLabel')}</span><span>{port}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">{t('outbounds.userCount')}</span><span>{getUserCount(outbound)}</span></div>
                    </>
                  )}
                </CardContent>
                <CardFooter className="flex gap-1.5 pt-2">
                  {outbound.protocol === 'freedom' && (
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => handleEditFreedom(item)}><Edit2 className="h-3 w-3 mr-1" />{tc('actions.edit')}</Button>
                  )}
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setViewingOutbound(outbound)}><Eye className="h-3 w-3 mr-1" />{tc('actions.view')}</Button>
                  {!isSimpleOutbound(outbound.protocol) && !mmwxManaged && (
                    <Button variant="outline" size="sm" className="h-7 text-xs text-red-600 hover:text-red-700" onClick={() => handleDelete(item)}><Trash2 className="h-3 w-3 mr-1" />{tc('actions.delete')}</Button>
                  )}
                </CardFooter>
              </Card>
            )
          })}
        </div>
      )}

      {/* Freedom Edit Dialog */}
      <Dialog open={!!editingFreedomOutbound} onOpenChange={(open) => !open && setEditingFreedomOutbound(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('outbounds.editFreedomOutbound')} - {editingFreedomOutbound?.outbound.tag}</DialogTitle>
            <DialogDescription>{t('outbounds.configDomainStrategy')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Button variant={freedomDomainStrategy === 'AsIs' ? 'default' : 'outline'} className="w-full justify-start" onClick={() => setFreedomDomainStrategy('AsIs')}>{t('outbounds.asIsDefault')}</Button>
              <p className="text-xs text-muted-foreground pl-4">{t('outbounds.domainStrategyNotSpecial')}</p>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">{t('outbounds.useIpSeries')}</p>
              <div className="grid grid-cols-2 gap-2">
                {['UseIP', 'UseIPv6v4', 'UseIPv6', 'UseIPv4v6', 'UseIPv4'].map((v) => (
                  <Button key={v} variant={freedomDomainStrategy === v ? 'default' : 'outline'} size="sm" className="justify-start" onClick={() => setFreedomDomainStrategy(v)}>{v}</Button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">{t('outbounds.forceIpSeries')}</p>
              <div className="grid grid-cols-2 gap-2">
                {['ForceIP', 'ForceIPv6v4', 'ForceIPv6', 'ForceIPv4v6', 'ForceIPv4'].map((v) => (
                  <Button key={v} variant={freedomDomainStrategy === v ? 'default' : 'outline'} size="sm" className="justify-start" onClick={() => setFreedomDomainStrategy(v)}>{v}</Button>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setEditingFreedomOutbound(null)}>{tc('actions.cancel')}</Button>
            <Button onClick={handleFreedomSubmit} disabled={remoteUpdateOutboundMutation.isPending}>{remoteUpdateOutboundMutation.isPending ? tc('actions.saving') : tc('actions.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* View Dialog */}
      <Dialog open={!!viewingOutbound} onOpenChange={(open) => !open && setViewingOutbound(null)}>
        <DialogContent className="max-w-3xl max-h-[90vh]">
          <DialogHeader>
            <DialogTitle>{t('outbounds.viewOutbound')} - {viewingOutbound?.tag}</DialogTitle>
            <DialogDescription>{t('outbounds.viewOutboundJson')}</DialogDescription>
          </DialogHeader>
          <div className="overflow-auto max-h-[60vh]">
            <pre className="bg-gray-50 dark:bg-gray-900 p-4 rounded-lg text-xs">{JSON.stringify(viewingOutbound, null, 2)}</pre>
          </div>
          <DialogFooter><Button onClick={() => setViewingOutbound(null)}>{tc('actions.close')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 从节点创建出站 — 选 1 个或多个节点,一键批量创建对应 outbound */}
      <NodeSelectDialog
        open={isNodeSelectOpen}
        onOpenChange={setIsNodeSelectOpen}
        multiple={true}
        // onConfirm 接管单/多选;onSelect 是接口必填,退化路径不会被命中(onConfirm 优先)
        onSelect={() => {}}
        onConfirm={(items) => handleBulkOutboundImport(items)}
        protocolFilter={['vless', 'vmess', 'trojan', 'ss', 'shadowsocks', 'socks5', 'http']}
      />

      {/* Cloudflare WARP 配置 modal */}
      <WarpModal
        serverId={serverId}
        serverName={serverName}
        open={isWarpModalOpen}
        onOpenChange={setIsWarpModalOpen}
        onChanged={() => queryClient.invalidateQueries({ queryKey: ['remote-outbounds', serverId] })}
      />
    </div>
  )
}
