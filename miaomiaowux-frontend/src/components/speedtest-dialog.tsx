// @ts-nocheck
// 节点测速工作台 dialog(PRO speed_test)。顶部选测速来源(主控/已安装测速端,默认主控);
// 表格列:协议 / 名称 / 服务器地址 / 测速结果 / 历史 / 测速;支持多选一键测速。
// 关闭语义由父级控制:点 X = 真正关闭;点外部/Esc = 收起到屏幕右侧悬浮按钮(防误关)。
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Gauge, Loader2, History, ArrowLeft, RefreshCw, Settings2, Plus, Trash2, Copy } from 'lucide-react'
import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'

const PROTOCOL_COLORS: Record<string, string> = {
  vmess: 'bg-blue-500/10 text-blue-700 dark:text-blue-400',
  vless: 'bg-purple-500/10 text-purple-700 dark:text-purple-400',
  trojan: 'bg-red-500/10 text-red-700 dark:text-red-400',
  ss: 'bg-green-500/10 text-green-700 dark:text-green-400',
  shadowsocks: 'bg-green-500/10 text-green-700 dark:text-green-400',
  hysteria2: 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-400',
  tuic: 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-400',
}

function relTime(t: string, tc: (k: string, o?: any) => string) {
  const ms = Date.now() - new Date(t).getTime()
  const s = Math.floor(ms / 1000)
  if (s < 60) return tc('time.justNow')
  const m = Math.floor(s / 60)
  if (m < 60) return tc('time.minutesAgo', { n: m })
  const h = Math.floor(m / 60)
  if (h < 24) return tc('time.hoursAgo', { n: h })
  return tc('time.daysAgo', { n: Math.floor(h / 24) })
}

// 每节点最新测速结果(有 running 时 4s 轮询)
function useLatestSpeedResults(enabled: boolean) {
  return useQuery({
    queryKey: ['speedtest-latest'],
    queryFn: async () => {
      const res = await api.get('/api/admin/speedtest/results?latest=1')
      const map: Record<number, any> = {}
      for (const r of res.data?.results || []) map[r.node_id] = r
      return map
    },
    enabled,
    refetchInterval: (q) =>
      Object.values(q.state.data || {}).some((r: any) => r?.status === 'running') ? 4000 : false,
  })
}

// 速度单元格(running 转圈 / 失败 / ↓速度)
function SpeedCell({ r, t }: { r: any; t: any }) {
  if (!r) return <span className='text-muted-foreground text-xs'>—</span>
  if (r.status === 'running')
    return (
      <span className='text-muted-foreground inline-flex items-center gap-1 whitespace-nowrap text-xs'>
        <Loader2 className='h-3 w-3 animate-spin' />{t('speedtest.testing')}
      </span>
    )
  if (r.status === 'failed')
    return <span className='text-red-600 dark:text-red-400 whitespace-nowrap text-xs' title={r.error}>{t('speedtest.failedShort')}</span>
  return (
    <span className='text-emerald-600 dark:text-emerald-400 font-mono whitespace-nowrap text-xs'>
      ↓ {Number(r.down_mbps).toFixed(1)} Mbps
    </span>
  )
}

// 延迟单元格
function LatencyCell({ r }: { r: any }) {
  if (!r || r.status !== 'ok') return <span className='text-muted-foreground text-xs'>—</span>
  return <span className='font-mono whitespace-nowrap text-xs'>{r.latency_ms} ms</span>
}

// 出口 IP 单元格(经代理观察到的对端 IP,用于核对落地/出站是否符合预期)
function EgressIPCell({ r }: { r: any }) {
  if (!r || !r.egress_ip) return <span className='text-muted-foreground text-xs'>—</span>
  return <span className='font-mono whitespace-nowrap text-xs'>{r.egress_ip}</span>
}

