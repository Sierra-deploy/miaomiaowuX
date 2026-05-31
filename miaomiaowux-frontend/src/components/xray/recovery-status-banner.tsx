import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AlertTriangle, RotateCcw, CheckCircle, RefreshCw } from 'lucide-react'

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { api } from '@/lib/api'
import { handleServerError } from '@/lib/handle-server-error'

type Props = {
  serverId: number
  serverName: string
  serverStatus: string
}

type RecoveryStatusResp = {
  has_pending: boolean
  has_current: boolean
  pending?: { id: number; config_hash: string; source: string; created_at: string }
  current?: { id: number; config_hash: string; source: string; created_at: string }
}

// RecoveryStatusBanner: agent 重连后若上报 xray config 与主控 current 不一致,
// 主控写入 pending_recovery 等待决策。此组件轮询 recovery-status,有 pending 时显示提示 + 决策对话。
// 只在 server 已连接时启用 — 离线状态下用户在另一个 Popover 触发恢复流程。
export function RecoveryStatusBanner({ serverId, serverName, serverStatus }: Props) {
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)

  const { data } = useQuery({
    queryKey: ['xray-recovery-status', serverId],
    queryFn: async () => {
      const resp = await api.get(`/api/admin/xray-snapshots/recovery-status?server_id=${serverId}`)
      return resp.data as RecoveryStatusResp
    },
    enabled: serverStatus === 'connected',
    refetchInterval: 15 * 1000, // 15s 轮询足够,这是低频事件
    staleTime: 10 * 1000,
  })

  const applyMutation = useMutation({
    mutationFn: async () => {
      const resp = await api.post(`/api/admin/xray-snapshots/recovery-apply?server_id=${serverId}`)
      return resp.data
    },
    onSuccess: () => {
      toast.success('已应用主控配置到 Agent')
      setDialogOpen(false)
      queryClient.invalidateQueries({ queryKey: ['xray-recovery-status', serverId] })
      queryClient.invalidateQueries({ queryKey: ['xray-snapshots', serverId] })
    },
    onError: handleServerError,
  })

  const acceptMutation = useMutation({
    mutationFn: async () => {
      const resp = await api.post(`/api/admin/xray-snapshots/recovery-accept?server_id=${serverId}`)
      return resp.data
    },
    onSuccess: () => {
      toast.success('已接受 Agent 当前配置为新版本')
      setDialogOpen(false)
      queryClient.invalidateQueries({ queryKey: ['xray-recovery-status', serverId] })
      queryClient.invalidateQueries({ queryKey: ['xray-snapshots', serverId] })
    },
    onError: handleServerError,
  })

  if (!data?.has_pending) return null

  return (
    <>
      <Badge
        variant="destructive"
        className="cursor-pointer gap-1 animate-pulse"
        onClick={(e) => { e.stopPropagation(); setDialogOpen(true) }}
        title="点击处理"
      >
        <AlertTriangle className="h-3 w-3" />待恢复
      </Badge>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-xl" onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-amber-500" />配置漂移待处理 - {serverName}</DialogTitle>
            <DialogDescription className="leading-relaxed">
              该服务器离线后重新上线,Agent 上报的 xray 配置与主控记录的最后版本不一致。两个常见原因:
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 text-sm">
            <div className="rounded-lg border bg-muted/30 p-3 space-y-1">
              <div className="font-medium">情况 A:你在新 VPS 上重新装了 Agent</div>
              <div className="text-xs text-muted-foreground">→ 选「应用主控配置」,把最后一次成功的配置覆盖到新 Agent。</div>
            </div>
            <div className="rounded-lg border bg-muted/30 p-3 space-y-1">
              <div className="font-medium">情况 B:你 SSH 上去手动修复了配置</div>
              <div className="text-xs text-muted-foreground">→ 选「接受 Agent 现状」,把当前 Agent 配置确认为新的主控记录。</div>
            </div>

            {data?.current && (
              <div className="rounded-lg border p-2 text-xs">
                <div><strong>主控当前:</strong> <span className="font-mono">{data.current.config_hash.slice(0, 12)}…</span> · {new Date(data.current.created_at).toLocaleString()}</div>
              </div>
            )}
            {data?.pending && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-900/20 p-2 text-xs">
                <div><strong>Agent 上报:</strong> <span className="font-mono">{data.pending.config_hash.slice(0, 12)}…</span> · {new Date(data.pending.created_at).toLocaleString()}</div>
              </div>
            )}
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>稍后处理</Button>
            <Button
              variant="secondary"
              onClick={() => acceptMutation.mutate()}
              disabled={acceptMutation.isPending || applyMutation.isPending}
            >
              {acceptMutation.isPending ? <RefreshCw className="h-3.5 w-3.5 mr-1 animate-spin" /> : <CheckCircle className="h-3.5 w-3.5 mr-1" />}
              接受 Agent 现状
            </Button>
            <Button
              onClick={() => applyMutation.mutate()}
              disabled={acceptMutation.isPending || applyMutation.isPending}
            >
              {applyMutation.isPending ? <RefreshCw className="h-3.5 w-3.5 mr-1 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5 mr-1" />}
              应用主控配置
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
