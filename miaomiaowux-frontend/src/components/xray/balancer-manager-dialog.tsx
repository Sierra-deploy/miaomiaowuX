// @ts-nocheck
// 负载均衡器(balancer)管理弹窗。服务管理(routing-panel) 与 节点管理(node-routing-dialog) 共用。
// 通过 set action 写回整个 routing(保留 rules) + 派生顶层 observatory/burstObservatory。
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api } from '@/lib/api'
import { handleServerError } from '@/lib/handle-server-error'
import { type Balancer, DEFAULT_PROBE_URL, DEFAULT_PROBE_INTERVAL, normalizeBalancers, toXrayBalancers, buildObservatory } from '@/lib/xray-balancer'

interface BalancerManagerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  serverId: number
  routing: any           // 当前 routing 对象(含 rules),set 时透传保留
  outbounds: any[]        // 可纳入 selector 的出站列表 [{tag, protocol}]
  onSaved: () => void     // 保存成功后回调(调用方负责刷新 routing 查询 + 重启 xray)
}

export function BalancerManagerDialog({ open, onOpenChange, serverId, routing, outbounds, onSaved }: BalancerManagerDialogProps) {
  const { t } = useTranslation('xray')
  const { t: tc } = useTranslation('common')

  const balancers: Balancer[] = useMemo(() => normalizeBalancers(routing?.balancers), [routing])

  const [tag, setTag] = useState('')
  const [selector, setSelector] = useState<string[]>([])
  const [strategy, setStrategy] = useState<Balancer['strategy']>('roundRobin')
  const [fallback, setFallback] = useState('')
  const [probeURL, setProbeURL] = useState(DEFAULT_PROBE_URL)
  const [probeInterval, setProbeInterval] = useState(DEFAULT_PROBE_INTERVAL)

  const reset = () => {
    setTag(''); setSelector([]); setStrategy('roundRobin'); setFallback('')
    setProbeURL(DEFAULT_PROBE_URL); setProbeInterval(DEFAULT_PROBE_INTERVAL)
  }

  const saveMutation = useMutation({
    mutationFn: async (newBalancers: Balancer[]) => {
      const payload: any = {
        action: 'set',
        routing: { ...routing, balancers: toXrayBalancers(newBalancers) },
        observatory: buildObservatory(newBalancers, 'leastPing'),
        burstObservatory: buildObservatory(newBalancers, 'leastLoad'),
      }
      return (await api.post(`/api/admin/remote/routing?server_id=${serverId}`, payload)).data
    },
    onSuccess: (data) => {
      if (data.success) { onSaved(); toast.success(t('routing.balancerSaved')); reset() }
      else toast.error(data.message || t('routing.balancerSaveFailed'))
    },
    onError: handleServerError,
  })

  const handleAdd = () => {
    const tg = tag.trim()
    if (!tg) { toast.error(t('routing.balancerTagRequired')); return }
    if (balancers.some(b => b.tag === tg)) { toast.error(t('routing.balancerTagDup')); return }
    if (selector.length < 2) { toast.error(t('routing.balancerSelectorMin')); return }
    const b: Balancer = { tag: tg, selector, strategy }
    if (fallback) b.fallbackTag = fallback
    if (strategy === 'leastPing' || strategy === 'leastLoad') {
      b.probeURL = probeURL.trim() || DEFAULT_PROBE_URL
      b.probeInterval = probeInterval.trim() || DEFAULT_PROBE_INTERVAL
    }
    saveMutation.mutate([...balancers, b])
  }

  const handleDelete = (tg: string) => saveMutation.mutate(balancers.filter(b => b.tag !== tg))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-lg max-h-[85vh] flex flex-col'>
        <DialogHeader>
          <DialogTitle>{t('routing.balancerTitle')}</DialogTitle>
          <DialogDescription>{t('routing.balancerDesc')}</DialogDescription>
        </DialogHeader>
        <div className='flex-1 overflow-y-auto space-y-4 py-2'>
          <div className='space-y-1.5'>
            <Label className='text-xs'>{t('routing.balancerExisting', { count: balancers.length })}</Label>
            {balancers.length === 0 ? (
              <p className='text-xs text-muted-foreground'>{t('routing.balancerNone')}</p>
            ) : balancers.map((b) => (
              <div key={b.tag} className='flex items-center justify-between rounded-md border px-3 py-1.5 text-xs'>
                <div className='min-w-0'>
                  <span className='font-medium'>⚖ {b.tag}</span>
                  <span className='text-muted-foreground'> · {b.strategy} · {(b.selector || []).join(', ')}</span>
                </div>
                <Button variant='ghost' size='sm' className='h-6 text-red-600 hover:text-red-700 shrink-0' onClick={() => handleDelete(b.tag)} disabled={saveMutation.isPending}>
                  <Trash2 className='size-3.5' />
                </Button>
              </div>
            ))}
          </div>

          <div className='border-t pt-3 space-y-3'>
            <Label className='text-xs font-medium'>{t('routing.balancerAdd')}</Label>
            <div className='grid grid-cols-2 gap-3'>
              <div className='space-y-1'>
                <Label className='text-xs'>tag *</Label>
                <Input placeholder='lb-proxy' value={tag} onChange={e => setTag(e.target.value)} className='text-xs' />
              </div>
              <div className='space-y-1'>
                <Label className='text-xs'>{t('routing.balancerStrategy')}</Label>
                <Select value={strategy} onValueChange={v => setStrategy(v as Balancer['strategy'])}>
                  <SelectTrigger className='text-xs'><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value='random'>random</SelectItem>
                    <SelectItem value='roundRobin'>roundRobin</SelectItem>
                    <SelectItem value='leastPing'>leastPing</SelectItem>
                    <SelectItem value='leastLoad'>leastLoad</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className='space-y-1'>
              <Label className='text-xs'>{t('routing.balancerSelector')} *</Label>
              <div className='border rounded-md p-2 max-h-40 overflow-y-auto space-y-1'>
                {outbounds.length === 0 ? (
                  <p className='text-xs text-muted-foreground'>{t('routing.balancerNoOutbound')}</p>
                ) : outbounds.map((o: any) => {
                  const checked = selector.includes(o.tag)
                  return (
                    <label key={o.tag} className='flex items-center gap-2 text-xs cursor-pointer'>
                      <input type='checkbox' checked={checked} onChange={() => setSelector(prev => checked ? prev.filter(x => x !== o.tag) : [...prev, o.tag])} />
                      <span>{o.tag} <span className='text-muted-foreground'>({o.protocol})</span></span>
                    </label>
                  )
                })}
              </div>
              <p className='text-[11px] text-muted-foreground'>{t('routing.balancerSelectorHint')}</p>
            </div>
            <div className='space-y-1'>
              <Label className='text-xs'>{t('routing.balancerFallback')}</Label>
              <Select value={fallback || '__none__'} onValueChange={v => setFallback(v === '__none__' ? '' : v)}>
                <SelectTrigger className='text-xs'><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value='__none__'>{t('routing.notSet')}</SelectItem>
                  {outbounds.map((o: any) => <SelectItem key={o.tag} value={o.tag}>{o.tag}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {(strategy === 'leastPing' || strategy === 'leastLoad') && (
              <div className='grid grid-cols-2 gap-3'>
                <div className='space-y-1'>
                  <Label className='text-xs'>probeURL</Label>
                  <Input value={probeURL} onChange={e => setProbeURL(e.target.value)} className='text-xs' />
                </div>
                <div className='space-y-1'>
                  <Label className='text-xs'>probeInterval</Label>
                  <Input value={probeInterval} onChange={e => setProbeInterval(e.target.value)} className='text-xs' />
                </div>
                <p className='col-span-2 text-[11px] text-muted-foreground'>{t('routing.balancerObservatoryHint')}</p>
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant='outline' onClick={() => onOpenChange(false)}>{tc('actions.close')}</Button>
          <Button onClick={handleAdd} disabled={saveMutation.isPending}>{t('routing.addBtn')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
