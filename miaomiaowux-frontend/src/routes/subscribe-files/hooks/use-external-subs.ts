// 外部订阅相关:列表 query + 4 个 mutation(同步全部 / 同步单个 / 更新 / 删除)+ 单个同步进行中 id 状态。
// 全部聚合到一个 hook,供主页面调用。
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'

export interface ExternalSubscription {
  id: number
  name: string
  url: string
  user_agent: string
  node_count: number
  upload: number
  download: number
  total: number
  expire?: number | string
  last_sync_at?: string
  traffic_mode?: 'download' | 'upload' | 'both'
}

interface UpdateExternalSubPayload {
  id: number
  name: string
  url: string
  user_agent?: string
  traffic_mode: 'download' | 'upload' | 'both'
}

export function useExternalSubs(opts: { enabled: boolean }) {
  const { t } = useTranslation('subscribe')
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['external-subscriptions'],
    queryFn: async () => {
      const response = await api.get('/api/user/external-subscriptions')
      return response.data as ExternalSubscription[]
    },
    enabled: opts.enabled,
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await api.delete(`/api/user/external-subscriptions?id=${id}`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['external-subscriptions'] })
      queryClient.invalidateQueries({ queryKey: ['traffic-summary'] })
      toast.success(t('toast.externalSubDeleted'))
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || t('toast.deleteFailed'))
    },
  })

  const updateMutation = useMutation({
    mutationFn: async (data: UpdateExternalSubPayload) => {
      await api.put(`/api/user/external-subscriptions?id=${data.id}`, {
        name: data.name,
        url: data.url,
        user_agent: data.user_agent,
        traffic_mode: data.traffic_mode,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['external-subscriptions'] })
      queryClient.invalidateQueries({ queryKey: ['traffic-summary'] })
      toast.success(t('toast.externalSubUpdated'))
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || t('toast.updateFailed'))
    },
  })

  const syncAllMutation = useMutation({
    mutationFn: async () => {
      const response = await api.post('/api/admin/sync-external-subscriptions')
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['external-subscriptions'] })
      queryClient.invalidateQueries({ queryKey: ['nodes'] })
      queryClient.invalidateQueries({ queryKey: ['traffic-summary'] })
      toast.success(t('toast.externalSubSynced'))
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || t('toast.syncFailed'))
    },
  })

  // syncingSingleId 提示当前哪条订阅在做单个同步(列表行用来转 spinner)
  const [syncingSingleId, setSyncingSingleId] = useState<number | null>(null)
  const syncSingleMutation = useMutation({
    mutationFn: async (id: number) => {
      setSyncingSingleId(id)
      const response = await api.post(`/api/admin/sync-external-subscription?id=${id}`)
      return response.data
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['external-subscriptions'] })
      queryClient.invalidateQueries({ queryKey: ['nodes'] })
      queryClient.invalidateQueries({ queryKey: ['all-nodes-with-tags'] })
      queryClient.invalidateQueries({ queryKey: ['traffic-summary'] })
      toast.success(data.message || t('toast.subscriptionSynced'))
      setSyncingSingleId(null)
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || t('toast.syncFailed'))
      setSyncingSingleId(null)
    },
  })

  return {
    externalSubs: data ?? [],
    isLoading,
    syncingSingleId,
    deleteMutation,
    updateMutation,
    syncAllMutation,
    syncSingleMutation,
  }
}