export function SpeedTestDialog({
  open, onMinimize, onClose, nodes,
}: {
  open: boolean
  onMinimize: () => void
  onClose: () => void
  nodes: any[]
}) {
  const { t } = useTranslation('nodes')
  const { t: tc } = useTranslation('common')
  const queryClient = useQueryClient()

  const [source, setSource] = useState<number | 'master'>('master') // 'master' 或 tester id
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [historyNode, setHistoryNode] = useState<{ id: number; name: string } | null>(null)
  const [manageTesters, setManageTesters] = useState(false)

  const { data: testersData } = useQuery({
    queryKey: ['speed-testers'],
    queryFn: async () => (await api.get('/api/admin/speedtest/testers')).data as { testers: any[] },
    enabled: open,
    staleTime: 10000,
  })
  const testers = testersData?.testers || []

  const { data: latestMap } = useLatestSpeedResults(open)

  // 解析节点 server:port
  const rows = useMemo(() => {
    return (nodes || []).map((n: any) => {
      let server = '', port = 0
      try {
        const c = JSON.parse(n.clash_config || '{}')
        server = c.server || ''
        port = Number(c.port) || 0
      } catch { /* ignore */ }
      return {
        id: n.id,
        name: n.node_name,
        protocol: (n.protocol || '').toLowerCase(),
        server,
        port,
        node_type: n.node_type as string | undefined,
        routed_outbound_tag: n.routed_outbound_tag as string | undefined,
      }
    })
  }, [nodes])

  const runTest = async (nodeIds: number[]) => {
    if (nodeIds.length === 0) return
    try {
      const body: any = {}
      if (source !== 'master') body.tester_id = source
      await Promise.all(nodeIds.map((id) => api.post('/api/admin/speedtest/run', { ...body, node_id: id })))
      toast.success(
        nodeIds.length === 1
          ? t('speedtest.started', { name: rows.find((r) => r.id === nodeIds[0])?.name || '' })
          : t('speedtest.batchStarted', { count: nodeIds.length })
      )
      queryClient.invalidateQueries({ queryKey: ['speedtest-latest'] })
    } catch (e: any) {
      toast.error(e?.response?.data?.error || t('speedtest.failed', { err: '' }))
    }
  }

  const allSelected = rows.length > 0 && selected.size === rows.length
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))
  const toggleOne = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent
        className='w-[95vw] sm:w-auto sm:!max-w-[95vw] max-h-[88vh] flex flex-col'
        onInteractOutside={(e) => { e.preventDefault(); onMinimize() }}
        onEscapeKeyDown={(e) => { e.preventDefault(); onMinimize() }}
      >
        {historyNode ? (
          <HistoryView node={historyNode} onBack={() => setHistoryNode(null)} t={t} tc={tc} />
        ) : manageTesters ? (
          <TestersView onBack={() => setManageTesters(false)} t={t} />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t('speedtest.dialogTitle')}</DialogTitle>
              <DialogDescription>{t('speedtest.dialogDesc')}</DialogDescription>
            </DialogHeader>

            {/* 测速来源选择 */}
            <div className='flex flex-wrap items-center gap-2'>
              <span className='text-muted-foreground text-sm'>{t('speedtest.source')}:</span>
              <Button
                size='sm'
                variant={source === 'master' ? 'default' : 'outline'}
                onClick={() => setSource('master')}
              >
                {t('speedtest.srcMaster')}
              </Button>
              {testers.map((x: any) => (
                <Button
                  key={x.id}
                  size='sm'
                  variant={source === x.id ? 'default' : 'outline'}
                  disabled={!x.online}
                  onClick={() => setSource(x.id)}
                  title={x.online ? '' : t('speedtest.offline')}
                >
                  {x.name}{x.online ? '' : ` (${t('speedtest.offline')})`}
                </Button>
              ))}
              <div className='ml-auto flex items-center gap-2'>
                {selected.size > 0 && (
                  <Button size='sm' onClick={() => runTest(Array.from(selected))}>
                    <Gauge className='mr-1 h-4 w-4' />
                    {t('speedtest.batchTest')} ({selected.size})
                  </Button>
                )}
                <Button size='sm' variant='outline' onClick={() => setManageTesters(true)}>
                  <Settings2 className='mr-1 h-4 w-4' />
                  {t('speedtest.testerManage')}
                </Button>
              </div>
            </div>

            {rows.length === 0 ? (
              <div className='text-muted-foreground rounded border py-10 text-center'>{t('speedtest.noNodes')}</div>
            ) : (
              <>
                {/* 桌面端:表格(速度/延迟分列) */}
                <div className='hidden max-h-[60vh] overflow-auto rounded border md:block'>
                  <table className='text-sm'>
                    <thead className='bg-muted/50 text-muted-foreground sticky top-0 text-xs'>
                      <tr>
                        <th className='w-8 p-2'><Checkbox checked={allSelected} onCheckedChange={toggleAll} /></th>
                        <th className='p-2 text-left font-normal'>{t('speedtest.colProtocol')}</th>
                        <th className='p-2 text-left font-normal'>{t('speedtest.colNode')}</th>
                        <th className='p-2 text-left font-normal'>{t('speedtest.colServer')}</th>
                        <th className='p-2 text-left font-normal'>{t('speedtest.colSpeed')}</th>
                        <th className='p-2 text-left font-normal'>{t('speedtest.colLatency')}</th>
                        <th className='p-2 text-left font-normal'>{t('speedtest.colEgressIP')}</th>
                        <th className='p-2 text-center font-normal'>{t('speedtest.colActions')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => {
                        const res = latestMap?.[r.id]
                        const running = res?.status === 'running'
                        return (
                          <tr key={r.id} className='border-t'>
                            <td className='p-2 text-center'>
                              <Checkbox checked={selected.has(r.id)} onCheckedChange={() => toggleOne(r.id)} />
                            </td>
                            <td className='p-2'>
                              <div className='flex flex-col items-start gap-0.5'>
                                <Badge variant='secondary' className={`text-[10px] ${PROTOCOL_COLORS[r.protocol] || ''}`}>
                                  {r.protocol.toUpperCase() || '?'}
                                </Badge>
                                {r.node_type === 'routed' && r.routed_outbound_tag && (
                                  <span className='text-[10px] text-indigo-600 dark:text-indigo-400 font-mono max-w-[110px] truncate' title={r.routed_outbound_tag}>
                                    ↳ {r.routed_outbound_tag.replace(/^routed:p\d+:/, '')}
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className='p-2'><div className='max-w-[280px] truncate' title={r.name}>{r.name}</div></td>
                            <td className='text-muted-foreground p-2 font-mono text-xs whitespace-nowrap'>{r.server}:{r.port}</td>
                            <td className='p-2'><SpeedCell r={res} t={t} /></td>
                            <td className='p-2'><LatencyCell r={res} /></td>
                            <td className='p-2'><EgressIPCell r={res} /></td>
                            <td className='p-2'>
                              <div className='flex items-center justify-center gap-1'>
                                <Button variant='ghost' size='icon' className='size-7 text-muted-foreground hover:text-foreground' title={t('speedtest.history')} onClick={() => setHistoryNode({ id: r.id, name: r.name })}>
                                  <History className='size-4' />
                                </Button>
                                <Button variant='ghost' size='icon' className='size-7 text-[#d97757] hover:text-[#c66647]' title={t('tooltip.speedtest')} disabled={running} onClick={() => runTest([r.id])}>
                                  {running ? <Loader2 className='size-4 animate-spin' /> : <Gauge className='size-4' />}
                                </Button>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                {/* 移动端:卡片 */}
                <div className='max-h-[60vh] space-y-2 overflow-auto md:hidden'>
                  {rows.map((r) => {
                    const res = latestMap?.[r.id]
                    const running = res?.status === 'running'
                    return (
                      <div key={r.id} className='rounded-lg border p-3'>
                        <div className='flex items-start gap-2'>
                          <Checkbox className='mt-0.5' checked={selected.has(r.id)} onCheckedChange={() => toggleOne(r.id)} />
                          <div className='min-w-0 flex-1'>
                            <div className='flex items-center gap-2'>
                              <div className='flex flex-col items-start gap-0.5 shrink-0'>
                                <Badge variant='secondary' className={`text-[10px] ${PROTOCOL_COLORS[r.protocol] || ''}`}>
                                  {r.protocol.toUpperCase() || '?'}
                                </Badge>
                                {r.node_type === 'routed' && r.routed_outbound_tag && (
                                  <span className='text-[10px] text-indigo-600 dark:text-indigo-400 font-mono max-w-[110px] truncate' title={r.routed_outbound_tag}>
                                    ↳ {r.routed_outbound_tag.replace(/^routed:p\d+:/, '')}
                                  </span>
                                )}
                              </div>
                              <span className='truncate font-medium' title={r.name}>{r.name}</span>
                            </div>
                            <div className='text-muted-foreground mt-1 font-mono text-xs break-all'>{r.server}:{r.port}</div>
                            <div className='mt-2 flex flex-wrap items-center gap-x-4 gap-y-1'>
                              <span className='text-muted-foreground text-[10px]'>{t('speedtest.colSpeed')}</span>
                              <SpeedCell r={res} t={t} />
                              <span className='text-muted-foreground text-[10px]'>{t('speedtest.colLatency')}</span>
                              <LatencyCell r={res} />
                              <span className='text-muted-foreground text-[10px]'>{t('speedtest.colEgressIP')}</span>
                              <EgressIPCell r={res} />
                            </div>
                          </div>
                          <div className='flex shrink-0 flex-col gap-1'>
                            <Button variant='ghost' size='icon' className='size-7 text-muted-foreground hover:text-foreground' title={t('speedtest.history')} onClick={() => setHistoryNode({ id: r.id, name: r.name })}>
                              <History className='size-4' />
                            </Button>
                            <Button variant='ghost' size='icon' className='size-7 text-[#d97757] hover:text-[#c66647]' title={t('tooltip.speedtest')} disabled={running} onClick={() => runTest([r.id])}>
                              {running ? <Loader2 className='size-4 animate-spin' /> : <Gauge className='size-4' />}
                            </Button>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

// 单节点历史视图(dialog 内切换,避免嵌套 dialog 触发外部点击收起)
function HistoryView({ node, onBack, t, tc }: { node: { id: number; name: string }; onBack: () => void; t: any; tc: any }) {
  const { data, isFetching, refetch } = useQuery({
    queryKey: ['speedtest-history', node.id],
    queryFn: async () => (await api.get(`/api/admin/speedtest/results?node_id=${node.id}&limit=100`)).data?.results || [],
    refetchInterval: (q) => (q.state.data || []).some((r: any) => r?.status === 'running') ? 4000 : false,
  })
  const rows = (data || []) as any[]
  return (
    <>
      <DialogHeader>
        <DialogTitle className='flex items-center gap-2'>
          <Button variant='ghost' size='icon' className='size-7' onClick={onBack}><ArrowLeft className='size-4' /></Button>
          {t('speedtest.historyOf', { name: node.name })}
        </DialogTitle>
        <DialogDescription>{t('speedtest.historyDesc')}</DialogDescription>
      </DialogHeader>
      <div className='flex justify-end'>
        <Button variant='ghost' size='sm' onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
        </Button>
      </div>
      <div className='max-h-[55vh] overflow-auto'>
        {rows.length === 0 ? (
          <div className='text-muted-foreground py-12 text-center text-sm'>{t('speedtest.historyEmpty')}</div>
        ) : (
          <table className='w-full text-sm'>
            <thead className='text-muted-foreground sticky top-0 bg-background text-xs'>
              <tr className='border-b'>
                <th className='py-2 text-right font-normal'>{t('speedtest.colSpeed')}</th>
                <th className='py-2 text-right font-normal'>{t('speedtest.colLatency')}</th>
                <th className='py-2 text-left font-normal pl-3'>{t('speedtest.colEgressIP')}</th>
                <th className='py-2 text-center font-normal'>{t('speedtest.colSource')}</th>
                <th className='py-2 text-right font-normal'>{t('speedtest.colTime')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className='border-b last:border-0'>
                  <td className='py-2 text-right font-mono'>
                    {r.status === 'running' ? (
                      <span className='text-muted-foreground inline-flex items-center gap-1'><Loader2 className='h-3 w-3 animate-spin' />{t('speedtest.testing')}</span>
                    ) : r.status === 'failed' ? (
                      <span className='text-red-600 dark:text-red-400'>{t('speedtest.failedShort')}</span>
                    ) : (
                      <span className='text-emerald-600 dark:text-emerald-400'>↓ {Number(r.down_mbps).toFixed(1)} M</span>
                    )}
                  </td>
                  <td className='py-2 text-right font-mono'>{r.status === 'ok' ? `${r.latency_ms}ms` : '-'}</td>
                  <td className='py-2 pl-3 font-mono text-xs whitespace-nowrap'>{r.egress_ip || <span className='text-muted-foreground'>—</span>}</td>
                  <td className='py-2 text-center'>
                    <Badge variant='outline' className='text-[10px]'>{r.source === 'home_tester' ? t('speedtest.srcTester') : t('speedtest.srcMaster')}</Badge>
                  </td>
                  <td className='py-2 text-right text-muted-foreground text-xs whitespace-nowrap' title={new Date(r.created_at).toLocaleString()}>{relTime(r.created_at, tc)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}

// 测速点(家用测速端)管理视图:配对(生成令牌+运行命令)、列表(在线状态)、删除。dialog 内切换。
function TestersView({ onBack, t }: { onBack: () => void; t: any }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [newToken, setNewToken] = useState('')
  const masterURL = typeof window !== 'undefined' ? window.location.origin : ''

  const { data, isLoading } = useQuery({
    queryKey: ['speed-testers'],
    queryFn: async () => (await api.get('/api/admin/speedtest/testers')).data as { testers: any[] },
    refetchInterval: 5000,
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
    <>
      <DialogHeader>
        <DialogTitle className='flex items-center gap-2'>
          <Button variant='ghost' size='icon' className='size-7' onClick={onBack}><ArrowLeft className='size-4' /></Button>
          {t('speedtest.testerManage')}
        </DialogTitle>
        <DialogDescription>{t('speedtest.testerManageDesc')}</DialogDescription>
      </DialogHeader>
      <div className='flex-1 space-y-4 overflow-y-auto py-2'>
        <div className='flex items-end gap-2'>
          <div className='flex-1 space-y-1'>
            <Label className='text-xs'>{t('speedtest.testerName')}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder='home-tester' className='text-xs' />
          </div>
          <Button size='sm' onClick={() => createMut.mutate()} disabled={createMut.isPending}>
            <Plus className='mr-1 size-4' />{t('speedtest.testerCreate')}
          </Button>
        </div>

        {newToken && (
          <div className='border-primary/40 bg-primary/5 space-y-1.5 rounded-md border p-3'>
            <Label className='text-primary text-xs'>{t('speedtest.testerTokenOnce')}</Label>
            <div className='flex gap-2'>
              <Input readOnly value={newToken} className='font-mono text-xs' />
              <Button variant='outline' size='icon' className='shrink-0' onClick={() => copy(newToken)}><Copy className='h-4 w-4' /></Button>
            </div>
            <Label className='mt-1 text-xs'>{t('speedtest.testerRunCmd')}</Label>
            <div className='flex gap-2'>
              <Input readOnly value={runCmd} className='font-mono text-[11px]' />
              <Button variant='outline' size='icon' className='shrink-0' onClick={() => copy(runCmd)}><Copy className='h-4 w-4' /></Button>
            </div>
            <p className='text-muted-foreground text-[11px]'>{t('speedtest.testerRunHint')}</p>
          </div>
        )}

        <div className='space-y-1.5'>
          <Label className='flex items-center gap-1 text-xs'>{t('speedtest.testerList')}{isLoading && <RefreshCw className='size-3 animate-spin' />}</Label>
          {(data?.testers || []).length === 0 ? (
            <p className='text-muted-foreground text-xs'>{t('speedtest.testerNone')}</p>
          ) : (data?.testers || []).map((x: any) => (
            <div key={x.id} className='flex items-center justify-between rounded-md border px-3 py-1.5 text-xs'>
              <div className='min-w-0'>
                <span className='font-medium'>{x.name || `#${x.id}`}</span>
                <Badge variant={x.online ? 'default' : 'secondary'} className='ml-2 text-[10px]'>{x.online ? t('speedtest.online') : t('speedtest.offline')}</Badge>
              </div>
              <Button variant='ghost' size='sm' className='h-6 shrink-0 text-red-600 hover:text-red-700' onClick={() => revokeMut.mutate(x.id)} disabled={revokeMut.isPending}>
                <Trash2 className='size-3.5' />
              </Button>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
