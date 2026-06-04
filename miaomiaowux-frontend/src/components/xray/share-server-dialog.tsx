// @ts-nocheck
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Copy, Trash2, Plus } from 'lucide-react'
import { api } from '@/lib/api'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import { ProFeatureGate } from '@/components/pro-feature-gate'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface ShareServerDialogProps {
  server: { id: number; name: string } | null
  onClose: () => void
}

// 拥有方:为某台服务器生成/管理分享令牌(PRO)。其他妙妙屋X主控用「拥有方地址 + 分享令牌」接入。
export function ShareServerDialog({ server, onClose }: ShareServerDialogProps) {
  const queryClient = useQueryClient()
  const [newToken, setNewToken] = useState('')
  const ownerURL = typeof window !== 'undefined' ? window.location.origin : ''

  const { data: sharesData } = useQuery({
    queryKey: ['server-shares', server?.id],
    queryFn: async () => {
      const res = await api.get(`/api/admin/server-share/list?server_id=${server!.id}`)
      return res.data as { shares: { id: number; label: string; created_at: string }[] }
    },
    enabled: !!server,
  })

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await api.post('/api/admin/server-share/create', { server_id: server!.id })
      return res.data as { share_token: string }
    },
    onSuccess: (data) => {
      setNewToken(data.share_token)
      toast.success('分享令牌已生成，请立即复制保存（仅显示一次）')
      queryClient.invalidateQueries({ queryKey: ['server-shares', server?.id] })
    },
    onError: (e: any) => {
      toast.error(e?.response?.data?.error || e?.response?.data?.message || '生成失败')
    },
  })

  const revokeMutation = useMutation({
    mutationFn: async (id: number) => {
      await api.post('/api/admin/server-share/revoke', { id })
    },
    onSuccess: () => {
      toast.success('已吊销')
      queryClient.invalidateQueries({ queryKey: ['server-shares', server?.id] })
    },
    onError: () => toast.error('吊销失败'),
  })

  const copyToClipboard = useCopyToClipboard()
  const copy = (text: string, label: string) => copyToClipboard(text, { success: `${label}已复制`, failure: '复制失败' })

  return (
    <Dialog open={!!server} onOpenChange={(open) => { if (!open) { setNewToken(''); onClose() } }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>分享服务器 · {server?.name}</DialogTitle>
          <DialogDescription>
            生成分享令牌后，把「拥有方地址 + 分享令牌」交给对方，对方在「服务管理 → 接入分享服务器」即可接入。被分享方默认拥有该服务器的全部远程操作权限。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs">拥有方地址</Label>
            <div className="flex gap-2">
              <Input readOnly value={ownerURL} className="font-mono text-xs" />
              <Button variant="outline" size="icon" className="shrink-0" onClick={() => copy(ownerURL, '地址')}><Copy className="h-4 w-4" /></Button>
            </div>
          </div>

          {newToken && (
            <div className="space-y-1.5">
              <Label className="text-xs text-primary">新分享令牌（仅显示一次，请立即复制）</Label>
              <div className="flex gap-2">
                <Input readOnly value={newToken} className="font-mono text-xs" />
                <Button variant="outline" size="icon" className="shrink-0" onClick={() => copy(newToken, '令牌')}><Copy className="h-4 w-4" /></Button>
              </div>
            </div>
          )}

          <ProFeatureGate feature="server_share">
            <Button onClick={() => createMutation.mutate()} disabled={createMutation.isPending} className="w-full">
              <Plus className="h-4 w-4 mr-1" />{createMutation.isPending ? '生成中…' : '生成分享令牌'}
            </Button>
          </ProFeatureGate>

          <div className="space-y-2">
            <Label className="text-xs">已分享（{sharesData?.shares?.length ?? 0}）</Label>
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {(sharesData?.shares ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">暂无分享。</p>
              ) : (
                (sharesData?.shares ?? []).map((s) => (
                  <div key={s.id} className="flex items-center justify-between rounded-md border px-3 py-1.5 text-xs">
                    <span className="text-muted-foreground">#{s.id} · {new Date(s.created_at).toLocaleString()}</span>
                    <Button variant="ghost" size="sm" className="h-6 text-red-600 hover:text-red-700" onClick={() => revokeMutation.mutate(s.id)} disabled={revokeMutation.isPending}>
                      <Trash2 className="h-3.5 w-3.5 mr-1" />吊销
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
