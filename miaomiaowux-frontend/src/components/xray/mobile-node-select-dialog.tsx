// @ts-nocheck
// 手机端专版节点选择器 — 用 Sheet 从底部上拉到全屏,代替 Dialog。
// 与 NodeSelectDialog 的桌面行布局(单行展示协议+名+标签+地址)不同,mobile 版每个
// 节点占 2 行:第 1 行 协议 badge + 节点名(可截断),第 2 行 tag + server:port;点击行即选中。
// 行高加大方便手指点选;搜索 / tag filter / 多选工具栏全部保留。
import { useState, useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Cable } from 'lucide-react'
import { api } from '@/lib/api'
import { getClashProtocolColor } from '@/lib/protocol-colors'
import { toast } from 'sonner'

interface ParsedNode {
  id: number
  raw_url: string
  node_name: string
  protocol: string
  parsed_config: string
  clash_config: string
  enabled: boolean
  tag: string
  original_server: string
  created_at: string
  updated_at: string
  node_type?: string
}

interface MobileNodeSelectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (node: ParsedNode, clashConfig: any) => void
  protocolFilter?: string[]
  multiple?: boolean
  onConfirm?: (items: Array<{ node: ParsedNode; clashConfig: any }>) => void
}

export function MobileNodeSelectDialog({
  open,
  onOpenChange,
  onSelect,
  protocolFilter,
  multiple = false,
  onConfirm,
}: MobileNodeSelectDialogProps) {
  const { t } = useTranslation('xray')
  const { t: tc } = useTranslation('common')
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<number>>(new Set())
  const [searchTerm, setSearchTerm] = useState('')
  const [tagFilter, setTagFilter] = useState<string>('all')

  // 与桌面端 NodeSelectDialog 共享同 queryKey ['nodes'] / ['user-config'] / ['admin-tunnels'] —
  // 节点管理改 tag → invalidateQueries(['nodes']) → 桌面/手机两端 dialog 都自动刷新。
  const nodesQ = useQuery({
    queryKey: ['nodes'],
    queryFn: async () => (await api.get('/api/admin/nodes')).data,
    enabled: open,
  })
  const userCfgQ = useQuery({
    queryKey: ['user-config'],
    queryFn: async () => (await api.get('/api/user/config')).data,
    enabled: open,
  })
  const tunnelsQ = useQuery({
    queryKey: ['admin-tunnels'],
    queryFn: async () => (await api.get('/api/admin/tunnels')).data,
    enabled: open,
  })

  const nodes: ParsedNode[] = nodesQ.data?.nodes ?? []
  const nodeOrder: number[] = userCfgQ.data?.node_order ?? []
  const tunnels: any[] = tunnelsQ.data?.tunnels ?? []
  const loading = nodesQ.isLoading

  useEffect(() => {
    if (open) {
      setSelectedNodeIds(new Set())
      setSearchTerm('')
      setTagFilter('all')
    }
  }, [open])

  useEffect(() => {
    if (nodesQ.isError && open) {
      const err: any = nodesQ.error
      toast.error(t('nodeSelect.loadFailed'), {
        description: err?.response?.data?.message || err?.message || String(err),
      })
    }
  }, [nodesQ.isError, nodesQ.error, open, t])

  const tunnelsByTarget = useMemo(() => {
    const map = new Map<string, any[]>()
    for (const tn of tunnels) {
      const key = `${tn.target_address}:${tn.target_port}`
      const arr = map.get(key) || []
      arr.push(tn)
      map.set(key, arr)
    }
    return map
  }, [tunnels])

  const handleSelectNode = (nodeId: number) => {
    setSelectedNodeIds((prev) => {
      const next = new Set(prev)
      if (multiple) {
        next.has(nodeId) ? next.delete(nodeId) : next.add(nodeId)
      } else {
        next.clear()
        if (!prev.has(nodeId)) next.add(nodeId)
      }
      return next
    })
  }

  const uniqueTags = useMemo(() => {
    const tags = new Set<string>()
    nodes.forEach((node) => {
      if (node.tag && node.tag.trim()) tags.add(node.tag.trim())
    })
    return Array.from(tags).sort()
  }, [nodes])

  const filteredNodes = useMemo(() => {
    let filtered = nodes.filter((node) => node.node_type !== 'routed')
    if (protocolFilter && protocolFilter.length > 0) {
      filtered = filtered.filter((node) =>
        protocolFilter.some((p) => node.protocol.toLowerCase().includes(p.toLowerCase()))
      )
    }
    if (tagFilter !== 'all') {
      filtered = filtered.filter((node) => node.tag === tagFilter)
    }
    if (searchTerm.trim()) {
      const searchLower = searchTerm.toLowerCase()
      filtered = filtered.filter((node) =>
        node.node_name?.toLowerCase().includes(searchLower) ||
        node.protocol?.toLowerCase().includes(searchLower) ||
        node.tag?.toLowerCase().includes(searchLower)
      )
    }
    if (nodeOrder.length > 0) {
      const idx = new Map<number, number>()
      nodeOrder.forEach((id, i) => idx.set(id, i))
      filtered = [...filtered].sort((a, b) => {
        const ai = idx.get(a.id) ?? Number.POSITIVE_INFINITY
        const bi = idx.get(b.id) ?? Number.POSITIVE_INFINITY
        return ai - bi
      })
    }
    return filtered
  }, [nodes, protocolFilter, tagFilter, searchTerm, nodeOrder])

  const handleConfirm = () => {
    if (selectedNodeIds.size === 0) return
    const items: Array<{ node: ParsedNode; clashConfig: any }> = []
    for (const id of selectedNodeIds) {
      const node = nodes.find((n) => n.id === id)
      if (!node) continue
      try {
        items.push({ node, clashConfig: JSON.parse(node.clash_config) })
      } catch {
        toast.error(`${t('nodeSelect.parseFailed')}: ${node.node_name}`)
      }
    }
    if (items.length === 0) return
    if (onConfirm) {
      onConfirm(items)
    } else {
      onSelect(items[0].node, items[0].clashConfig)
    }
    onOpenChange(false)
  }

  const toggleSelectAllFiltered = (filteredIds: number[], allFilteredChecked: boolean) => {
    setSelectedNodeIds((prev) => {
      const next = new Set(prev)
      if (allFilteredChecked) filteredIds.forEach((id) => next.delete(id))
      else filteredIds.forEach((id) => next.add(id))
      return next
    })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side='bottom' className='h-[92vh] flex flex-col p-0 gap-0'>
        <SheetHeader className='p-4 border-b shrink-0'>
          <SheetTitle>{t('nodeSelect.importFromNode')}</SheetTitle>
          <SheetDescription className='text-xs'>{t('nodeSelect.importDesc')}</SheetDescription>
        </SheetHeader>

        <div className='flex-1 overflow-hidden flex flex-col'>
          {/* 搜索 */}
          <div className='px-4 pt-3 pb-2 shrink-0'>
            <Input
              placeholder={t('nodeSelect.searchPlaceholder')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className='h-10'
            />
          </div>

          {/* Tag filter — 横向滚动 chip 行(mobile 优化) */}
          {uniqueTags.length > 0 && (
            <div className='px-4 pb-2 shrink-0 overflow-x-auto'>
              <div className='flex gap-2 w-max'>
                <Button
                  size='sm'
                  variant={tagFilter === 'all' ? 'default' : 'outline'}
                  onClick={() => setTagFilter('all')}
                  className='shrink-0 h-8'
                >
                  {t('nodeSelect.all')}
                </Button>
                {uniqueTags.map((tag) => (
                  <Button
                    key={tag}
                    size='sm'
                    variant={tagFilter === tag ? 'default' : 'outline'}
                    onClick={() => setTagFilter(tag)}
                    className='shrink-0 h-8'
                  >
                    {tag}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {/* 多选工具栏 */}
          {multiple && filteredNodes.length > 0 && (() => {
            const filteredIds = filteredNodes.map((n) => n.id)
            const allChecked = filteredIds.every((id) => selectedNodeIds.has(id))
            return (
              <div className='px-4 py-2 border-t flex items-center justify-between text-xs shrink-0'>
                <span className='text-muted-foreground'>
                  {t('nodeSelect.selectedCount', { defaultValue: '已选' })}: {selectedNodeIds.size} / {filteredNodes.length}
                </span>
                <Button
                  size='sm'
                  variant='ghost'
                  className='h-7 text-xs'
                  onClick={() => toggleSelectAllFiltered(filteredIds, allChecked)}
                >
                  {allChecked
                    ? t('nodeSelect.clearSelection', { defaultValue: '清空选择' })
                    : t('nodeSelect.selectAll', { defaultValue: '全选当前列表' })}
                </Button>
              </div>
            )
          })()}

          {/* 节点列表 — 触屏友好的两行卡片 */}
          <div className='flex-1 overflow-y-auto px-3 py-2'>
            {loading ? (
              <p className='text-sm text-muted-foreground text-center py-8'>{t('nodeSelect.loading')}</p>
            ) : filteredNodes.length === 0 ? (
              <p className='text-sm text-muted-foreground text-center py-8'>
                {searchTerm || tagFilter !== 'all' ? t('nodeSelect.noMatch') : t('nodeSelect.noNodes')}
              </p>
            ) : (
              <div className='space-y-2'>
                {filteredNodes.map((node) => {
                  let clashConfig: any = null
                  try {
                    clashConfig = JSON.parse(node.clash_config)
                  } catch {
                    // ignore
                  }
                  const fwdTunnels = clashConfig?.server && clashConfig?.port
                    ? (tunnelsByTarget.get(`${clashConfig.server}:${clashConfig.port}`) || [])
                    : []
                  const isSelected = selectedNodeIds.has(node.id)
                  return (
                    <div
                      key={node.id}
                      onClick={() => handleSelectNode(node.id)}
                      className={`flex items-start gap-3 p-3 rounded-lg border transition-colors ${
                        isSelected ? 'bg-primary/10 border-primary' : 'bg-card hover:bg-muted/40'
                      }`}
                    >
                      <div className='flex-1 min-w-0 space-y-1.5'>
                        {/* Row 1: 协议 + 节点名 + tunnel 标记 */}
                        <div className='flex items-center gap-2 min-w-0'>
                          <Badge
                            variant='outline'
                            className={`shrink-0 text-[10px] px-1.5 py-0 ${getClashProtocolColor(node.protocol) || 'bg-gray-500/10'}`}
                          >
                            {node.protocol.toUpperCase()}
                          </Badge>
                          <span className='font-medium text-sm truncate flex-1 min-w-0'>{node.node_name}</span>
                          {fwdTunnels.length > 0 && (
                            <Badge
                              variant='outline'
                              className='h-5 w-5 p-0 flex items-center justify-center shrink-0 border-orange-300 text-orange-600 dark:text-orange-400'
                              title={t('nodeList.forwardedByTunnel', { defaultValue: '被 tunnel 转发' })}
                            >
                              <Cable className='h-3 w-3' />
                            </Badge>
                          )}
                        </div>
                        {/* Row 2: tag + server:port */}
                        <div className='flex items-center gap-2 text-xs min-w-0'>
                          {node.tag && (
                            <Badge variant='secondary' className='text-[10px] shrink-0 px-1.5 py-0'>{node.tag}</Badge>
                          )}
                          {clashConfig && (
                            <span className='text-muted-foreground font-mono truncate'>
                              {clashConfig.server}:{clashConfig.port}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        <SheetFooter className='p-4 border-t shrink-0 gap-2 flex-col-reverse sm:flex-row'>
          <Button variant='outline' onClick={() => onOpenChange(false)} className='w-full sm:w-auto'>
            {tc('actions.cancel')}
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={selectedNodeIds.size === 0}
            className='w-full sm:w-auto'
          >
            {multiple && selectedNodeIds.size > 1
              ? `${t('nodeSelect.confirmImport')} (${selectedNodeIds.size})`
              : t('nodeSelect.confirmImport')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
