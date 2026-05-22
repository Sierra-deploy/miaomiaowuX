// @ts-nocheck
// 节点测速按钮(PRO speed_test)。下拉选测速来源:主控本机 / 各家用测速端;含"管理测速端"。
// 无许可时置灰+提示升级,后端 403 兜底。
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Gauge } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useLicenseFeature } from '@/hooks/use-license'
import { api } from '@/lib/api'
import { SpeedTesterManagerDialog } from '@/components/speedtester-manager-dialog'

export function NodeSpeedTestButton({ nodeId, nodeName }: { nodeId: number; nodeName?: string }) {
  const { t } = useTranslation('nodes')
  const { hasFeature } = useLicenseFeature('speed_test')
  const [running, setRunning] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)

  const { data: testersData } = useQuery({
    queryKey: ['speed-testers'],
    queryFn: async () => (await api.get('/api/admin/speedtest/testers')).data as { testers: any[] },
    enabled: hasFeature,
    staleTime: 10000,
  })
  const testers = testersData?.testers || []

  const run = async (testerId?: number, label?: string) => {
    setRunning(true)
    const tid = toast.loading(t('speedtest.running', { name: nodeName || '' }))
    try {
      const body: any = { node_id: nodeId }
      if (testerId) body.tester_id = testerId
      const res = await api.post('/api/admin/speedtest/run', body)
      const r = res.data?.result
      if (res.data?.success && r) {
        toast.success(`${label ? label + ' · ' : ''}` + t('speedtest.result', { mbps: Number(r.down_mbps).toFixed(2), ms: r.latency_ms }), { id: tid })
      } else {
        toast.error(t('speedtest.failed', { err: r?.error || '' }), { id: tid })
      }
    } catch (e: any) {
      toast.error(e?.response?.data?.error || t('speedtest.failed', { err: '' }), { id: tid })
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant='ghost'
                size='icon'
                className={`size-8 ${hasFeature ? '' : 'opacity-50'}`}
                disabled={running}
                onClick={(e) => { if (!hasFeature) { e.preventDefault(); toast.error(t('speedtest.proRequired')) } }}
              >
                <Gauge className='size-4' />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{t('tooltip.speedtest')}{hasFeature ? '' : ' (PRO)'}</TooltipContent>
        </Tooltip>
        {hasFeature && (
          <DropdownMenuContent align='end' className='w-52'>
            <DropdownMenuItem onClick={() => run(undefined, t('speedtest.fromMaster'))}>{t('speedtest.fromMaster')}</DropdownMenuItem>
            {testers.filter((x: any) => x.online).map((x: any) => (
              <DropdownMenuItem key={x.id} onClick={() => run(x.id, x.name)}>{t('speedtest.fromTester', { name: x.name })}</DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setManageOpen(true)}>{t('speedtest.testerManage')}…</DropdownMenuItem>
          </DropdownMenuContent>
        )}
      </DropdownMenu>
      <SpeedTesterManagerDialog open={manageOpen} onOpenChange={setManageOpen} />
    </>
  )
}
