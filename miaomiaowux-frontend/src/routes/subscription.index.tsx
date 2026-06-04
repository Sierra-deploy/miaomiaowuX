// @ts-nocheck
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { QRCodeCanvas } from 'qrcode.react'
import {
  Copy,
  Download,
  QrCode,
  ChevronDown,
} from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { Topbar } from '@/components/layout/topbar'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

import clashIcon from '@/assets/icons/clash_color.png'
import stashIcon from '@/assets/icons/stash_color.png'
import shadowrocketIcon from '@/assets/icons/shadowrocket_color.png'
import surfboardIcon from '@/assets/icons/surfboard_color.png'
import surgeIcon from '@/assets/icons/surge_color.png'
import surgeMacIcon from '@/assets/icons/surgeformac_icon_color.png'
import loonIcon from '@/assets/icons/loon_color.png'
import quanxIcon from '@/assets/icons/quanx_color.png'
import egernIcon from '@/assets/icons/egern_color.png'
import singboxIcon from '@/assets/icons/sing-box_color.png'
import v2rayIcon from '@/assets/icons/v2ray_color.png'
import uriIcon from '@/assets/icons/uri-color.svg'

export const Route = createFileRoute('/subscription/')({
  component: SubscriptionPage,
})

type SubscribeFile = {
  id: number
  name: string
  description: string
  type: string
  filename: string
  file_short_code?: string
  custom_short_code?: string
  created_at: string
  updated_at: string
}

const CLIENT_TYPES = [
  { type: 'clash', name: 'Clash', icon: clashIcon },
  { type: 'stash', name: 'Stash', icon: stashIcon },
  { type: 'clash-to-shadowrocket', name: 'Shadowrocket', icon: shadowrocketIcon },
  { type: 'surfboard', name: 'Surfboard', icon: surfboardIcon },
  { type: 'surge', name: 'Surge', icon: surgeIcon },
  { type: 'surgemac', name: 'Surge Mac', icon: surgeMacIcon },
  { type: 'clash-to-surge', name: 'Clash→Surge', icon: surgeIcon },
  { type: 'loon', name: 'Loon', icon: loonIcon },
  { type: 'clash-to-loon', name: 'Clash→Loon', icon: loonIcon },
  { type: 'clash-to-loon-kelee', name: 'Clash→Loon(kelee)', icon: loonIcon },
  { type: 'qx', name: 'QuantumultX', icon: quanxIcon },
  { type: 'egern', name: 'Egern', icon: egernIcon },
  { type: 'sing-box', name: 'sing-box', icon: singboxIcon },
  { type: 'v2ray', name: 'V2Ray', icon: v2rayIcon },
  { type: 'uri', name: 'URI', icon: uriIcon },
] as const

