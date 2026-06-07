// @ts-nocheck
import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Cable } from 'lucide-react'
import { api } from '@/lib/api'
import { getClashProtocolColor } from '@/lib/protocol-colors'
import { toast } from 'sonner'
import { useIsMobile } from '@/hooks/use-mobile'
import { MobileNodeSelectDialog } from './mobile-node-select-dialog'


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

interface NodeSelectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (node: ParsedNode, clashConfig: any) => void
  /** Filter nodes by protocol, e.g., ['vless', 'vmess', 'trojan'] */
  protocolFilter?: string[]
  /** 启用多选;调用方应提供 onConfirm 接收批量结果,onSelect 仅在退化时用 */
  multiple?: boolean
  /** 多选模式确认回调;传入则覆盖单选 onSelect 的"单条"语义,选 1/多 都走它 */
  onConfirm?: (items: Array<{ node: ParsedNode; clashConfig: any }>) => void
}

export function NodeSelectDialog(props: NodeSelectDialogProps) {
  // 手机端委托给 Sheet 版,避免 Dialog max-w 在小屏溢出 + 触屏密集行难点选
  const isMobile = useIsMobile()
  if (isMobile) return <MobileNodeSelectDialog {...props} />
  return <DesktopNodeSelectDialog {...props} />
}

