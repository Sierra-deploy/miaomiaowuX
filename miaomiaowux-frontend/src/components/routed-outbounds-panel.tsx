// @ts-nocheck
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Plus, Trash2, Copy, Route as RouteIcon } from 'lucide-react'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { EmptyStateCard } from '@/components/ui/empty-state'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { api } from '@/lib/api'

interface PhysicalNode {
  id: number
  node_name: string
  protocol: string
  original_server: string
  inbound_tag: string
  node_type?: string
}

interface RoutedNode {
  ID: number
  NodeName: string
  ParentNodeID?: number
  OriginalServer: string
  InboundTag: string
  RoutedOutboundTag: string
  RoutedOutboundJSON: string
  RoutedRuleMarktag: string
  RoutedAdminEmail: string
  RoutedAdminCredential: string
  CreatedAt: string
}

const FREEDOM_TEMPLATE = JSON.stringify({ protocol: 'freedom', settings: {} }, null, 2)

/**
 * 路由出站管理面板,可独立成页面或在 Dialog 中嵌入显示。
 * - showHeader=true:显示页面级标题 + 新增按钮 + 说明卡(独立路由用)
 * - showHeader=false:作为子组件嵌入(Dialog 内,标题由外层 DialogHeader 给)
 */
export function RoutedOutboundsPanel({ showHeader = true }: { showHeader?: boolean }) {
  const qc = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [parentId, setParentId] = useState<string>('')
  const [label, setLabel] = useState('')
  const [outboundJSON, setOutboundJSON] = useState(FREEDOM_TEMPLATE)
  const [credPreview, setCredPreview] = useState<RoutedNode | null>(null)

  const nodesQ = useQuery({
    queryKey: ['admin-nodes'],
    queryFn: async () => {
      const res = await api.get('/api/admin/nodes')
      return res.data?.nodes || res.data || []
    },
  })

  const physicalNodes: PhysicalNode[] = useMemo(() => {
    const all = (nodesQ.data || []) as any[]
    return all
      .filter((n) => (!n.node_type || n.node_type === 'physical') && !!n.inbound_tag && !!n.original_server)
      .map((n) => ({
        id: n.id,
        node_name: n.node_name,
        protocol: n.protocol,
        original_server: n.original_server,
        inbound_tag: n.inbound_tag,
        node_type: n.node_type,
      }))
  }, [nodesQ.data])

  const routedQ = useQuery({
    enabled: physicalNodes.length > 0,
    queryKey: ['routed-outbounds', physicalNodes.map((n) => n.id)],
    queryFn: async () => {
      const results = await Promise.all(
        physicalNodes.map(async (n) => {
          const res = await api.get(`/api/admin/routed-outbound?parent_id=${n.id}`)
          return { parentId: n.id, items: (res.data?.items || []) as RoutedNode[] }
        }),
      )
      const map = new Map<number, RoutedNode[]>()
      results.forEach((r) => map.set(r.parentId, r.items || []))
      return map
    },
  })

  // 服务器与 outbound 数据(给 outboundDisplay 用,但 outboundDisplay 依赖 flatRouted,所以 useMemo 那条放后面)
  const serverNamesByParent = useMemo(() => {
    const m = new Map<number, string>()
    physicalNodes.forEach((n) => m.set(n.id, n.original_server))
    return m
  }, [physicalNodes])
  const uniqueServers = useMemo(() => Array.from(new Set(physicalNodes.map((n) => n.original_server).filter(Boolean))), [physicalNodes])
  const remoteServersQ = useQuery({
    queryKey: ['remote-servers-for-routed'],
    queryFn: async () => (await api.get('/api/admin/remote-servers')).data,
  })
  const outboundsByServer = useQuery({
    enabled: uniqueServers.length > 0 && !!remoteServersQ.data,
    queryKey: ['outbounds-by-server', uniqueServers],
    queryFn: async () => {
      const serversList: any[] = remoteServersQ.data?.servers || []
      const map = new Map<string, any[]>()
      await Promise.all(
        uniqueServers.map(async (name) => {
          const sv = serversList.find((s) => s.name === name)
          if (!sv) return
          try {
            const res = await api.get(`/api/admin/remote/outbounds?server_id=${sv.id}`)
            map.set(name, res.data?.outbounds || [])
          } catch {}
        }),
      )
      return map
    },
  })

  const flatRouted: Array<{ parent: PhysicalNode; node: RoutedNode }> = useMemo(() => {
    const out: Array<{ parent: PhysicalNode; node: RoutedNode }> = []
    if (!routedQ.data) return out
    physicalNodes.forEach((p) => {
      const items = routedQ.data?.get(p.id) || []
      items.forEach((n) => out.push({ parent: p, node: n }))
    })
    return out
  }, [routedQ.data, physicalNodes])

  // 路由出站 tag → 友好显示名(优先 节点名 → 服务器名 → 原 tag)
  const outboundDisplay = useMemo(() => {
    const map: Record<string, string> = {}
    const nodesAll: any[] = nodesQ.data || []
    const serversList: any[] = remoteServersQ.data?.servers || []
    const nodeByAddr: Record<string, { nodeName: string; server: string }> = {}
    for (const n of nodesAll) {
      try {
        const cfg = JSON.parse(n.clash_config)
        if (cfg?.server) {
          const key = `${cfg.server}:${cfg.port || ''}`
          if (!nodeByAddr[key]) nodeByAddr[key] = { nodeName: n.node_name, server: n.original_server || '' }
        }
      } catch {}
    }
    const serverByAddr: Record<string, string> = {}
    for (const s of serversList) {
      for (const a of [s.ip_address, s.domain, s.pull_address]) {
        if (a) serverByAddr[a] = s.name
      }
    }
    flatRouted.forEach(({ parent, node }) => {
      const serverName = serverNamesByParent.get(parent.id) || ''
      const list = outboundsByServer.data?.get(serverName) || []
      const ob = list.find((o: any) => o.tag === node.RoutedOutboundTag)
      if (!ob) {
        map[node.RoutedOutboundTag] = node.RoutedOutboundTag
        return
      }
      let addr = ''
      let port: any = ''
      const vnext = ob.settings?.vnext?.[0]
      const servers = ob.settings?.servers?.[0]
      if (vnext) { addr = vnext.address; port = vnext.port }
      else if (servers) { addr = servers.address; port = servers.port }
      else if (ob.settings?.address) { addr = ob.settings.address; port = ob.settings.port }
      const key = `${addr}:${port}`
      const matchNode = nodeByAddr[key]
      if (matchNode) {
        map[node.RoutedOutboundTag] = matchNode.server ? `${matchNode.nodeName} · ${matchNode.server}` : matchNode.nodeName
        return
      }
      const matchServer = serverByAddr[addr]
      if (matchServer) {
        map[node.RoutedOutboundTag] = matchServer
        return
      }
      map[node.RoutedOutboundTag] = node.RoutedOutboundTag
    })
    return map
  }, [flatRouted, outboundsByServer.data, nodesQ.data, remoteServersQ.data, serverNamesByParent])

  const createM = useMutation({
    mutationFn: async () => {
      let outboundParsed: any
      try {
        outboundParsed = JSON.parse(outboundJSON)
      } catch (e: any) {
        throw new Error(`Outbound JSON 解析失败: ${e.message}`)
      }
      const res = await api.post('/api/admin/routed-outbound', {
        parent_node_id: Number(parentId),
        label,
        outbound: outboundParsed,
      })
      return res.data
    },
    onSuccess: () => {
      toast.success('路由出站创建成功')
      setDialogOpen(false)
      setLabel('')
      setOutboundJSON(FREEDOM_TEMPLATE)
      qc.invalidateQueries({ queryKey: ['admin-nodes'] })
      qc.invalidateQueries({ queryKey: ['routed-outbounds'] })
    },
    onError: (e: any) => {
      toast.error(e?.response?.data?.error || e?.response?.data?.message || e.message)
    },
  })

  const deleteM = useMutation({
    mutationFn: async (id: number) => {
      const res = await api.delete(`/api/admin/routed-outbound?id=${id}`)
      return res.data
    },
    onSuccess: () => {
      toast.success('已删除')
      qc.invalidateQueries({ queryKey: ['admin-nodes'] })
      qc.invalidateQueries({ queryKey: ['routed-outbounds'] })
    },
    onError: (e: any) => {
      toast.error(e?.response?.data?.error || e?.response?.data?.message || e.message)
    },
  })

  const copyToClipboard = useCopyToClipboard()
  const copyText = (s: string) => copyToClipboard(s, { success: '已复制', failure: '复制失败' })

  return (
    <div className='space-y-4'>
      {showHeader && (
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2'>
            <RouteIcon className='h-6 w-6' />
            <h2 className='text-2xl font-bold'>路由出站管理</h2>
          </div>
          <Button onClick={() => setDialogOpen(true)} disabled={physicalNodes.length === 0}>
            <Plus className='mr-2 h-4 w-4' />
            新增路由出站
          </Button>
        </div>
      )}
      {!showHeader && (
        <div className='flex justify-end'>
          <Button size='sm' onClick={() => setDialogOpen(true)} disabled={physicalNodes.length === 0}>
            <Plus className='mr-1 h-4 w-4' />
            新增路由出站
          </Button>
        </div>
      )}

      <Card>
        <CardHeader className='py-3'>
          <CardTitle className='text-sm'>说明</CardTitle>
        </CardHeader>
        <CardContent className='text-xs text-muted-foreground space-y-1.5'>
          <p>
            路由出站是挂在物理节点下的虚拟节点 — 共用父节点 inbound,但流量被路由到独立的出站。
          </p>
          <p>
            把该 routed 节点加入套餐 → 用户绑套餐时自动开子账号 + 加入 rule.user;退订时下线但凭据保留可续费恢复。
          </p>
        </CardContent>
      </Card>

      {flatRouted.length === 0 ? (
        <EmptyStateCard
          icon={<RouteIcon className='size-12 text-muted-foreground' />}
          title='还没有路由出站'
          description={
            physicalNodes.length === 0
              ? '需要先有物理节点(带 inbound_tag 与 server)'
              : '点击"新增路由出站"开始创建'
          }
        />
      ) : (
        <Card>
          <CardContent className='pt-4'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>父节点</TableHead>
                  <TableHead>Label / 节点名</TableHead>
                  <TableHead>Server</TableHead>
                  <TableHead>Outbound Tag</TableHead>
                  <TableHead>Admin 凭据</TableHead>
                  <TableHead className='text-right'>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {flatRouted.map(({ parent, node }) => (
                  <TableRow key={node.ID}>
                    <TableCell className='font-mono text-xs'>
                      #{parent.id} {parent.node_name}
                    </TableCell>
                    <TableCell>
                      <div className='font-medium'>{node.NodeName}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant='outline'>{node.OriginalServer}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className='font-medium text-xs'>{outboundDisplay[node.RoutedOutboundTag] || node.RoutedOutboundTag}</div>
                      {outboundDisplay[node.RoutedOutboundTag] && outboundDisplay[node.RoutedOutboundTag] !== node.RoutedOutboundTag && (
                        <div className='font-mono text-[10px] text-muted-foreground mt-0.5'>{node.RoutedOutboundTag}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button variant='ghost' size='sm' onClick={() => setCredPreview(node)}>
                        <Copy className='mr-1 h-3 w-3' />
                        查看
                      </Button>
                    </TableCell>
                    <TableCell className='text-right'>
                      <Button
                        variant='ghost'
                        size='sm'
                        className='text-destructive'
                        onClick={() => {
                          if (confirm(`确定删除路由出站 ${node.NodeName} 吗?\n会同时清理 agent 上的 outbound/rule/admin client + 所有绑定用户子账号(凭据保留)`)) {
                            deleteM.mutate(node.ID)
                          }
                        }}
                      >
                        <Trash2 className='mr-1 h-3 w-3' />
                        删除
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* 创建对话框 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className='sm:max-w-2xl'>
          <DialogHeader>
            <DialogTitle>新增路由出站</DialogTitle>
            <DialogDescription>
              选择父物理节点,定义出站配置。后端会自动创建占位 admin client + outbound + routing rule。
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-4'>
            <div className='space-y-2'>
              <Label>父物理节点</Label>
              <Select value={parentId} onValueChange={setParentId}>
                <SelectTrigger>
                  <SelectValue placeholder='选择父节点' />
                </SelectTrigger>
                <SelectContent>
                  {physicalNodes.map((n) => (
                    <SelectItem key={n.id} value={String(n.id)}>
                      #{n.id} {n.node_name} ({n.original_server} / {n.inbound_tag})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className='space-y-2'>
              <Label>Label</Label>
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder='WTT / HKBN / DIRECT'
              />
              <p className='text-xs text-muted-foreground'>
                只允许 [a-zA-Z0-9-] 长度 2-32;用于生成 outbound tag 与 admin email。
              </p>
            </div>
            <div className='space-y-2'>
              <Label>Outbound 配置 (JSON)</Label>
              <textarea
                className='font-mono text-xs w-full min-h-[220px] rounded-md border border-input bg-background p-3'
                value={outboundJSON}
                onChange={(e) => setOutboundJSON(e.target.value)}
              />
              <p className='text-xs text-muted-foreground'>
                xray outbound 完整定义(无需 tag,由后端自动生成 namespacedTag)。
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant='outline' onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => createM.mutate()}
              disabled={!parentId || !label || createM.isPending}
            >
              {createM.isPending ? '创建中...' : '创建'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Admin 凭据预览 */}
      <Dialog open={!!credPreview} onOpenChange={(v) => !v && setCredPreview(null)}>
        <DialogContent className='sm:max-w-xl'>
          <DialogHeader>
            <DialogTitle>Admin 占位凭据</DialogTitle>
            <DialogDescription>
              管理员可用此凭据直接测试该 routed 出站是否可用(不影响用户)。
            </DialogDescription>
          </DialogHeader>
          {credPreview && (
            <div className='space-y-3'>
              <div>
                <div className='flex items-center justify-between mb-1'>
                  <Label className='text-xs'>Email</Label>
                  <Button size='sm' variant='ghost' className='h-6 px-2' onClick={() => copyText(credPreview.RoutedAdminEmail)}>
                    <Copy className='h-3 w-3' />
                  </Button>
                </div>
                <div className='text-xs bg-muted p-2 rounded font-mono break-all'>
                  {credPreview.RoutedAdminEmail}
                </div>
              </div>
              <div>
                <div className='flex items-center justify-between mb-1'>
                  <Label className='text-xs'>Credential JSON</Label>
                  <Button size='sm' variant='ghost' className='h-6 px-2' onClick={() => copyText(credPreview.RoutedAdminCredential)}>
                    <Copy className='h-3 w-3' />
                  </Button>
                </div>
                <div className='text-xs bg-muted p-2 rounded font-mono break-all whitespace-pre-wrap max-h-48 overflow-auto'>
                  {credPreview.RoutedAdminCredential}
                </div>
              </div>
              <div>
                <div className='flex items-center justify-between mb-1'>
                  <Label className='text-xs'>Outbound JSON</Label>
                  <Button size='sm' variant='ghost' className='h-6 px-2' onClick={() => copyText(credPreview.RoutedOutboundJSON)}>
                    <Copy className='h-3 w-3' />
                  </Button>
                </div>
                <div className='text-xs bg-muted p-2 rounded font-mono break-all whitespace-pre-wrap max-h-48 overflow-auto'>
                  {credPreview.RoutedOutboundJSON}
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setCredPreview(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
