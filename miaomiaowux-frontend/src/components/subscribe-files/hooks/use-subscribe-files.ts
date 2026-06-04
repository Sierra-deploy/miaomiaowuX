// 主订阅文件 list query + 7 个 mutation(import / upload / delete / updateMetadata / inlineUpdate / reorder / toggleAutoSync)。
// 与 use-external-subs / use-proxy-providers 平行,聚合到一个 hook,主页面只需调用一次。
//
// mutation 的副作用(关闭 dialog / 重置 form)通过 callback prop 上抛,保持 hook 自身无状态副作用。
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { handleServerError } from '@/lib/handle-server-error'

export interface SubscribeFile {
  id: number
  name: string
  description: string
  type: 'create' | 'import' | 'upload' | 'package'
  filename: string
  file_short_code: string
  custom_short_code: string
  auto_sync_custom_rules: boolean
  template_filename: string
  selected_tags: string[]
  selected_node_ids?: number[]
  selected_custom_rule_ids?: number[]
  selected_override_script_ids?: number[]
  stats_server_ids: string
  traffic_limit: number | null
  sort_order: number
  raw_output: boolean
  created_by: string
  created_at: string
  updated_at: string
  latest_version?: number
}

interface ImportFormPayload {
  name: string
  description: string
  url: string
  filename: string
}

interface UploadInput {
  file: File
  form: { name: string; description: string; filename: string }
}

export function useSubscribeFiles(opts: {
  enabled: boolean
  // mutation 成功后的副作用(关闭 dialog / 重置 form)
  onImportSuccess?: () => void
  onUploadSuccess?: () => void
  onMetadataUpdateSuccess?: () => void
}) {
  const { t } = useTranslation('subscribe')
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['subscribe-files'],
    queryFn: async () => {
      const response = await api.get('/api/admin/subscribe-files')
      return response.data as { files: SubscribeFile[] }
    },
    enabled: opts.enabled,
  })

  const importMutation = useMutation({
    mutationFn: async (data: ImportFormPayload) => {
      const response = await api.post('/api/admin/subscribe-files/import', data)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['subscribe-files'] })
      queryClient.invalidateQueries({ queryKey: ['user-subscriptions'] })
      toast.success(t('toast.importSuccess'))
      opts.onImportSuccess?.()
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || t('toast.importFailed'))
    },
  })

  const uploadMutation = useMutation({
    mutationFn: async ({ file, form }: UploadInput) => {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('name', form.name || file.name)
      formData.append('description', form.description)
      formData.append('filename', form.filename || file.name)
      const response = await api.post('/api/admin/subscribe-files/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['subscribe-files'] })
      queryClient.invalidateQueries({ queryKey: ['user-subscriptions'] })
      toast.success(t('toast.uploadSuccess'))
      opts.onUploadSuccess?.()
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || t('toast.uploadFailed'))
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await api.delete(`/api/admin/subscribe-files/${id}`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['subscribe-files'] })
      queryClient.invalidateQueries({ queryKey: ['user-subscriptions'] })
      toast.success(t('toast.deleteSuccess'))
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || t('toast.deleteFailed'))
    },
  })

  const updateMetadataMutation = useMutation({
    mutationFn: async (payload: { id: number; data: Record<string, any> }) => {
      const response = await api.put(`/api/admin/subscribe-files/${payload.id}`, payload.data)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['subscribe-files'] })
      queryClient.invalidateQueries({ queryKey: ['user-subscriptions'] })
      toast.success(t('toast.updateSuccess'))
      opts.onMetadataUpdateSuccess?.()
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || t('toast.updateFailed'))
    },
  })

  // 内联字段更新(自定义短码 / 模板绑定 / 标签 / stats_server_ids 等):无 dialog,无副作用,只 invalidate
  const inlineUpdateMutation = useMutation({
    mutationFn: async (payload: { id: number; data: Record<string, any> }) => {
      const response = await api.put(`/api/admin/subscribe-files/${payload.id}`, payload.data)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['subscribe-files'] })
      queryClient.invalidateQueries({ queryKey: ['user-subscriptions'] })
      // stats_server_ids 改变后,流量列要按新范围重新聚合,必须 invalidate 流量 query
      queryClient.invalidateQueries({ queryKey: ['subscribe-files-traffic'] })
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || t('toast.updateFailed'))
    },
  })

  const reorderMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      await api.put('/api/admin/subscribe-files/reorder', { ids })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['subscribe-files'] })
    },
  })

  const toggleAutoSyncMutation = useMutation({
    mutationFn: async (payload: { id: number; enabled: boolean }) => {
      const response = await api.patch(`/api/admin/subscribe-files/${payload.id}`, {
        auto_sync_custom_rules: payload.enabled,
      })
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['subscribe-files'] })
      toast.success(t('toast.syncSettingUpdated'))
    },
    onError: (error) => {
      handleServerError(error)
    },
  })

  return {
    files: data?.files ?? [],
    isLoading,
    importMutation,
    uploadMutation,
    deleteMutation,
    updateMetadataMutation,
    inlineUpdateMutation,
    reorderMutation,
    toggleAutoSyncMutation,
  }
}
