// 代理集合配置:列表 query + 5 个 mutation(创建 / 更新 / 删除 / 批量删除 / 切换 process_mode)。
// mutation 内部触及主页面的本地状态(关闭 dialog / 重置 form / 清空选中 id),通过 callback prop 上抛。
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'

export interface ProxyProviderConfig {
  id: number
  external_subscription_id: number
  name: string
  type: string
  interval: number
  proxy: string
  size_limit: number
  header: string
  health_check_enabled: boolean
  health_check_url: string
  health_check_interval: number
  health_check_timeout: number
  health_check_lazy: boolean
  health_check_expected_status: number
  filter: string
  exclude_filter: string
  exclude_type: string
  override: string
  process_mode: 'client' | 'mmw'
  created_at: string
  updated_at: string
}

interface ProviderPayloadCreate {
  external_subscription_id: number
  name: string
  type: string
  interval: number
  proxy: string
  size_limit: number
  header: string
  health_check_enabled: boolean
  health_check_url: string
  health_check_interval: number
  health_check_timeout: number
  health_check_lazy: boolean
  health_check_expected_status: number
  filter: string
  exclude_filter: string
  exclude_type: string
  override: string
  process_mode: string
}

interface ProviderPayloadUpdate extends Omit<ProviderPayloadCreate, 'external_subscription_id'> {
  id: number
}

export function useProxyProviders(opts: {
  enabled: boolean
  // mutation 成功后的副作用(主页面持有,关 dialog / 重置 form 等)
  onCreateSuccess?: () => void
  onUpdateSuccess?: () => void
  onBatchDeleteDone?: () => void
}) {
  const { t } = useTranslation('subscribe')
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['proxy-provider-configs'],
    queryFn: async () => {
      const response = await api.get('/api/user/proxy-provider-configs')
      return Array.isArray(response.data) ? (response.data as ProxyProviderConfig[]) : []
    },
    enabled: opts.enabled,
  })

  const createMutation = useMutation({
    mutationFn: async (data: ProviderPayloadCreate) => {
      const response = await api.post('/api/user/proxy-provider-configs', data)
      // MMW 模式新建后刷一次缓存
      if (data.process_mode === 'mmw' && response.data?.id) {
        try {
          await api.post(`/api/user/proxy-provider-cache/refresh?id=${response.data.id}`)
        } catch (e) {
          console.warn('缓存刷新失败:', e)
        }
      }
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['proxy-provider-configs'] })
      toast.success(t('toast.proxyProviderCreated'))
      opts.onCreateSuccess?.()
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || t('toast.createFailed'))
    },
  })

  const updateMutation = useMutation({
    mutationFn: async (data: ProviderPayloadUpdate) => {
      const response = await api.put(`/api/user/proxy-provider-configs?id=${data.id}`, data)
      if (data.process_mode === 'mmw') {
        try {
          await api.post(`/api/user/proxy-provider-cache/refresh?id=${data.id}`)
        } catch (e) {
          console.warn('缓存刷新失败:', e)
        }
      }
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['proxy-provider-configs'] })
      toast.success(t('toast.proxyProviderUpdated'))
      opts.onUpdateSuccess?.()
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || t('toast.updateFailed'))
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await api.delete(`/api/user/proxy-provider-configs?id=${id}`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['proxy-provider-configs'] })
      toast.success(t('toast.proxyProviderDeleted'))
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || t('toast.deleteFailed'))
    },
  })

  const batchDeleteMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      const results = await Promise.allSettled(
        ids.map((id) => api.delete(`/api/user/proxy-provider-configs?id=${id}`)),
      )
      const failed = results.filter((r) => r.status === 'rejected').length
      if (failed > 0) {
        throw new Error(t('toast.configDeleteFailed', { count: failed }))
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['proxy-provider-configs'] })
      opts.onBatchDeleteDone?.()
      toast.success(t('toast.batchDeleteSuccess'))
    },
    onError: (error: any) => {
      queryClient.invalidateQueries({ queryKey: ['proxy-provider-configs'] })
      opts.onBatchDeleteDone?.()
      toast.error(error.message || t('toast.batchDeleteFailed'))
    },
  })

  const toggleProcessModeMutation = useMutation({
    mutationFn: async (config: ProxyProviderConfig) => {
      const newMode = config.process_mode === 'mmw' ? 'client' : 'mmw'
      await api.put(`/api/user/proxy-provider-configs?id=${config.id}`, {
        ...config,
        process_mode: newMode,
      })
      return newMode
    },
    onSuccess: (newMode) => {
      queryClient.invalidateQueries({ queryKey: ['proxy-provider-configs'] })
      toast.success(newMode === 'mmw' ? t('toast.switchedToMmw') : t('toast.switchedToClient'))
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || t('toast.switchFailed'))
    },
  })

  return {
    configs: data ?? [],
    isLoading,
    createMutation,
    updateMutation,
    deleteMutation,
    batchDeleteMutation,
    toggleProcessModeMutation,
  }
}
