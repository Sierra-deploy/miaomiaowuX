// @ts-nocheck
import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Topbar } from '@/components/layout/topbar'
import { DataTable } from '@/components/data-table'
import type { DataTableColumn } from '@/components/data-table'
import { useLicenseUsage } from '@/hooks/use-license'
import { formatBytes } from '@/lib/format'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { api } from '@/lib/api'
import { handleServerError } from '@/lib/handle-server-error'
import { profileQueryFn } from '@/lib/profile'
import { useAuthStore } from '@/stores/auth-store'
import { Gauge, Package, Pencil, Users as UsersIcon } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'

// @ts-ignore - retained simple route definition
export const Route = createFileRoute('/users')({
  beforeLoad: () => {
    const token = useAuthStore.getState().auth.accessToken
    if (!token) {
      throw redirect({ to: '/' })
    }
  },
  component: UsersPage,
})

type UserRow = {
  username: string
  email: string
  nickname: string
  role: string
  is_active: boolean
  remark: string
  package_id?: number | null
  package_name?: string
  traffic_limit_gb?: number
  traffic_used?: number
  traffic_limit?: number
  is_over_limit?: boolean
  is_reset?: boolean
  reset_day?: number
  package_end_date?: string
  speed_limit_mbps?: number
  device_limit?: number
  speed_limit_override?: number | null
  device_limit_override?: number | null
  node_speed_limit_overrides?: Record<string, number>
  node_device_limit_overrides?: Record<string, number>
  user_short_code?: string
  custom_user_short_code?: string
}

// 跟后端 shortCodeRe 严格保持一致(users.go)。前端做 UX 校验避免无效请求,后端兜底。
const SHORT_CODE_RE = /^[A-Za-z0-9_-]{2,16}$/

type ResetState = {
  username: string
  password: string
}

type CreateState = {
  username: string
  email: string
  nickname: string
  password: string
  remark: string
}

type PackageManageState = {
  username: string
  selectedPackageId: number | null
  isReset: boolean
  resetDay: number
  expireDate: string
  initialized: boolean
}

const defaultExpireDate = () => {
  const d = new Date()
  d.setMonth(d.getMonth() + 1)
  return d.toISOString().split('T')[0]
}

const generatePassword = (length = 12) => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  return Array.from({ length }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('')
}

