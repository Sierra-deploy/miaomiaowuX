// WarpModal — Cloudflare WARP 出站配置 modal。
//
// 通过 master /api/admin/remote/warp/* 4 个 endpoint 跟某 agent 上的 WARP 服务交互。
// 安装时 agent 内嵌 Go HTTP client 调 Cloudflare API 注册账号 + 自动注入 warp-v4 + warp-v6
// 双 outbound 到本机 xray。前端只看状态 + 一键安装/升级/卸载。
//
// 参考 3x-ui WarpModal.tsx 的产品形态:
//   - 顶部状态卡:已注册 ✔ / 未注册 ✖,显示 v4/v6 地址 + license 状态
//   - 4 个操作按钮:安装 / 刷新配置 / 升级 WARP+ / 卸载

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Loader2, Cloud, CheckCircle2, AlertCircle, KeyRound, Trash2, RefreshCcw } from 'lucide-react'

import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { api } from '@/lib/api'
import { handleServerError } from '@/lib/handle-server-error'

interface WarpStatus {
  installed: boolean
  license_active?: boolean
  device_id?: string
  addr_v4?: string
  addr_v6?: string
  registered_at?: string
}

interface WarpModalProps {
  serverId: number
  serverName: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 安装/卸载完成后回调,父组件可用来 invalidate outbound 列表查询 */
  onChanged?: () => void
}

export function WarpModal({ serverId, serverName, open, onOpenChange, onChanged }: WarpModalProps) {
  const { t } = useTranslation('xray')
  const queryClient = useQueryClient()
  const [licenseInput, setLicenseInput] = useState('')

  const { data: status, isLoading, refetch } = useQuery<WarpStatus>({
    queryKey: ['warp-status', serverId],
    queryFn: async () => {
      const resp = await api.get(`/api/admin/remote/warp/status?server_id=${serverId}`)
      return resp.data
    },
    enabled: open,
    refetchInterval: open ? 5000 : false, // 安装时 agent 状态变化,每 5s 刷一次
  })

  const installMutation = useMutation({
    mutationFn: async () => {
      const resp = await api.post(`/api/admin/remote/warp/install?server_id=${serverId}`)
      return resp.data
    },
    onSuccess: () => {
      // 区分首次安装 vs "刷新配置"重新同步:before-this-click 已 installed → 后者 toast,
      // 否则前者。用调用瞬间的 status 快照判断,而不是 onSuccess 时(refetch 可能已经更新)。
      const wasInstalled = status?.installed ?? false
      toast.success(wasInstalled ? t('outbounds.warp.synced') : t('outbounds.warp.installed'))
      refetch()
      queryClient.invalidateQueries({ queryKey: ['remote-outbounds', serverId] })
      queryClient.invalidateQueries({ queryKey: ['remote-servers'] })
      onChanged?.()
    },
    onError: handleServerError,
  })

  const licenseMutation = useMutation({
    mutationFn: async (license: string) => {
      const resp = await api.post(`/api/admin/remote/warp/license?server_id=${serverId}`, { license })
      return resp.data
    },
    onSuccess: () => {
      toast.success(t('outbounds.warp.licenseUpdated'))
      setLicenseInput('')
      refetch()
      queryClient.invalidateQueries({ queryKey: ['remote-outbounds', serverId] })
    },
    onError: handleServerError,
  })

  const removeMutation = useMutation({
    mutationFn: async () => {
      const resp = await api.post(`/api/admin/remote/warp/remove?server_id=${serverId}`)
      return resp.data
    },
    onSuccess: () => {
      toast.success(t('outbounds.warp.removed'))
      refetch()
      queryClient.invalidateQueries({ queryKey: ['remote-outbounds', serverId] })
      queryClient.invalidateQueries({ queryKey: ['remote-servers'] })
      onChanged?.()
    },
    onError: handleServerError,
  })

  const installed = status?.installed ?? false
  const anyPending = installMutation.isPending || licenseMutation.isPending || removeMutation.isPending

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cloud className="h-5 w-5 text-orange-500" />
            {t('outbounds.warp.title')} — {serverName}
          </DialogTitle>
          <DialogDescription>{t('outbounds.warp.subtitle')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* 状态卡 */}
          <Card>
            <CardContent className="pt-4 pb-4">
              {isLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('outbounds.warp.checking')}
                </div>
              ) : installed ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    <span className="font-medium">{t('outbounds.warp.installed')}</span>
                    {status?.license_active && (
                      <Badge variant="outline" className="border-orange-500 text-orange-600 dark:text-orange-400 dark:border-orange-400">
                        WARP+
                      </Badge>
                    )}
                  </div>
                  {status?.addr_v4 && (
                    <div className="text-xs text-muted-foreground font-mono">IPv4: {status.addr_v4}</div>
                  )}
                  {status?.addr_v6 && (
                    <div className="text-xs text-muted-foreground font-mono">IPv6: {status.addr_v6}</div>
                  )}
                  <div className="text-xs text-muted-foreground mt-2">
                    {t('outbounds.warp.outboundsInjected')}: <code>warp-v4</code>, <code>warp-v6</code>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <AlertCircle className="h-4 w-4 text-amber-500" />
                  {t('outbounds.warp.notInstalled')}
                </div>
              )}
            </CardContent>
          </Card>

          {/* 操作按钮 */}
          {!installed ? (
            <Button
              onClick={() => installMutation.mutate()}
              disabled={anyPending}
              className="w-full"
            >
              {installMutation.isPending ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />{t('outbounds.warp.installing')}</>
              ) : (
                <><Cloud className="h-4 w-4 mr-2" />{t('outbounds.warp.install')}</>
              )}
            </Button>
          ) : (
            <div className="space-y-3">
              {/* license input */}
              <div className="space-y-1">
                <Label htmlFor="warp-license" className="text-sm">{t('outbounds.warp.licenseLabel')}</Label>
                <div className="flex gap-2">
                  <Input
                    id="warp-license"
                    value={licenseInput}
                    onChange={(e) => setLicenseInput(e.target.value)}
                    placeholder="XXXXXXXX-XXXXXXXX-XXXXXXXX"
                    className="font-mono text-xs flex-1"
                    disabled={anyPending}
                  />
                  <Button
                    variant="secondary"
                    onClick={() => licenseInput.trim() && licenseMutation.mutate(licenseInput.trim())}
                    disabled={anyPending || !licenseInput.trim()}
                  >
                    {licenseMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4 mr-1" />}
                    {t('outbounds.warp.upgradeLicense')}
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">{t('outbounds.warp.licenseHint')}</p>
              </div>

              {/* refresh / remove
                  "刷新配置" 不再只 refetch status — 而是调 install endpoint。
                  install handler 幂等:已注册 → 不重新 Cloudflare 注册,但会重新 remove+add warp-v4/warp-v6 到 xray runtime,
                  覆盖用户场景:出站列表里手动删了 warp-v4/v6 后想用此按钮一键恢复。 */}
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => installMutation.mutate()}
                  disabled={anyPending}
                  className="flex-1"
                >
                  {installMutation.isPending
                    ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    : <RefreshCcw className="h-4 w-4 mr-1" />}
                  {t('outbounds.warp.refresh')}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    if (confirm(t('outbounds.warp.removeConfirm'))) {
                      removeMutation.mutate()
                    }
                  }}
                  disabled={anyPending}
                  className="flex-1"
                >
                  {removeMutation.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Trash2 className="h-4 w-4 mr-1" />}
                  {t('outbounds.warp.remove')}
                </Button>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={anyPending}>
            {t('outbounds.warp.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
