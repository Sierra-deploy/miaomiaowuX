// @ts-nocheck
// 节点测速工作台 dialog(PRO speed_test)。顶部选测速来源(主控/已安装测速端,默认主控);
// 表格列:协议 / 名称 / 服务器地址 / 测速结果 / 历史 / 测速;支持多选一键测速。
// 关闭语义由父级控制:点 X = 真正关闭;点外部/Esc = 收起到屏幕右侧悬浮按钮(防误关)。
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Gauge, Loader2, History, ArrowLeft, RefreshCw, Settings2, Plus, Trash2, Copy, Zap, ExternalLink } from 'lucide-react'
import { api } from '@/lib/api'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import { useIdSelection } from '@/hooks/use-id-selection'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ProtocolBadge } from '@/components/common/protocol-badge'

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

// 前端 running → timeout 的阈值:超过这么久还在 running 视为后端卡住/丢失,UI 允许重测
const RUNNING_TIMEOUT_MS = 15_000

// isStaleRunning 判断 running 行是否超过 15s 没出结果(视为前端层面超时,可重测)
function isStaleRunning(r: any): boolean {
  if (r?.status !== 'running') return false
  const started = r?.created_at ? new Date(r.created_at).getTime() : 0
  if (!started) return false
  return Date.now() - started > RUNNING_TIMEOUT_MS
}

// 每节点最新测速结果(有 running 时 1.5s 轮询,显著降低用户感知延迟)
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
      Object.values(q.state.data || {}).some((r: any) => r?.status === 'running') ? 1500 : false,
  })
}

// 速度单元格(running 转圈 / 超时 / 失败 / ↓速度)
function SpeedCell({ r, t }: { r: any; t: any }) {
  if (!r) return <span className='text-muted-foreground text-xs'>—</span>
  if (r.status === 'running') {
    if (isStaleRunning(r)) {
      return <span className='text-orange-600 dark:text-orange-400 whitespace-nowrap text-xs' title={t('speedtest.timeoutHint')}>{t('speedtest.timeout')}</span>
    }
    return (
      <span className='text-muted-foreground inline-flex items-center gap-1 whitespace-nowrap text-xs'>
        <Loader2 className='h-3 w-3 animate-spin' />{t('speedtest.testing')}
      </span>
    )
  }
  if (r.status === 'failed')
    return <span className='text-red-600 dark:text-red-400 whitespace-nowrap text-xs' title={r.error}>{t('speedtest.failedShort')}</span>
  return (
    <span className='text-emerald-600 dark:text-emerald-400 font-mono whitespace-nowrap text-xs'>
      ↓ {Number(r.down_mbps).toFixed(1)} Mbps
    </span>
  )
}

