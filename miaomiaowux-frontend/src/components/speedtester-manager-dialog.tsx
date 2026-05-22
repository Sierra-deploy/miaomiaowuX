// @ts-nocheck
// 家用测速端管理(PRO speed_test Phase 2):配对(生成令牌+运行命令)、列表(在线状态)、吊销。
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Copy, Trash2, Plus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api } from '@/lib/api'

export function SpeedTesterManagerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation('nodes')
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [newToken, setNewToken] = useState('')
  const masterURL = typeof window !== 'undefined' ? window.location.origin : ''

  const { data, isLoading } = useQuery({
    queryKey: ['speed-testers'],
    queryFn: async () => (await api.get('/api/admin/speedtest/testers')).data as { testers: any[] },
    enabled: open,
    refetchInterval: open ? 5000 : false,
  })

  const createMut = useMutation({
    mutationFn: async () => (await api.post('/api/admin/speedtest/testers/create', { name: name.trim() || 'home-tester' })).data,
    onSuccess: (d) => { setNewToken(d.token); setName(''); qc.invalidateQueries({ queryKey: ['speed-testers'] }); toast.success(t('speedtest.testerCreated')) },
    onError: (e: any) => toast.error(e?.response?.data?.error || t('speedtest.testerCreateFailed')),
  })
  const revokeMut = useMutation({
    mutationFn: async (id: number) => (await api.post('/api/admin/speedtest/testers/revoke', { id })).data,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['speed-testers'] }); toast.success(t('speedtest.testerRevoked')) },
    onError: () => toast.error(t('speedtest.testerRevokeFailed')),
  })

  const copy = (s: string) => navigator.clipboard?.writeText(s).then(() => toast.success(t('speedtest.copied')), () => {})
  const runCmd = newToken ? `mmwx-speedtester -master ${masterURL} -token ${newToken} -name home-tester` : ''

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) setNewToken(''); onOpenChange(o) }}>
      <DialogContent className='max-w-lg max-h-[85vh] flex flex-col'>
        <DialogHeader>
          <DialogTitle>{t('speedtest.testerManage')}</DialogTitle>
          <DialogDescription>{t('speedtest.testerManageDesc')}</DialogDescription>
        </DialogHeader>
        <div className='flex-1 overflow-y-auto space-y-4 py-2'>
          {/* 新建 */}
          <div className='flex gap-2 items-end'>
            <div className='flex-1 space-y-1'>
              <Label className='text-xs'>{t('speedtest.testerName')}</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder='home-tester' className='text-xs' />
            </div>
            <Button size='sm' onClick={() => createMut.mutate()} disabled={createMut.isPending}>
              <Plus className='size-4 mr-1' />{t('speedtest.testerCreate')}
            </Button>
          </div>

          {newToken && (
            <div className='space-y-1.5 rounded-md border border-primary/40 p-3 bg-primary/5'>
              <Label className='text-xs text-primary'>{t('speedtest.testerTokenOnce')}</Label>
              <div className='flex gap-2'>
                <Input readOnly value={newToken} className='font-mono text-xs' />
                <Button variant='outline' size='icon' className='shrink-0' onClick={() => copy(newToken)}><Copy className='h-4 w-4' /></Button>
              </div>
              <Label className='text-xs mt-1'>{t('speedtest.testerRunCmd')}</Label>
              <div className='flex gap-2'>
                <Input readOnly value={runCmd} className='font-mono text-[11px]' />
                <Button variant='outline' size='icon' className='shrink-0' onClick={() => copy(runCmd)}><Copy className='h-4 w-4' /></Button>
              </div>
              <p className='text-[11px] text-muted-foreground'>{t('speedtest.testerRunHint')}</p>
            </div>
          )}

          {/* 列表 */}
          <div className='space-y-1.5'>
            <Label className='text-xs flex items-center gap-1'>{t('speedtest.testerList')}{isLoading && <RefreshCw className='size-3 animate-spin' />}</Label>
            {(data?.testers || []).length === 0 ? (
              <p className='text-xs text-muted-foreground'>{t('speedtest.testerNone')}</p>
            ) : (data?.testers || []).map((t2: any) => (
              <div key={t2.id} className='flex items-center justify-between rounded-md border px-3 py-1.5 text-xs'>
                <div className='min-w-0'>
                  <span className='font-medium'>{t2.name || `#${t2.id}`}</span>
                  <Badge variant={t2.online ? 'default' : 'secondary'} className='ml-2 text-[10px]'>{t2.online ? t('speedtest.online') : t('speedtest.offline')}</Badge>
                </div>
                <Button variant='ghost' size='sm' className='h-6 text-red-600 hover:text-red-700 shrink-0' onClick={() => revokeMut.mutate(t2.id)} disabled={revokeMut.isPending}>
                  <Trash2 className='size-3.5' />
                </Button>
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
