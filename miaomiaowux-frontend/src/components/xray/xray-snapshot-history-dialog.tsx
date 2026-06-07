import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { History, Download, FileText, RotateCcw, RefreshCw } from 'lucide-react'

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { handleServerError } from '@/lib/handle-server-error'
import { cn } from '@/lib/utils'

type SnapshotItem = {
  id: number
  config_hash: string
  source: string
  status: string
  created_at: string
  size_bytes: number
  config_json?: string
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  serverId: number | null
  serverName: string
  previewId: number | null
  previewConfig: string
  onPreview: (id: number, config: string) => void
}

function sourceLabel(s: string): string {
  switch (s) {
    case 'agent_report': return 'Agent 上报'
    case 'master_write': return '主控修改'
    case 'manual_accept': return '手动接受'
    default: return s
  }
}

function statusLabel(s: string): string {
  switch (s) {
    case 'current': return '当前'
    case 'old': return '历史'
    case 'pending_recovery': return '待恢复'
    default: return s
  }
}

function statusBadgeVariant(s: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (s) {
    case 'current': return 'default'
    case 'pending_recovery': return 'destructive'
    default: return 'secondary'
  }
}

export function XraySnapshotHistoryDialog({ open, onOpenChange, serverId, serverName, previewId, previewConfig, onPreview }: Props) {
  const queryClient = useQueryClient()
  const [restoringId, setRestoringId] = useState<number | null>(null)

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['xray-snapshots', serverId],
    queryFn: async () => {
      const resp = await api.get(`/api/admin/xray-snapshots/list?server_id=${serverId}`)
      return resp.data as { items: SnapshotItem[]; total: number }
    },
    enabled: open && serverId !== null,
    staleTime: 5 * 1000,
  })

  const previewMutation = useMutation({
    mutationFn: async (snapshotId: number) => {
      const resp = await api.get(`/api/admin/xray-snapshots/list?server_id=${serverId}&with_config=true`)
      const items = resp.data?.items as SnapshotItem[]
      const found = items?.find(s => s.id === snapshotId)
      if (!found) throw new Error('snapshot not found')
      return { id: snapshotId, config: found.config_json || '' }
    },
    onSuccess: (r) => {
      // 美化 JSON 后展示
      try {
        onPreview(r.id, JSON.stringify(JSON.parse(r.config), null, 2))
      } catch {
        onPreview(r.id, r.config)
      }
    },
    onError: handleServerError,
  })

  const restoreMutation = useMutation({
    mutationFn: async (snapshotId: number) => {
      setRestoringId(snapshotId)
      const resp = await api.post(`/api/admin/xray-snapshots/restore?snapshot_id=${snapshotId}`)
      return resp.data
    },
    onSuccess: () => {
      toast.success('已下发到 Agent,Xray 会自动重载')
      queryClient.invalidateQueries({ queryKey: ['xray-snapshots', serverId] })
    },
    onError: handleServerError,
    onSettled: () => setRestoringId(null),
  })

  const items = data?.items || []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 宽度策略:手机端贴 viewport(默认 calc(100%-2rem)),sm 及以上才放宽到 5xl;
          覆盖默认的 sm:max-w-lg 必须显式带 sm: 前缀,否则 tailwind specificity 会让默认胜出 */}
      <DialogContent className="w-[95vw] max-w-[95vw] sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base sm:text-lg"><History className="h-4 w-4" />配置历史 - {serverName}</DialogTitle>
          <DialogDescription className="text-xs sm:text-sm">主控保存的所有 xray 配置版本。可预览任意历史快照,也可一键下发到 Agent(下发前会自动跑 xray test 验证)。</DialogDescription>
        </DialogHeader>

        {/* 手机端单列、md 5 列网格 — 左 3 / 右 2;手机端把预览塞在列表下面 */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          {/* 左侧: 历史列表 */}
          <div className="md:col-span-3 flex flex-col gap-2 min-h-0">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">历史列表 ({items.length})</div>
              <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isLoading}>
                <RefreshCw className={cn('h-3.5 w-3.5 mr-1', isLoading && 'animate-spin')} />刷新
              </Button>
            </div>
            {/* overflow-x-auto:窄屏下让 5 列 table 出横向滚动,不挤压;
                max-h-[420px] sm:max-h-[480px]:手机端预留更多 viewport 给底部按钮 */}
            <div className="rounded-lg border max-h-[420px] sm:max-h-[480px] overflow-auto">
              <Table className="min-w-[560px]">
                <TableHeader className="sticky top-0 bg-background">
                  <TableRow>
                    <TableHead className="w-24">状态</TableHead>
                    <TableHead>时间</TableHead>
                    <TableHead>来源</TableHead>
                    <TableHead className="font-mono text-xs">Hash</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.length === 0 ? (
                    <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-6">{isLoading ? '加载中...' : '暂无历史快照'}</TableCell></TableRow>
                  ) : items.map(s => (
                    <TableRow key={s.id} className={cn(previewId === s.id && 'bg-muted/50')}>
                      <TableCell>
                        <Badge variant={statusBadgeVariant(s.status)}>{statusLabel(s.status)}</Badge>
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{new Date(s.created_at).toLocaleString()}</TableCell>
                      <TableCell className="text-xs">{sourceLabel(s.source)}</TableCell>
                      <TableCell className="font-mono text-xs">{s.config_hash.slice(0, 10)}…</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="sm" onClick={() => previewMutation.mutate(s.id)} disabled={previewMutation.isPending}>
                            <FileText className="h-3.5 w-3.5 mr-1" />预览
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={s.status === 'current' || restoreMutation.isPending}
                            title={s.status === 'current' ? '当前配置无需下发' : '下发此版本到 Agent'}
                            onClick={() => {
                              if (!confirm(`确定要把这个版本下发到 ${serverName} 吗?\n配置会先经过 xray test 验证,通过才下发。`)) return
                              restoreMutation.mutate(s.id)
                            }}
                          >
                            {restoringId === s.id ? <RefreshCw className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Download className="h-3.5 w-3.5 mr-1" />}
                            下发
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>

          {/* 右侧: 配置预览 */}
          <div className="md:col-span-2 flex flex-col gap-2 min-h-0">
            <div className="text-sm font-medium">
              {previewId === null ? '配置预览' : `预览 #${previewId}`}
            </div>
            <Textarea
              value={previewConfig}
              readOnly
              placeholder="点击列表里的「预览」查看配置内容"
              className="font-mono text-xs flex-1 min-h-[260px] sm:min-h-[400px] max-h-[420px] sm:max-h-[480px] resize-none"
            />
            {previewId !== null && (
              <Button
                variant="default"
                size="sm"
                disabled={restoreMutation.isPending}
                onClick={() => {
                  if (!confirm(`确定要把版本 #${previewId} 下发到 ${serverName} 吗?\n配置会先经过 xray test 验证,通过才下发。`)) return
                  restoreMutation.mutate(previewId)
                }}
              >
                <RotateCcw className="h-3.5 w-3.5 mr-1" />下发此版本
              </Button>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