// 延迟单元格:同时是一个按钮。无数据时显示 Zap 图标可点击,点完跑真延迟探测;
// 已有数据时显示 ms,再次点击重测。运行中显示 spinner;超 15s 视为超时,变成可重测。
function LatencyCell({ r, onProbe, busy, t }: { r: any; onProbe: () => void; busy: boolean; t: any }) {
  const running = (r?.status === 'running' && !isStaleRunning(r)) || busy
  if (running) {
    return (
      <button className='inline-flex items-center gap-1 text-muted-foreground text-xs font-mono' disabled>
        <Loader2 className='h-3 w-3 animate-spin' />
      </button>
    )
  }
  // 超 15s 未返回 → 视为超时,展示橙色按钮可重测
  if (r?.status === 'running' && isStaleRunning(r)) {
    return (
      <button
        type='button'
        onClick={onProbe}
        title={t('speedtest.timeoutHint')}
        className='inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-orange-600 dark:text-orange-400 hover:bg-orange-500/10'
      >
        <Zap className='h-3 w-3' />{t('speedtest.timeout')}
      </button>
    )
  }
  // 失败:展示一个红色 Zap,点击重测
  if (r?.status === 'failed') {
    return (
      <button
        type='button'
        onClick={onProbe}
        title={t('speedtest.latencyRetry') + (r?.error ? `: ${r.error}` : '')}
        className='inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-red-600 dark:text-red-400 hover:bg-red-500/10'
      >
        <Zap className='h-3 w-3' />
        {t('speedtest.failedShort')}
      </button>
    )
  }
  // ok + 有 latency_ms:显示 ms,可重测
  if (r?.status === 'ok' && typeof r?.latency_ms === 'number' && r.latency_ms >= 0) {
    return (
      <button
        type='button'
        onClick={onProbe}
        title={t('speedtest.latencyRetry')}
        className='inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-xs hover:bg-muted'
      >
        <Zap className='h-3 w-3 text-amber-500' />
        {r.latency_ms} ms
      </button>
    )
  }
  // 无数据 / 没拿到 ms:显示一个 Zap 按钮提示用户点击
  return (
    <button
      type='button'
      onClick={onProbe}
      title={t('speedtest.latencyOnlyTip')}
      className='inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-amber-600 hover:bg-amber-500/10'
    >
      <Zap className='h-3 w-3' />
      {t('speedtest.latencyProbe')}
    </button>
  )
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

  const [source, setSource] = useState<number | 'master'>(() => {
    const cached = localStorage.getItem('mmwx-speedtest-source')
    if (cached && cached !== 'master') {
      const num = Number(cached)
      if (!isNaN(num)) return num
    }
    return 'master'
  })
  const [threads, setThreads] = useState<1 | 8>(() => {
    return localStorage.getItem('mmwx-speedtest-threads') === '8' ? 8 : 1
  })
  const { selected, toggle: toggleOne, toggleAll: toggleAllIds } = useIdSelection<number>()
  const [historyNode, setHistoryNode] = useState<{ id: number; name: string } | null>(null)
  const [manageTesters, setManageTesters] = useState(false)
  // 点离线测速端时进入 TestersView 并自动重发安装命令的 tester id
  const [autoRotateTesterId, setAutoRotateTesterId] = useState<number | null>(null)

  const { data: testersData } = useQuery({
    queryKey: ['speed-testers'],
    queryFn: async () => (await api.get('/api/admin/speedtest/testers')).data as { testers: any[] },
    enabled: open,
    staleTime: 10000,
  })
  const testers = testersData?.testers || []

  useEffect(() => { localStorage.setItem('mmwx-speedtest-source', String(source)) }, [source])
  useEffect(() => { localStorage.setItem('mmwx-speedtest-threads', String(threads)) }, [threads])
  useEffect(() => {
    // 上次选的 tester 已被删除 → 自动回落到主控
    if (source !== 'master' && testers.length > 0 && !testers.some((t: any) => t.id === source)) {
      setSource('master')
    }
  }, [testers, source])

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

  // 速度测试用当前选定的线程数。latencyOnly=true 时跳过下载,只跑 Cloudflare 204 真延迟探测
  const runTest = async (nodeIds: number[], latencyOnly = false) => {
    if (nodeIds.length === 0) return
    try {
      const body: any = { threads }
      if (source !== 'master') body.tester_id = source
      if (latencyOnly) body.latency_only = true
      await Promise.all(nodeIds.map((id) => api.post('/api/admin/speedtest/run', { ...body, node_id: id })))
      if (!latencyOnly) {
        toast.success(
          nodeIds.length === 1
            ? t('speedtest.started', { name: rows.find((r) => r.id === nodeIds[0])?.name || '' })
            : t('speedtest.batchStarted', { count: nodeIds.length })
        )
      }
      queryClient.invalidateQueries({ queryKey: ['speedtest-latest'] })
    } catch (e: any) {
      toast.error(e?.response?.data?.error || t('speedtest.failed', { err: '' }))
    }
  }

  const allSelected = rows.length > 0 && selected.size === rows.length
  const toggleAll = () => toggleAllIds(rows.map((r) => r.id))

  return (
    <>
    <Dialog open={open} onOpenChange={(o) => { if (!o) { setHistoryNode(null); onClose() } }}>
      <DialogContent
        className='w-[95vw] sm:w-auto sm:!max-w-[95vw] max-h-[88vh] flex flex-col'
        // 点外面 / 按 Esc:历史子视图退回主视图;主视图最小化。测速端管理用 Sheet 独立,
        // 与本 dialog 解耦,关 Sheet 不会带着 dialog 一起关。
        onInteractOutside={(e) => {
          e.preventDefault()
          if (historyNode) { setHistoryNode(null); return }
          onMinimize()
        }}
        onEscapeKeyDown={(e) => {
          e.preventDefault()
          if (historyNode) { setHistoryNode(null); return }
          onMinimize()
        }}
      >
        {historyNode ? (
          <HistoryView node={historyNode} onBack={() => setHistoryNode(null)} t={t} tc={tc} />
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
                  onClick={() => {
                    if (x.online) {
                      setSource(x.id)
                    } else {
                      // 离线测速端 → 进入管理视图并自动轮换 token、重发安装命令
                      setAutoRotateTesterId(x.id)
                      setManageTesters(true)
                    }
                  }}
                  title={x.online ? '' : t('speedtest.offlineClickHint')}
                  className={x.online ? '' : 'opacity-60'}
                >
                  {x.name}{x.online ? '' : ` (${t('speedtest.offline')})`}
                </Button>
              ))}
              <span className='text-muted-foreground ml-3 text-sm'>{t('speedtest.threads')}:</span>
              <Button size='sm' variant={threads === 1 ? 'default' : 'outline'} onClick={() => setThreads(1)}>
                {t('speedtest.threadsSingle')}
              </Button>
              <Button size='sm' variant={threads === 8 ? 'default' : 'outline'} onClick={() => setThreads(8)}>
                {t('speedtest.threadsMulti')}
              </Button>
              <div className='ml-auto flex items-center gap-2'>
                {selected.size > 0 && (
                  <Button size='sm' onClick={() => runTest(Array.from(selected))}>
                    <Gauge className='mr-1 h-4 w-4' />
                    {t('speedtest.batchTest')} ({selected.size})
                  </Button>
                )}
                <Popover
                  open={manageTesters}
                  onOpenChange={(o) => { setManageTesters(o); if (!o) setAutoRotateTesterId(null) }}
                >
                  <PopoverTrigger asChild>
                    <Button size='sm' variant='outline'>
                      <Settings2 className='mr-1 h-4 w-4' />
                      {t('speedtest.testerManage')}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align='end' side='bottom' sideOffset={6} className='w-[min(560px,92vw)] p-4 max-h-[70vh] overflow-y-auto'>
                    <TestersView
                      onBack={() => { setManageTesters(false); setAutoRotateTesterId(null) }}
                      t={t}
                      autoRotateId={autoRotateTesterId}
                    />
                  </PopoverContent>
                </Popover>
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
                        const running = res?.status === 'running' && !isStaleRunning(res)
                        return (
                          <tr key={r.id} className='border-t'>
                            <td className='p-2 text-center'>
                              <Checkbox checked={selected.has(r.id)} onCheckedChange={() => toggleOne(r.id)} />
                            </td>
                            <td className='p-2'>
                              <div className='flex flex-col items-start gap-0.5'>
                                <ProtocolBadge protocol={r.protocol} />
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
                            <td className='p-2'><LatencyCell r={res} onProbe={() => runTest([r.id], true)} busy={running} t={t} /></td>
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
                    const running = res?.status === 'running' && !isStaleRunning(res)
                    return (
                      <div key={r.id} className='rounded-lg border p-3'>
                        <div className='flex items-start gap-2'>
                          <Checkbox className='mt-0.5' checked={selected.has(r.id)} onCheckedChange={() => toggleOne(r.id)} />
                          <div className='min-w-0 flex-1'>
                            <div className='flex items-center gap-2'>
                              <div className='flex flex-col items-start gap-0.5 shrink-0'>
                                <ProtocolBadge protocol={r.protocol} />
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
                              <LatencyCell r={res} onProbe={() => runTest([r.id], true)} busy={running} t={t} />
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
    </>
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

// 测速点(家用测速端)管理视图:配对(生成令牌+运行命令)、列表(在线状态)、删除、离线重发安装命令。
// autoRotateId:打开时自动为该 tester 轮换 token 并展示安装命令(从 source selector 点离线测速端进入时用)
function TestersView({ onBack, t, autoRotateId }: { onBack: () => void; t: any; autoRotateId?: number | null }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  // newCred:刚生成 / 刚轮换出来的凭据(token + tester 名称),用于显示安装命令
  const [newCred, setNewCred] = useState<{ token: string; name: string } | null>(null)
  const masterURL = typeof window !== 'undefined' ? window.location.origin : ''

  const { data, isLoading } = useQuery({
    queryKey: ['speed-testers'],
    queryFn: async () => (await api.get('/api/admin/speedtest/testers')).data as { testers: any[] },
    refetchInterval: 5000,
  })
  const createMut = useMutation({
    mutationFn: async () => {
      const finalName = name.trim() || 'mmwx-speedtester'
      const d = (await api.post('/api/admin/speedtest/testers/create', { name: finalName })).data
      return { ...d, name: finalName }
    },
    onSuccess: (d: any) => { setNewCred({ token: d.token, name: d.name }); setName(''); qc.invalidateQueries({ queryKey: ['speed-testers'] }); toast.success(t('speedtest.testerCreated')) },
    onError: (e: any) => toast.error(e?.response?.data?.error || t('speedtest.testerCreateFailed')),
  })
  const revokeMut = useMutation({
    mutationFn: async (id: number) => (await api.post('/api/admin/speedtest/testers/revoke', { id })).data,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['speed-testers'] }); toast.success(t('speedtest.testerRevoked')) },
    onError: () => toast.error(t('speedtest.testerRevokeFailed')),
  })
  // 离线测速端轮换 token:库里只存哈希,原 token 不可恢复 → 必须生成新的让用户重跑安装命令
  const rotateMut = useMutation({
    mutationFn: async (tester: { id: number; name: string }) => {
      const d = (await api.post('/api/admin/speedtest/testers/rotate-token', { id: tester.id })).data
      return { token: d.token, name: tester.name }
    },
    onSuccess: (d) => { setNewCred(d); qc.invalidateQueries({ queryKey: ['speed-testers'] }); toast.success(t('speedtest.tokenRotated')) },
    onError: (e: any) => toast.error(e?.response?.data?.error || t('speedtest.tokenRotateFailed')),
  })

  // 从 source selector 点离线测速端进来时,自动跑一次 rotate-token,直接展示安装命令(不用用户再点一遍)
  useEffect(() => {
    if (!autoRotateId) return
    const tester = (data?.testers || []).find((x: any) => x.id === autoRotateId)
    if (tester && !tester.online) {
      rotateMut.mutate({ id: tester.id, name: tester.name || `tester-${tester.id}` })
    }
    // 只在 testers 数据到位后跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRotateId, data?.testers])

  const copyToClipboard = useCopyToClipboard()
  const copy = (s: string) => copyToClipboard(s, { success: t('speedtest.copied') })
  // mmwX-plugins 提供的一键安装脚本(自动下载对应平台二进制 + systemd / 任务计划)。
  // tester 名称在创建时就已确定并存到主控库,二进制不需要带 -name 参数。
  const scriptBaseURL = 'https://raw.githubusercontent.com/MMWOrg/mmwX-plugins/refs/heads/main/speedtest/scripts'
  const linuxCmd = newCred ? `curl -fsSL ${scriptBaseURL}/install.sh | bash -s -- -master ${masterURL} -token ${newCred.token}` : ''
  const windowsCmd = newCred ? `irm ${scriptBaseURL}/install.ps1 -OutFile install.ps1; .\\install.ps1 -Master ${masterURL} -Token ${newCred.token}` : ''

  // 从 source selector 点离线测速端进来:只展示该 tester 的安装命令/token,隐藏新建表单和测速端列表
  const compactMode = autoRotateId != null

  return (
    <>
      <div className='mb-3'>
        <div className='font-medium text-sm'>{t('speedtest.testerManage')}</div>
        <div className='text-muted-foreground text-xs mt-0.5'>{t('speedtest.testerManageDesc')}</div>
      </div>
      <div className='space-y-4'>
        {!compactMode && (
          <>
            <a
              href='https://github.com/MMWOrg/mmwX-plugins/releases/latest'
              target='_blank'
              rel='noopener noreferrer'
              className='flex items-center gap-1.5 text-xs text-primary hover:underline'
            >
              <ExternalLink className='size-3.5' />
              {t('speedtest.testerDownload')}
            </a>
            <div className='flex items-end gap-2'>
              <div className='flex-1 space-y-1'>
                <Label className='text-xs'>{t('speedtest.testerName')}</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder='mmwx-speedtester' className='text-xs' />
              </div>
              <Button size='sm' onClick={() => createMut.mutate()} disabled={createMut.isPending}>
                <Plus className='mr-1 size-4' />{t('speedtest.testerCreate')}
              </Button>
            </div>
          </>
        )}

        {newCred && (
          <div className='border-primary/40 bg-primary/5 space-y-2 rounded-md border p-3'>
            <Label className='text-primary text-xs flex items-center gap-2'>
              {t('speedtest.testerTokenOnce')}
              <span className='text-muted-foreground font-mono text-[10px]'>{newCred.name}</span>
            </Label>
            <div className='flex gap-2'>
              <Input readOnly value={newCred.token} className='font-mono text-xs' />
              <Button variant='outline' size='icon' className='shrink-0' onClick={() => copy(newCred.token)}><Copy className='h-4 w-4' /></Button>
            </div>
            <Label className='mt-1.5 text-xs'>{t('speedtest.testerLinuxCmd')}</Label>
            <div className='flex gap-2'>
              <Input readOnly value={linuxCmd} className='font-mono text-[11px]' />
              <Button variant='outline' size='icon' className='shrink-0' onClick={() => copy(linuxCmd)}><Copy className='h-4 w-4' /></Button>
            </div>
            <Label className='mt-1.5 text-xs'>{t('speedtest.testerWindowsCmd')}</Label>
            <div className='flex gap-2'>
              <Input readOnly value={windowsCmd} className='font-mono text-[11px]' />
              <Button variant='outline' size='icon' className='shrink-0' onClick={() => copy(windowsCmd)}><Copy className='h-4 w-4' /></Button>
            </div>
            <p className='text-muted-foreground text-[11px]'>{t('speedtest.testerRunHint')}</p>
          </div>
        )}

        {!compactMode && <div className='space-y-1.5'>
          <Label className='flex items-center gap-1 text-xs'>{t('speedtest.testerList')}{isLoading && <RefreshCw className='size-3 animate-spin' />}</Label>
          {(data?.testers || []).length === 0 ? (
            <p className='text-muted-foreground text-xs'>{t('speedtest.testerNone')}</p>
          ) : (data?.testers || []).map((x: any) => (
            <div key={x.id} className='flex items-center justify-between rounded-md border px-3 py-1.5 text-xs'>
              <div className='min-w-0'>
                <span className='font-medium'>{x.name || `#${x.id}`}</span>
                <Badge variant={x.online ? 'default' : 'secondary'} className='ml-2 text-[10px]'>{x.online ? t('speedtest.online') : t('speedtest.offline')}</Badge>
              </div>
              <div className='flex items-center gap-1 shrink-0'>
                {!x.online && (
                  <Button
                    variant='ghost'
                    size='sm'
                    className='h-6 text-primary hover:text-primary'
                    onClick={() => rotateMut.mutate({ id: x.id, name: x.name || `tester-${x.id}` })}
                    disabled={rotateMut.isPending}
                    title={t('speedtest.rotateHint')}
                  >
                    <RefreshCw className='size-3.5 mr-1' />{t('speedtest.resendInstall')}
                  </Button>
                )}
                <Button variant='ghost' size='sm' className='h-6 text-red-600 hover:text-red-700' onClick={() => revokeMut.mutate(x.id)} disabled={revokeMut.isPending}>
                  <Trash2 className='size-3.5' />
                </Button>
              </div>
            </div>
          ))}
        </div>}
      </div>
    </>
  )
}
