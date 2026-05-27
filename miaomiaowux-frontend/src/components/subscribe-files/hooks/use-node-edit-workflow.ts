// 节点编辑工作流的所有 query + mutation:
//   - fileContentQuery / configFileContentQuery / nodesConfigQuery: 拉文件内容(各按不同的 editing target)
//   - nodesQuery: 拉所有节点(供编辑节点对话框选择)
//   - saveMutation / saveConfigMutation: 保存
//
// 副作用(从 query 数据 sync 到 editor state)留在父组件,这里只暴露原始 query + mutation。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { handleServerError } from '@/lib/handle-server-error'

interface FileTarget {
  filename: string
}

interface FileContent {
  name?: string
  content: string
  latest_version?: number
}

export function useNodeEditWorkflow(opts: {
  enabled: boolean
  editingFile: FileTarget | null
  editingConfigFile: FileTarget | null
  editingNodesFile: FileTarget | null
  editNodesDialogOpen: boolean
  // 保存成功后的副作用,关闭 dialog + 重置 editor state
  onSaveSuccess?: () => void
  onSaveConfigSuccess?: () => void
}) {
  const { t } = useTranslation('subscribe')
  const queryClient = useQueryClient()

  // 编辑文件 dialog 用 — 文件内容 + 版本号(用于乐观更新)
  // 注意:走 `/api/admin/rules/` 端点(规则文件层) — 与 configFileContentQuery 的 `/api/admin/subscribe-files/` 不同
  const fileContentQuery = useQuery({
    queryKey: ['rule-file', opts.editingFile?.filename],
    queryFn: async () => {
      if (!opts.editingFile) return null
      const response = await api.get(`/api/admin/rules/${encodeURIComponent(opts.editingFile.filename)}`)
      return response.data as FileContent
    },
    enabled: Boolean(opts.editingFile && opts.enabled),
    refetchOnWindowFocus: false,
  })

  // 编辑配置 dialog 用
  const configFileContentQuery = useQuery({
    queryKey: ['subscribe-file-content', opts.editingConfigFile?.filename],
    queryFn: async () => {
      if (!opts.editingConfigFile) return null
      const response = await api.get(
        `/api/admin/subscribe-files/${encodeURIComponent(opts.editingConfigFile.filename)}/content`,
      )
      return response.data as { content: string }
    },
    enabled: Boolean(opts.editingConfigFile && opts.enabled),
    refetchOnWindowFocus: false,
  })

  // 节点列表(编辑节点 dialog 里的可选节点池)
  const nodesQuery = useQuery({
    queryKey: ['nodes'],
    queryFn: async () => {
      const response = await api.get('/api/admin/nodes')
      return response.data as { nodes: Array<{ id: number; node_name: string }> }
    },
    enabled: Boolean(opts.editNodesDialogOpen && opts.enabled),
    refetchOnWindowFocus: false,
  })

  // 编辑节点 dialog 用 — 拉同一份文件,但用单独 queryKey 避免与"编辑配置"互相 invalidate
  const nodesConfigQuery = useQuery({
    queryKey: ['nodes-config-content', opts.editingNodesFile?.filename],
    queryFn: async () => {
      if (!opts.editingNodesFile) return null
      const response = await api.get(
        `/api/admin/subscribe-files/${encodeURIComponent(opts.editingNodesFile.filename)}/content`,
      )
      return response.data as { content: string }
    },
    enabled: Boolean(opts.editingNodesFile && opts.enabled),
    refetchOnWindowFocus: false,
  })

  // 保存(编辑文件 dialog,触发 rule-file invalidate)
  const saveMutation = useMutation({
    mutationFn: async (payload: { file: string; content: string }) => {
      const response = await api.put(`/api/admin/rules/${encodeURIComponent(payload.file)}`, {
        content: payload.content,
      })
      return response.data as { version: number }
    },
    onSuccess: () => {
      toast.success(t('toast.ruleSaved'))
      queryClient.invalidateQueries({
        queryKey: ['rule-file', opts.editingFile?.filename],
      })
      opts.onSaveSuccess?.()
    },
    onError: (error) => {
      handleServerError(error)
    },
  })

  // 保存配置(编辑配置 dialog,触发 subscribe-file-content invalidate)
  const saveConfigMutation = useMutation({
    mutationFn: async (payload: { filename: string; content: string }) => {
      const response = await api.put(
        `/api/admin/subscribe-files/${encodeURIComponent(payload.filename)}/content`,
        { content: payload.content },
      )
      return response.data
    },
    onSuccess: () => {
      toast.success(t('toast.configSaved'))
      queryClient.invalidateQueries({
        queryKey: ['subscribe-file-content', opts.editingConfigFile?.filename],
      })
      queryClient.invalidateQueries({ queryKey: ['subscribe-files'] })
      opts.onSaveConfigSuccess?.()
    },
    onError: (error) => {
      handleServerError(error)
    },
  })

  return {
    fileContentQuery,
    configFileContentQuery,
    nodesQuery,
    nodesConfigQuery,
    saveMutation,
    saveConfigMutation,
  }
}