function SubscriptionPage() {
  const { t } = useTranslation('dashboard')
  const { t: tc } = useTranslation()
  const { auth } = useAuthStore()
  const [qrValue, setQrValue] = useState<string | null>(null)
  const [displayURLs, setDisplayURLs] = useState<Record<number, string>>({})

  const { data: subscribeFilesData } = useQuery({
    queryKey: ['user-subscriptions'],
    queryFn: async () => {
      const response = await api.get('/api/subscriptions')
      return response.data as { subscriptions: SubscribeFile[]; user_short_code: string }
    },
    enabled: Boolean(auth.accessToken),
    staleTime: 60 * 1000,
  })

  const subscribeFiles = subscribeFilesData?.subscriptions ?? []
  const userShortCode = subscribeFilesData?.user_short_code ?? ''

  const { data: tokenData } = useQuery({
    queryKey: ['user-token'],
    queryFn: async () => {
      const response = await api.get('/api/user/token')
      return response.data as { token: string }
    },
    enabled: Boolean(auth.accessToken) && !userShortCode,
    staleTime: 5 * 60 * 1000,
  })

  const userToken = tokenData?.token ?? ''

  const baseURL =
    api.defaults.baseURL ??
    (typeof window !== 'undefined'
      ? `${window.location.protocol}//${window.location.host}`
      : 'http://localhost:12889')

  const buildSubscriptionURL = (filename: string, fileShortCode: string | undefined, clientType?: string, fileType?: string, customShortCode?: string) => {
    const shortCode = customShortCode || fileShortCode
    if (shortCode) {
      // 订阅短链接 = /x/{文件短码}{用户短码};所有用户(含管理员)都拼上自己的 user_short_code
      const url = new URL(`/x/${shortCode + userShortCode}`, baseURL)
      if (clientType) url.searchParams.set('t', clientType)
      return url.toString()
    }
    if (fileType === 'package') {
      const url = new URL('/api/user/package-subscribe', baseURL)
      if (clientType) url.searchParams.set('t', clientType)
      if (userToken) url.searchParams.set('token', userToken)
      return url.toString()
    }
    const url = new URL('/api/clash/subscribe', baseURL)
    url.searchParams.set('filename', filename)
    if (clientType) url.searchParams.set('t', clientType)
    if (userToken) url.searchParams.set('token', userToken)
    return url.toString()
  }

  const handleCopy = async (fileId: number, urlText: string, clientName: string) => {
    setDisplayURLs((prev) => ({ ...prev, [fileId]: urlText }))
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(urlText)
        toast.success(t('user.subscribe.linkCopied', { client: clientName }))
        return
      } catch (_) { /* fall through */ }
    }
    toast.error(tc('actions.copyFailed'))
  }

  const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    hour12: false,
  })

  return (
    <div className='min-h-svh bg-background'>
      <Topbar />
      <main className='mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 pt-24'>
        <section className='space-y-2 text-center sm:text-left'>
          <h1 className='text-3xl font-semibold tracking-tight'>{t('user.subscribe.title')}</h1>
        </section>

        <section className='mt-8 grid gap-6 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-3'>
          {subscribeFiles.length === 0 ? (
            <Card className='sm:col-span-1 md:col-span-2 lg:col-span-3 border-dashed shadow-none w-full'>
              <CardHeader>
                <CardTitle>{t('user.subscribe.noSubscriptionsTitle')}</CardTitle>
                <CardDescription>{t('user.subscribe.noSubscriptionsDesc')}</CardDescription>
              </CardHeader>
            </Card>
          ) : null}

          {subscribeFiles.map((file) => {
            const subscribeURL = buildSubscriptionURL(file.filename, file.file_short_code, undefined, file.type, file.custom_short_code)
            const displayURL = displayURLs[file.id] || subscribeURL
            const clashURL = `clash://install-config?url=${encodeURIComponent(subscribeURL)}`
            const updatedLabel = file.updated_at
              ? dateFormatter.format(new Date(file.updated_at))
              : null

            return (
              <Card key={file.id} className='flex flex-col justify-between'>
                <CardHeader>
                  <div className='flex items-start gap-3 overflow-hidden'>
                    <button
                      onClick={() => setQrValue(displayURL)}
                      className='flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary transition-all hover:bg-primary/20 hover:scale-110 active:scale-95 cursor-pointer'
                      title={t('user.subscribe.showQR')}
                    >
                      <QrCode className='size-6' />
                    </button>
                    <div className='flex-1 min-w-0 space-y-1 text-left'>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <CardTitle className='text-lg truncate'>{file.name}</CardTitle>
                        </TooltipTrigger>
                        <TooltipContent>{file.name}</TooltipContent>
                      </Tooltip>
                      <CardDescription>{file.description || '—'}</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className='space-y-4'>
                  <div className='flex items-center justify-end gap-2 flex-wrap'>
                    {updatedLabel ? (
                      <p className='text-xs text-muted-foreground'>{updatedLabel}</p>
                    ) : null}
                  </div>
                  <div className='break-all rounded-lg border bg-muted/40 p-3 font-mono text-xs shadow-inner sm:text-sm'>
                    {displayURL}
                  </div>
                  <div className='grid grid-cols-2 gap-2'>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size='sm'
                          className='w-full transition-transform hover:-translate-y-0.5 hover:shadow-md active:translate-y-0.5 active:scale-95'
                        >
                          <Copy className='mr-2 size-4' />
                          {t('user.subscribe.copy')}
                          <ChevronDown className='ml-2 size-4' />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align='end' className='w-56'>
                        {CLIENT_TYPES.map((client) => {
                          const clientURL = buildSubscriptionURL(file.filename, file.file_short_code, client.type, file.type, file.custom_short_code)
                          return (
                            <DropdownMenuItem
                              key={client.type}
                              onClick={() => handleCopy(file.id, clientURL, client.name)}
                              className='cursor-pointer'
                            >
                              <img src={client.icon} alt={client.name} className='mr-2 size-4' />
                              {client.name}
                            </DropdownMenuItem>
                          )
                        })}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <Button
                      size='sm'
                      variant='secondary'
                      className='w-full transition-transform hover:-translate-y-0.5 hover:shadow-md active:translate-y-0.5 active:scale-95'
                      asChild
                    >
                      <a href={clashURL}>
                        <Download className='mr-2 size-4' />{t('user.subscribe.importClash')}
                      </a>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </section>
      </main>

      <Dialog
        open={Boolean(qrValue)}
        onOpenChange={(open) => { if (!open) setQrValue(null) }}
      >
        <DialogContent className='sm:max-w-sm'>
          <DialogHeader>
            <DialogTitle>{t('user.subscribe.qrTitle')}</DialogTitle>
            <DialogDescription>{t('user.subscribe.description')}</DialogDescription>
          </DialogHeader>
          {qrValue ? (
            <div className='flex flex-col items-center gap-4'>
              <div className='rounded-xl border bg-white p-4 shadow-inner'>
                <QRCodeCanvas value={qrValue} size={220} level='M' includeMargin />
              </div>
              <div className='font-mono text-xs break-all text-center text-muted-foreground'>
                {qrValue}
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