function DesktopNodeSelectDialog({ open, onOpenChange, onSelect, protocolFilter, multiple = false, onConfirm }: NodeSelectDialogProps) {
  const { t } = useTranslation('xray')
  const { t: tc } = useTranslation('common')
  const [nodes, setNodes] = useState<ParsedNode[]>([])
  const [nodeOrder, setNodeOrder] = useState<number[]>([])
  const [tunnels, setTunnels] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<number>>(new Set())
  const [searchTerm, setSearchTerm] = useState('')
  const [tagFilter, setTagFilter] = useState<string>('all')

  // Load node list + user_config(取节点排序) + tunnels(标记被 tunnel 转发的节点)
  useEffect(() => {
    if (open) {
      loadAll()
      setSelectedNodeIds(new Set())
      setSearchTerm('')
      setTagFilter('all')
    }
  }, [open])

  const loadAll = async () => {
    setLoading(true)
    try {
      const [nodesRes, ucRes, tnRes] = await Promise.all([
        api.get('/api/admin/nodes'),
        api.get('/api/user/config').catch(() => ({ data: {} })),
        api.get('/api/admin/tunnels').catch(() => ({ data: { tunnels: [] } })),
      ])
      setNodes(nodesRes.data?.nodes || [])
      setNodeOrder(ucRes.data?.node_order || [])
      setTunnels(tnRes.data?.tunnels || [])
    } catch (error) {
      toast.error(t('nodeSelect.loadFailed'), {
        description: error.response?.data?.message || error.message,
      })
      setNodes([])
    } finally {
      setLoading(false)
    }
  }

  // server:port → tunnel[](和 nodes 主页的 renderForwardedBadge 同源,判断该节点是否被某 tunnel 转发)
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
        // 单选:点已选 → 取消,点新的 → 替换
        next.clear()
        if (!prev.has(nodeId)) next.add(nodeId)
      }
      return next
    })
  }

  // Get unique tags
  const uniqueTags = useMemo(() => {
    const tags = new Set<string>()
    nodes.forEach((node) => {
      if (node.tag && node.tag.trim()) {
        tags.add(node.tag.trim())
      }
    })
    return Array.from(tags).sort()
  }, [nodes])

  // Filter nodes + 按 user_config.node_order 排序(节点列表里用户调过的顺序)
  const filteredNodes = useMemo(() => {
    let filtered = nodes

    // 隐藏路由出站节点 — 已经是某条 outbound 的"客户端视图",不应作为新出站的来源
    filtered = filtered.filter((node) => node.node_type !== 'routed')

    // Filter by protocol if specified
    if (protocolFilter && protocolFilter.length > 0) {
      filtered = filtered.filter((node) =>
        protocolFilter.some((p) => node.protocol.toLowerCase().includes(p.toLowerCase()))
      )
    }

    // Filter by tag
    if (tagFilter !== 'all') {
      filtered = filtered.filter((node) => node.tag === tagFilter)
    }

    // Filter by search term
    if (searchTerm.trim()) {
      const searchLower = searchTerm.toLowerCase()
      filtered = filtered.filter((node) =>
        node.node_name?.toLowerCase().includes(searchLower) ||
        node.protocol?.toLowerCase().includes(searchLower) ||
        node.tag?.toLowerCase().includes(searchLower)
      )
    }

    // 按 node_order 排序,不在 order 里的排到最后(保留稳定相对顺序)
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
      // 旧 API 兼容:只回单条
      onSelect(items[0].node, items[0].clashConfig)
    }
    onOpenChange(false)
  }

  // 当前过滤后的可选节点(在 filteredNodes useMemo 之后才能用,这里通过函数延迟绑定);
  // 全选:勾上当前 filter 内所有节点;清空:清掉当前 filter 范围内的勾选
  const toggleSelectAllFiltered = (filteredIds: number[], allFilteredChecked: boolean) => {
    setSelectedNodeIds((prev) => {
      const next = new Set(prev)
      if (allFilteredChecked) filteredIds.forEach((id) => next.delete(id))
      else filteredIds.forEach((id) => next.add(id))
      return next
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('nodeSelect.importFromNode')}</DialogTitle>
          <DialogDescription>{t('nodeSelect.importDesc')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 flex-1 overflow-hidden flex flex-col">
          {/* Search box */}
          <div className="space-y-2">
            <Label>{t('nodeSelect.searchNode')}</Label>
            <Input
              placeholder={t('nodeSelect.searchPlaceholder')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>

          {/* Tag filter */}
          {uniqueTags.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant={tagFilter === 'all' ? 'default' : 'outline'}
                onClick={() => setTagFilter('all')}
              >
                {t('nodeSelect.all')}
              </Button>
              {uniqueTags.map((tag) => (
                <Button
                  key={tag}
                  size="sm"
                  variant={tagFilter === tag ? 'default' : 'outline'}
                  onClick={() => setTagFilter(tag)}
                >
                  {tag}
                </Button>
              ))}
            </div>
          )}

          {/* 多选工具栏:全选当前过滤范围 / 清空当前过滤范围 */}
          {multiple && filteredNodes.length > 0 && (() => {
            const filteredIds = filteredNodes.map((n) => n.id)
            const allChecked = filteredIds.every((id) => selectedNodeIds.has(id))
            return (
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">
                  {t('nodeSelect.selectedCount', { defaultValue: '已选' })}: {selectedNodeIds.size} / {filteredNodes.length}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 text-xs"
                  onClick={() => toggleSelectAllFiltered(filteredIds, allChecked)}
                >
                  {allChecked ? t('nodeSelect.clearSelection', { defaultValue: '清空选择' }) : t('nodeSelect.selectAll', { defaultValue: '全选当前列表' })}
                </Button>
              </div>
            )
          })()}

          {/* Node list */}
          <div className="flex-1 overflow-y-auto border rounded-lg p-4">
            {loading ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('nodeSelect.loading')}</p>
            ) : filteredNodes.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                {searchTerm || tagFilter !== 'all' ? t('nodeSelect.noMatch') : t('nodeSelect.noNodes')}
              </p>
            ) : (
              <div className="space-y-2">
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
                  return (
                    <div
                      key={node.id}
                      className={`flex items-center gap-2 p-2 border rounded hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer transition-colors ${
                        selectedNodeIds.has(node.id) ? 'bg-primary/10 border-primary' : ''
                      }`}
                      onClick={() => handleSelectNode(node.id)}
                    >
                      <Checkbox
                        checked={selectedNodeIds.has(node.id)}
                        onCheckedChange={() => handleSelectNode(node.id)}
                      />
                      {/* 节点信息单行显示:协议 + 节点名 + tunnel 标记 + 标签 + 地址 */}
                      <div className="flex flex-1 min-w-0 items-center gap-2 text-sm">
                        <Badge
                          variant="outline"
                          className={`shrink-0 ${getClashProtocolColor(node.protocol) || 'bg-gray-500/10'}`}
                        >
                          {node.protocol.toUpperCase()}
                        </Badge>
                        <span className="font-medium truncate min-w-0">{node.node_name}</span>
                        {fwdTunnels.length > 0 && (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge variant='outline' className='h-5 w-5 p-0 flex items-center justify-center shrink-0 border-orange-300 text-orange-600 dark:text-orange-400'>
                                  <Cable className='h-3 w-3' />
                                </Badge>
                              </TooltipTrigger>
                              <TooltipContent>
                                <div className='space-y-0.5 text-xs'>
                                  <div className='font-medium'>{t('nodeList.forwardedByTunnel', { defaultValue: '被 tunnel 转发' })}</div>
                                  {fwdTunnels.map((tn: any) => (
                                    <div key={`${tn.server_id}-${tn.tag}`} className='font-mono'>
                                      {tn.server_name}:{tn.listen_port} · {tn.tag}
                                    </div>
                                  ))}
                                </div>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                        {node.tag && (
                          <Badge variant="secondary" className="text-xs shrink-0">
                            {node.tag}
                          </Badge>
                        )}
                        {clashConfig && (
                          <span className="text-xs text-muted-foreground truncate ml-auto font-mono shrink-0">
                            {clashConfig.server}:{clashConfig.port}
                          </span>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <div className="text-sm text-muted-foreground">
            {multiple
              ? (selectedNodeIds.size > 0
                  ? `${t('nodeSelect.selectedCount', { defaultValue: '已选' })} ${selectedNodeIds.size} ${t('nodeSelect.itemUnit', { defaultValue: '个节点' })}`
                  : t('nodeSelect.selectNode'))
              : (selectedNodeIds.size > 0 ? t('nodeSelect.selected') : t('nodeSelect.selectNode'))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tc('actions.cancel')}
          </Button>
          <Button onClick={handleConfirm} disabled={selectedNodeIds.size === 0}>
            {multiple && selectedNodeIds.size > 1
              ? `${t('nodeSelect.confirmImport')} (${selectedNodeIds.size})`
              : t('nodeSelect.confirmImport')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
