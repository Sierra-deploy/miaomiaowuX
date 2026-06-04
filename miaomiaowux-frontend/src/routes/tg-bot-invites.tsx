// @ts-nocheck
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { toast } from 'sonner'
import { Topbar } from '@/components/layout/topbar'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

type Invite = {
  code: string
  kind: 'new' | 'bind'
  bind_username?: string
  created_by: string
  package_id?: number
  max_uses: number
  used_count: number
  expires_at?: string
  revoked: boolean
  remark?: string
  created_at: string
  usable: boolean
}

export const Route = createFileRoute('/tg-bot-invites')({
  beforeLoad: () => {
    const token = useAuthStore.getState().auth.accessToken
    if (!token) throw redirect({ to: '/' })
  },
  component: TGBotInvitesPage,
})

function TGBotInvitesPage() {
  const qc = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState({
    kind: 'new' as 'new' | 'bind',
    bind_username: '',
    package_id: '',
    max_uses: 1,
    expires_at: '',
    remark: '',
  })

  const { data: invites, isLoading } = useQuery({
    queryKey: ['tg-bot-invites'],
    queryFn: async () => (await api.get<{ items: Invite[] }>('/api/admin/tgbot/invites')).data.items ?? [],
  })

  const { data: packages } = useQuery({
    queryKey: ['packages-for-invite'],
    queryFn: async () => (await api.get('/api/admin/packages')).data ?? [],
  })

  const createMut = useMutation({
    mutationFn: async () => {
      const body: any = { kind: form.kind, max_uses: Number(form.max_uses) || 1, remark: form.remark }
      if (form.kind === 'bind') body.bind_username = form.bind_username.trim()
      if (form.package_id) body.package_id = Number(form.package_id)
      if (form.expires_at) body.expires_at = new Date(form.expires_at).toISOString()
      const res = await api.post('/api/admin/tgbot/invites', body)
      return res.data
    },
    onSuccess: (data) => {
      toast.success('邀请码已创建: ' + data.code)
      navigator.clipboard?.writeText(data.code).catch(() => {})
      setCreateOpen(false)
      setForm({ kind: 'new', bind_username: '', package_id: '', max_uses: 1, expires_at: '', remark: '' })
      qc.invalidateQueries({ queryKey: ['tg-bot-invites'] })
    },
    onError: (e: any) => toast.error(e?.response?.data?.error || e?.message || '创建失败'),
  })

  const revokeMut = useMutation({
    mutationFn: async (code: string) => api.post('/api/admin/tgbot/invites/revoke', { code }),
    onSuccess: () => {
      toast.success('已撤销')
      qc.invalidateQueries({ queryKey: ['tg-bot-invites'] })
    },
    onError: (e: any) => toast.error(e?.response?.data?.error || e?.message || '撤销失败'),
  })

  return (
    <div className='flex flex-col min-h-screen'>
      <Topbar />
      <div className='flex-1 container mx-auto py-6 px-4 space-y-6 max-w-6xl'>
        <Card>
          <CardHeader className='flex flex-row items-center justify-between'>
            <div>
              <CardTitle>TG 机器人邀请码</CardTitle>
              <CardDescription>
                生成给 TG 用户用的邀请码。kind=new 创建新账号,kind=bind 绑定到已有 username。
                用户在 TG 里 /start &lt;code&gt; 触发。
              </CardDescription>
            </div>
            <Button onClick={() => setCreateOpen(true)}>新建邀请码</Button>
          </CardHeader>
          <CardContent>
            {isLoading && <div className='text-muted-foreground text-sm'>加载中...</div>}
            {!isLoading && (invites?.length ?? 0) === 0 && (
              <div className='text-muted-foreground text-sm py-6 text-center'>暂无邀请码</div>
            )}
            {!isLoading && (invites?.length ?? 0) > 0 && (
              <div className='overflow-x-auto'>
                <table className='w-full text-sm'>
                  <thead>
                    <tr className='border-b'>
                      <th className='text-left py-2 px-2'>码</th>
                      <th className='text-left py-2 px-2'>类型</th>
                      <th className='text-left py-2 px-2'>绑定</th>
                      <th className='text-left py-2 px-2'>套餐</th>
                      <th className='text-left py-2 px-2'>用量</th>
                      <th className='text-left py-2 px-2'>到期</th>
                      <th className='text-left py-2 px-2'>状态</th>
                      <th className='text-left py-2 px-2'>备注</th>
                      <th className='py-2 px-2'></th>
                    </tr>
                  </thead>
                  <tbody>
                    {invites!.map((inv) => (
                      <tr key={inv.code} className='border-b hover:bg-muted/50'>
                        <td className='py-2 px-2 font-mono'>
                          <span className='cursor-pointer' onClick={() => {
                            navigator.clipboard?.writeText(inv.code).catch(() => {})
                            toast.success('已复制')
                          }}>{inv.code}</span>
                        </td>
                        <td className='py-2 px-2'>
                          <Badge variant={inv.kind === 'new' ? 'default' : 'secondary'}>{inv.kind}</Badge>
                        </td>
                        <td className='py-2 px-2 text-muted-foreground'>{inv.bind_username || '-'}</td>
                        <td className='py-2 px-2 text-muted-foreground'>
                          {inv.package_id ? `#${inv.package_id}` : '-'}
                        </td>
                        <td className='py-2 px-2 text-muted-foreground'>{inv.used_count} / {inv.max_uses}</td>
                        <td className='py-2 px-2 text-muted-foreground'>
                          {inv.expires_at ? new Date(inv.expires_at).toLocaleString() : '永不'}
                        </td>
                        <td className='py-2 px-2'>
                          {inv.revoked ? <Badge variant='destructive'>已撤销</Badge>
                            : inv.usable ? <Badge variant='outline'>可用</Badge>
                              : <Badge variant='secondary'>已耗尽</Badge>}
                        </td>
                        <td className='py-2 px-2 text-muted-foreground max-w-[200px] truncate'>{inv.remark || '-'}</td>
                        <td className='py-2 px-2 text-right'>
                          {!inv.revoked && (
                            <Button size='sm' variant='ghost' onClick={() => revokeMut.mutate(inv.code)}>撤销</Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建邀请码</DialogTitle>
          </DialogHeader>
          <div className='space-y-3'>
            <div className='space-y-1'>
              <Label>类型</Label>
              <div className='flex gap-2'>
                <Button type='button' size='sm' variant={form.kind === 'new' ? 'default' : 'outline'}
                  onClick={() => setForm((f) => ({ ...f, kind: 'new' }))}>new (创建账号)</Button>
                <Button type='button' size='sm' variant={form.kind === 'bind' ? 'default' : 'outline'}
                  onClick={() => setForm((f) => ({ ...f, kind: 'bind' }))}>bind (绑定已有)</Button>
              </div>
            </div>
            {form.kind === 'bind' && (
              <div className='space-y-1'>
                <Label>bind_username (必填)</Label>
                <Input value={form.bind_username} onChange={(e) => setForm((f) => ({ ...f, bind_username: e.target.value }))} />
              </div>
            )}
            <div className='space-y-1'>
              <Label>套餐 (可选, 仅 kind=new 时生效)</Label>
              <select className='w-full border rounded h-9 px-2 bg-background' value={form.package_id}
                onChange={(e) => setForm((f) => ({ ...f, package_id: e.target.value }))}>
                <option value=''>不预绑</option>
                {(packages as any[])?.map((p: any) => (
                  <option key={p.id} value={p.id}>{p.name} ({p.traffic_limit_gb}GB / {p.cycle_days}天)</option>
                ))}
              </select>
            </div>
            <div className='space-y-1'>
              <Label>max_uses (默认 1)</Label>
              <Input type='number' min={1} value={form.max_uses}
                onChange={(e) => setForm((f) => ({ ...f, max_uses: Number(e.target.value) }))} />
            </div>
            <div className='space-y-1'>
              <Label>过期时间 (留空 = 永不)</Label>
              <Input type='datetime-local' value={form.expires_at}
                onChange={(e) => setForm((f) => ({ ...f, expires_at: e.target.value }))} />
            </div>
            <div className='space-y-1'>
              <Label>备注</Label>
              <Input value={form.remark} onChange={(e) => setForm((f) => ({ ...f, remark: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant='outline'>取消</Button>
            </DialogClose>
            <Button onClick={() => createMut.mutate()} disabled={createMut.isPending
              || (form.kind === 'bind' && !form.bind_username.trim())}>
              {createMut.isPending ? '创建中...' : '创建'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