function UsersPage() {
  const { auth } = useAuthStore()
  const queryClient = useQueryClient()
  const { t } = useTranslation('users')
  const { t: tc } = useTranslation('common')
  const { data: licenseUsage } = useLicenseUsage()
  const usersAtLimit = Boolean(licenseUsage?.usage?.users && licenseUsage.usage.users.current >= licenseUsage.usage.users.max)
  const [resetState, setResetState] = useState<ResetState | null>(null)
  const [deleteUsername, setDeleteUsername] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [createState, setCreateState] = useState<CreateState>({
    username: '',
    email: '',
    nickname: '',
    password: generatePassword(),
    remark: '',
  })
  const [packageManageState, setPackageManageState] = useState<PackageManageState | null>(null)
  const [remarkEditState, setRemarkEditState] = useState<{ username: string; remark: string } | null>(null)
  // 查看用户子账户对话框
  const [subaccountsViewUser, setSubaccountsViewUser] = useState<string | null>(null)
  const subaccountsQuery = useQuery({
    queryKey: ['user-subaccounts', subaccountsViewUser],
    queryFn: async () => {
      const r = await api.get(`/api/admin/users/subaccounts?username=${encodeURIComponent(subaccountsViewUser!)}`)
      return r.data as { success: boolean; username: string; subaccounts: Array<{ type: 'routed' | 'inbound'; email?: string; identifier?: string; node_id?: number; node_name?: string; server_id?: number; server_name?: string; inbound_tag?: string; protocol?: string; is_active: boolean; updated_at?: string }> }
    },
    enabled: !!subaccountsViewUser,
  })
  // 用户限速统一编辑 dialog:全局覆盖 + per-node 覆盖合在一个 dialog 里
  const [limitsEditState, setLimitsEditState] = useState<{
    username: string
    package_id: number | null
    // 用户级全局覆盖(空字符串 = 不覆盖)
    speed_limit_override: string
    device_limit_override: string
    // 用户级 per-node 覆盖(空 = 沿用全局/套餐)
    speed_overrides: Record<string, string>
    device_overrides: Record<string, string>
  } | null>(null)
  // 复用 subaccountsQuery 拿用户在每个 inbound 上的子账户(含 node_id / node_name)
  const limitsSubaccountsQuery = useQuery({
    queryKey: ['user-subaccounts', limitsEditState?.username],
    queryFn: async () => {
      const r = await api.get(`/api/admin/users/subaccounts?username=${encodeURIComponent(limitsEditState!.username)}`)
      return r.data as { success: boolean; username: string; subaccounts: Array<{ type: 'routed' | 'inbound'; email?: string; identifier?: string; node_id?: number; node_name?: string; server_id?: number; server_name?: string; inbound_tag?: string; protocol?: string; is_active: boolean; updated_at?: string }> }
    },
    enabled: !!limitsEditState?.username,
  })
  // 拉取套餐对象,用于在 per-node 表格展示「套餐对该节点的实际限速」灰色 hint
  const limitsPackageQuery = useQuery({
    queryKey: ['package-detail', limitsEditState?.package_id],
    queryFn: async () => {
      const r = await api.get(`/api/admin/packages/${limitsEditState!.package_id}`)
      return r.data as { package?: { id: number; speed_limit_mbps: number; device_limit: number; node_speed_limits?: Record<string, number>; node_device_limits?: Record<string, number>; nodes?: number[] } }
    },
    enabled: !!limitsEditState?.package_id,
  })

  const { data: profile, isLoading: profileLoading, isError: profileError } = useQuery({
    queryKey: ['profile'],
    queryFn: profileQueryFn,
    enabled: Boolean(auth.accessToken),
    staleTime: 5 * 60 * 1000,
  })

  const isAdmin = Boolean(profile?.is_admin)

  const usersQuery = useQuery({
    queryKey: ['admin-users'],
    queryFn: async () => {
      const response = await api.get('/api/admin/users')
      return response.data as { users: UserRow[] }
    },
    enabled: Boolean(isAdmin && auth.accessToken),
    staleTime: 30 * 1000,
  })

  const packagesQuery = useQuery({
    queryKey: ['packages'],
    queryFn: async () => {
      const response = await api.get('/api/admin/packages')
      return response.data
    },
    enabled: Boolean(packageManageState && auth.accessToken),
  })

  const statusMutation = useMutation({
    mutationFn: async (payload: { username: string; is_active: boolean }) => {
      await api.post('/api/admin/users/status', payload)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      toast.success(t('toast.statusUpdated'))
    },
    onError: handleServerError,
  })

  const resetMutation = useMutation({
    mutationFn: async (payload: ResetState) => {
      const response = await api.post('/api/admin/users/reset-password', {
        username: payload.username,
        new_password: payload.password,
      })
      return response.data as { username: string; password: string }
    },
    onSuccess: (data) => {
      toast.success(t('toast.passwordReset'))
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      setResetState(null)

      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(data.password).catch(() => null)
      }
    },
    onError: (error) => {
      handleServerError(error)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (username: string) => {
      await api.post('/api/admin/users/delete', { username })
    },
    onSuccess: () => {
      toast.success(t('toast.userDeleted'))
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      setDeleteUsername(null)
    },
    onError: (error) => {
      handleServerError(error)
    },
  })

  const createMutation = useMutation({
    mutationFn: async (payload: CreateState) => {
      const response = await api.post('/api/admin/users/create', {
        username: payload.username,
        email: payload.email,
        nickname: payload.nickname,
        password: payload.password,
        remark: payload.remark,
      })
      return response.data as { username: string; email: string; nickname: string; role: string; password: string }
    },
    onSuccess: (data) => {
      toast.success(t('toast.userCreated'))
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      setCreateOpen(false)
      setCreateState({ username: '', email: '', nickname: '', password: generatePassword(), remark: '' })

      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(data.password).catch(() => null)
      }
    },
    onError: (error) => {
      handleServerError(error)
    },
  })

  const updatePackageMutation = useMutation({
    mutationFn: async (payload: { username: string; package_id: number | null; start_date?: string; expire_date?: string; is_reset?: boolean; reset_day?: number }) => {
      if (payload.package_id === null) {
        await api.post('/api/admin/packages/unassign', { username: payload.username })
        return { warnings: [] }
      } else {
        const resp = await api.post('/api/admin/packages/assign', {
          username: payload.username,
          package_id: payload.package_id,
          start_date: payload.start_date || new Date().toISOString().split('T')[0],
          expire_date: payload.expire_date,
          is_reset: payload.is_reset ?? false,
          reset_day: payload.reset_day ?? 1,
        })
        return resp.data as { message?: string; warnings?: string[] }
      }
    },
    onSuccess: (data, variables) => {
      if (data?.warnings?.length) {
        toast.warning(t('toast.packageWarning', { warnings: data.warnings.join(', ') }))
      } else {
        toast.success(t('toast.packageUpdated'))
      }
      queryClient.invalidateQueries({ queryKey: ['user-package', variables.username] })
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      setPackageManageState(null)
    },
    onError: handleServerError,
  })

  const remarkMutation = useMutation({
    mutationFn: async (payload: { username: string; remark: string }) => {
      await api.post('/api/admin/users/remark', payload)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      toast.success(t('toast.remarkUpdated'))
      setRemarkEditState(null)
    },
    onError: handleServerError,
  })

  // 短码 mutation:留空 = 清自定义(回退到自动生成 user_short_code);非空必须匹配 SHORT_CODE_RE。
  // 后端会再校验一次 + DB UNIQUE 索引兜底冲突。
  const shortCodeMutation = useMutation({
    mutationFn: async (payload: { username: string; short_code: string }) => {
      if (payload.short_code !== '' && !SHORT_CODE_RE.test(payload.short_code)) {
        throw new Error(t('toast.shortCodeInvalid', { defaultValue: '短码只能含字母 / 数字 / 下划线 / 横杠,长度 2-16' }))
      }
      await api.post('/api/admin/users/short-code', payload)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      toast.success(t('toast.shortCodeUpdated', { defaultValue: '短码已更新' }))
    },
    onError: (err: any) => {
      // 显式抛出的 Error(前端格式校验)直接弹 message;后端 409 / 500 走通用 handler
      const msg = err?.message || err?.response?.data?.error || err?.response?.data?.message
      if (msg) {
        toast.error(msg)
      } else {
        handleServerError(err)
      }
    },
  })

  // 统一保存:并行调全局 limits + per-node limits 两个 endpoint
  const limitsMutation = useMutation({
    mutationFn: async (payload: {
      username: string
      speed_limit_override: number | null
      device_limit_override: number | null
      node_speed_overrides: Record<number, number>
      node_device_overrides: Record<number, number>
    }) => {
      await Promise.all([
        api.put('/api/admin/users/limits', {
          username: payload.username,
          speed_limit_override: payload.speed_limit_override,
          device_limit_override: payload.device_limit_override,
        }),
        api.put('/api/admin/users/node-limits', {
          username: payload.username,
          node_speed_overrides: payload.node_speed_overrides,
          node_device_overrides: payload.node_device_overrides,
        }),
      ])
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      toast.success(t('toast.limitsUpdated'))
      setLimitsEditState(null)
    },
    onError: handleServerError,
  })

  // Hydration:Dialog 打开时,当套餐数据加载完毕,把空字段填入套餐默认值。
  // 只对"用户未设过 override"的字段填,不覆盖用户已有的值。每次 dialog 打开只 hydrate 一次,
  // 避免后续套餐查询刷新覆盖用户已改过的输入。
  const hydratedUsernameRef = useRef<string | null>(null)
  useEffect(() => {
    const state = limitsEditState
    const pkg = limitsPackageQuery.data?.package
    const subs = limitsSubaccountsQuery.data?.subaccounts
    if (!state || !pkg) return
    if (hydratedUsernameRef.current === state.username) return
    // 必须等 subaccounts 也加载完(per-node 输入框依赖它列出节点)
    if (!subs) return
    hydratedUsernameRef.current = state.username

    setLimitsEditState((prev) => {
      if (!prev) return prev
      const next = { ...prev }
      // 全局覆盖:用户已设非空,则保留;否则填入套餐通用值(0 = 不限速 也作为初始填入)
      if (next.speed_limit_override === '') {
        next.speed_limit_override = String(pkg.speed_limit_mbps ?? 0)
      }
      if (next.device_limit_override === '') {
        next.device_limit_override = String(pkg.device_limit ?? 0)
      }
      // per-node:每个可见节点,如果用户没设 override,就预填该节点在套餐里的实际值
      // (套餐 per-node ?? 套餐通用)
      const pkgNodeSpeed = pkg.node_speed_limits ?? {}
      const pkgNodeDevice = pkg.node_device_limits ?? {}
      const nextSpeed = { ...next.speed_overrides }
      const nextDevice = { ...next.device_overrides }
      for (const sa of subs) {
        if (typeof sa.node_id !== 'number') continue
        const k = String(sa.node_id)
        if (!(k in nextSpeed)) {
          const v = k in pkgNodeSpeed ? pkgNodeSpeed[k] : (pkg.speed_limit_mbps ?? 0)
          nextSpeed[k] = String(v)
        }
        if (!(k in nextDevice)) {
          const v = k in pkgNodeDevice ? pkgNodeDevice[k] : (pkg.device_limit ?? 0)
          nextDevice[k] = String(v)
        }
      }
      next.speed_overrides = nextSpeed
      next.device_overrides = nextDevice
      return next
    })
  }, [limitsEditState, limitsPackageQuery.data, limitsSubaccountsQuery.data])

  // dialog 关闭时重置 hydration 标记,下次打开新用户能重新填充
  useEffect(() => {
    if (limitsEditState === null) {
      hydratedUsernameRef.current = null
    }
  }, [limitsEditState])

  const users = useMemo(() => usersQuery.data?.users ?? [], [usersQuery.data])

  if (profileLoading) {
    return (
      <div className='min-h-svh bg-background'>
        <Topbar />
        <main className='mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 pt-24'>
          <Card className='shadow-none border-dashed'>
            <CardHeader>
              <CardTitle>{t('loading.title')}</CardTitle>
              <CardDescription>{t('loading.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className='space-y-3'>
                <div className='h-10 w-full rounded-md bg-muted animate-pulse' />
                <div className='h-10 w-full rounded-md bg-muted animate-pulse' />
                <div className='h-10 w-full rounded-md bg-muted animate-pulse' />
              </div>
            </CardContent>
          </Card>
        </main>
      </div>
    )
  }

  if (!isAdmin || profileError) {
    return (
      <div className='min-h-svh bg-background'>
        <Topbar />
        <main className='mx-auto flex w-full max-w-3xl flex-col items-center justify-center gap-4 px-4 py-20 text-center sm:px-6 pt-24'>
          <Card className='w-full shadow-none border-dashed'>
            <CardHeader>
              <CardTitle>{t('noPermission.title')}</CardTitle>
              <CardDescription>{t('noPermission.description')}</CardDescription>
            </CardHeader>
          </Card>
        </main>
      </div>
    )
  }

  return (
    <div className='min-h-svh bg-background'>
      <Topbar />
      <main className='mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 pt-24'>
        <section className='space-y-3'>
          <h1 className='text-3xl font-semibold tracking-tight'>{t('page.title')}</h1>
          <p className='text-muted-foreground'>{t('page.description')}</p>
        </section>

        <Card className='mt-8'>
          <CardHeader>
            <div className='flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'>
              <div>
                <CardTitle>{t('accountList.title')}</CardTitle>
                <CardDescription>{t('accountList.description')}</CardDescription>
              </div>
              <Button
                size='sm'
                disabled={usersAtLimit}
                title={usersAtLimit ? tc('license.userLimitReached', { current: licenseUsage?.usage?.users?.current, max: licenseUsage?.usage?.users?.max }) : undefined}
                onClick={() => {
                  setCreateState({ username: '', email: '', nickname: '', password: generatePassword(), remark: '' })
                  setCreateOpen(true)
                }}
              >
                {t('accountList.addUser')}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <DataTable
              data={users}
              getRowKey={(user) => user.username}
              emptyText={t('accountList.empty')}

              columns={[
                {
                  header: t('columns.username'),
                  cell: (user) => user.username,
                  cellClassName: 'font-medium',
                  width: '120px'
                },
                {
                  header: t('columns.nickname'),
                  cell: (user) => user.nickname || '—',
                  width: '120px'
                },
                {
                  header: t('columns.remark'),
                  cell: (user) => (
                    <div className='flex items-center gap-2'>
                      <span className='truncate max-w-[150px]' title={user.remark}>{user.remark || '—'}</span>
                      <Button
                        variant='ghost'
                        size='icon'
                        className='h-6 w-6 shrink-0'
                        onClick={() => setRemarkEditState({ username: user.username, remark: user.remark || '' })}
                      >
                        <Pencil className='h-3 w-3' />
                      </Button>
                    </div>
                  ),
                  width: '180px'
                },
                {
                  header: t('columns.userShortCode', { defaultValue: '用户短码' }),
                  cell: (user) => {
                    // 当前生效:custom 非空走 custom,否则系统自动生成的 user_short_code。
                    // 跟后端 GetEffectiveUserShortCode 一致。
                    const effective = user.custom_user_short_code || user.user_short_code || ''
                    return (
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button
                            variant='ghost'
                            size='sm'
                            className='h-7 px-2 font-mono text-xs gap-1'
                            title={t('shortCode.editTooltip', { defaultValue: '点击编辑短码' })}
                          >
                            <span>{effective || '—'}</span>
                            <Pencil className='h-3 w-3 opacity-60' />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className='w-72 p-3' align='start'>
                          <Label className='text-xs'>{t('shortCode.label', { defaultValue: '用户短码' })}</Label>
                          <Input
                            className='h-7 text-sm font-mono mt-1'
                            placeholder={user.user_short_code ? t('shortCode.placeholderAuto', { code: user.user_short_code, defaultValue: '留空恢复自动 ({{code}})' }) : t('shortCode.placeholderEmpty', { defaultValue: '留空使用自动短码' })}
                            defaultValue={user.custom_user_short_code || ''}
                            disabled={shortCodeMutation.isPending}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                const value = (e.target as HTMLInputElement).value.trim()
                                shortCodeMutation.mutate({ username: user.username, short_code: value })
                              }
                            }}
                          />
                          <p className='text-[10px] text-muted-foreground mt-1'>
                            {t('shortCode.hint', {
                              defaultValue: '回车保存。留空恢复自动短码。允许字母 / 数字 / 下划线 / 横杠,长度 2-16。',
                            })}
                          </p>
                        </PopoverContent>
                      </Popover>
                    )
                  },
                  width: '140px'
                },
                {
                  header: t('columns.packageTraffic'),
                  cell: (user) => {
                    if (!user.package_id) {
                      return (
                        <Button
                          variant='ghost'
                          size='sm'
                          className='text-muted-foreground h-7 px-2'
                          onClick={() =>
                            setPackageManageState({
                              username: user.username,
                              selectedPackageId: null,
                              isReset: user.is_reset ?? false,
                              resetDay: user.reset_day ?? 1,
                              expireDate: user.package_end_date ?? defaultExpireDate(),
                              initialized: true,
                            })
                          }
                        >
                          <Package className='h-3 w-3 mr-1' />
                          {t('package.bind')}
                        </Button>
                      )
                    }
                    const used = user.traffic_used ?? 0
                    const limit = user.traffic_limit ?? 0
                    const percent = limit > 0 ? Math.min((used / limit) * 100, 100) : 0
                    const isOver = user.is_over_limit
                    return (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div
                              className='w-full cursor-pointer space-y-1'
                              onClick={() =>
                                setPackageManageState({
                                  username: user.username,
                                  selectedPackageId: user.package_id ?? null,
                                  isReset: user.is_reset ?? false,
                                  resetDay: user.reset_day ?? 1,
                                  expireDate: user.package_end_date ?? defaultExpireDate(),
                                  initialized: true,
                                })
                              }
                            >
                              <div className='flex items-center justify-between text-xs'>
                                <span className='font-medium truncate max-w-[100px]'>{user.package_name}</span>
                                {isOver ? (
                                  <Badge variant='destructive' className='text-[10px] h-4 px-1'>{t('package.overLimit')}</Badge>
                                ) : (
                                  <span className='text-muted-foreground'>{percent.toFixed(0)}%</span>
                                )}
                              </div>
                              <Progress value={percent} className={`h-1.5 ${isOver ? '[&>div]:bg-destructive' : percent > 80 ? '[&>div]:bg-yellow-500' : ''}`} />
                            </div>
                          </TooltipTrigger>
                          <TooltipContent side='top' className='text-xs'>
                            <p>{t('package.tooltipPackage', { name: user.package_name })}</p>
                            <p>{t('package.tooltipUsed', { used: formatBytes(used) })}</p>
                            <p>{t('package.tooltipLimit', { limit: user.traffic_limit_gb })}</p>
                            <p>{t('package.tooltipPercent', { percent: percent.toFixed(1) })}</p>
                            {((user.speed_limit_mbps ?? 0) > 0 || user.speed_limit_override != null) && (
                              <p>{t('package.tooltipSpeed', { speed: user.speed_limit_override ?? user.speed_limit_mbps ?? 0 })}{user.speed_limit_override != null ? ` (${t('limits.override')})` : ''}</p>
                            )}
                            {((user.device_limit ?? 0) > 0 || user.device_limit_override != null) && (
                              <p>{t('package.tooltipDevice', { count: user.device_limit_override ?? user.device_limit ?? 0 })}{user.device_limit_override != null ? ` (${t('limits.override')})` : ''}</p>
                            )}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )
                  },
                  width: '200px'
                },
                {
                  header: t('columns.role'),
                  cell: (user) => {
                    const isAdminRow = user.role === 'admin'
                    return <span className='text-sm font-medium'>{isAdminRow ? t('roles.admin') : t('roles.user')}</span>
                  },
                  headerClassName: 'text-center',
                  cellClassName: 'text-center',
                  width: '100px'
                },
                {
                  header: t('columns.status'),
                  cell: (user) => {
                    const isSelf = user.username === profile?.username
                    const isAdminRow = user.role === 'admin'
                    return (
                      <Switch
                        checked={user.is_active}
                        disabled={statusMutation.isPending || isSelf || isAdminRow}
                        onCheckedChange={(checked) =>
                          statusMutation.mutate({
                            username: user.username,
                            is_active: checked,
                          })
                        }
                      />
                    )
                  },
                  headerClassName: 'text-center',
                  cellClassName: 'text-center',
                  width: '100px'
                },
                {
                  header: t('columns.actions'),
                  cell: (user) => {
                    const isAdminRow = user.role === 'admin'
                    return isAdminRow ? (
                      <span className='text-sm text-muted-foreground'>—</span>
                    ) : (
                      <div className='flex items-center justify-end gap-2'>
                        <Button
                          size='sm'
                          variant='outline'
                          disabled={resetMutation.isPending}
                          onClick={() =>
                            setResetState({
                              username: user.username,
                              password: generatePassword(),
                            })
                          }
                        >
                          {t('actions.resetPassword')}
                        </Button>
                        <Button
                          size='sm'
                          variant='outline'
                          onClick={() =>
                            setPackageManageState({
                              username: user.username,
                              selectedPackageId: user.package_id ?? null,
                              isReset: user.is_reset ?? false,
                              resetDay: user.reset_day ?? 1,
                              expireDate: user.package_end_date ?? defaultExpireDate(),
                              initialized: true,
                            })
                          }
                        >
                          <Package className='h-3 w-3 mr-1' />
                          {t('package.manage')}
                        </Button>
                        {user.package_id && (
                          <Button
                            size='sm'
                            variant='outline'
                            onClick={() => {
                              const speedOverrides: Record<string, string> = {}
                              const deviceOverrides: Record<string, string> = {}
                              if (user.node_speed_limit_overrides) {
                                for (const [k, v] of Object.entries(user.node_speed_limit_overrides)) {
                                  speedOverrides[k] = String(v)
                                }
                              }
                              if (user.node_device_limit_overrides) {
                                for (const [k, v] of Object.entries(user.node_device_limit_overrides)) {
                                  deviceOverrides[k] = String(v)
                                }
                              }
                              setLimitsEditState({
                                username: user.username,
                                package_id: user.package_id ?? null,
                                speed_limit_override: user.speed_limit_override != null ? String(user.speed_limit_override) : '',
                                device_limit_override: user.device_limit_override != null ? String(user.device_limit_override) : '',
                                speed_overrides: speedOverrides,
                                device_overrides: deviceOverrides,
                              })
                            }}
                          >
                            <Gauge className='h-3 w-3 mr-1' />
                            {t('limits.edit')}
                          </Button>
                        )}
                        <Button
                          size='sm'
                          variant='outline'
                          onClick={() => setSubaccountsViewUser(user.username)}
                          title='查看子账户与所在节点'
                        >
                          <UsersIcon className='h-3 w-3 mr-1' />
                          子账户
                        </Button>
                        <Button
                          size='sm'
                          variant='destructive'
                          disabled={deleteMutation.isPending}
                          onClick={() => setDeleteUsername(user.username)}
                        >
                          {t('actions.deleteUser')}
                        </Button>
                      </div>
                    )
                  },
                  headerClassName: 'text-right',
                  cellClassName: 'text-right',
                  width: '340px'
                }
              ] as DataTableColumn<UserRow>[]}

              mobileCard={{
                header: (user) => {
                  const isAdminRow = user.role === 'admin'
                  return (
                    <div>
                      <div className='flex items-center justify-between mb-1'>
                        <div className='font-medium text-sm'>{user.username}</div>
                        <Badge variant={isAdminRow ? 'default' : 'secondary'} className='text-xs'>
                          {isAdminRow ? t('roles.admin') : t('roles.user')}
                        </Badge>
                      </div>
                      {user.nickname && (
                        <div className='text-xs text-muted-foreground line-clamp-1'>{user.nickname}</div>
                      )}
                    </div>
                  )
                },
                fields: [
                  {
                    label: t('columns.email'),
                    value: (user) => <span className='break-all'>{user.email || '—'}</span>
                  },
                  {
                    label: t('columns.remark'),
                    value: (user) => (
                      <div className='flex items-center gap-2'>
                        <span className='truncate'>{user.remark || '—'}</span>
                        <Button
                          variant='ghost'
                          size='icon'
                          className='h-6 w-6 shrink-0'
                          onClick={() => setRemarkEditState({ username: user.username, remark: user.remark || '' })}
                        >
                          <Pencil className='h-3 w-3' />
                        </Button>
                      </div>
                    )
                  },
                  {
                    label: t('columns.status'),
                    value: (user) => {
                      const isSelf = user.username === profile?.username
                      const isAdminRow = user.role === 'admin'
                      return (
                        <div className='flex items-center gap-2'>
                          <Switch
                            checked={user.is_active}
                            disabled={statusMutation.isPending || isSelf || isAdminRow}
                            onCheckedChange={(checked) =>
                              statusMutation.mutate({
                                username: user.username,
                                is_active: checked,
                              })
                            }
                          />
                          <span>{user.is_active ? t('status.enabled') : t('status.disabled')}</span>
                        </div>
                      )
                    }
                  }
                ],
                actions: (user) => {
                  const isAdminRow = user.role === 'admin'
                  return isAdminRow ? null : (
                    <>
                      <Button
                        variant='outline'
                        size='sm'
                        className='flex-1'
                        disabled={resetMutation.isPending}
                        onClick={() =>
                          setResetState({
                            username: user.username,
                            password: generatePassword(),
                          })
                        }
                      >
                        {t('actions.resetPassword')}
                      </Button>
                      <Button
                        variant='outline'
                        size='sm'
                        className='flex-1'
                        onClick={() =>
                          setPackageManageState({
                            username: user.username,
                            selectedPackageId: user.package_id ?? null,
                            isReset: user.is_reset ?? false,
                            resetDay: user.reset_day ?? 1,
                            expireDate: user.package_end_date ?? defaultExpireDate(),
                            initialized: true,
                          })
                        }
                      >
                        {t('package.manage')}
                      </Button>
                      <Button
                        variant='outline'
                        size='sm'
                        className='flex-1'
                        onClick={() => setSubaccountsViewUser(user.username)}
                      >
                        子账户
                      </Button>
                      <Button
                        variant='destructive'
                        size='sm'
                        className='flex-1'
                        disabled={deleteMutation.isPending}
                        onClick={() => setDeleteUsername(user.username)}
                      >
                        {t('actions.deleteUser')}
                      </Button>
                    </>
                  )
                }
              }}
            />
          </CardContent>
        </Card>
      </main>

      <Dialog open={createOpen} onOpenChange={(open) => setCreateOpen(open)}>
        <DialogContent className='sm:max-w-lg max-h-[90vh] overflow-y-auto'>
          <DialogHeader>
            <DialogTitle>{t('createDialog.title')}</DialogTitle>
          </DialogHeader>
          <div className='space-y-4'>
            <div className='space-y-2'>
              <Label htmlFor='create-username'>{t('createDialog.username')}</Label>
              <Input
                id='create-username'
                value={createState.username}
                autoComplete='off'
                onChange={(event) =>
                  setCreateState((prev) => {
                    const value = event.target.value
                    const shouldSyncNickname = prev.nickname === '' || prev.nickname === prev.username
                    return {
                      ...prev,
                      username: value,
                      nickname: shouldSyncNickname ? value : prev.nickname,
                    }
                  })
                }
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='create-email'>{t('createDialog.email')}</Label>
              <Input
                id='create-email'
                type='email'
                value={createState.email}
                autoComplete='off'
                onChange={(event) =>
                  setCreateState((prev) => ({ ...prev, email: event.target.value }))
                }
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='create-nickname'>{t('createDialog.nickname')}</Label>
              <Input
                id='create-nickname'
                value={createState.nickname}
                autoComplete='off'
                onChange={(event) =>
                  setCreateState((prev) => ({ ...prev, nickname: event.target.value }))
                }
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='create-password'>{t('createDialog.password')}</Label>
              <Input
                id='create-password'
                type='text'
                value={createState.password}
                onChange={(event) =>
                  setCreateState((prev) => ({ ...prev, password: event.target.value }))
                }
              />
              <p className='text-xs text-muted-foreground'>{t('createDialog.passwordHint')}</p>
            </div>
            <div className='space-y-2'>
              <Label htmlFor='create-remark'>{t('createDialog.remark')}</Label>
              <Input
                id='create-remark'
                value={createState.remark}
                placeholder={t('createDialog.remarkPlaceholder')}
                autoComplete='off'
                onChange={(event) =>
                  setCreateState((prev) => ({ ...prev, remark: event.target.value }))
                }
              />
            </div>
          </div>
          <DialogFooter className='gap-2'>
            <DialogClose asChild>
              <Button type='button' variant='outline' disabled={createMutation.isPending}>
                {t('actions.cancel', { ns: 'common' })}
              </Button>
            </DialogClose>
            <Button
              type='button'
              disabled={!createState.username || createMutation.isPending}
              onClick={() => createMutation.mutate(createState)}
            >
              {createMutation.isPending ? t('createDialog.creating') : t('createDialog.confirmCreate')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(resetState)} onOpenChange={(open) => (open ? null : setResetState(null))}>
        <DialogContent className='sm:max-w-md'>
          <DialogHeader>
            <DialogTitle>{t('resetDialog.title')}</DialogTitle>
          </DialogHeader>
          <div className='space-y-4'>
            <div className='space-y-2'>
              <Label>{t('resetDialog.username')}</Label>
              <Input value={resetState?.username ?? ''} readOnly disabled />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='new-password'>{t('resetDialog.newPassword')}</Label>
              <Input
                id='new-password'
                type='text'
                value={resetState?.password ?? ''}
                onChange={(event) =>
                  setResetState((prev) =>
                    prev
                      ? {
                          ...prev,
                          password: event.target.value,
                        }
                      : prev
                  )
                }
              />
              <p className='text-xs text-muted-foreground'>{t('resetDialog.passwordHint')}</p>
            </div>
          </div>
          <DialogFooter className='gap-2'>
            <DialogClose asChild>
              <Button type='button' variant='outline' disabled={resetMutation.isPending}>
                {t('actions.cancel', { ns: 'common' })}
              </Button>
            </DialogClose>
            <Button
              type='button'
              disabled={!resetState?.password || resetMutation.isPending}
              onClick={() => resetState && resetMutation.mutate(resetState)}
            >
              {resetMutation.isPending ? t('resetDialog.resetting') : t('resetDialog.confirmReset')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteUsername)} onOpenChange={(open) => !open && setDeleteUsername(null)}>
        <DialogContent className='sm:max-w-md'>
          <DialogHeader>
            <DialogTitle>{t('deleteDialog.title')}</DialogTitle>
          </DialogHeader>
          <div className='space-y-4'>
            <p className='text-sm text-muted-foreground'>
              <span dangerouslySetInnerHTML={{ __html: t('deleteDialog.description', { username: deleteUsername }) }} />
            </p>
            <ul className='list-disc list-inside text-sm text-muted-foreground space-y-1'>
              <li>{t('deleteDialog.dataAccount')}</li>
              <li>{t('deleteDialog.dataSubscription')}</li>
              <li>{t('deleteDialog.dataNodes')}</li>
              <li>{t('deleteDialog.dataExternalSub')}</li>
              <li>{t('deleteDialog.dataSettings')}</li>
            </ul>
            <p className='text-sm text-destructive font-medium'>{t('deleteDialog.irreversible')}</p>
          </div>
          <DialogFooter className='gap-2'>
            <DialogClose asChild>
              <Button type='button' variant='outline' disabled={deleteMutation.isPending}>
                {t('actions.cancel', { ns: 'common' })}
              </Button>
            </DialogClose>
            <Button
              type='button'
              variant='destructive'
              disabled={deleteMutation.isPending}
              onClick={() => deleteUsername && deleteMutation.mutate(deleteUsername)}
            >
              {deleteMutation.isPending ? t('deleteDialog.deleting') : t('deleteDialog.confirmDelete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(packageManageState)} onOpenChange={(open) => !open && setPackageManageState(null)}>
        <DialogContent className='sm:max-w-md'>
          <DialogHeader>
            <DialogTitle>{t('packageDialog.title')}</DialogTitle>
          </DialogHeader>
          <div className='space-y-4'>
            <div className='space-y-2'>
              <Label>{t('packageDialog.username')}</Label>
              <Input value={packageManageState?.username ?? ''} readOnly disabled />
            </div>
            <div className='space-y-3'>
              <Label>{t('packageDialog.selectPackage')}</Label>
              {(packagesQuery.isLoading || packagesQuery.isPending) ? (
                <div className='text-sm text-muted-foreground'>{t('packageDialog.loadingPackages')}</div>
              ) : (packagesQuery.data?.packages as any[])?.length > 0 ? (
                <div className='space-y-2 max-h-80 overflow-y-auto border rounded-md p-3'>
                  <div
                    className={`flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 transition hover:bg-muted ${packageManageState?.selectedPackageId === null ? 'bg-primary/10 border border-primary/30' : ''}`}
                    onClick={() => setPackageManageState((prev) => prev ? { ...prev, selectedPackageId: null } : prev)}
                  >
                    <span className='text-sm font-medium'>{t('packageDialog.noPackage')}</span>
                  </div>
                  {(packagesQuery.data?.packages as any[]).map((pkg: any) => (
                    <div
                      key={pkg.id}
                      className={`flex cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 transition hover:bg-muted ${packageManageState?.selectedPackageId === pkg.id ? 'bg-primary/10 border border-primary/30' : ''}`}
                      onClick={() => setPackageManageState((prev) => prev ? { ...prev, selectedPackageId: pkg.id } : prev)}
                    >
                      <div>
                        <div className='text-sm font-medium'>{pkg.name}</div>
                        {pkg.description && <div className='text-xs text-muted-foreground'>{pkg.description}</div>}
                      </div>
                      <Badge variant='secondary' className='shrink-0'>{pkg.traffic_limit_gb} GB</Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <div className='text-sm text-muted-foreground'>{t('packageDialog.noAvailablePackages')}</div>
              )}
            </div>
            {packageManageState?.selectedPackageId != null && (
              <div className='space-y-3'>
                <div className='space-y-2'>
                  <Label htmlFor='pkg-expire-date'>{t('packageDialog.expireDate')}</Label>
                  <Input
                    id='pkg-expire-date'
                    type='date'
                    value={packageManageState?.expireDate ?? ''}
                    onChange={(e) => setPackageManageState((prev) => prev ? { ...prev, expireDate: e.target.value } : prev)}
                  />
                  <p className='text-xs text-muted-foreground'>{t('packageDialog.expireDateHint')}</p>
                </div>
                <div className='flex items-center space-x-2'>
                  <Checkbox
                    id='pkg-is-reset'
                    checked={packageManageState?.isReset ?? false}
                    onCheckedChange={(checked) => setPackageManageState((prev) => prev ? { ...prev, isReset: !!checked, ...(checked ? { resetDay: new Date().getDate() } : {}) } : prev)}
                  />
                  <Label htmlFor='pkg-is-reset' className='cursor-pointer'>{t('packageDialog.enableMonthlyReset')}</Label>
                </div>
                {packageManageState?.isReset && (
                  <div className='space-y-2'>
                    <Label htmlFor='pkg-reset-day'>{t('packageDialog.monthlyResetDay')}</Label>
                    <Input
                      id='pkg-reset-day'
                      type='number'
                      min={1}
                      max={31}
                      value={packageManageState.resetDay}
                      onChange={(e) => setPackageManageState((prev) => prev ? { ...prev, resetDay: parseInt(e.target.value) || 1 } : prev)}
                    />
                    <p className='text-xs text-muted-foreground'>
                      {t('packageDialog.monthlyResetDayHint')}{packageManageState.resetDay > 28 && t('packageDialog.monthlyResetDayWarning')}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
          <DialogFooter className='gap-2'>
            <DialogClose asChild>
              <Button type='button' variant='outline' disabled={updatePackageMutation.isPending}>
                {t('actions.cancel', { ns: 'common' })}
              </Button>
            </DialogClose>
            <Button
              type='button'
              disabled={updatePackageMutation.isPending}
              onClick={() => {
                if (packageManageState) {
                  updatePackageMutation.mutate({
                    username: packageManageState.username,
                    package_id: packageManageState.selectedPackageId,
                    expire_date: packageManageState.expireDate,
                    is_reset: packageManageState.isReset,
                    reset_day: packageManageState.resetDay,
                  })
                }
              }}
            >
              {updatePackageMutation.isPending ? t('packageDialog.saving') : t('packageDialog.confirmSave')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(remarkEditState)} onOpenChange={(open) => !open && setRemarkEditState(null)}>
        <DialogContent className='sm:max-w-md'>
          <DialogHeader>
            <DialogTitle>{t('remarkDialog.title')}</DialogTitle>
          </DialogHeader>
          <div className='space-y-4'>
            <div className='space-y-2'>
              <Label>{t('remarkDialog.username')}</Label>
              <Input value={remarkEditState?.username ?? ''} readOnly disabled />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='edit-remark'>{t('remarkDialog.remark')}</Label>
              <Input
                id='edit-remark'
                value={remarkEditState?.remark ?? ''}
                placeholder={t('remarkDialog.remarkPlaceholder')}
                onChange={(event) =>
                  setRemarkEditState((prev) =>
                    prev ? { ...prev, remark: event.target.value } : prev
                  )
                }
              />
            </div>
          </div>
          <DialogFooter className='gap-2'>
            <DialogClose asChild>
              <Button type='button' variant='outline' disabled={remarkMutation.isPending}>
                {t('actions.cancel', { ns: 'common' })}
              </Button>
            </DialogClose>
            <Button
              type='button'
              disabled={remarkMutation.isPending}
              onClick={() => remarkEditState && remarkMutation.mutate(remarkEditState)}
            >
              {remarkMutation.isPending ? t('remarkDialog.saving') : t('remarkDialog.confirmSave')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 用户限速统一编辑 dialog:全局覆盖 + per-node 覆盖合在同一 dialog */}
      <Dialog open={Boolean(limitsEditState)} onOpenChange={(open) => !open && setLimitsEditState(null)}>
        <DialogContent className='max-w-3xl max-h-[90vh] flex flex-col overflow-hidden'>
          <DialogHeader>
            <DialogTitle>{t('limits.title')} — {limitsEditState?.username}</DialogTitle>
          </DialogHeader>

          <div className='flex-1 overflow-y-auto space-y-5 pr-1'>
            {/* 全局覆盖 */}
            <div>
              <div className='text-sm font-semibold mb-2'>{t('limits.globalHeader', { defaultValue: '全局覆盖(对所有节点生效)' })}</div>
              <div className='grid grid-cols-1 sm:grid-cols-2 gap-3'>
                <div className='space-y-2'>
                  <Label htmlFor='edit-speed-limit'>{t('limits.speedLimit')}</Label>
                  <Input
                    id='edit-speed-limit'
                    type='number'
                    min='0'
                    step='1'
                    value={limitsEditState?.speed_limit_override ?? ''}
                    placeholder={t('limits.speedPlaceholder')}
                    onChange={(event) =>
                      setLimitsEditState((prev) =>
                        prev ? { ...prev, speed_limit_override: event.target.value } : prev
                      )
                    }
                  />
                  <p className='text-xs text-muted-foreground'>{t('limits.speedDesc')}</p>
                </div>
                <div className='space-y-2'>
                  <Label htmlFor='edit-device-limit'>{t('limits.deviceLimit')}</Label>
                  <Input
                    id='edit-device-limit'
                    type='number'
                    min='0'
                    step='1'
                    value={limitsEditState?.device_limit_override ?? ''}
                    placeholder={t('limits.devicePlaceholder')}
                    onChange={(event) =>
                      setLimitsEditState((prev) =>
                        prev ? { ...prev, device_limit_override: event.target.value } : prev
                      )
                    }
                  />
                  <p className='text-xs text-muted-foreground'>{t('limits.deviceDesc')}</p>
                </div>
              </div>
            </div>

            {/* per-node 覆盖 */}
            <div>
              <div className='text-sm font-semibold mb-2'>
                {t('limits.perNodeHeader', { defaultValue: '每节点覆盖(优先级最高)' })}
              </div>
              {limitsSubaccountsQuery.isLoading ? (
                <div className='py-6 text-center text-sm text-muted-foreground'>{t('limits.loading', { defaultValue: '加载中…' })}</div>
              ) : !limitsSubaccountsQuery.data?.subaccounts?.length ? (
                <div className='py-6 text-center text-sm text-muted-foreground border rounded-md'>{t('limits.empty', { defaultValue: '该用户暂无可见节点' })}</div>
              ) : (() => {
                // 去重 by node_id(同一节点的多个子账户合并成一行)
                type RowEntry = { node_id: number; node_name: string; server_name: string; protocol: string }
                const seen = new Map<number, RowEntry>()
                for (const sa of limitsSubaccountsQuery.data!.subaccounts) {
                  if (typeof sa.node_id !== 'number') continue
                  if (!seen.has(sa.node_id)) {
                    seen.set(sa.node_id, {
                      node_id: sa.node_id,
                      node_name: sa.node_name || `node-${sa.node_id}`,
                      server_name: sa.server_name || '',
                      protocol: sa.protocol || '',
                    })
                  }
                }
                const rows = Array.from(seen.values())
                const pkg = limitsPackageQuery.data?.package
                const pkgNodeSpeed = pkg?.node_speed_limits ?? {}
                const pkgNodeDevice = pkg?.node_device_limits ?? {}
                const pkgSpeed = pkg?.speed_limit_mbps ?? 0
                const pkgDevice = pkg?.device_limit ?? 0
                // 套餐对该节点的实际限速 = node_speed_limits[id] ?? speed_limit_mbps(0=显式不限速)
                const effectivePkgSpeed = (nodeId: number): number => {
                  const k = String(nodeId)
                  if (k in pkgNodeSpeed) return pkgNodeSpeed[k]
                  return pkgSpeed
                }
                const effectivePkgDevice = (nodeId: number): number => {
                  const k = String(nodeId)
                  if (k in pkgNodeDevice) return pkgNodeDevice[k]
                  return pkgDevice
                }
                return (
                  <div className='border rounded-md overflow-hidden'>
                    <table className='w-full text-sm'>
                      <thead className='text-xs text-muted-foreground border-b bg-muted/40'>
                        <tr>
                          <th className='text-left py-2 px-2 font-medium'>{t('limits.colNode', { defaultValue: '节点' })}</th>
                          <th className='text-right py-2 px-2 font-medium'>{t('limits.colSpeedOverride', { defaultValue: '限速 Mbps' })}</th>
                          <th className='text-right py-2 px-2 font-medium'>{t('limits.colDeviceOverride', { defaultValue: '客户端数' })}</th>
                        </tr>
                      </thead>
                      <tbody className='divide-y'>
                        {rows.map((r) => (
                          <tr key={r.node_id}>
                            <td className='py-2 px-2'>
                              <div className='font-medium'>{r.node_name}</div>
                              <div className='text-[10px] text-muted-foreground'>
                                {r.server_name}
                                {r.protocol && ` · ${r.protocol}`}
                              </div>
                            </td>
                            <td className='py-2 px-2 text-right'>
                              <Input
                                type='number'
                                min='0'
                                step='1'
                                value={limitsEditState?.speed_overrides[String(r.node_id)] ?? ''}
                                placeholder={String(effectivePkgSpeed(r.node_id))}
                                onChange={(e) => {
                                  const raw = e.target.value
                                  setLimitsEditState((prev) => {
                                    if (!prev) return prev
                                    const next = { ...prev.speed_overrides }
                                    if (raw === '') delete next[String(r.node_id)]
                                    else next[String(r.node_id)] = raw
                                    return { ...prev, speed_overrides: next }
                                  })
                                }}
                                className='no-spin h-7 w-24 text-xs text-right tabular-nums inline-block'
                                aria-label='speed override'
                              />
                            </td>
                            <td className='py-2 px-2 text-right'>
                              <Input
                                type='number'
                                min='0'
                                step='1'
                                value={limitsEditState?.device_overrides[String(r.node_id)] ?? ''}
                                placeholder={String(effectivePkgDevice(r.node_id))}
                                onChange={(e) => {
                                  const raw = e.target.value
                                  setLimitsEditState((prev) => {
                                    if (!prev) return prev
                                    const next = { ...prev.device_overrides }
                                    if (raw === '') delete next[String(r.node_id)]
                                    else next[String(r.node_id)] = raw
                                    return { ...prev, device_overrides: next }
                                  })
                                }}
                                className='no-spin h-7 w-20 text-xs text-right tabular-nums inline-block'
                                aria-label='device override'
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              })()}
              <p className='text-xs text-muted-foreground mt-2'>
                {t('limits.fallbackHint', { defaultValue: '默认从套餐继承。修改后该值覆盖套餐。0 = 显式不限速;留空 = 沿用上一层。' })}
              </p>
            </div>
          </div>

          <DialogFooter className='gap-2'>
            <DialogClose asChild>
              <Button type='button' variant='outline' disabled={limitsMutation.isPending}>
                {t('actions.cancel', { ns: 'common' })}
              </Button>
            </DialogClose>
            <Button
              type='button'
              disabled={limitsMutation.isPending}
              onClick={() => {
                if (!limitsEditState) return
                // 关键:跟"套餐当前值"比对,相等就过滤为 null/delete(等价于"沿用套餐",
                // 保留 fallback 语义 — 后续套餐改了能跟着变,不会被冻结在旧值)
                const pkg = limitsPackageQuery.data?.package
                const pkgSpeed = pkg?.speed_limit_mbps ?? 0
                const pkgDevice = pkg?.device_limit ?? 0
                const pkgNodeSpeed = pkg?.node_speed_limits ?? {}
                const pkgNodeDevice = pkg?.node_device_limits ?? {}

                const effectivePkgSpeed = (nodeId: number): number => {
                  const k = String(nodeId)
                  if (k in pkgNodeSpeed) return pkgNodeSpeed[k]
                  return pkgSpeed
                }
                const effectivePkgDevice = (nodeId: number): number => {
                  const k = String(nodeId)
                  if (k in pkgNodeDevice) return pkgNodeDevice[k]
                  return pkgDevice
                }

                // 全局:用户填的等于套餐通用值 → 视为 null(沿用套餐)
                const speedStr = limitsEditState.speed_limit_override
                const deviceStr = limitsEditState.device_limit_override
                const speedNum = speedStr !== '' && Number.isFinite(parseFloat(speedStr)) ? parseFloat(speedStr) : null
                const deviceNum = deviceStr !== '' && Number.isFinite(parseInt(deviceStr, 10)) ? parseInt(deviceStr, 10) : null
                const speedOverride = speedNum !== null && speedNum !== pkgSpeed ? speedNum : null
                const deviceOverride = deviceNum !== null && deviceNum !== pkgDevice ? deviceNum : null

                // per-node:用户填的等于该节点的"套餐实际限速"→ 视为沿用,不写入 map
                const speedPayload: Record<number, number> = {}
                for (const [k, v] of Object.entries(limitsEditState.speed_overrides)) {
                  if (v === '') continue
                  const n = parseFloat(v)
                  if (!Number.isFinite(n) || n < 0) continue
                  const nodeId = Number(k)
                  if (n === effectivePkgSpeed(nodeId)) continue
                  speedPayload[nodeId] = n
                }
                const devicePayload: Record<number, number> = {}
                for (const [k, v] of Object.entries(limitsEditState.device_overrides)) {
                  if (v === '') continue
                  const n = parseInt(v, 10)
                  if (!Number.isFinite(n) || n < 0) continue
                  const nodeId = Number(k)
                  if (n === effectivePkgDevice(nodeId)) continue
                  devicePayload[nodeId] = n
                }

                limitsMutation.mutate({
                  username: limitsEditState.username,
                  speed_limit_override: speedOverride,
                  device_limit_override: deviceOverride,
                  node_speed_overrides: speedPayload,
                  node_device_overrides: devicePayload,
                })
              }}
            >
              {limitsMutation.isPending ? t('remarkDialog.saving') : t('remarkDialog.confirmSave')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 子账户与所在节点对话框(管理员视图) */}
      <Dialog open={Boolean(subaccountsViewUser)} onOpenChange={(open) => !open && setSubaccountsViewUser(null)}>
        <DialogContent className='max-w-2xl'>
          <DialogHeader>
            <DialogTitle>子账户与所在节点 — {subaccountsViewUser}</DialogTitle>
          </DialogHeader>
          <ScrollArea className='max-h-[60vh] pr-2'>
            {subaccountsQuery.isLoading ? (
              <div className='py-6 text-center text-sm text-muted-foreground'>加载中…</div>
            ) : !subaccountsQuery.data?.subaccounts?.length ? (
              <div className='py-6 text-center text-sm text-muted-foreground'>该用户暂无子账户</div>
            ) : (
              <div className='space-y-2'>
                {subaccountsQuery.data.subaccounts.map((sa, idx) => (
                  <div key={idx} className='rounded border p-3 text-sm space-y-1'>
                    <div className='flex items-center gap-2'>
                      <Badge variant={sa.type === 'routed' ? 'default' : 'secondary'}>
                        {sa.type === 'routed' ? '路由出站' : '入站绑定'}
                      </Badge>
                      {!sa.is_active && <Badge variant='outline'>已暂停</Badge>}
                      <span className='ml-auto text-xs text-muted-foreground'>{sa.updated_at}</span>
                    </div>
                    {sa.node_name && (
                      <div className='text-xs'>
                        <span className='text-muted-foreground'>节点: </span>
                        <span className='font-mono'>{sa.node_name}</span>
                      </div>
                    )}
                    {sa.server_name && (
                      <div className='text-xs'>
                        <span className='text-muted-foreground'>服务器: </span>
                        <span className='font-mono'>{sa.server_name}</span>
                      </div>
                    )}
                    {sa.inbound_tag && (
                      <div className='text-xs'>
                        <span className='text-muted-foreground'>入站 tag: </span>
                        <span className='font-mono'>{sa.inbound_tag}</span>
                        {sa.protocol && <span className='text-muted-foreground ml-2'>({sa.protocol})</span>}
                      </div>
                    )}
                    {sa.email && (
                      <div className='text-xs'>
                        <span className='text-muted-foreground'>email: </span>
                        <span className='font-mono'>{sa.email}</span>
                      </div>
                    )}
                    {sa.identifier && (
                      <div className='text-xs break-all'>
                        <span className='text-muted-foreground'>凭据: </span>
                        <span className='font-mono'>{sa.identifier}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
          <DialogFooter>
            <Button variant='outline' onClick={() => setSubaccountsViewUser(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
