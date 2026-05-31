import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { BookOpen, CircleHelp, Copy, Eye, EyeOff, KeyRound, Lock, RefreshCw, Settings, Timer } from 'lucide-react'
import { Topbar } from '@/components/layout/topbar'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import { handleServerError } from '@/lib/handle-server-error'
import { useAuthStore } from '@/stores/auth-store'
import { UserPermissionsDialog } from '@/components/user-permissions-dialog'

export const Route = createFileRoute('/system-settings')({
  beforeLoad: () => {
    const token = useAuthStore.getState().auth.accessToken
    if (!token) {
      throw redirect({ to: '/' })
    }
  },
  component: SystemSettingsPage,
})

function SystemSettingsPage() {
  const { t } = useTranslation('system')
  const queryClient = useQueryClient()
  const { auth } = useAuthStore()
  const [forceSyncExternal, setForceSyncExternal] = useState(false)
  const [matchRule, setMatchRule] = useState<'node_name' | 'server_port' | 'type_server_port'>('node_name')
  const [syncScope, setSyncScope] = useState<'saved_only' | 'all'>('saved_only')
  const [keepNodeName, setKeepNodeName] = useState(true)
  const [cacheExpireMinutes, setCacheExpireMinutes] = useState(0)
  const [syncTraffic, setSyncTraffic] = useState(false)
  const [nodeNameFilter, setNodeNameFilter] = useState('剩余|流量|到期|订阅|时间|重置')
  const [appendSubInfo, setAppendSubInfo] = useState(false)
  const [showApiToken, setShowApiToken] = useState(false)
  const [masterUrl, setMasterUrl] = useState('')

  // Master URL query
  const { data: masterUrlData } = useQuery({
    queryKey: ['master-url'],
    queryFn: async () => {
      const response = await api.get('/api/admin/system-settings/master-url')
      return response.data as { success: boolean; master_url: string }
    },
    enabled: Boolean(auth.accessToken),
    staleTime: 5 * 60 * 1000,
  })

  useEffect(() => {
    if (masterUrlData?.master_url !== undefined) {
      setMasterUrl(masterUrlData.master_url)
    }
  }, [masterUrlData])

  const updateMasterUrlMutation = useMutation({
    mutationFn: async (url: string) => {
      await api.put('/api/admin/system-settings/master-url', { master_url: url })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['master-url'] })
      toast.success(t('masterUrl.updated'))
    },
    onError: handleServerError,
  })

  // API Token query
  const { data: apiTokenData, isLoading: loadingApiToken } = useQuery({
    queryKey: ['api-token'],
    queryFn: async () => {
      const response = await api.get('/api/admin/system-settings/api-token')
      return response.data as { success: boolean; token: string }
    },
    enabled: Boolean(auth.accessToken),
    staleTime: 5 * 60 * 1000,
  })

  // Regenerate API Token mutation
  const regenerateApiTokenMutation = useMutation({
    mutationFn: async () => {
      const response = await api.post('/api/admin/system-settings/api-token/regenerate')
      return response.data as { success: boolean; token: string; message: string }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-token'] })
      toast.success(t('apiToken.regenerated'))
    },
    onError: handleServerError,
  })

  const copyApiToken = () => {
    if (apiTokenData?.token) {
      navigator.clipboard.writeText(apiTokenData.token)
      toast.success(t('apiToken.copied'))
    }
  }
  // 短链接全局开关（系统级设置）
  const { data: shortLinkData } = useQuery({
    queryKey: ['short-link-enabled'],
    queryFn: async () => {
      const response = await api.get('/api/admin/system-settings/short-link')
      return response.data as { success: boolean; enable_short_link: boolean }
    },
    enabled: Boolean(auth.accessToken),
    staleTime: 5 * 60 * 1000,
  })

  const toggleShortLinkMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      await api.put('/api/admin/system-settings/short-link', { enable_short_link: enabled })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['short-link-enabled'] })
      queryClient.invalidateQueries({ queryKey: ['user-subscriptions'] })
      toast.success(t('shortLink.updated'))
    },
    onError: handleServerError,
  })

  useEffect(() => {
    if (shortLinkData?.enable_short_link !== undefined) {
      setEnableShortLink(shortLinkData.enable_short_link)
    }
  }, [shortLinkData])

  const [enableShortLink, setEnableShortLink] = useState(true)
  const [enableOverrideScripts, setEnableOverrideScripts] = useState(false)
  const [useNewTemplateSystem, setUseNewTemplateSystem] = useState(true)
  const [enableMmwFeatures, setEnableMmwFeatures] = useState(true)
  const [enableUserRoutedOutbound, setEnableUserRoutedOutbound] = useState(false)
  const [userRoutedOutboundQuota, setUserRoutedOutboundQuota] = useState(2)
  const [userRoutedOutboundDailyLimit, setUserRoutedOutboundDailyLimit] = useState(5)

  const { data: overrideScriptsData } = useQuery({
    queryKey: ['override-scripts-enabled'],
    queryFn: async () => {
      const response = await api.get('/api/admin/system-settings/override-scripts')
      return response.data as { success: boolean; enable_override_scripts: boolean }
    },
    enabled: Boolean(auth.accessToken),
    staleTime: 5 * 60 * 1000,
  })

  const toggleOverrideScriptsMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      await api.put('/api/admin/system-settings/override-scripts', { enable_override_scripts: enabled })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['override-scripts-enabled'] })
      toast.success(t('overrideScripts.updated'))
    },
    onError: handleServerError,
  })

  useEffect(() => {
    if (overrideScriptsData?.enable_override_scripts !== undefined) {
      setEnableOverrideScripts(overrideScriptsData.enable_override_scripts)
    }
  }, [overrideScriptsData])

  const { data: mmwFeaturesData } = useQuery({
    queryKey: ['miaomiaowu-features-enabled'],
    queryFn: async () => {
      const response = await api.get('/api/admin/system-settings/miaomiaowu-features')
      return response.data as { success: boolean; enable_miaomiaowu_features: boolean }
    },
    enabled: Boolean(auth.accessToken),
    staleTime: 5 * 60 * 1000,
  })

  const toggleMmwFeaturesMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      await api.put('/api/admin/system-settings/miaomiaowu-features', { enable_miaomiaowu_features: enabled })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['miaomiaowu-features-enabled'] })
      toast.success(t('miaomiaowuFeatures.updated'))
    },
    onError: handleServerError,
  })

  useEffect(() => {
    if (mmwFeaturesData?.enable_miaomiaowu_features !== undefined) {
      setEnableMmwFeatures(mmwFeaturesData.enable_miaomiaowu_features)
    }
  }, [mmwFeaturesData])

  // 兼容妙妙屋短链接 — 旧版 mmw 用 /<code>,新版 mmwx 用 /x/<code>;开启后兼容旧链接
  const { data: mmwShortLinkCompatData } = useQuery({
    queryKey: ['mmw-short-link-compat'],
    queryFn: async () => {
      const response = await api.get('/api/admin/system-settings/mmw-short-link-compat')
      return response.data as { success: boolean; enable_mmw_short_link_compat: boolean }
    },
    enabled: Boolean(auth.accessToken),
    staleTime: 5 * 60 * 1000,
  })
  const [enableMmwShortLinkCompat, setEnableMmwShortLinkCompat] = useState(false)
  useEffect(() => {
    if (mmwShortLinkCompatData?.enable_mmw_short_link_compat !== undefined) {
      setEnableMmwShortLinkCompat(mmwShortLinkCompatData.enable_mmw_short_link_compat)
    }
  }, [mmwShortLinkCompatData])
  const toggleMmwShortLinkCompatMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      await api.put('/api/admin/system-settings/mmw-short-link-compat', { enable_mmw_short_link_compat: enabled })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mmw-short-link-compat'] })
      toast.success('设置已更新')
    },
    onError: handleServerError,
  })

  // 用户路由出站开关 + 配额(与 UserPermissionsDialog 共享同一 config,通过同 queryKey 缓存复用)
  const { data: userPermConfigData } = useQuery({
    queryKey: ['user-permissions-config'],
    queryFn: async () => {
      const res = await api.get('/api/admin/system-settings/user-permissions')
      return res.data as { success: boolean; config: any }
    },
    enabled: Boolean(auth.accessToken),
    staleTime: 5 * 60 * 1000,
  })
  useEffect(() => {
    const c = userPermConfigData?.config
    if (c) {
      setEnableUserRoutedOutbound(Boolean(c.routed_outbound_enabled))
      const q = Number(c.quota_routed_outbound)
      setUserRoutedOutboundQuota(q > 0 ? q : 2)
      const d = Number(c.daily_limit_routed_outbound)
      setUserRoutedOutboundDailyLimit(d > 0 ? d : 5)
    }
  }, [userPermConfigData])

  const saveUserRoutedOutboundMutation = useMutation({
    mutationFn: async (payload: { enabled: boolean; quota: number; daily: number }) => {
      const base = userPermConfigData?.config ?? {}
      // PUT 整个配置(其他字段保持原值,仅改本卡片管理的 3 个字段)
      await api.put('/api/admin/system-settings/user-permissions', {
        pages: base.pages ?? [],
        quota_template: Number(base.quota_template ?? 0),
        quota_override: Number(base.quota_override ?? 0),
        quota_subscribe: Number(base.quota_subscribe ?? 0),
        routed_outbound_enabled: payload.enabled,
        quota_routed_outbound: payload.enabled ? payload.quota : 0,
        daily_limit_routed_outbound: payload.enabled ? payload.daily : 0,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-permissions-config'] })
      queryClient.invalidateQueries({ queryKey: ['user-permissions'] })
      toast.success('已保存')
    },
    onError: (e: any) => {
      toast.error(e?.response?.data?.message || '保存失败')
    },
  })

  // 静默模式
  const [silentMode, setSilentMode] = useState(false)
  const [silentModeTimeout, setSilentModeTimeout] = useState(15)

  const { data: silentModeData } = useQuery({
    queryKey: ['silent-mode'],
    queryFn: async () => {
      const response = await api.get('/api/admin/system-settings/silent-mode')
      return response.data as { success: boolean; silent_mode: boolean; silent_mode_timeout: number }
    },
    enabled: Boolean(auth.accessToken),
    staleTime: 5 * 60 * 1000,
  })

  const updateSilentModeMutation = useMutation({
    mutationFn: async (params: { silent_mode: boolean; silent_mode_timeout: number }) => {
      await api.put('/api/admin/system-settings/silent-mode', params)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['silent-mode'] })
      toast.success(t('silentMode.updated'))
    },
    onError: handleServerError,
  })

  useEffect(() => {
    if (silentModeData) {
      setSilentMode(silentModeData.silent_mode)
      setSilentModeTimeout(silentModeData.silent_mode_timeout)
    }
  }, [silentModeData])

  // 强制加密
  const { data: encryptionData } = useQuery({
    queryKey: ['require-encryption'],
    queryFn: async () => {
      const response = await api.get('/api/admin/system-settings/require-encryption')
      return response.data as { success: boolean; require_encryption: boolean }
    },
    enabled: Boolean(auth.accessToken),
    staleTime: 5 * 60 * 1000,
  })

  const updateEncryptionMutation = useMutation({
    mutationFn: async (params: { require_encryption: boolean }) => {
      await api.put('/api/admin/system-settings/require-encryption', params)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['require-encryption'] })
      toast.success(t('encryption.updated'))
    },
    onError: handleServerError,
  })

  // 定时配置
  const [speedCollectInterval, setSpeedCollectInterval] = useState(3)
  const [reportInterval, setReportInterval] = useState(5)
  const [trafficCheckInterval, setTrafficCheckInterval] = useState(120)
  const [heartbeatInterval, setHeartbeatInterval] = useState(30)

  const { data: intervalsData } = useQuery({
    queryKey: ['system-intervals'],
    queryFn: async () => {
      const response = await api.get('/api/admin/system-settings/intervals')
      return response.data as {
        success: boolean
        speed_collect_interval: number
        report_interval: number
        traffic_check_interval: number
        heartbeat_interval: number
      }
    },
    enabled: Boolean(auth.accessToken),
    staleTime: 5 * 60 * 1000,
  })

  useEffect(() => {
    if (intervalsData) {
      setSpeedCollectInterval(intervalsData.speed_collect_interval)
      setReportInterval(intervalsData.report_interval)
      setTrafficCheckInterval(intervalsData.traffic_check_interval)
      setHeartbeatInterval(intervalsData.heartbeat_interval)
    }
  }, [intervalsData])

  const updateIntervalsMutation = useMutation({
    mutationFn: async (data: {
      speed_collect_interval: number
      report_interval: number
      traffic_check_interval: number
      heartbeat_interval: number
    }) => {
      await api.put('/api/admin/system-settings/intervals', data)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['system-intervals'] })
      toast.success(t('intervals.updated'))
    },
    onError: handleServerError,
  })
  const [enableProxyProvider, setEnableProxyProvider] = useState(false)
  const [proxyGroupsSourceUrl, setProxyGroupsSourceUrl] = useState('')
  const [clientCompatibilityMode, setClientCompatibilityMode] = useState(false)

  // 通知配置
  interface NotifyConfig {
    notify_enabled: boolean
    telegram_bot_token: string
    telegram_chat_id: string
    notify_login: boolean
    notify_subscribe_fetch: boolean
    notify_daily_traffic: boolean
    notify_server_offline: boolean
    notify_server_online: boolean
    notify_traffic_threshold: boolean
    notify_daily_traffic_time: string
    notify_traffic_threshold_percent: number
  }
  const [notifyConfig, setNotifyConfig] = useState<NotifyConfig>({
    notify_enabled: false,
    telegram_bot_token: '',
    telegram_chat_id: '',
    notify_login: false,
    notify_subscribe_fetch: false,
    notify_daily_traffic: false,
    notify_server_offline: false,
    notify_server_online: false,
    notify_traffic_threshold: false,
    notify_daily_traffic_time: '08:00',
    notify_traffic_threshold_percent: 80,
  })
  const [editingBotToken, setEditingBotToken] = useState('')

  const { data: notifyData } = useQuery({
    queryKey: ['notify-config'],
    queryFn: async () => {
      const response = await api.get('/api/admin/notify-config')
      return response.data as NotifyConfig
    },
    enabled: Boolean(auth.accessToken),
    staleTime: 5 * 60 * 1000,
  })

  useEffect(() => {
    if (notifyData) {
      setNotifyConfig(notifyData)
      setEditingBotToken(notifyData.telegram_bot_token)
    }
  }, [notifyData])

  const updateNotifyMutation = useMutation({
    mutationFn: async (data: NotifyConfig) => {
      await api.put('/api/admin/notify-config', data)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notify-config'] })
      toast.success(t('telegram.configUpdated'))
    },
    onError: handleServerError,
  })

  const testNotifyMutation = useMutation({
    mutationFn: async () => {
      await api.post('/api/admin/notify-config/test')
    },
    onSuccess: () => {
      toast.success(t('telegram.testSent'))
    },
    onError: handleServerError,
  })

  const saveNotifyConfig = (updates: Partial<NotifyConfig>) => {
    const newConfig = { ...notifyConfig, ...updates }
    setNotifyConfig(newConfig)
    updateNotifyMutation.mutate(newConfig)
  }

  // 自定义安全阈值(登录限流/暴力防护/订阅频率限制),后端 PUT 后自动热更新限流器,无需重启主控。
  type SecurityConfig = {
    login_rate_max_attempts: number
    login_rate_window_minutes: number
    login_rate_lock_minutes: number
    brute_force_enabled: boolean
    brute_force_max_failures: number
    brute_force_window_minutes: number
    brute_force_block_minutes: number
    sub_rate_enabled: boolean
    sub_rate_limit: number
    sub_rate_window_minutes: number
  }
  const [securityConfig, setSecurityConfig] = useState<SecurityConfig>({
    login_rate_max_attempts: 5,
    login_rate_window_minutes: 60,
    login_rate_lock_minutes: 60,
    brute_force_enabled: true,
    brute_force_max_failures: 5,
    brute_force_window_minutes: 1440,
    brute_force_block_minutes: 1440,
    sub_rate_enabled: true,
    sub_rate_limit: 60,
    sub_rate_window_minutes: 1,
  })
  const { data: securityData } = useQuery({
    queryKey: ['security-settings'],
    queryFn: async () => {
      const response = await api.get('/api/admin/security-settings')
      return response.data as SecurityConfig
    },
    enabled: Boolean(auth.accessToken),
    staleTime: 5 * 60 * 1000,
  })
  useEffect(() => {
    if (securityData) setSecurityConfig(securityData)
  }, [securityData])
  const updateSecurityMutation = useMutation({
    mutationFn: async (data: SecurityConfig) => {
      await api.put('/api/admin/security-settings', data)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['security-settings'] })
    },
    onError: handleServerError,
  })
  const saveSecurityConfig = (updates: Partial<SecurityConfig>) => {
    const newConfig = { ...securityConfig, ...updates }
    setSecurityConfig(newConfig)
    updateSecurityMutation.mutate(newConfig)
  }

  const { data: userConfig, isLoading: _loadingConfig } = useQuery({
    queryKey: ['user-config'],
    queryFn: async () => {
      const response = await api.get('/api/user/config')
      return response.data as {
        force_sync_external: boolean
        match_rule: string
        sync_scope: string
        keep_node_name: boolean
        cache_expire_minutes: number
        sync_traffic: boolean
        node_name_filter: string
        append_sub_info: boolean
        enable_short_link: boolean
        use_new_template_system: boolean
        enable_proxy_provider: boolean
        proxy_groups_source_url: string
        client_compatibility_mode: boolean
      }
    },
    enabled: Boolean(auth.accessToken),
    staleTime: 5 * 60 * 1000,
  })

  useEffect(() => {
    if (userConfig) {
      setForceSyncExternal(userConfig.force_sync_external)
      setMatchRule(userConfig.match_rule as 'node_name' | 'server_port' | 'type_server_port')
      setSyncScope((userConfig.sync_scope as 'saved_only' | 'all') || 'saved_only')
      setKeepNodeName(userConfig.keep_node_name !== false) // 默认为 true
      setCacheExpireMinutes(userConfig.cache_expire_minutes)
      setSyncTraffic(userConfig.sync_traffic)
      setNodeNameFilter(userConfig.node_name_filter || '剩余|流量|到期|订阅|时间|重置')
      setAppendSubInfo(Boolean(userConfig.append_sub_info))
      // 短链接是系统级开关,只由 shortLinkData(/short-link)驱动 + toggleShortLinkMutation 保存。
      // 这里不能再用 per-user 的 userConfig.enable_short_link 覆盖它,否则刷新后被(默认 false)覆盖掉。
      setUseNewTemplateSystem(userConfig.use_new_template_system !== false) // 默认为 true
      setEnableProxyProvider(userConfig.enable_proxy_provider || false)
      setProxyGroupsSourceUrl(userConfig.proxy_groups_source_url || '')
      setClientCompatibilityMode(userConfig.client_compatibility_mode || false)
    }
  }, [userConfig])

  const updateConfigMutation = useMutation({
    mutationFn: async (data: {
      force_sync_external: boolean
      match_rule: string
      sync_scope: string
      keep_node_name: boolean
      cache_expire_minutes: number
      sync_traffic: boolean
      node_name_filter: string
      append_sub_info: boolean
      enable_short_link: boolean
      use_new_template_system: boolean
      enable_proxy_provider: boolean
      proxy_groups_source_url: string
      client_compatibility_mode: boolean
    }) => {
      await api.put('/api/user/config', data)
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['user-config'] })
      // 当短链接开关状态改变时，刷新订阅列表以更新链接显示
      if (variables.enable_short_link !== enableShortLink) {
        queryClient.invalidateQueries({ queryKey: ['user-subscriptions'] })
      }
      setForceSyncExternal(variables.force_sync_external)
      setMatchRule(variables.match_rule as 'node_name' | 'server_port' | 'type_server_port')
      setSyncScope(variables.sync_scope as 'saved_only' | 'all')
      setKeepNodeName(variables.keep_node_name)
      setCacheExpireMinutes(variables.cache_expire_minutes)
      setSyncTraffic(variables.sync_traffic)
      setNodeNameFilter(variables.node_name_filter)
      setAppendSubInfo(variables.append_sub_info)
      setEnableShortLink(variables.enable_short_link)
      setUseNewTemplateSystem(variables.use_new_template_system)
      setEnableProxyProvider(variables.enable_proxy_provider)
      setProxyGroupsSourceUrl(variables.proxy_groups_source_url || '')
      setClientCompatibilityMode(variables.client_compatibility_mode)
      toast.success(t('configUpdated'))
    },
    onError: (error) => {
      handleServerError(error)
      toast.error(t('configUpdateFailed'))
    },
  })

  const updateConfig = (updates: Partial<{
    force_sync_external: boolean
    match_rule: string
    sync_scope: string
    keep_node_name: boolean
    cache_expire_minutes: number
    sync_traffic: boolean
    node_name_filter: string
    append_sub_info: boolean
    enable_short_link: boolean
    use_new_template_system: boolean
    enable_proxy_provider: boolean
    proxy_groups_source_url: string
    client_compatibility_mode: boolean
  }>) => {
    updateConfigMutation.mutate({
      force_sync_external: forceSyncExternal,
      match_rule: matchRule,
      sync_scope: syncScope,
      keep_node_name: keepNodeName,
      cache_expire_minutes: cacheExpireMinutes,
      sync_traffic: syncTraffic,
      node_name_filter: nodeNameFilter,
      append_sub_info: appendSubInfo,
      enable_short_link: enableShortLink,
      use_new_template_system: useNewTemplateSystem,
      enable_proxy_provider: enableProxyProvider,
      proxy_groups_source_url: proxyGroupsSourceUrl,
      client_compatibility_mode: clientCompatibilityMode,
      ...updates,
    })
  }

  return (
    <div className='min-h-svh bg-background'>
      <Topbar />
      <main className='mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 pt-24'>
        <section className='space-y-2'>
          <h1 className='text-3xl font-semibold tracking-tight'>{t('title')}</h1>
          <p className='text-muted-foreground'>{t('description')}</p>
        </section>

        <div className='mt-8 space-y-6'>
          {/* 外部订阅同步设置 */}
          <Card>
            <CardHeader className='pb-4'>
              <CardTitle>{t('sync.title')}</CardTitle>
              <CardDescription>{t('sync.description')}</CardDescription>
            </CardHeader>
            <CardContent className='space-y-4'>
              <div className='flex items-center justify-between'>
                <div className='flex items-center gap-2'>
                  <Label htmlFor='sync-traffic' className='cursor-pointer'>
                    {t('sync.syncTraffic')}
                  </Label>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <CircleHelp className='h-4 w-4 text-muted-foreground cursor-help' />
                    </TooltipTrigger>
                    <TooltipContent side='right' className='max-w-xs'>
                      <p>{t('sync.syncTrafficHint')}</p>
                    </TooltipContent>
                  </Tooltip>
                </div>
                <Switch
                  id='sync-traffic'
                  checked={syncTraffic}
                  onCheckedChange={(checked) => updateConfig({ sync_traffic: checked })}
                  disabled={updateConfigMutation.isPending}
                />
              </div>

              <div className='space-y-2 pt-3 border-t'>
                <div className='flex items-center gap-2'>
                  <Label htmlFor='node-name-filter'>{t('sync.nodeNameFilter')}</Label>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <CircleHelp className='h-4 w-4 text-muted-foreground cursor-help' />
                    </TooltipTrigger>
                    <TooltipContent side='right' className='max-w-xs'>
                      <p>{t('sync.nodeNameFilterHint')}</p>
                    </TooltipContent>
                  </Tooltip>
                </div>
                <Input
                  id='node-name-filter'
                  value={nodeNameFilter}
                  onChange={(e) => setNodeNameFilter(e.target.value)}
                  onBlur={() => updateConfig({ node_name_filter: nodeNameFilter })}
                  disabled={updateConfigMutation.isPending}
                  placeholder='剩余|流量|到期|订阅|时间|重置'
                />
                <p className='text-xs text-muted-foreground'>{t('sync.nodeNameFilterDesc')}</p>
              </div>

              {/* 节点名追加订阅信息(剩余流量/天数)— 同步自 mmw v0.7.3 */}
              <div className='flex items-center justify-between pt-3 border-t'>
                <div className='flex items-center gap-2'>
                  <Label htmlFor='append-sub-info' className='cursor-pointer'>
                    节点名称追加订阅信息
                  </Label>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <CircleHelp className='h-4 w-4 text-muted-foreground cursor-help' />
                    </TooltipTrigger>
                    <TooltipContent side='right' className='max-w-xs'>
                      <p>开启后,同步外部订阅时在节点名称后追加剩余流量和剩余天数,例如:节点名 398.22GB📊 26Days⏳</p>
                    </TooltipContent>
                  </Tooltip>
                </div>
                <Switch
                  id='append-sub-info'
                  checked={appendSubInfo}
                  onCheckedChange={(checked) => updateConfig({ append_sub_info: checked })}
                  disabled={updateConfigMutation.isPending}
                />
              </div>

              <div className='flex items-center justify-between pt-3 border-t'>
                <div className='flex items-center gap-2'>
                  <Label htmlFor='force-sync-external' className='cursor-pointer'>
                    {t('sync.forceSyncExternal')}
                  </Label>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <CircleHelp className='h-4 w-4 text-muted-foreground cursor-help' />
                    </TooltipTrigger>
                    <TooltipContent side='right' className='max-w-xs'>
                      <p>{t('sync.forceSyncExternalHint')}</p>
                    </TooltipContent>
                  </Tooltip>
                </div>
                <Switch
                  id='force-sync-external'
                  checked={forceSyncExternal}
                  onCheckedChange={(checked) => updateConfig({ force_sync_external: checked })}
                  disabled={updateConfigMutation.isPending}
                />
              </div>

              {forceSyncExternal && (
                <div className='space-y-4 pt-3 border-t bg-muted/30 -mx-6 px-6 py-4 rounded-b-lg'>
                  <div className='space-y-2'>
                    <Label>{t('sync.matchRule')}</Label>
                    <RadioGroup
                      value={matchRule}
                      onValueChange={(value: 'node_name' | 'server_port' | 'type_server_port') => {
                        setMatchRule(value)
                        updateConfig({ match_rule: value })
                      }}
                      disabled={updateConfigMutation.isPending}
                      className='flex flex-wrap gap-4'
                    >
                      <div className='flex items-center space-x-2'>
                        <RadioGroupItem value='node_name' id='match-node-name' />
                        <Label htmlFor='match-node-name' className='font-normal cursor-pointer'>
                          {t('sync.matchRuleNodeName')}
                        </Label>
                      </div>
                      <div className='flex items-center space-x-2'>
                        <RadioGroupItem value='server_port' id='match-server-port' />
                        <Label htmlFor='match-server-port' className='font-normal cursor-pointer'>
                          {t('sync.matchRuleServerPort')}
                        </Label>
                      </div>
                      <div className='flex items-center space-x-2'>
                        <RadioGroupItem value='type_server_port' id='match-type-server-port' />
                        <Label htmlFor='match-type-server-port' className='font-normal cursor-pointer'>
                          {t('sync.matchRuleTypeServerPort')}
                        </Label>
                      </div>
                    </RadioGroup>
                  </div>

                  <div className='space-y-2 pt-3 border-t border-border/50'>
                    <Label>{t('sync.syncScope')}</Label>
                    <RadioGroup
                      value={syncScope}
                      onValueChange={(value: 'saved_only' | 'all') => {
                        setSyncScope(value)
                        updateConfig({ sync_scope: value })
                      }}
                      disabled={updateConfigMutation.isPending}
                      className='flex flex-wrap gap-4'
                    >
                      <div className='flex items-center space-x-2'>
                        <RadioGroupItem value='saved_only' id='sync-saved-only' />
                        <Label htmlFor='sync-saved-only' className='font-normal cursor-pointer'>
                          {t('sync.syncScopeSavedOnly')}
                        </Label>
                      </div>
                      <div className='flex items-center space-x-2'>
                        <RadioGroupItem value='all' id='sync-all' />
                        <Label htmlFor='sync-all' className='font-normal cursor-pointer'>
                          {t('sync.syncScopeAll')}
                        </Label>
                      </div>
                    </RadioGroup>
                  </div>

                  <div className='flex items-center justify-between pt-3 border-t border-border/50'>
                    <div className='flex items-center gap-2'>
                      <Label htmlFor='keep-node-name' className='cursor-pointer'>
                        {t('sync.keepNodeName')}
                      </Label>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <CircleHelp className='h-4 w-4 text-muted-foreground cursor-help' />
                        </TooltipTrigger>
                        <TooltipContent side='right' className='max-w-xs'>
                          <p>{t('sync.keepNodeNameHint')}</p>
                        </TooltipContent>
                      </Tooltip>
                    </div>
                    <Switch
                      id='keep-node-name'
                      checked={keepNodeName}
                      onCheckedChange={(checked) => {
                        setKeepNodeName(checked)
                        updateConfig({ keep_node_name: checked })
                      }}
                      disabled={updateConfigMutation.isPending}
                    />
                  </div>

                  <div className='space-y-2 pt-3 border-t border-border/50'>
                    <div className='flex items-center gap-2'>
                      <Label htmlFor='cache-expire-minutes'>{t('sync.cacheExpireMinutes')}</Label>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <CircleHelp className='h-4 w-4 text-muted-foreground cursor-help' />
                        </TooltipTrigger>
                        <TooltipContent side='right' className='max-w-xs'>
                          <p>{t('sync.cacheExpireMinutesHint')}</p>
                        </TooltipContent>
                      </Tooltip>
                    </div>
                    <Input
                      id='cache-expire-minutes'
                      type='number'
                      min='0'
                      value={cacheExpireMinutes}
                      onChange={(e) => setCacheExpireMinutes(parseInt(e.target.value) || 0)}
                      onBlur={() => updateConfig({ cache_expire_minutes: cacheExpireMinutes })}
                      disabled={updateConfigMutation.isPending}
                      placeholder='0'
                      className='w-32'
                    />
                    <p className='text-xs text-destructive'>{t('sync.cacheExpireWarning')}</p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* 功能开关 */}
          <Card>
            <CardHeader className='pb-4'>
              <CardTitle>{t('title')}</CardTitle>
              <CardDescription>{t('description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className='grid grid-cols-1 sm:grid-cols-2 gap-4'>
                {/* 短链接 */}
                <div className='flex items-center justify-between rounded-lg border p-3'>
                  <div className='flex items-center gap-2'>
                    <Label htmlFor='short-link-toggle' className='cursor-pointer'>
                      {t('shortLink.enableLabel')}
                    </Label>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <CircleHelp className='h-4 w-4 text-muted-foreground cursor-help' />
                      </TooltipTrigger>
                      <TooltipContent side='top' className='max-w-xs'>
                        <p>{t('shortLink.description')}</p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <Switch
                    id='short-link-toggle'
                    checked={enableShortLink}
                    onCheckedChange={(checked) => {
                      setEnableShortLink(checked)
                      toggleShortLinkMutation.mutate(checked)
                    }}
                    disabled={toggleShortLinkMutation.isPending}
                  />
                </div>

                {/* 覆写脚本 */}
                <div className='flex items-center justify-between rounded-lg border p-3'>
                  <div className='flex items-center gap-2'>
                    <Label htmlFor='override-scripts-toggle' className='cursor-pointer'>
                      {t('overrideScripts.enableLabel')}
                    </Label>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <CircleHelp className='h-4 w-4 text-muted-foreground cursor-help' />
                      </TooltipTrigger>
                      <TooltipContent side='top' className='max-w-xs'>
                        <p>{t('overrideScripts.description')}</p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <Switch
                    id='override-scripts-toggle'
                    checked={enableOverrideScripts}
                    onCheckedChange={(checked) => {
                      setEnableOverrideScripts(checked)
                      toggleOverrideScriptsMutation.mutate(checked)
                    }}
                    disabled={toggleOverrideScriptsMutation.isPending}
                  />
                </div>

                {/* 妙妙屋功能 */}
                <div className='flex items-center justify-between rounded-lg border p-3'>
                  <div className='flex items-center gap-2'>
                    <UserPermissionsDialog />
                    <Label htmlFor='mmw-features-toggle' className='cursor-pointer'>
                      {t('miaomiaowuFeatures.enableLabel')}
                    </Label>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <CircleHelp className='h-4 w-4 text-muted-foreground cursor-help' />
                      </TooltipTrigger>
                      <TooltipContent side='top' className='max-w-xs'>
                        <p>{t('miaomiaowuFeatures.description')}</p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <Switch
                    id='mmw-features-toggle'
                    checked={enableMmwFeatures}
                    onCheckedChange={(checked) => {
                      setEnableMmwFeatures(checked)
                      toggleMmwFeaturesMutation.mutate(checked)
                    }}
                    disabled={toggleMmwFeaturesMutation.isPending}
                  />
                </div>

                {/* 兼容妙妙屋短链接 */}
                <div className='flex items-center justify-between rounded-lg border p-3'>
                  <div className='flex items-center gap-2'>
                    <Label htmlFor='mmw-short-link-compat-toggle' className='cursor-pointer'>
                      兼容妙妙屋短链接
                    </Label>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <CircleHelp className='h-4 w-4 text-muted-foreground cursor-help' />
                      </TooltipTrigger>
                      <TooltipContent side='top' className='max-w-xs'>
                        <p>开启后,旧版妙妙屋短链 <code>/短链接</code> 访问会自动尝试匹配新版 <code>/x/短链接</code>,命中则放行;未命中按安全规则计数(防暴力枚举)。默认关闭。</p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <Switch
                    id='mmw-short-link-compat-toggle'
                    checked={enableMmwShortLinkCompat}
                    onCheckedChange={(checked) => {
                      setEnableMmwShortLinkCompat(checked)
                      toggleMmwShortLinkCompatMutation.mutate(checked)
                    }}
                    disabled={toggleMmwShortLinkCompatMutation.isPending}
                  />
                </div>

                {/* 从妙妙屋迁移 — 跳到独立向导 */}
                <div className='flex items-center justify-between rounded-lg border p-3'>
                  <div className='flex items-center gap-2'>
                    <Label className='cursor-default'>从妙妙屋迁移</Label>
                    <span className='text-xs text-muted-foreground'>一次性把妙妙屋数据导入到当前实例</span>
                  </div>
                  <Button variant='outline' size='sm' asChild>
                    <Link to='/migrate-from-mmw'>打开迁移向导</Link>
                  </Button>
                </div>

                {/* 允许用户创建路由出站 */}
                <div className='flex items-center justify-between rounded-lg border p-3'>
                  <div className='flex items-center gap-2'>
                    <Label htmlFor='user-routed-outbound-toggle' className='cursor-pointer'>
                      允许用户创建路由出站
                    </Label>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <CircleHelp className='h-4 w-4 text-muted-foreground cursor-help' />
                      </TooltipTrigger>
                      <TooltipContent side='top' className='max-w-xs'>
                        <p>开启后,普通用户可在自己可见的节点上创建路由出站(routed_owner=user),不依赖套餐分配。</p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <div className='flex items-center gap-2'>
                    <div className='flex flex-col items-end gap-0.5'>
                      <span className='text-[10px] text-muted-foreground'>数量</span>
                      <Input
                        type='number'
                        min={1}
                        className='w-16 h-7 text-xs'
                        value={userRoutedOutboundQuota}
                        onChange={(e) => {
                          const n = Math.max(1, parseInt(e.target.value, 10) || 0)
                          setUserRoutedOutboundQuota(n)
                        }}
                        onBlur={() => {
                          if (enableUserRoutedOutbound) {
                            saveUserRoutedOutboundMutation.mutate({ enabled: true, quota: userRoutedOutboundQuota, daily: userRoutedOutboundDailyLimit })
                          }
                        }}
                        disabled={!enableUserRoutedOutbound}
                        placeholder='2'
                      />
                    </div>
                    <div className='flex flex-col items-end gap-0.5'>
                      <span className='text-[10px] text-muted-foreground'>每日次数</span>
                      <Input
                        type='number'
                        min={1}
                        className='w-16 h-7 text-xs'
                        value={userRoutedOutboundDailyLimit}
                        onChange={(e) => {
                          const n = Math.max(1, parseInt(e.target.value, 10) || 0)
                          setUserRoutedOutboundDailyLimit(n)
                        }}
                        onBlur={() => {
                          if (enableUserRoutedOutbound) {
                            saveUserRoutedOutboundMutation.mutate({ enabled: true, quota: userRoutedOutboundQuota, daily: userRoutedOutboundDailyLimit })
                          }
                        }}
                        disabled={!enableUserRoutedOutbound}
                        placeholder='5'
                      />
                    </div>
                    <Switch
                      id='user-routed-outbound-toggle'
                      checked={enableUserRoutedOutbound}
                      onCheckedChange={(checked) => {
                        setEnableUserRoutedOutbound(checked)
                        saveUserRoutedOutboundMutation.mutate({ enabled: checked, quota: userRoutedOutboundQuota, daily: userRoutedOutboundDailyLimit })
                      }}
                      disabled={saveUserRoutedOutboundMutation.isPending}
                    />
                  </div>
                </div>

                {/* 通知推送 */}
                <div className='flex items-center justify-between rounded-lg border p-3'>
                  <div className='flex items-center gap-2'>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button variant='outline' size='icon' className='h-7 w-7'>
                          <Settings className='h-3.5 w-3.5' />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className='w-80' side='bottom' align='start'>
                        <div className='space-y-4'>
                          <div className='space-y-2'>
                            <Label htmlFor='bot-token'>{t('telegram.botToken')}</Label>
                            <Input
                              id='bot-token'
                              value={editingBotToken}
                              onChange={(e) => setEditingBotToken(e.target.value)}
                              onBlur={() => {
                                if (editingBotToken !== notifyConfig.telegram_bot_token) {
                                  saveNotifyConfig({ telegram_bot_token: editingBotToken })
                                }
                              }}
                              placeholder={t('telegram.botTokenPlaceholder')}
                            />
                          </div>
                          <div className='space-y-2'>
                            <Label htmlFor='chat-id'>{t('telegram.chatId')}</Label>
                            <Input
                              id='chat-id'
                              value={notifyConfig.telegram_chat_id}
                              onChange={(e) => setNotifyConfig({ ...notifyConfig, telegram_chat_id: e.target.value })}
                              onBlur={() => {
                                if (notifyConfig.telegram_chat_id !== notifyData?.telegram_chat_id) {
                                  saveNotifyConfig({ telegram_chat_id: notifyConfig.telegram_chat_id })
                                }
                              }}
                              placeholder={t('telegram.chatIdPlaceholder')}
                            />
                          </div>
                          <Button
                            variant='outline'
                            size='sm'
                            className='w-full'
                            onClick={() => testNotifyMutation.mutate()}
                            disabled={testNotifyMutation.isPending || !notifyConfig.telegram_bot_token || !notifyConfig.telegram_chat_id}
                          >
                            {testNotifyMutation.isPending ? '...' : t('telegram.sendTest')}
                          </Button>
                          <div className='border-t pt-3 space-y-2'>
                            <div className='flex items-center gap-2'>
                              <Checkbox
                                id='notify-login'
                                checked={notifyConfig.notify_login}
                                onCheckedChange={(checked) => saveNotifyConfig({ notify_login: checked === true })}
                              />
                              <Label htmlFor='notify-login' className='cursor-pointer text-sm'>{t('telegram.events.login')}</Label>
                            </div>
                            <div className='flex items-center gap-2'>
                              <Checkbox
                                id='notify-subscribe'
                                checked={notifyConfig.notify_subscribe_fetch}
                                onCheckedChange={(checked) => saveNotifyConfig({ notify_subscribe_fetch: checked === true })}
                              />
                              <Label htmlFor='notify-subscribe' className='cursor-pointer text-sm'>{t('telegram.events.subscribe')}</Label>
                            </div>
                            <div className='flex items-center gap-2'>
                              <Checkbox
                                id='notify-online'
                                checked={notifyConfig.notify_server_online}
                                onCheckedChange={(checked) => saveNotifyConfig({ notify_server_online: checked === true })}
                              />
                              <Label htmlFor='notify-online' className='cursor-pointer text-sm'>{t('telegram.events.serverOnline')}</Label>
                            </div>
                            <div className='flex items-center gap-2'>
                              <Checkbox
                                id='notify-offline'
                                checked={notifyConfig.notify_server_offline}
                                onCheckedChange={(checked) => saveNotifyConfig({ notify_server_offline: checked === true })}
                              />
                              <Label htmlFor='notify-offline' className='cursor-pointer text-sm'>{t('telegram.events.serverOffline')}</Label>
                            </div>
                            <div className='flex items-center gap-2'>
                              <Checkbox
                                id='notify-daily'
                                checked={notifyConfig.notify_daily_traffic}
                                onCheckedChange={(checked) => saveNotifyConfig({ notify_daily_traffic: checked === true })}
                              />
                              <Label htmlFor='notify-daily' className='cursor-pointer text-sm'>{t('telegram.events.dailyTraffic')}</Label>
                              {notifyConfig.notify_daily_traffic && (
                                <Input
                                  type='time'
                                  value={notifyConfig.notify_daily_traffic_time}
                                  onChange={(e) => setNotifyConfig({ ...notifyConfig, notify_daily_traffic_time: e.target.value })}
                                  onBlur={() => saveNotifyConfig({ notify_daily_traffic_time: notifyConfig.notify_daily_traffic_time })}
                                  className='h-7 w-24 text-xs'
                                />
                              )}
                            </div>
                            <div className='flex items-center gap-2'>
                              <Checkbox
                                id='notify-threshold'
                                checked={notifyConfig.notify_traffic_threshold}
                                onCheckedChange={(checked) => saveNotifyConfig({ notify_traffic_threshold: checked === true })}
                              />
                              <Label htmlFor='notify-threshold' className='cursor-pointer text-sm'>{t('telegram.events.trafficThreshold')}</Label>
                              {notifyConfig.notify_traffic_threshold && (
                                <Input
                                  type='number'
                                  min={1}
                                  max={100}
                                  value={notifyConfig.notify_traffic_threshold_percent}
                                  onChange={(e) => setNotifyConfig({ ...notifyConfig, notify_traffic_threshold_percent: Number(e.target.value) })}
                                  onBlur={() => saveNotifyConfig({ notify_traffic_threshold_percent: notifyConfig.notify_traffic_threshold_percent })}
                                  className='h-7 w-16 text-xs'
                                />
                              )}
                            </div>
                          </div>
                        </div>
                      </PopoverContent>
                    </Popover>
                    <Label htmlFor='notify-enabled' className='cursor-pointer'>
                      {t('telegram.enableLabel')}
                    </Label>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <CircleHelp className='h-4 w-4 text-muted-foreground cursor-help' />
                      </TooltipTrigger>
                      <TooltipContent side='top' className='max-w-xs'>
                        <p>{t('telegram.description')}</p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <Switch
                    id='notify-enabled'
                    checked={notifyConfig.notify_enabled}
                    onCheckedChange={(checked) => saveNotifyConfig({ notify_enabled: checked })}
                    disabled={updateNotifyMutation.isPending}
                  />
                </div>

                {/* 静默模式 */}
                <div className='flex items-center justify-between rounded-lg border border-orange-200 bg-orange-50 p-3 dark:border-orange-900 dark:bg-orange-950'>
                  <div className='flex items-center gap-2'>
                    <Label htmlFor='silent-mode-toggle' className='cursor-pointer'>
                      {t('silentMode.enableLabel')}
                    </Label>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <CircleHelp className='h-4 w-4 text-muted-foreground cursor-help' />
                      </TooltipTrigger>
                      <TooltipContent side='top' className='max-w-xs'>
                        <p>{t('silentMode.description')}</p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <Switch
                    id='silent-mode-toggle'
                    checked={silentMode}
                    onCheckedChange={(checked) => {
                      setSilentMode(checked)
                      updateSilentModeMutation.mutate({ silent_mode: checked, silent_mode_timeout: silentModeTimeout })
                    }}
                    disabled={updateSilentModeMutation.isPending}
                  />
                </div>

                {/* 强制加密通信 */}
                <div className='flex items-center justify-between rounded-lg border p-3'>
                  <div className='flex items-center gap-2'>
                    <Label htmlFor='require-encryption-toggle' className='cursor-pointer'>
                      {t('encryption.enableLabel')}
                    </Label>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <CircleHelp className='h-4 w-4 text-muted-foreground cursor-help' />
                      </TooltipTrigger>
                      <TooltipContent side='top' className='max-w-xs'>
                        <p>{t('encryption.description')}</p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <Switch
                    id='require-encryption-toggle'
                    checked={encryptionData?.require_encryption ?? false}
                    onCheckedChange={(checked) => {
                      updateEncryptionMutation.mutate({ require_encryption: checked })
                    }}
                    disabled={updateEncryptionMutation.isPending}
                  />
                </div>
              </div>

              {/* 静默模式超时设置 */}
              {silentMode && (
                <div className='mt-4 space-y-2 rounded-lg border border-orange-200 bg-orange-50 p-3 dark:border-orange-900 dark:bg-orange-950'>
                  <div className='flex items-center gap-2'>
                    <Label htmlFor='silent-mode-timeout'>{t('silentMode.timeout')}</Label>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <CircleHelp className='h-4 w-4 text-muted-foreground cursor-help' />
                      </TooltipTrigger>
                      <TooltipContent side='top' className='max-w-xs'>
                        <p>{t('silentMode.hint', { timeout: silentModeTimeout })}</p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <Input
                    id='silent-mode-timeout'
                    type='number'
                    min={1}
                    max={1440}
                    value={silentModeTimeout}
                    onChange={(e) => setSilentModeTimeout(parseInt(e.target.value) || 15)}
                    onBlur={() => updateSilentModeMutation.mutate({ silent_mode: silentMode, silent_mode_timeout: silentModeTimeout })}
                    disabled={updateSilentModeMutation.isPending}
                    className='max-w-32'
                  />
                </div>
              )}
              {encryptionData?.require_encryption && (
                <p className='mt-1 text-xs text-amber-600 dark:text-amber-400'>
                  {t('encryption.warning')}
                </p>
              )}
            </CardContent>
          </Card>

          {/* 自定义安全阈值:登录限流 / 暴力防护 / 订阅频率限制。每个 input onBlur 即时保存,后端热更新限流器无需重启 */}
          <Card>
            <CardHeader className='pb-4'>
              <CardTitle>自定义安全阈值</CardTitle>
              <CardDescription>
                调整登录限流、订阅暴力防护、订阅频率限制的阈值。修改后立即生效,无需重启主控。
              </CardDescription>
            </CardHeader>
            <CardContent className='space-y-6'>
              {/* 登录限流 */}
              <div className='space-y-3'>
                <div className='font-semibold text-sm'>登录限流</div>
                <p className='text-xs text-muted-foreground'>失败次数达上限后,IP/账户在锁定时长内禁止登录。</p>
                <div className='grid grid-cols-1 sm:grid-cols-3 gap-3'>
                  <div className='space-y-1'>
                    <Label htmlFor='login-rate-max-attempts' className='text-xs'>最大尝试次数</Label>
                    <Input
                      id='login-rate-max-attempts'
                      type='number'
                      min={1}
                      value={securityConfig.login_rate_max_attempts}
                      onChange={(e) => setSecurityConfig({ ...securityConfig, login_rate_max_attempts: Number(e.target.value) })}
                      onBlur={() => saveSecurityConfig({ login_rate_max_attempts: securityConfig.login_rate_max_attempts })}
                    />
                  </div>
                  <div className='space-y-1'>
                    <Label htmlFor='login-rate-window' className='text-xs'>统计窗口(分钟)</Label>
                    <Input
                      id='login-rate-window'
                      type='number'
                      min={1}
                      value={securityConfig.login_rate_window_minutes}
                      onChange={(e) => setSecurityConfig({ ...securityConfig, login_rate_window_minutes: Number(e.target.value) })}
                      onBlur={() => saveSecurityConfig({ login_rate_window_minutes: securityConfig.login_rate_window_minutes })}
                    />
                  </div>
                  <div className='space-y-1'>
                    <Label htmlFor='login-rate-lock' className='text-xs'>锁定时长(分钟)</Label>
                    <Input
                      id='login-rate-lock'
                      type='number'
                      min={1}
                      value={securityConfig.login_rate_lock_minutes}
                      onChange={(e) => setSecurityConfig({ ...securityConfig, login_rate_lock_minutes: Number(e.target.value) })}
                      onBlur={() => saveSecurityConfig({ login_rate_lock_minutes: securityConfig.login_rate_lock_minutes })}
                    />
                  </div>
                </div>
              </div>

              {/* 订阅暴力防护 */}
              <div className='space-y-3 pt-4 border-t'>
                <div className='flex items-center justify-between'>
                  <div>
                    <div className='font-semibold text-sm'>订阅暴力防护</div>
                    <p className='text-xs text-muted-foreground mt-1'>短链接 /x/ 与临时订阅 /t/ 访问失败次数达上限 → 封禁 IP,并发 Telegram 通知。</p>
                  </div>
                  <Switch
                    checked={securityConfig.brute_force_enabled}
                    onCheckedChange={(checked) => saveSecurityConfig({ brute_force_enabled: checked })}
                  />
                </div>
                {securityConfig.brute_force_enabled && (
                  <div className='grid grid-cols-1 sm:grid-cols-3 gap-3'>
                    <div className='space-y-1'>
                      <Label htmlFor='brute-force-max-failures' className='text-xs'>最大失败次数</Label>
                      <Input
                        id='brute-force-max-failures'
                        type='number'
                        min={1}
                        value={securityConfig.brute_force_max_failures}
                        onChange={(e) => setSecurityConfig({ ...securityConfig, brute_force_max_failures: Number(e.target.value) })}
                        onBlur={() => saveSecurityConfig({ brute_force_max_failures: securityConfig.brute_force_max_failures })}
                      />
                    </div>
                    <div className='space-y-1'>
                      <Label htmlFor='brute-force-window' className='text-xs'>统计窗口(分钟)</Label>
                      <Input
                        id='brute-force-window'
                        type='number'
                        min={1}
                        value={securityConfig.brute_force_window_minutes}
                        onChange={(e) => setSecurityConfig({ ...securityConfig, brute_force_window_minutes: Number(e.target.value) })}
                        onBlur={() => saveSecurityConfig({ brute_force_window_minutes: securityConfig.brute_force_window_minutes })}
                      />
                    </div>
                    <div className='space-y-1'>
                      <Label htmlFor='brute-force-block' className='text-xs'>封禁时长(分钟)</Label>
                      <Input
                        id='brute-force-block'
                        type='number'
                        min={1}
                        value={securityConfig.brute_force_block_minutes}
                        onChange={(e) => setSecurityConfig({ ...securityConfig, brute_force_block_minutes: Number(e.target.value) })}
                        onBlur={() => saveSecurityConfig({ brute_force_block_minutes: securityConfig.brute_force_block_minutes })}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* 订阅频率限制 */}
              <div className='space-y-3 pt-4 border-t'>
                <div className='flex items-center justify-between'>
                  <div>
                    <div className='font-semibold text-sm'>订阅频率限制</div>
                    <p className='text-xs text-muted-foreground mt-1'>同一 IP 在窗口内最多访问订阅的次数,超出返回 429,防机器抓取。</p>
                  </div>
                  <Switch
                    checked={securityConfig.sub_rate_enabled}
                    onCheckedChange={(checked) => saveSecurityConfig({ sub_rate_enabled: checked })}
                  />
                </div>
                {securityConfig.sub_rate_enabled && (
                  <div className='grid grid-cols-1 sm:grid-cols-2 gap-3'>
                    <div className='space-y-1'>
                      <Label htmlFor='sub-rate-limit' className='text-xs'>最大请求数</Label>
                      <Input
                        id='sub-rate-limit'
                        type='number'
                        min={1}
                        value={securityConfig.sub_rate_limit}
                        onChange={(e) => setSecurityConfig({ ...securityConfig, sub_rate_limit: Number(e.target.value) })}
                        onBlur={() => saveSecurityConfig({ sub_rate_limit: securityConfig.sub_rate_limit })}
                      />
                    </div>
                    <div className='space-y-1'>
                      <Label htmlFor='sub-rate-window' className='text-xs'>统计窗口(分钟)</Label>
                      <Input
                        id='sub-rate-window'
                        type='number'
                        min={1}
                        value={securityConfig.sub_rate_window_minutes}
                        onChange={(e) => setSecurityConfig({ ...securityConfig, sub_rate_window_minutes: Number(e.target.value) })}
                        onBlur={() => saveSecurityConfig({ sub_rate_window_minutes: securityConfig.sub_rate_window_minutes })}
                      />
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* 定时配置 + 主服务器地址 */}
          <Card>
            <CardHeader className='pb-4'>
              <CardTitle className='flex items-center gap-2'>
                <Timer className='h-5 w-5' />
                {t('intervals.title')}
              </CardTitle>
              <CardDescription>{t('intervals.description')}</CardDescription>
            </CardHeader>
            <CardContent className='space-y-4'>
              <div className='grid grid-cols-2 gap-4'>
                <div className='space-y-1'>
                  <Label htmlFor='speed-interval' className='text-sm'>{t('intervals.speedCollect')}</Label>
                  <Input
                    id='speed-interval'
                    type='number'
                    min={1}
                    value={speedCollectInterval}
                    onChange={(e) => setSpeedCollectInterval(Number(e.target.value))}
                  />
                </div>
                <div className='space-y-1'>
                  <Label htmlFor='report-interval' className='text-sm'>{t('intervals.reportInterval')}</Label>
                  <Input
                    id='report-interval'
                    type='number'
                    min={1}
                    max={60}
                    value={reportInterval}
                    onChange={(e) => setReportInterval(Number(e.target.value))}
                  />
                </div>
                <div className='space-y-1'>
                  <Label htmlFor='check-interval' className='text-sm'>{t('intervals.trafficCheck')}</Label>
                  <Input
                    id='check-interval'
                    type='number'
                    min={10}
                    value={trafficCheckInterval}
                    onChange={(e) => setTrafficCheckInterval(Number(e.target.value))}
                  />
                </div>
                <div className='space-y-1'>
                  <Label htmlFor='heartbeat-interval' className='text-sm'>{t('intervals.heartbeat')}</Label>
                  <Input
                    id='heartbeat-interval'
                    type='number'
                    min={5}
                    value={heartbeatInterval}
                    onChange={(e) => setHeartbeatInterval(Number(e.target.value))}
                  />
                </div>
              </div>
              <Button
                size='sm'
                onClick={() => updateIntervalsMutation.mutate({
                  speed_collect_interval: speedCollectInterval,
                  report_interval: reportInterval,
                  traffic_check_interval: trafficCheckInterval,
                  heartbeat_interval: heartbeatInterval,
                })}
                disabled={updateIntervalsMutation.isPending}
              >
                {t('actions.save', { ns: 'common' })}
              </Button>

              <div className='border-t pt-4 space-y-2'>
                <Label htmlFor='master-url'>{t('masterUrl.title')}</Label>
                <Input
                  id='master-url'
                  placeholder={t('masterUrl.placeholder')}
                  value={masterUrl}
                  onChange={(e) => setMasterUrl(e.target.value)}
                  onBlur={() => {
                    const trimmed = masterUrl.trim().replace(/\/+$/, '')
                    setMasterUrl(trimmed)
                    if (trimmed !== (masterUrlData?.master_url || '')) {
                      updateMasterUrlMutation.mutate(trimmed)
                    }
                  }}
                  disabled={updateMasterUrlMutation.isPending}
                />
                <p className='text-xs text-muted-foreground'>{t('masterUrl.hint')}</p>
              </div>
            </CardContent>
          </Card>

          {/* API Token */}
          <Card>
            <CardHeader className='pb-4'>
              <CardTitle>{t('apiToken.title')}</CardTitle>
              <CardDescription>{t('apiToken.description')}</CardDescription>
            </CardHeader>
            <CardContent className='space-y-3'>
              <div className='flex items-center gap-2'>
                <div className='flex-1 relative'>
                  <Input
                    type={showApiToken ? 'text' : 'password'}
                    value={loadingApiToken ? '...' : (apiTokenData?.token || '')}
                    readOnly
                    className='pr-10 font-mono text-sm'
                  />
                  <Button
                    type='button'
                    variant='ghost'
                    size='sm'
                    className='absolute right-0 top-0 h-full px-3 hover:bg-transparent'
                    onClick={() => setShowApiToken(!showApiToken)}
                  >
                    {showApiToken ? (
                      <EyeOff className='h-4 w-4 text-muted-foreground' />
                    ) : (
                      <Eye className='h-4 w-4 text-muted-foreground' />
                    )}
                  </Button>
                </div>
                <Button
                  type='button'
                  variant='outline'
                  size='icon'
                  onClick={copyApiToken}
                  disabled={loadingApiToken || !apiTokenData?.token}
                >
                  <Copy className='h-4 w-4' />
                </Button>
                <Button
                  type='button'
                  variant='outline'
                  size='icon'
                  onClick={() => {
                    if (confirm(t('apiToken.regenerateConfirm'))) {
                      regenerateApiTokenMutation.mutate()
                    }
                  }}
                  disabled={loadingApiToken || regenerateApiTokenMutation.isPending}
                >
                  <RefreshCw className={`h-4 w-4 ${regenerateApiTokenMutation.isPending ? 'animate-spin' : ''}`} />
                </Button>
              </div>
              <p className='text-xs text-muted-foreground whitespace-pre-line'>
                {t('apiToken.warning')}
              </p>
            </CardContent>
          </Card>

          {/* 许可证设置 */}
          <LicenseSettingsCard />
        </div>
      </main>
    </div>
  )
}

function LicenseSettingsCard() {
  const { t } = useTranslation('system')
  const queryClient = useQueryClient()
  const [licenseKey, setLicenseKey] = useState('')

  const { data: licenseSettings } = useQuery({
    queryKey: ['license-settings'],
    queryFn: async () => {
      const response = await api.get('/api/admin/license/settings')
      return response.data as {
        success: boolean
        license_key: string
      }
    },
    staleTime: 5 * 60 * 1000,
  })

  const { data: licenseStatus } = useQuery({
    queryKey: ['license-status'],
    queryFn: async () => {
      const response = await api.get('/api/admin/license/status')
      return response.data as {
        success: boolean
        license: {
          valid: boolean
          max_servers: number
          expires_at?: string
          plan?: {
            name: string
            display_name: string
            max_servers: number
            max_nodes: number
            max_users: number
            features: string[]
          }
        }
      }
    },
    staleTime: 60 * 1000,
  })

  useEffect(() => {
    if (licenseSettings) {
      setLicenseKey(licenseSettings.license_key || '')
    }
  }, [licenseSettings])

  const updateMutation = useMutation({
    mutationFn: async () => {
      await api.put('/api/admin/license/settings', {
        license_key: licenseKey,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['license-settings'] })
      queryClient.invalidateQueries({ queryKey: ['license-status'] })
      toast.success(t('license.updated'))
    },
    onError: handleServerError,
  })

  const lic = licenseStatus?.license
  const isTrial = !licenseKey || lic?.plan?.name === 'TRIAL'

  return (
    <Card>
      <CardHeader className='pb-4'>
        <CardTitle className='flex items-center gap-2'>
          <KeyRound className='h-5 w-5' />
          {t('license.title')}
        </CardTitle>
        <CardDescription>{t('license.description')}</CardDescription>
      </CardHeader>
      <CardContent className='space-y-4'>
        {lic && (
          <div className='rounded-lg border bg-muted/40 p-4'>
            <div className='flex items-center gap-2 mb-3'>
              <span className='text-sm font-medium'>{t('license.status')}:</span>
              <span className={`text-sm font-medium ${lic.valid ? 'text-green-600' : 'text-red-500'}`}>
                {lic.valid ? t('license.valid') : t('license.invalid')}
              </span>
              <span className='text-muted-foreground'>·</span>
              <span className='text-sm text-muted-foreground'>{t('license.plan')}:</span>
              <span className='text-sm'>{lic.plan?.display_name || t('license.trial')}</span>
              {lic.expires_at && (
                <>
                  <span className='text-muted-foreground'>·</span>
                  <span className='text-sm text-muted-foreground'>{t('license.expiresAt')}:</span>
                  <span className='text-sm'>{lic.expires_at}</span>
                </>
              )}
            </div>
            <div className='grid grid-cols-3 gap-3'>
              <div className='rounded border bg-background px-3 py-2 text-center'>
                <div className='text-lg font-semibold'>{lic.max_servers}</div>
                <div className='text-xs text-muted-foreground'>{t('license.maxServers')}</div>
              </div>
              {lic.plan && (
                <>
                  <div className='rounded border bg-background px-3 py-2 text-center'>
                    <div className='text-lg font-semibold'>{lic.plan.max_nodes}</div>
                    <div className='text-xs text-muted-foreground'>{t('license.maxNodes')}</div>
                  </div>
                  <div className='rounded border bg-background px-3 py-2 text-center'>
                    <div className='text-lg font-semibold'>{lic.plan.max_users}</div>
                    <div className='text-xs text-muted-foreground'>{t('license.maxUsers')}</div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {isTrial && (
          <div className='rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-950'>
            <p className='text-sm text-blue-800 dark:text-blue-200'>
              {t('license.trialHint')}{' '}
              <a
                href='https://license.miaomiaowu.net/'
                target='_blank'
                rel='noopener noreferrer'
                className='font-medium underline'
              >
                license.miaomiaowu.net
              </a>
            </p>
          </div>
        )}

        {/* PRO 功能清单 — 激活的可点击跳文档,未激活的灰色不可点 hover 显示"需要升级许可证" */}
        <ProFeaturesPanel features={lic?.plan?.features || []} />


        <div className='space-y-2'>
          <Label>{t('license.licenseKey')}</Label>
          <div className='flex items-center gap-2'>
            <Input
              value={licenseKey}
              onChange={(e) => setLicenseKey(e.target.value)}
              placeholder={t('license.licenseKeyPlaceholder')}
            />
            <Button
              onClick={() => updateMutation.mutate()}
              disabled={updateMutation.isPending}
              className='shrink-0'
            >
              {updateMutation.isPending ? '...' : t('actions.save', { ns: 'common' })}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// PRO 功能清单
// 数据源:license.plan.features 字符串数组(后端按 feature key 下发)。
// 这里硬编码 4 个已上线的 PRO 能力 + 各自的文档 URL,匹配 license.features 决定按钮可点性。
// PRO 功能键名必须对齐后端 license features 列表(server_share / speed_test / limiter / embedded)。
// 之前误写成 rate_limit / embedded_xray,导致即使许可证含这两项也命中不到、显示为锁定。
const PRO_FEATURES: { key: string; label: string; doc: string }[] = [
  { key: 'speed_test', label: '节点测速', doc: 'https://miaomiaowu.net/x/docs/node-speedtest' },
  { key: 'limiter', label: '节点限速', doc: 'https://miaomiaowu.net/x/docs/node-ratelimit' },
  { key: 'server_share', label: '分享服务器', doc: 'https://miaomiaowu.net/x/docs/share-server' },
  { key: 'embedded', label: '内嵌 Xray', doc: 'https://miaomiaowu.net/x/docs/embedded-xray' },
]

// 与 pro-feature-gate.tsx 里的 Pro 角标保持同一视觉:星形 SVG + "Pro" 字 + 琥珀渐变胶囊;未激活退灰
function ProBadge({ active }: { active: boolean }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[9px] font-bold leading-none shadow-sm',
      active
        ? 'border-amber-300/60 bg-gradient-to-r from-amber-400 to-yellow-300 text-amber-900 shadow-amber-200/50'
        : 'border-gray-300/60 bg-gradient-to-r from-gray-200 to-gray-300 text-gray-500 dark:border-gray-500/60 dark:from-gray-700 dark:to-gray-600 dark:text-gray-300'
    )}>
      <svg className={cn('h-2 w-2', active && 'animate-pulse')} viewBox='0 0 24 24' fill='currentColor'>
        <path d='M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z' />
      </svg>
      Pro
    </span>
  )
}

function ProFeaturesPanel({ features }: { features: string[] }) {
  const activeSet = new Set(features || [])
  return (
    <div className='space-y-2'>
      <Label className='text-sm'>PRO 功能</Label>
      <div className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
        {PRO_FEATURES.map((f) => {
          const active = activeSet.has(f.key)
          if (active) {
            return (
              <Tooltip key={f.key}>
                <TooltipTrigger asChild>
                  <a
                    href={f.doc}
                    target='_blank'
                    rel='noopener noreferrer'
                    className='inline-flex items-center justify-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary/15'
                  >
                    <ProBadge active />
                    {f.label}
                    <BookOpen className='h-3 w-3 opacity-60' />
                  </a>
                </TooltipTrigger>
                <TooltipContent className='font-mono text-[11px]'>{f.doc}</TooltipContent>
              </Tooltip>
            )
          }
          return (
            <Tooltip key={f.key}>
              <TooltipTrigger asChild>
                <button
                  type='button'
                  disabled
                  className='inline-flex cursor-not-allowed items-center justify-center gap-1.5 rounded-md border bg-muted px-3 py-2 text-sm text-muted-foreground opacity-70'
                >
                  <ProBadge active={false} />
                  {f.label}
                  <Lock className='h-3 w-3' />
                </button>
              </TooltipTrigger>
              <TooltipContent>需要升级许可证</TooltipContent>
            </Tooltip>
          )
        })}
      </div>
    </div>
  )
}
