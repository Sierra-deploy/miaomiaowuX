// @ts-nocheck
import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { load as parseYAML, dump as dumpYAML } from 'js-yaml'
import { Copy } from 'lucide-react'
import { formatBytes as formatTraffic, formatTrafficGB } from '@/lib/format'
import {
  defaultOverrideForm,
  overrideFormToJSON,
  jsonToOverrideForm,
  type OverrideForm,
} from '@/components/subscribe-files/utils/override-form'
import { PreviewDialog } from '@/components/subscribe-files/dialogs/preview-dialog'
import { EditConfigDialog } from '@/components/subscribe-files/dialogs/edit-config-dialog'
import { EditExternalSubDialog } from '@/components/subscribe-files/dialogs/edit-external-sub-dialog'
import { EditFileDialog } from '@/components/subscribe-files/dialogs/edit-file-dialog'
import { EditMetadataDialog } from '@/components/subscribe-files/dialogs/edit-metadata-dialog'
import { EditNodesHostDialog } from '@/components/subscribe-files/dialogs/edit-nodes-host-dialog'
import { BatchDeleteProviderDialog } from '@/components/subscribe-files/dialogs/batch-delete-provider-dialog'
import { ProxyProviderProDialog } from '@/components/subscribe-files/dialogs/proxy-provider-pro-dialog'
import { ProxyProviderEditDialog } from '@/components/subscribe-files/dialogs/proxy-provider-edit-dialog'
import { ExternalSubsSection } from '@/components/subscribe-files/components/external-subs-section'
import { ProxyProvidersSection } from '@/components/subscribe-files/components/proxy-providers-section'
import { FilesListSection } from '@/components/subscribe-files/components/files-list-section'
import { useSupportData } from '@/components/subscribe-files/hooks/use-support-data'
import { useExternalSubs } from '@/components/subscribe-files/hooks/use-external-subs'
import { useProxyProviders } from '@/components/subscribe-files/hooks/use-proxy-providers'
import { useUserMeta } from '@/components/subscribe-files/hooks/use-user-meta'
import { useAllNodes } from '@/components/subscribe-files/hooks/use-all-nodes'
import { useSubscribeFiles } from '@/components/subscribe-files/hooks/use-subscribe-files'
import { useNodeEditWorkflow } from '@/components/subscribe-files/hooks/use-node-edit-workflow'
import {
  batchCreateByRegion,
  batchCreateByProtocol,
} from '@/components/subscribe-files/utils/batch-create-providers'
import {
  Upload,
  Download,
  Edit,
  Settings,
  FileText,
  Save,
  Trash2,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Eye,
} from 'lucide-react'
import { toast } from 'sonner'
import { useAuthStore } from '@/stores/auth-store'
import { profileQueryFn } from '@/lib/profile'
import { api } from '@/lib/api'
import {
  validateClashConfig,
  formatValidationIssues,
} from '@/lib/clash-validator'
import { handleServerError } from '@/lib/handle-server-error'
import {
  collectMissingRuleTargets,
  extractProxyGroupNames,
  replaceMissingRuleTargets,
} from '@/lib/rules-node-replacement'
import { translateOutbound } from '@/lib/sublink/translations'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useProxyGroupCategories } from '@/hooks/use-proxy-groups'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { DataTable } from '@/components/data-table'
import type { DataTableColumn } from '@/components/data-table'
import { MissingNodesReplaceDialog } from '@/components/missing-nodes-replace-dialog'
// TrafficScopePopover 由 files-list-section 内联使用 — 这里只保留服务器列表 + 保存回调透传
import { Twemoji } from '@/components/twemoji'

export const Route = createFileRoute('/subscribe-files/')({
  beforeLoad: () => {
    const token = useAuthStore.getState().auth.accessToken
    if (!token) {
      throw redirect({ to: '/' })
    }
  },
  component: SubscribeFilesPage,
})

type SubscribeFile = {
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

// TYPE_COLORS 已搬到 ./subscribe-files/components/files-list-section.tsx;TYPE_LABELS 已废弃(改用 t('management.typeLabels.X'))

type ExternalSubscription = {
  id: number
  name: string
  url: string
  user_agent: string
  node_count: number
  last_sync_at: string | null
  upload: number
  download: number
  total: number
  expire: string | null
  traffic_mode: 'download' | 'upload' | 'both'
  created_at: string
  updated_at: string
}

type ProxyProviderConfig = {
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

// 代理协议类型列表搬到 ./subscribe-files/utils/proxy-provider-form.ts(被 ProxyProviderEditDialog 用)


// IP 版本选项
// IP_VERSION_OPTIONS 同上,搬到 ./subscribe-files/utils/proxy-provider-form.ts

// OverrideForm 类型、默认值、↔JSON 互转都搬到了 ./subscribe-files/utils/override-form.ts
// 见 B1 拆分计划:零行为变更,只是模块化

// 格式化流量
function SubscribeFilesPage() {
  const { t } = useTranslation('subscribe')
  const { auth } = useAuthStore()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { data: profileInfo } = useQuery({
    queryKey: ['profile'],
    queryFn: profileQueryFn,
    enabled: Boolean(auth.accessToken),
    staleTime: 5 * 60 * 1000,
  })
  const isAdmin = Boolean(profileInfo?.is_admin)
  const isMobile = useMediaQuery('(max-width: 640px)')

  // 获取代理组配置
  const { data: proxyGroupCategories = [] } = useProxyGroupCategories()

  // 日期格式化器
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'medium',
        timeStyle: 'short',
        hour12: false,
      }),
    []
  )

  // 对话框状态
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false)
  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [editingFile, setEditingFile] = useState<SubscribeFile | null>(null)
  const [editMetadataDialogOpen, setEditMetadataDialogOpen] = useState(false)
  const [editingMetadata, setEditingMetadata] = useState<SubscribeFile | null>(
    null
  )
  const [editConfigDialogOpen, setEditConfigDialogOpen] = useState(false)
  const [editingConfigFile, setEditingConfigFile] =
    useState<SubscribeFile | null>(null)

  // 编辑节点Dialog状态
  const [editNodesDialogOpen, setEditNodesDialogOpen] = useState(false)
  const [editingNodesFile, setEditingNodesFile] =
    useState<SubscribeFile | null>(null)
  const [proxyGroups, setProxyGroups] = useState<
    Array<{ name: string; type: string; proxies: string[]; use?: string[] }>
  >([])
  const [showAllNodes, setShowAllNodes] = useState(true)

  // 编辑器状态
  const [editorValue, setEditorValue] = useState('')
  const [isDirty, setIsDirty] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)

  // 编辑配置状态
  const [configContent, setConfigContent] = useState('')

  // 流量统计范围抽屉(管理员点订阅"流量"列触发)

  // 缺失节点替换对话框状态
  const [missingNodesDialogOpen, setMissingNodesDialogOpen] = useState(false)
  const [missingNodes, setMissingNodes] = useState<string[]>([])
  const [replacementChoice, setReplacementChoice] = useState<string>('DIRECT')
  const [pendingConfigAfterSave, setPendingConfigAfterSave] = useState('')
  const missingNodeReplacementOptions = useMemo(() => {
    if (!pendingConfigAfterSave) {
      return []
    }
    try {
      const parsedConfig = parseYAML(pendingConfigAfterSave)
      return extractProxyGroupNames(parsedConfig)
    } catch {
      return []
    }
  }, [pendingConfigAfterSave])

  // 导入表单
  const [importForm, setImportForm] = useState({
    name: '',
    description: '',
    url: '',
    filename: '',
  })

  // 上传表单
  const [uploadForm, setUploadForm] = useState({
    name: '',
    description: '',
    filename: '',
  })
  const [uploadFile, setUploadFile] = useState<File | null>(null)

  // 编辑元数据表单
  const [metadataForm, setMetadataForm] = useState({
    name: '',
    description: '',
    filename: '',
    template_filename: '',
    selected_tags: [] as string[],
    selected_node_ids: [] as number[],
    selected_custom_rule_ids: [] as number[],
    selected_override_script_ids: [] as number[],
    stats_server_ids: '',
    traffic_limit: '' as string,
    custom_short_code: '',
    raw_output: false,
  })

  // 外部订阅卡片折叠状态 - 默认折叠
  const [isExternalSubsExpanded, setIsExternalSubsExpanded] = useState(false)

  // 编辑外部订阅对话框状态
  const [editExternalSubDialogOpen, setEditExternalSubDialogOpen] =
    useState(false)
  const [editingExternalSub, setEditingExternalSub] =
    useState<ExternalSubscription | null>(null)
  const [editExternalSubForm, setEditExternalSubForm] = useState({
    name: '',
    url: '',
    user_agent: '',
    traffic_mode: 'both' as 'download' | 'upload' | 'both',
  })

  // 代理集合对话框状态
  const [proxyProviderDialogOpen, setProxyProviderDialogOpen] = useState(false)
  const [selectedExternalSub, setSelectedExternalSub] =
    useState<ExternalSubscription | null>(null)
  const [proxyProviderForm, setProxyProviderForm] = useState({
    name: '',
    type: 'http',
    interval: 3600,
    proxy: 'DIRECT',
    size_limit: 0,
    header_user_agent: 'Clash/v1.18.0',
    header_authorization: '',
    health_check_enabled: true,
    health_check_url: 'https://www.gstatic.com/generate_204',
    health_check_interval: 300,
    health_check_timeout: 5000,
    health_check_lazy: true,
    health_check_expected_status: 204,
    filter: '',
    exclude_filter: '',
    exclude_type: [] as string[],
    override: { ...defaultOverrideForm },
    process_mode: 'client' as 'client' | 'mmw',
  })
  const [editingProxyProvider, setEditingProxyProvider] =
    useState<ProxyProviderConfig | null>(null)
  const [isProxyProvidersExpanded, setIsProxyProvidersExpanded] =
    useState(false)

  // 代理集合Pro对话框状态
  const [proxyProviderProDialogOpen, setProxyProviderProDialogOpen] =
    useState(false)
  const [proSelectedExternalSub, setProSelectedExternalSub] =
    useState<ExternalSubscription | null>(null)
  const [proNamePrefix, setProNamePrefix] = useState('')
  const [proCreatingRegion, setProCreatingRegion] = useState(false)
  const [proCreatingProtocol, setProCreatingProtocol] = useState(false)
  const [proCreationResults, setProCreationResults] = useState<
    Array<{ name: string; success: boolean; error?: string }>
  >([])
  const [enableGeoIPMatching, setEnableGeoIPMatching] = useState(true) // 根据IP位置分组开关

  // 代理集合批量操作状态
  const [selectedProxyProviderIds, setSelectedProxyProviderIds] = useState<
    Set<number>
  >(new Set())
  const [proxyProviderFilterSubId, setProxyProviderFilterSubId] = useState<
    number | 'all'
  >('all')
  const [batchDeleteDialogOpen, setBatchDeleteDialogOpen] = useState(false)

  // 代理集合预览状态（MMW 模式）
  const [previewDialogOpen, setPreviewDialogOpen] = useState(false)
  const [previewContent, setPreviewContent] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewConfigName, setPreviewConfigName] = useState('')

  // 订阅文件:list query + 7 个 mutation,聚合到 hook,见 ./subscribe-files/hooks/use-subscribe-files
  const {
    files,
    isLoading,
    importMutation,
    uploadMutation,
    deleteMutation,
    updateMetadataMutation,
    inlineUpdateMutation,
    reorderMutation,
    toggleAutoSyncMutation,
  } = useSubscribeFiles({
    enabled: Boolean(auth.accessToken),
    onImportSuccess: () => {
      setImportDialogOpen(false)
      setImportForm({ name: '', description: '', url: '', filename: '' })
    },
    onUploadSuccess: () => {
      setUploadDialogOpen(false)
      setUploadForm({ name: '', description: '', filename: '' })
      setUploadFile(null)
    },
    onMetadataUpdateSuccess: () => {
      setEditMetadataDialogOpen(false)
      setEditingMetadata(null)
      setMetadataForm({
        name: '',
        description: '',
        filename: '',
        template_filename: '',
        selected_tags: [],
        selected_node_ids: [],
        selected_custom_rule_ids: [],
        selected_override_script_ids: [],
        stats_server_ids: '',
        traffic_limit: '',
        custom_short_code: '',
        raw_output: false,
      })
    },
  })

  // 外部订阅:列表 + 4 个 mutation + 单个同步进行中 id,聚合到 hook,见 ./subscribe-files/hooks/use-external-subs
  const {
    externalSubs,
    isLoading: isExternalSubsLoading,
    syncingSingleId,
    deleteMutation: deleteExternalSubMutation,
    updateMutation: updateExternalSubMutation,
    syncAllMutation: syncExternalSubsMutation,
    syncSingleMutation: syncSingleExternalSubMutation,
  } = useExternalSubs({ enabled: Boolean(auth.accessToken) })

  // 用户元信息(token + custom short code + user-config)聚合到 hook,见 ./subscribe-files/hooks/use-user-meta
  const {
    userToken,
    myUserShortCode,
    myCustomUserShortCode,
    updateShortCodeMutation: updateMyShortCodeMutation,
    enableProxyProvider,
  } = useUserMeta({ enabled: Boolean(auth.accessToken) })

  // 代理集合配置:list query + 5 个 mutation,聚合到 hook,见 ./subscribe-files/hooks/use-proxy-providers
  const {
    configs: proxyProviderConfigs,
    isLoading: isProxyProviderConfigsLoading,
    createMutation: createProxyProviderMutation,
    updateMutation: updateProxyProviderMutation,
    deleteMutation: deleteProxyProviderMutation,
    batchDeleteMutation: batchDeleteProxyProviderMutation,
    toggleProcessModeMutation,
  } = useProxyProviders({
    enabled: Boolean(auth.accessToken && enableProxyProvider),
    onCreateSuccess: () => {
      setProxyProviderDialogOpen(false)
      // 创建后重置 form
      setProxyProviderForm({
        name: '',
        type: 'http',
        interval: 3600,
        proxy: 'DIRECT',
        size_limit: 0,
        header_user_agent: 'Clash/v1.18.0',
        header_authorization: '',
        health_check_enabled: true,
        health_check_url: 'https://www.gstatic.com/generate_204',
        health_check_interval: 300,
        health_check_timeout: 5000,
        health_check_lazy: true,
        health_check_expected_status: 204,
        filter: '',
        exclude_filter: '',
        exclude_type: [],
        override: { ...defaultOverrideForm },
        process_mode: 'client',
      })
    },
    onUpdateSuccess: () => {
      setProxyProviderDialogOpen(false)
      setEditingProxyProvider(null)
    },
    onBatchDeleteDone: () => {
      setSelectedProxyProviderIds(new Set())
      setBatchDeleteDialogOpen(false)
    },
  })

  // 全部节点 + 按 tag 分组,见 ./subscribe-files/hooks/use-all-nodes
  // 编辑元数据 dialog + 列表行内"选择节点" Popover 都需要全节点 — 直接在登录后常驻拉(数据量小)
  const { allNodesData, allNodesLoaded, nodesByTag } = useAllNodes({
    enabled: Boolean(auth.accessToken),
  })

  // 6 个支持数据 query(下拉候选 + 流量统计)聚合到 hook,见 ./subscribe-files/hooks/use-support-data
  const {
    templates: templatesData,
    nodeTags: nodeTagsData,
    remoteServersRaw: remoteServersData,
    customRules: customRulesList,
    overrideScripts: overrideScriptsList,
    traffic: trafficData,
    isTrafficLoading,
  } = useSupportData()

  // 导入订阅
  // ↑ 7 个订阅文件 mutation 已搬到 ./subscribe-files/hooks/use-subscribe-files

  const handleMoveUp = (file: SubscribeFile) => {
    const idx = files.findIndex((f) => f.id === file.id)
    if (idx <= 0) return
    const ids = files.map((f) => f.id)
    ;[ids[idx - 1], ids[idx]] = [ids[idx], ids[idx - 1]]
    reorderMutation.mutate(ids)
  }

  const handleMoveDown = (file: SubscribeFile) => {
    const idx = files.findIndex((f) => f.id === file.id)
    if (idx < 0 || idx >= files.length - 1) return
    const ids = files.map((f) => f.id)
    ;[ids[idx], ids[idx + 1]] = [ids[idx + 1], ids[idx]]
    reorderMutation.mutate(ids)
  }

  // ↑ 4 个外部订阅 mutation + syncingSingleId 已搬到 ./subscribe-files/hooks/use-external-subs

  // 创建代理集合配置
  // 上面 5 个代理集合 mutation 已搬到 ./subscribe-files/hooks/use-proxy-providers

  // 过滤后的代理集合配置列表
  const filteredProxyProviderConfigs = useMemo(() => {
    if (proxyProviderFilterSubId === 'all') {
      return proxyProviderConfigs
    }
    return proxyProviderConfigs.filter(
      (c) => c.external_subscription_id === proxyProviderFilterSubId
    )
  }, [proxyProviderConfigs, proxyProviderFilterSubId])

  // 处理全选/取消全选
  const handleSelectAllProxyProviders = (checked: boolean) => {
    if (checked) {
      setSelectedProxyProviderIds(
        new Set(filteredProxyProviderConfigs.map((c) => c.id))
      )
    } else {
      setSelectedProxyProviderIds(new Set())
    }
  }

  // 处理单个选中/取消选中
  const handleSelectProxyProvider = (id: number, checked: boolean) => {
    setSelectedProxyProviderIds((prev) => {
      const newSet = new Set(prev)
      if (checked) {
        newSet.add(id)
      } else {
        newSet.delete(id)
      }
      return newSet
    })
  }

  // toggleProcessModeMutation 已搬到 ./subscribe-files/hooks/use-proxy-providers

  // 批量创建代理集合(按地域 / 按协议)— 实现搬到 ./subscribe-files/utils/batch-create-providers
  const handleBatchCreateByRegion = () =>
    batchCreateByRegion({
      selectedExternalSub: proSelectedExternalSub,
      namePrefix: proNamePrefix,
      enableGeoIPMatching,
      setCreating: setProCreatingRegion,
      setResults: setProCreationResults,
      setNamePrefix: setProNamePrefix,
      invalidateProviders: () =>
        queryClient.invalidateQueries({ queryKey: ['proxy-provider-configs'] }),
      t,
    })

  const handleBatchCreateByProtocol = () =>
    batchCreateByProtocol({
      selectedExternalSub: proSelectedExternalSub,
      namePrefix: proNamePrefix,
      setCreating: setProCreatingProtocol,
      setResults: setProCreationResults,
      setNamePrefix: setProNamePrefix,
      invalidateProviders: () =>
        queryClient.invalidateQueries({ queryKey: ['proxy-provider-configs'] }),
      t,
    })

  // 预览妙妙屋处理后的配置
  const handlePreviewProxyProvider = async (config: ProxyProviderConfig) => {
    if (config.process_mode !== 'mmw') {
      toast.error(t('toast.onlyMmwPreview'))
      return
    }

    setPreviewConfigName(config.name)
    setPreviewContent('')
    setPreviewLoading(true)
    setPreviewDialogOpen(true)

    try {
      const response = await api.get(
        `/api/proxy-provider/${config.id}?token=${userToken}`,
        {
          responseType: 'text',
        }
      )
      setPreviewContent(response.data)
    } catch (error: any) {
      setPreviewContent(
        `# ${t('toast.previewFailed')}\n# ${error.response?.data || error.message || 'Unknown error'}`
      )
      toast.error(t('toast.previewFailed'))
    } finally {
      setPreviewLoading(false)
    }
  }

  // 生成代理集合YAML配置预览
  const generateProxyProviderYAML = () => {
    if (!selectedExternalSub) return ''

    const form = proxyProviderForm
    const isClientMode = form.process_mode === 'client'

    // 构建配置对象
    const config: Record<string, any> = {
      type: form.type,
      path: `./proxy_providers/${form.name}.yaml`,
      interval: form.interval,
    }

    // URL
    if (isClientMode) {
      config.url = selectedExternalSub.url
    } else {
      // 妙妙屋处理模式，URL 指向后端接口
      const baseUrl =
        typeof window !== 'undefined' ? window.location.origin : '{妙妙屋地址}'
      // 编辑模式使用实际 ID，新建模式使用占位符
      const configId = editingProxyProvider?.id || '{config_id}'
      config.url = `${baseUrl}/api/proxy-provider/${configId}?token=${userToken || '{user_token}'}`
    }

    // 下载代理
    if (form.proxy && form.proxy !== 'DIRECT') {
      config.proxy = form.proxy
    }

    // 文件大小限制
    if (form.size_limit > 0) {
      config['size-limit'] = form.size_limit
    }

    // 请求头
    if (form.header_user_agent || form.header_authorization) {
      config.header = {}
      if (form.header_user_agent) {
        config.header['User-Agent'] = form.header_user_agent
          .split(',')
          .map((s: string) => s.trim())
      }
      if (form.header_authorization) {
        config.header['Authorization'] = [form.header_authorization]
      }
    }

    // 健康检查
    if (form.health_check_enabled) {
      config['health-check'] = {
        enable: true,
        url: form.health_check_url,
        interval: form.health_check_interval,
        timeout: form.health_check_timeout,
        lazy: form.health_check_lazy,
        'expected-status': form.health_check_expected_status,
      }
    }

    // 高级配置（仅客户端模式输出）
    if (isClientMode) {
      if (form.filter) {
        config.filter = form.filter
      }
      if (form.exclude_filter) {
        config['exclude-filter'] = form.exclude_filter
      }
      if (form.exclude_type.length > 0) {
        config['exclude-type'] = form.exclude_type.join('|')
      }
      // 将 override 表单转换为 JSON，然后解析为对象
      const overrideJSON = overrideFormToJSON(form.override)
      if (overrideJSON) {
        try {
          config.override = JSON.parse(overrideJSON)
        } catch {
          // 忽略无效JSON
        }
      }
    }

    // 生成YAML
    const yamlObj: Record<string, any> = {}
    yamlObj[form.name] = config

    return dumpYAML(yamlObj, { indent: 2, lineWidth: -1 })
  }

  // 获取用户配置（包含节点排序）
  // 注意: 与 useUserMeta 共享 queryKey ['user-config']，但这里读的字段更多（node_order/match_rule 等）
  const userConfigQuery = useQuery({
    queryKey: ['user-config'],
    queryFn: async () => {
      const response = await api.get('/api/user/config')
      return response.data as {
        force_sync_external: boolean
        match_rule: string
        cache_expire_minutes: number
        sync_traffic: boolean
        node_order: number[]
      }
    },
    enabled: Boolean(auth.accessToken),
  })

  // 节点编辑工作流: 5 queries + 2 mutations
  const {
    fileContentQuery,
    configFileContentQuery,
    nodesQuery,
    nodesConfigQuery,
    saveMutation,
    saveConfigMutation,
  } = useNodeEditWorkflow({
    enabled: Boolean(auth.accessToken),
    editingFile,
    editingConfigFile,
    editingNodesFile,
    editNodesDialogOpen,
    onSaveSuccess: () => {
      setIsDirty(false)
      setValidationError(null)
      setEditDialogOpen(false)
      setEditingFile(null)
      setEditorValue('')
    },
    onSaveConfigSuccess: () => {
      setEditConfigDialogOpen(false)
      setEditingConfigFile(null)
      setConfigContent('')
    },
  })

  // toggleAutoSyncMutation 已搬到 ./subscribe-files/hooks/use-subscribe-files

  // 当文件内容加载完成时，更新编辑器
  useEffect(() => {
    if (!fileContentQuery.data) return
    setEditorValue(fileContentQuery.data.content ?? '')
    setIsDirty(false)
    setValidationError(null)
  }, [fileContentQuery.data])

  // YAML 验证
  useEffect(() => {
    if (!editingFile || fileContentQuery.isLoading) return

    const timer = setTimeout(() => {
      const trimmed = editorValue.trim()
      if (!trimmed) {
        setValidationError(t('toast.validationEmpty'))
        return
      }

      try {
        parseYAML(editorValue)
        setValidationError(null)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'YAML parse failed'
        setValidationError(message)
      }
    }, 300)

    return () => clearTimeout(timer)
  }, [editorValue, editingFile, fileContentQuery.isLoading])

  // 加载配置文件内容
  useEffect(() => {
    if (!configFileContentQuery.data) return
    setConfigContent(configFileContentQuery.data.content ?? '')
  }, [configFileContentQuery.data])

  // 解析YAML配置并提取代理组（编辑节点用）
  useEffect(() => {
    if (!nodesConfigQuery.data?.content) return

    try {
      const parsed = parseYAML(nodesConfigQuery.data.content) as any
      if (parsed && parsed['proxy-groups']) {
        // 保留代理组的所有原始属性
        const groups = parsed['proxy-groups'].map((group: any) => ({
          ...group, // 保留所有原始属性
          name: group.name || '',
          type: group.type || '',
          proxies: Array.isArray(group.proxies) ? group.proxies : [],
        }))
        setProxyGroups(groups)
      }
    } catch (error) {
      console.error('解析YAML失败:', error)
      toast.error(t('toast.parseConfigFailed'))
    }
  }, [nodesConfigQuery.data])

  const handleEdit = (file: SubscribeFile) => {
    setEditingFile(file)
    setEditDialogOpen(true)
    // 不要立即清空 editorValue，等待 useEffect 从 fileContentQuery 加载数据
    setIsDirty(false)
    setValidationError(null)
  }

  const handleSave = () => {
    if (!editingFile) return
    try {
      parseYAML(editorValue || '')
      setValidationError(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'YAML parse failed'
      setValidationError(message)
      toast.error(t('toast.saveFailed'))
      return
    }

    saveMutation.mutate({ file: editingFile.filename, content: editorValue })
  }

  const handleReset = () => {
    if (!fileContentQuery.data) return
    setEditorValue(fileContentQuery.data.content ?? '')
    setIsDirty(false)
    setValidationError(null)
  }

  const handleImport = () => {
    if (!importForm.name || !importForm.url) {
      toast.error(t('toast.fillNameAndUrl'))
      return
    }
    importMutation.mutate(importForm)
  }

  const handleUpload = () => {
    if (!uploadFile) {
      toast.error(t('toast.selectFile'))
      return
    }
    // hook 化后 uploadMutation 的 mutationFn 显式接收 file + form,不再 closure 主页面 state
    uploadMutation.mutate({ file: uploadFile, form: uploadForm })
  }

  const handleDelete = (id: number) => {
    deleteMutation.mutate(id)
  }

  const handleEditMetadata = (file: SubscribeFile) => {
    setEditingMetadata(file)
    setMetadataForm({
      name: file.name,
      description: file.description,
      filename: file.filename,
      template_filename: file.template_filename || '',
      selected_tags: file.selected_tags || [],
      selected_node_ids: file.selected_node_ids || [],
      selected_custom_rule_ids: file.selected_custom_rule_ids || [],
      selected_override_script_ids: file.selected_override_script_ids || [],
      stats_server_ids: file.stats_server_ids || '',
      traffic_limit: file.traffic_limit != null ? String(file.traffic_limit) : '',
      custom_short_code: file.custom_short_code || '',
      raw_output: file.raw_output || false,
    })
    setEditMetadataDialogOpen(true)
  }

  const handleUpdateMetadata = () => {
    if (!editingMetadata) return
    if (!metadataForm.name.trim()) {
      toast.error(t('toast.fillName'))
      return
    }
    if (!metadataForm.filename.trim()) {
      toast.error(t('toast.fillFilename'))
      return
    }
    updateMetadataMutation.mutate({
      id: editingMetadata.id,
      data: {
        name: metadataForm.name,
        description: metadataForm.description,
        filename: metadataForm.filename,
        template_filename: metadataForm.template_filename,
        // 提交时:节点选择模式(selected_node_ids 非空)清空 selected_tags;反之亦然(避免双重过滤)
        selected_tags: metadataForm.selected_node_ids.length > 0 ? [] : metadataForm.selected_tags,
        selected_node_ids: metadataForm.selected_node_ids,
        selected_custom_rule_ids: metadataForm.selected_custom_rule_ids,
        selected_override_script_ids: metadataForm.selected_override_script_ids,
        stats_server_ids: metadataForm.stats_server_ids,
        traffic_limit: metadataForm.traffic_limit ? parseFloat(metadataForm.traffic_limit) : null,
        custom_short_code: metadataForm.custom_short_code,
        raw_output: metadataForm.raw_output,
      },
    })
  }

  const handleEditConfig = (file: SubscribeFile) => {
    setEditingConfigFile(file)
    setEditConfigDialogOpen(true)
  }

  const handleSaveConfig = () => {
    if (!editingConfigFile) return

    let parsed: any
    try {
      parsed = parseYAML(configContent || '')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'YAML parse failed'
      toast.error(t('toast.saveFailed2') + message)
      return
    }

    // 校验配置有效性
    const clashValidationResult = validateClashConfig(parsed)

    if (!clashValidationResult.valid) {
      // 有错误级别的问题，阻止保存
      const errorMessage = formatValidationIssues(clashValidationResult.issues)
      toast.error(t('toast.configValidationFailed'), {
        description: errorMessage,
        duration: 10000,
      })
      console.error('Clash配置校验失败:', clashValidationResult.issues)
      return
    }

    // 准备保存的内容
    let contentToSave = configContent

    // 如果有自动修复的内容，使用修复后的配置
    if (clashValidationResult.fixedConfig) {
      contentToSave = dumpYAML(clashValidationResult.fixedConfig, {
        lineWidth: -1,
        noRefs: true,
      })

      // 显示修复提示
      const warningIssues = clashValidationResult.issues.filter(
        (i) => i.level === 'warning'
      )
      if (warningIssues.length > 0) {
        toast.warning(t('toast.configAutoFixed'), {
          description: formatValidationIssues(warningIssues),
          duration: 8000,
        })
      }
    }

    saveConfigMutation.mutate({
      filename: editingConfigFile.filename,
      content: contentToSave,
    })
  }

  const handleToggleAutoSync = (id: number, enabled: boolean) => {
    toggleAutoSyncMutation.mutate({ id, enabled })
  }

  const handleEditNodes = (file: SubscribeFile) => {
    setEditingNodesFile(file)
    setEditNodesDialogOpen(true)
    setShowAllNodes(false)
  }

  // 验证 rules 中的节点是否存在于 proxy-groups 中
  const validateRulesNodes = (parsedConfig: any) => {
    const missingNodeNames = collectMissingRuleTargets(parsedConfig, 'node')
    missingNodeNames.forEach((nodeName) => {
      console.log(`[validateRulesNodes] 发现缺失节点: "${nodeName}"`)
    })
    return {
      missingNodes: missingNodeNames,
    }
  }

  // 应用缺失节点替换
  const handleApplyReplacement = () => {
    try {
      const parsedConfig = parseYAML(pendingConfigAfterSave) as any
      replaceMissingRuleTargets(parsedConfig, replacementChoice)

      // 转换回YAML
      const finalConfig = dumpYAML(parsedConfig, {
        lineWidth: -1,
        noRefs: true,
      })
      setConfigContent(finalConfig)

      // 更新查询缓存
      queryClient.setQueryData(['nodes-config', editingNodesFile?.id], {
        content: finalConfig,
      })

      // 只关闭替换对话框，不关闭编辑节点对话框
      setMissingNodesDialogOpen(false)
      toast.success(t('toast.replacementApplied', { choice: replacementChoice }))
    } catch (error) {
      const message = error instanceof Error ? error.message : t('toast.applyFailed')
      toast.error(message)
      console.error('应用替换失败:', error)
    }
  }

  const handleSaveNodes = async () => {
    if (!editingNodesFile) return

    // 使用当前的 configContent（可能已经被 handleRenameGroup 修改过），如果没有则使用查询数据
    const currentContent = configContent || nodesConfigQuery.data?.content
    if (!currentContent) return

    // 辅助函数：重新排序节点属性，确保 name, type, server, port 在前4位
    const reorderProxyProperties = (proxy: any) => {
      const orderedProxy: any = {}
      // 前4个属性按顺序添加
      if ('name' in proxy) orderedProxy.name = proxy.name
      if ('type' in proxy) orderedProxy.type = proxy.type
      if ('server' in proxy) orderedProxy.server = proxy.server
      // 确保 port 是数字类型，而不是字符串
      if ('port' in proxy) {
        orderedProxy.port =
          typeof proxy.port === 'string' ? parseInt(proxy.port, 10) : proxy.port
      }
      // 添加其他所有属性
      Object.keys(proxy).forEach((key) => {
        if (!['name', 'type', 'server', 'port'].includes(key)) {
          orderedProxy[key] = proxy[key]
        }
      })
      return orderedProxy
    }

    try {
      let parsed = parseYAML(currentContent) as any

      // 获取所有 MMW 模式代理集合的名称（用于后续检查）
      const allMmwProviderNames = proxyProviderConfigs
        .filter((c) => c.process_mode === 'mmw')
        .map((c) => c.name)

      // 先收集所有被使用的代理集合，提前获取它们的节点名称
      // 这样在过滤 proxies 时可以保留这些节点
      const usedProviderNames = new Set<string>()
      proxyGroups.forEach((group) => {
        // 从 use 属性收集（客户端模式）
        if (group.use) {
          group.use.forEach((provider) => usedProviderNames.add(provider))
        }
        // 从 proxies 属性收集 MMW 代理集合的引用（MMW 模式下代理集合名称作为代理组名称出现在 proxies 中）
        if (group.proxies) {
          group.proxies.forEach((proxy) => {
            if (allMmwProviderNames.includes(proxy)) {
              usedProviderNames.add(proxy)
            }
          })
        }
      })

      // 筛选 MMW 模式的代理集合
      const mmwProviderConfigs = proxyProviderConfigs.filter(
        (c) => usedProviderNames.has(c.name) && c.process_mode === 'mmw'
      )

      // 获取 MMW 节点数据（提前获取，用于保留已有节点）
      const mmwNodesMap: Record<string, { nodes: any[]; prefix: string }> = {}
      const mmwNodeNames = new Set<string>() // 所有 MMW 节点名称
      for (const config of mmwProviderConfigs) {
        try {
          const resp = await api.get(
            `/api/user/proxy-provider-nodes?id=${config.id}`
          )
          if (resp.data && resp.data.nodes) {
            mmwNodesMap[config.name] = resp.data
            // 收集所有 MMW 节点名称（带前缀）
            resp.data.nodes.forEach((node: any) => {
              mmwNodeNames.add(resp.data.prefix + node.name)
            })
          }
        } catch (err) {
          console.error(`获取代理集合 ${config.name} 节点失败:`, err)
        }
      }

      // 收集所有代理组中使用的节点名称
      const usedNodeNames = new Set<string>()
      proxyGroups.forEach((group) => {
        group.proxies.forEach((proxy) => {
          // 只添加实际节点（不是DIRECT、REJECT等特殊节点，也不是其他代理组）
          if (
            !['DIRECT', 'REJECT', 'PROXY', 'no-resolve'].includes(proxy) &&
            !proxyGroups.some((g) => g.name === proxy)
          ) {
            usedNodeNames.add(proxy)
          }
        })
      })

      // 如果有使用的节点，从nodesQuery获取它们的配置
      if (usedNodeNames.size > 0 && nodesQuery.data?.nodes) {
        // 获取使用的节点的Clash配置
        const nodeConfigs: any[] = []
        // 创建节点名称到节点ID的映射（用于后续排序）
        const nodeNameToIdMap = new Map<string, number>()

        nodesQuery.data.nodes.forEach((node: any) => {
          if (usedNodeNames.has(node.node_name) && node.clash_config) {
            try {
              const clashConfig =
                typeof node.clash_config === 'string'
                  ? JSON.parse(node.clash_config)
                  : node.clash_config
              // 重新排序属性，确保 name, type, server, port 在前4位
              const orderedConfig = reorderProxyProperties(clashConfig)
              nodeConfigs.push(orderedConfig)
              // 记录节点名称到ID的映射
              nodeNameToIdMap.set(node.node_name, node.id)
            } catch (e) {
              console.error(`解析节点 ${node.node_name} 的配置失败:`, e)
            }
          }
        })

        // 应用节点排序：根据用户配置的 node_order 对节点进行排序
        if (nodeConfigs.length > 0 && userConfigQuery.data?.node_order) {
          const nodeOrder = userConfigQuery.data.node_order
          // 创建节点ID到排序位置的映射
          const orderMap = new Map<number, number>()
          nodeOrder.forEach((id, index) => orderMap.set(id, index))

          // 按照 node_order 排序节点配置
          nodeConfigs.sort((a, b) => {
            const aId = nodeNameToIdMap.get(a.name)
            const bId = nodeNameToIdMap.get(b.name)

            const aOrder =
              aId !== undefined ? (orderMap.get(aId) ?? Infinity) : Infinity
            const bOrder =
              bId !== undefined ? (orderMap.get(bId) ?? Infinity) : Infinity

            return aOrder - bOrder
          })
        }

        // 更新proxies部分
        if (nodeConfigs.length > 0) {
          // 保留现有的proxies中不在usedNodeNames中的节点
          const existingProxies = parsed.proxies || []

          // 合并：使用新的节点配置，添加现有但未使用的节点
          const updatedProxies = [...nodeConfigs]

          // 只保留 MMW 代理集合的节点，移除其他未使用的节点
          existingProxies.forEach((proxy: any) => {
            if (
              !usedNodeNames.has(proxy.name) &&
              !updatedProxies.some((p) => p.name === proxy.name)
            ) {
              // 只有 MMW 节点才保留（因为它们是通过代理集合同步的）
              if (mmwNodeNames.has(proxy.name)) {
                updatedProxies.push(reorderProxyProperties(proxy))
              }
              // 其他未使用的节点不再保留，会从 proxies 列表中移除
            }
          })

          parsed.proxies = updatedProxies
        }
      } else {
        // 如果没有使用的节点，保留原有的proxies或设置为空数组
        if (!parsed.proxies) {
          parsed.proxies = []
        }
      }

      // 处理链式代理：给落地节点组中的节点添加 dialer-proxy 参数
      const landingGroup = proxyGroups.find((g) => g.name === '🌄 落地节点')
      const hasRelayGroup = proxyGroups.some((g) => g.name === '🌠 中转节点')

      if (
        landingGroup &&
        hasRelayGroup &&
        parsed.proxies &&
        Array.isArray(parsed.proxies)
      ) {
        // 获取落地节点组中的所有节点名称
        const landingNodeNames = new Set(
          landingGroup.proxies.filter((p): p is string => p !== undefined)
        )

        // 创建节点名称到协议的映射（用于判断是否已是链式代理节点）
        const nodeProtocolMap = new Map<string, string>()
        if (nodesQuery.data?.nodes) {
          nodesQuery.data.nodes.forEach((node: any) => {
            nodeProtocolMap.set(node.node_name, node.protocol)
          })
        }

        // 给这些节点添加 dialer-proxy 参数（跳过已经是链式代理的节点）
        parsed.proxies = parsed.proxies.map((proxy: any) => {
          if (landingNodeNames.has(proxy.name)) {
            // 通过协议判断是否为链式代理节点（协议包含 ⇋）
            const protocol = nodeProtocolMap.get(proxy.name)
            if (protocol && protocol.includes('⇋')) {
              return proxy
            }
            return {
              ...proxy,
              'dialer-proxy': '🌠 中转节点',
            }
          }
          return proxy
        })
      }

      // 更新代理组，保留 use 字段
      if (parsed && parsed['proxy-groups']) {
        parsed['proxy-groups'] = proxyGroups.map((group) => {
          const groupConfig: any = {
            ...group, // 保留所有原始属性（如 url, interval, strategy 等）
            proxies: group.proxies, // 更新 proxies
          }
          // 保留 use 字段（代理集合引用）
          if (group.use && group.use.length > 0) {
            groupConfig.use = group.use
          }
          return groupConfig
        })
      }

      // 为预置代理组添加 rules 和 rule-providers
      if (proxyGroupCategories.length > 0 && proxyGroups.length > 0) {
        // 创建代理组名称到分类的映射
        const categoryMap = new Map(
          proxyGroupCategories.map((cat) => [cat.group_label, cat])
        )

        // 收集需要添加的分类（只包含用户添加的预置代理组）
        const selectedCategories: string[] = []
        proxyGroups.forEach((group) => {
          const category = categoryMap.get(group.name)
          if (category) {
            selectedCategories.push(category.name)
          }
        })

        if (selectedCategories.length > 0) {
          // 构建 rule-providers
          const ruleProviders: Record<string, any> =
            parsed['rule-providers'] || {}

          for (const categoryName of selectedCategories) {
            const category = proxyGroupCategories.find(
              (c) => c.name === categoryName
            )
            if (!category) continue

            // 添加 site rule providers
            for (const provider of category.site_rules) {
              if (!ruleProviders[provider.key]) {
                ruleProviders[provider.key] = {
                  type: provider.type,
                  format: provider.format,
                  behavior: provider.behavior,
                  url: provider.url,
                  path: provider.path,
                  interval: provider.interval,
                }
              }
            }

            // 添加 IP rule providers
            for (const provider of category.ip_rules) {
              if (!ruleProviders[provider.key]) {
                ruleProviders[provider.key] = {
                  type: provider.type,
                  format: provider.format,
                  behavior: provider.behavior,
                  url: provider.url,
                  path: provider.path,
                  interval: provider.interval,
                }
              }
            }
          }

          parsed['rule-providers'] = ruleProviders

          // 构建 rules（domain-based 规则在前，IP-based 规则在后）
          const existingRules: string[] = parsed.rules || []
          const newRules: string[] = []

          // 先添加 site rules（domain-based）
          for (const categoryName of selectedCategories) {
            const category = proxyGroupCategories.find(
              (c) => c.name === categoryName
            )
            if (!category || !category.rule_name) continue

            const outbound =
              category.group_label || translateOutbound(category.rule_name)

            // Site rules
            for (const provider of category.site_rules) {
              const ruleStr = `RULE-SET,${provider.key},${outbound}`
              if (
                !existingRules.includes(ruleStr) &&
                !newRules.includes(ruleStr)
              ) {
                newRules.push(ruleStr)
              }
            }
          }

          // 再添加 IP rules
          for (const categoryName of selectedCategories) {
            const category = proxyGroupCategories.find(
              (c) => c.name === categoryName
            )
            if (!category || !category.rule_name) continue

            const outbound =
              category.group_label || translateOutbound(category.rule_name)

            // IP rules
            for (const provider of category.ip_rules) {
              const ruleStr = `RULE-SET,${provider.key},${outbound},no-resolve`
              if (
                !existingRules.includes(ruleStr) &&
                !newRules.includes(ruleStr)
              ) {
                newRules.push(ruleStr)
              }
            }
          }

          // 合并新规则到现有规则中（插入到 MATCH 规则之前）
          const matchRuleIndex = existingRules.findIndex((r) =>
            r.startsWith('MATCH,')
          )
          if (matchRuleIndex >= 0) {
            // 在 MATCH 规则之前插入新规则
            parsed.rules = [
              ...existingRules.slice(0, matchRuleIndex),
              ...newRules,
              ...existingRules.slice(matchRuleIndex),
            ]
          } else {
            // 如果没有 MATCH 规则，追加到末尾
            parsed.rules = [...existingRules, ...newRules]
          }
        }
      }

      // 筛选非 MMW 模式的代理集合（MMW 相关数据已在函数开头获取）
      const nonMmwProviders = proxyProviderConfigs.filter(
        (c) => usedProviderNames.has(c.name) && c.process_mode !== 'mmw'
      )

      // 找出不再被使用的 MMW 代理集合（需要清理其自动创建的代理组和节点）
      // allMmwProviderNames 已在函数开头定义
      const unusedMmwProviders = allMmwProviderNames.filter(
        (name) => !usedProviderNames.has(name)
      )

      // 清理不再使用的 MMW 代理集合的自动创建代理组和节点
      if (unusedMmwProviders.length > 0 && parsed['proxy-groups']) {
        // 删除自动创建的代理组（名称与代理集合相同的代理组）
        parsed['proxy-groups'] = parsed['proxy-groups'].filter((group: any) => {
          if (unusedMmwProviders.includes(group.name)) {
            console.log(`[MMW清理] 删除不再使用的代理组: ${group.name}`)
            return false
          }
          return true
        })

        // 删除这些代理集合的节点（根据前缀匹配）
        if (parsed.proxies && Array.isArray(parsed.proxies)) {
          // 构建需要清理的节点前缀列表
          const prefixesToRemove: string[] = []
          for (const providerName of unusedMmwProviders) {
            // 根据代理集合名称计算前缀
            let namePrefix = providerName
            if (providerName.includes('-')) {
              namePrefix = providerName.substring(0, providerName.indexOf('-'))
            }
            const prefix = `〖${namePrefix}〗`
            prefixesToRemove.push(prefix)
          }

          // 过滤掉匹配这些前缀的节点
          const beforeCount = parsed.proxies.length
          parsed.proxies = parsed.proxies.filter((proxy: any) => {
            const proxyName = proxy.name || ''
            for (const prefix of prefixesToRemove) {
              if (proxyName.startsWith(prefix)) {
                console.log(`[MMW清理] 删除节点: ${proxyName}`)
                return false
              }
            }
            return true
          })
          const removedCount = beforeCount - parsed.proxies.length
          if (removedCount > 0) {
            console.log(`[MMW清理] 共删除 ${removedCount} 个节点`)
          }
        }
      }

      // 处理 MMW 模式的代理集合（与获取订阅逻辑一致）
      if (Object.keys(mmwNodesMap).length > 0) {
        // 1. 更新使用 MMW 代理集合的代理组
        parsed['proxy-groups'] = parsed['proxy-groups'].map((group: any) => {
          const groupConfig: any = { ...group }

          if (group.use && group.use.length > 0) {
            const newUse: string[] = []
            const mmwGroupNames: string[] = []

            group.use.forEach((providerName: string) => {
              if (mmwNodesMap[providerName]) {
                // MMW 模式：添加代理组名称（而非节点名称）
                mmwGroupNames.push(providerName)
              } else {
                // 非 MMW 模式：保留 use 引用
                newUse.push(providerName)
              }
            })

            // 添加 MMW 代理组名称到 proxies
            if (mmwGroupNames.length > 0) {
              groupConfig.proxies = [
                ...(groupConfig.proxies || []),
                ...mmwGroupNames,
              ]
            }

            // 只保留非 MMW 的 use 引用
            if (newUse.length > 0) {
              groupConfig.use = newUse
            } else {
              delete groupConfig.use
            }
          }

          return groupConfig
        })

        // 2. 为每个 MMW 代理集合创建或更新对应的代理组
        const mmwGroupsToAdd: any[] = []
        for (const [providerName, data] of Object.entries(mmwNodesMap)) {
          const nodeNames = data.nodes.map(
            (node: any) => data.prefix + node.name
          )

          // 检查是否已存在同名代理组
          const existingGroupIndex = parsed['proxy-groups']?.findIndex(
            (g: any) => g.name === providerName
          )

          if (existingGroupIndex >= 0) {
            // 更新已存在的代理组的 proxies
            parsed['proxy-groups'][existingGroupIndex].proxies = nodeNames
          } else {
            // 创建新代理组（类型为 url-test）
            mmwGroupsToAdd.push({
              name: providerName,
              type: 'url-test',
              url: 'http://www.gstatic.com/generate_204',
              interval: 300,
              tolerance: 50,
              proxies: nodeNames,
            })
          }
        }

        // 3. 将新创建的 MMW 代理组追加到 proxy-groups 末尾
        if (mmwGroupsToAdd.length > 0) {
          parsed['proxy-groups'] = [
            ...parsed['proxy-groups'],
            ...mmwGroupsToAdd,
          ]
        }

        // 4. 添加 MMW 节点到 proxies
        for (const [, data] of Object.entries(mmwNodesMap)) {
          data.nodes.forEach((node: any) => {
            const prefixedNode = reorderProxyProperties({
              ...node,
              name: data.prefix + node.name,
            })
            // 检查是否已存在同名节点
            const existingIndex = parsed.proxies?.findIndex(
              (p: any) => p.name === prefixedNode.name
            )
            if (existingIndex >= 0) {
              parsed.proxies[existingIndex] = prefixedNode
            } else {
              parsed.proxies.push(prefixedNode)
            }
          })
        }
      }

      // 只为非 MMW 代理集合生成 proxy-providers 配置
      if (nonMmwProviders.length > 0) {
        const providers: Record<string, any> = {}
        nonMmwProviders.forEach((config) => {
          const baseUrl = window.location.origin
          const providerConfig: Record<string, any> = {
            type: config.type || 'http',
            path: `./proxy_providers/${config.name}.yaml`,
            url: `${baseUrl}/api/proxy-provider/${config.id}?token=${userToken}`,
            interval: config.interval || 3600,
          }
          if (config.health_check_enabled) {
            providerConfig['health-check'] = {
              enable: true,
              url:
                config.health_check_url ||
                'http://www.gstatic.com/generate_204',
              interval: config.health_check_interval || 300,
            }
          }
          providers[config.name] = providerConfig
        })
        if (Object.keys(providers).length > 0) {
          parsed['proxy-providers'] = providers
        }
      }

      // 校验配置有效性
      const clashValidationResult = validateClashConfig(parsed)

      if (!clashValidationResult.valid) {
        // 有错误级别的问题，阻止保存
        const errorMessage = formatValidationIssues(
          clashValidationResult.issues
        )
        toast.error(t('toast.configValidationFailed'), {
          description: errorMessage,
          duration: 10000,
        })
        console.error('Clash配置校验失败:', clashValidationResult.issues)
        return
      }

      // 如果有自动修复的内容，使用修复后的配置
      if (clashValidationResult.fixedConfig) {
        parsed = clashValidationResult.fixedConfig

        // 显示修复提示
        const warningIssues = clashValidationResult.issues.filter(
          (i) => i.level === 'warning'
        )
        if (warningIssues.length > 0) {
          toast.warning(t('toast.configAutoFixed'), {
            description: formatValidationIssues(warningIssues),
            duration: 8000,
          })
        }
      }

      // 转换回YAML
      const newContent = dumpYAML(parsed, { lineWidth: -1, noRefs: true })

      // 验证 rules 中引用的节点是否都存在
      const validationResult = validateRulesNodes(parsed)
      if (validationResult.missingNodes.length > 0) {
        // 有缺失的节点，显示替换对话框
        setMissingNodes(validationResult.missingNodes)
        setPendingConfigAfterSave(newContent)
        setMissingNodesDialogOpen(true)
      } else {
        // 没有缺失节点，直接应用
        // 更新编辑配置对话框中的内容
        setConfigContent(newContent)
        // 只关闭编辑节点对话框，不保存到文件
        setEditNodesDialogOpen(false)
        toast.success(t('toast.nodesApplied'))
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : t('toast.applyFailed')
      toast.error(message)
      console.error('应用节点配置失败:', error)
    }
  }

  const handleRemoveNodeFromGroup = (groupName: string, nodeIndex: number) => {
    const updatedGroups = proxyGroups.map((group) => {
      if (group.name === groupName) {
        return {
          ...group,
          proxies: group.proxies.filter((_, idx) => idx !== nodeIndex),
        }
      }
      return group
    })
    setProxyGroups(updatedGroups)
  }

  // 删除整个代理组
  const handleRemoveGroup = (groupName: string) => {
    setProxyGroups((groups) => {
      // 先过滤掉要删除的组
      const filteredGroups = groups.filter((group) => group.name !== groupName)

      // 从所有剩余组的 proxies 列表中移除对被删除组的引用
      return filteredGroups.map((group) => ({
        ...group,
        proxies: group.proxies.filter((proxy) => proxy !== groupName),
      }))
    })
  }

  // 处理代理组改名
  const handleRenameGroup = (oldName: string, newName: string) => {
    setProxyGroups((groups) => {
      // 更新被改名的组
      const updatedGroups = groups.map((group) => {
        if (group.name === oldName) {
          return { ...group, name: newName }
        }
        // 更新其他组中对这个组的引用
        return {
          ...group,
          proxies: group.proxies.map((proxy) =>
            proxy === oldName ? newName : proxy
          ),
        }
      })
      return updatedGroups
    })

    // 同时更新配置文件内容中的 rules 部分
    if (nodesConfigQuery.data?.content) {
      try {
        const parsed = parseYAML(nodesConfigQuery.data.content) as any
        if (parsed && parsed['rules'] && Array.isArray(parsed['rules'])) {
          // 更新 rules 中的代理组引用
          const updatedRules = parsed['rules'].map((rule: any) => {
            if (typeof rule === 'string') {
              // 规则格式: "DOMAIN-SUFFIX,google.com,PROXY_GROUP"
              const parts = rule.split(',')
              if (parts.length >= 3 && parts[2] === oldName) {
                parts[2] = newName
                return parts.join(',')
              }
            } else if (typeof rule === 'object' && rule.target) {
              // 对象格式的规则，更新 target 字段
              if (rule.target === oldName) {
                return { ...rule, target: newName }
              }
            }
            return rule
          })
          parsed['rules'] = updatedRules

          // 转换回YAML并更新配置内容
          const newContent = dumpYAML(parsed, { lineWidth: -1, noRefs: true })
          setConfigContent(newContent)

          // 更新 nodesConfigQuery 的缓存
          queryClient.setQueryData(['nodes-config', editingNodesFile?.id], {
            content: newContent,
          })
        }
      } catch (error) {
        console.error('更新配置文件中的代理组引用失败:', error)
      }
    }
  }

  // 计算可用节点
  // 按 userConfig.node_order 排序,跟节点管理页保持一致(管理页里用户手动拖拽过的顺序);
  // 没在 node_order 里的节点(新增的)排到后面,内部按 nodes 数组原顺序(后端默认 created_at DESC)。
  const availableNodes = useMemo(() => {
    if (!nodesQuery.data?.nodes) return []

    const nodeOrder = userConfigQuery.data?.node_order || []
    const orderMap = new Map<number, number>()
    nodeOrder.forEach((id, index) => orderMap.set(id, index))
    const sortedNodes = [...nodesQuery.data.nodes].sort((a, b) => {
      const ai = orderMap.get(a.id) ?? Number.POSITIVE_INFINITY
      const bi = orderMap.get(b.id) ?? Number.POSITIVE_INFINITY
      return ai - bi
    })
    const allNodeNames = sortedNodes.map((n) => n.node_name)

    if (showAllNodes) {
      return allNodeNames
    }

    // 获取所有代理组中已使用的节点
    const usedNodes = new Set<string>()
    proxyGroups.forEach((group) => {
      group.proxies.forEach((proxy) => usedNodes.add(proxy))
    })

    // 只返回未使用的节点
    return allNodeNames.filter((name) => !usedNodes.has(name))
  }, [nodesQuery.data, proxyGroups, showAllNodes, userConfigQuery.data?.node_order])

  // 处理编辑节点对话框关闭
  const handleEditNodesDialogOpenChange = (open: boolean) => {
    if (!open) {
      // 先关闭对话框
      setEditNodesDialogOpen(false)

      // 延迟重置数据，避免用户看到复位动画
      setTimeout(() => {
        // 关闭时重新加载原始数据
        if (nodesConfigQuery.data?.content) {
          try {
            const parsed = parseYAML(nodesConfigQuery.data.content) as any
            if (parsed && parsed['proxy-groups']) {
              // 保留代理组的所有原始属性
              const groups = parsed['proxy-groups'].map((group: any) => ({
                ...group, // 保留所有原始属性
                name: group.name || '',
                type: group.type || '',
                proxies: Array.isArray(group.proxies) ? group.proxies : [],
              }))
              setProxyGroups(groups)
            }
          } catch (error) {
            console.error('重新加载配置失败:', error)
          }
        }
        setEditingNodesFile(null)
        setShowAllNodes(false)
      }, 200)
    } else {
      setEditNodesDialogOpen(open)
    }
  }

  return (
    <main className='mx-auto w-full max-w-7xl px-4 py-8 pt-24 sm:px-6'>
      <section className='space-y-4'>
        <div className='flex flex-col gap-3 sm:gap-4'>
          <h1 className='text-3xl font-semibold tracking-tight'>{t('management.title')}</h1>

          <div className='flex gap-2'>
            <p className='text-muted-foreground mt-2'>
              {t('management.description')}
            </p>
          </div>

          <div className='flex gap-1 sm:gap-2 md:justify-start'>
            {/* 导入订阅 */}
            {/* <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
              <DialogTrigger asChild>
                <Button variant='outline' className='flex-1 md:flex-none text-xs sm:text-sm px-1.5 py-2 sm:px-4 sm:py-2'>
                  <Download className='mr-0.5 sm:mr-2 h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0' />
                  <span className='truncate'>导入订阅</span>
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>导入订阅</DialogTitle>
                  <DialogDescription>
                    从 Clash 订阅链接导入，系统会自动下载并保存文件
                  </DialogDescription>
                </DialogHeader>
                <div className='space-y-4 py-4'>
                  <div className='space-y-2'>
                    <Label htmlFor='import-name'>订阅名称 *</Label>
                    <Input
                      id='import-name'
                      placeholder={t('editMetadata.namePlaceholder')}
                      value={importForm.name}
                      onChange={(e) => setImportForm({ ...importForm, name: e.target.value })}
                    />
                  </div>
                  <div className='space-y-2'>
                    <Label htmlFor='import-url'>订阅链接 *</Label>
                    <Input
                      id='import-url'
                      placeholder='https://example.com/subscribe?token=xxx'
                      value={importForm.url}
                      onChange={(e) => setImportForm({ ...importForm, url: e.target.value })}
                    />
                  </div>
                  <div className='space-y-2'>
                    <Label htmlFor='import-filename'>文件名（可选）</Label>
                    <Input
                      id='import-filename'
                      placeholder='留空则自动获取'
                      value={importForm.filename}
                      onChange={(e) => setImportForm({ ...importForm, filename: e.target.value })}
                    />
                  </div>
                  <div className='space-y-2'>
                    <Label htmlFor='import-description'>说明（可选）</Label>
                    <Textarea
                      id='import-description'
                      placeholder={t('editMetadata.descriptionPlaceholder')}
                      value={importForm.description}
                      onChange={(e) => setImportForm({ ...importForm, description: e.target.value })}
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button variant='outline' onClick={() => setImportDialogOpen(false)}>
                    取消
                  </Button>
                  <Button onClick={handleImport} disabled={importMutation.isPending}>
                    {importMutation.isPending ? '导入中...' : '导入'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog> */}

            {/* 上传文件 */}
            {/* <Dialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen}>
              <DialogTrigger asChild>
                <Button variant='outline' className='flex-1 md:flex-none text-xs sm:text-sm px-1.5 py-2 sm:px-4 sm:py-2'>
                  <Upload className='mr-0.5 sm:mr-2 h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0' />
                  <span className='truncate'>上传文件</span>
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>上传文件</DialogTitle>
                  <DialogDescription>
                    上传本地 YAML 格式的 Clash 订阅文件
                  </DialogDescription>
                </DialogHeader>
                <div className='space-y-4 py-4'>
                  <div className='space-y-2'>
                    <Label htmlFor='upload-file'>选择文件 *</Label>
                    <Input
                      id='upload-file'
                      type='file'
                      accept='.yaml,.yml'
                      onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                    />
                  </div>
                  <div className='space-y-2'>
                    <Label htmlFor='upload-name'>订阅名称（可选）</Label>
                    <Input
                      id='upload-name'
                      placeholder='留空则使用文件名'
                      value={uploadForm.name}
                      onChange={(e) => setUploadForm({ ...uploadForm, name: e.target.value })}
                    />
                  </div>
                  <div className='space-y-2'>
                    <Label htmlFor='upload-filename'>文件名（可选）</Label>
                    <Input
                      id='upload-filename'
                      placeholder='留空则使用原文件名'
                      value={uploadForm.filename}
                      onChange={(e) => setUploadForm({ ...uploadForm, filename: e.target.value })}
                    />
                  </div>
                  <div className='space-y-2'>
                    <Label htmlFor='upload-description'>说明（可选）</Label>
                    <Textarea
                      id='upload-description'
                      placeholder={t('editMetadata.descriptionPlaceholder')}
                      value={uploadForm.description}
                      onChange={(e) => setUploadForm({ ...uploadForm, description: e.target.value })}
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button variant='outline' onClick={() => setUploadDialogOpen(false)}>
                    取消
                  </Button>
                  <Button onClick={handleUpload} disabled={uploadMutation.isPending}>
                    {uploadMutation.isPending ? '上传中...' : '上传'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog> */}

            {/* 生成订阅 */}
            {/* <Button variant='outline' className='flex-1 md:flex-none text-xs sm:text-sm px-1.5 py-2 sm:px-4 sm:py-2' onClick={() => navigate({ to: '/generator' })}>
              <FileText className='mr-0.5 sm:mr-2 h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0' />
              <span className='truncate'>生成订阅</span>
            </Button> */}

            {/* 自定义代理组 - 保留入口 */}
            {/* <Link to='/subscribe-files/custom'>
              <Button>
                <Plus className='mr-2 h-4 w-4' />
                自定义代理组
              </Button>
            </Link> */}
          </div>
        </div>

        {/* 订阅文件列表 Card section — 拆到 ./subscribe-files/components/files-list-section */}
        <FilesListSection
          files={files}
          loading={isLoading}
          isAdmin={isAdmin}
          trafficData={trafficData}
          isTrafficLoading={isTrafficLoading}
          myUserShortCode={myUserShortCode}
          myCustomUserShortCode={myCustomUserShortCode}
          templates={templatesData ?? []}
          dateFormatter={dateFormatter}
          onEditMetadata={handleEditMetadata}
          onEditConfig={handleEditConfig}
          onDelete={handleDelete}
          onMoveUp={handleMoveUp}
          onMoveDown={handleMoveDown}
          onToggleAutoSync={handleToggleAutoSync}
          trafficScopeServers={(remoteServersData?.servers ?? []).map((s: any) => ({ id: s.id, name: s.name }))}
          savingTrafficScope={inlineUpdateMutation.isPending}
          onSaveTrafficScope={(file, statsServerIds) => {
            // 同原 drawer 逻辑:发完整 payload,只改 stats_server_ids,其它字段维持现状
            inlineUpdateMutation.mutate({
              id: file.id,
              data: {
                name: file.name,
                description: (file as any).description || '',
                filename: file.filename,
                type: file.type,
                url: (file as any).url || '',
                template_filename: (file as any).template_filename || '',
                selected_tags: (file as any).selected_tags || [],
                selected_node_ids: (file as any).selected_node_ids || [],
                selected_custom_rule_ids: (file as any).selected_custom_rule_ids || [],
                selected_override_script_ids: (file as any).selected_override_script_ids || [],
                stats_server_ids: statsServerIds,
                // 透传原值:不强转 0,避免"原本 NULL/未设置"被 inline update 持久化成 0,导致流量计算被覆盖为 0。
                traffic_limit: (file as any).traffic_limit,
                custom_short_code: (file as any).custom_short_code || '',
                raw_output: (file as any).raw_output ?? false,
              },
            })
          }}
          inlineUpdate={(payload) => inlineUpdateMutation.mutate(payload)}
          updateUserShortCode={(value) => updateMyShortCodeMutation.mutate(value)}
          updateMetadataPending={updateMetadataMutation.isPending}
          deletePending={deleteMutation.isPending}
          allNodes={(allNodesData?.nodes ?? []).map((n: any) => ({
            id: n.id,
            node_name: n.node_name,
            protocol: n.protocol || '',
            original_server: n.original_server || '',
            tag: n.tag || '',
          }))}
          savingSelectedNodes={inlineUpdateMutation.isPending}
          onSaveSelectedNodes={(file, nodeIds) => {
            // 行内快捷"选择节点":发完整 payload,只改 selected_node_ids + 清空 selected_tags,其它字段维持现状
            inlineUpdateMutation.mutate({
              id: file.id,
              data: {
                name: file.name,
                description: (file as any).description || '',
                filename: file.filename,
                type: file.type,
                url: (file as any).url || '',
                template_filename: file.template_filename || '',
                selected_tags: [],
                selected_node_ids: nodeIds,
                selected_custom_rule_ids: (file as any).selected_custom_rule_ids || [],
                selected_override_script_ids: (file as any).selected_override_script_ids || [],
                stats_server_ids: (file as any).stats_server_ids || '',
                traffic_limit: (file as any).traffic_limit,
                custom_short_code: (file as any).custom_short_code || '',
                raw_output: (file as any).raw_output ?? false,
              },
            })
          }}
        />

        {/* 外部订阅 Card section — 拆到 ./subscribe-files/components/external-subs-section */}
        <ExternalSubsSection
          externalSubs={externalSubs}
          loading={isExternalSubsLoading}
          nodesByTag={nodesByTag}
          allNodesLoaded={allNodesLoaded}
          expanded={isExternalSubsExpanded}
          onExpandedChange={setIsExternalSubsExpanded}
          syncingSingleId={syncingSingleId}
          dateFormatter={dateFormatter}
          actions={{
            syncAll: () => syncExternalSubsMutation.mutate(),
            syncAllPending: syncExternalSubsMutation.isPending,
            syncSingle: (id) => syncSingleExternalSubMutation.mutate(id),
            update: (payload) => updateExternalSubMutation.mutate(payload),
            updatePending: updateExternalSubMutation.isPending,
            delete: (id) => deleteExternalSubMutation.mutate(id),
            deletePending: deleteExternalSubMutation.isPending,
          }}
          onEdit={(sub, form) => {
            setEditingExternalSub(sub)
            setEditExternalSubForm(form)
            setEditExternalSubDialogOpen(true)
          }}
        />

        {/* 代理集合配置 Card section — 拆到 ./subscribe-files/components/proxy-providers-section */}
        {enableProxyProvider && (
          <ProxyProvidersSection
            configs={proxyProviderConfigs}
            filteredConfigs={filteredProxyProviderConfigs}
            loading={isProxyProviderConfigsLoading}
            externalSubs={externalSubs}
            expanded={isProxyProvidersExpanded}
            onExpandedChange={setIsProxyProvidersExpanded}
            filterSubId={proxyProviderFilterSubId}
            onFilterSubIdChange={setProxyProviderFilterSubId}
            selectedIds={selectedProxyProviderIds}
            onSelectedIdsChange={setSelectedProxyProviderIds}
            onSelectAll={(checked) => handleSelectAllProxyProviders(checked)}
            onSelectOne={(id, checked) => handleSelectProxyProvider(id, checked)}
            onOpenBatchDelete={() => setBatchDeleteDialogOpen(true)}
            onOpenCreateBasic={() => {
              setProSelectedExternalSub(null)
              setProCreationResults([])
              setProxyProviderProDialogOpen(true)
            }}
            onOpenCreateAdvanced={() => {
              setEditingProxyProvider(null)
              setSelectedExternalSub(null)
              setProxyProviderForm({
                name: '',
                type: 'http',
                interval: 3600,
                proxy: 'DIRECT',
                size_limit: 0,
                header_user_agent: 'Clash/v1.18.0',
                header_authorization: '',
                health_check_enabled: true,
                health_check_url: 'https://www.gstatic.com/generate_204',
                health_check_interval: 300,
                health_check_timeout: 5000,
                health_check_lazy: true,
                health_check_expected_status: 204,
                filter: '',
                exclude_filter: '',
                exclude_type: [],
                override: { ...defaultOverrideForm },
                process_mode: 'client',
              })
              setProxyProviderDialogOpen(true)
            }}
            onEdit={(config) => {
              // 解析 header JSON,填充表单,打开编辑对话框(原 inline 60+ 行逻辑)
              setEditingProxyProvider(config)
              const sub = externalSubs.find((s) => s.id === config.external_subscription_id)
              setSelectedExternalSub(sub || null)
              let headerUserAgent = 'Clash/v1.18.0'
              let headerAuthorization = ''
              if (config.header) {
                try {
                  const headerObj = JSON.parse(config.header)
                  if (headerObj['User-Agent']) {
                    headerUserAgent = Array.isArray(headerObj['User-Agent'])
                      ? headerObj['User-Agent'].join(', ')
                      : headerObj['User-Agent']
                  }
                  if (headerObj['Authorization']) {
                    headerAuthorization = Array.isArray(headerObj['Authorization'])
                      ? headerObj['Authorization'][0]
                      : headerObj['Authorization']
                  }
                } catch {}
              }
              setProxyProviderForm({
                name: config.name,
                type: config.type,
                interval: config.interval,
                proxy: config.proxy,
                size_limit: config.size_limit,
                header_user_agent: headerUserAgent,
                header_authorization: headerAuthorization,
                health_check_enabled: config.health_check_enabled,
                health_check_url: config.health_check_url,
                health_check_interval: config.health_check_interval,
                health_check_timeout: config.health_check_timeout,
                health_check_lazy: config.health_check_lazy,
                health_check_expected_status: config.health_check_expected_status,
                filter: config.filter,
                exclude_filter: config.exclude_filter,
                exclude_type: config.exclude_type ? config.exclude_type.split(',').map((s) => s.trim()) : [],
                override: jsonToOverrideForm(config.override),
                process_mode: config.process_mode as 'client' | 'mmw',
              })
              setProxyProviderDialogOpen(true)
            }}
            onCopyYAML={(config) => {
              // 生成并复制 YAML(原 inline 80+ 行逻辑)
              const sub = externalSubs.find((s) => s.id === config.external_subscription_id)
              if (!sub) return
              setSelectedExternalSub(sub)
              let headerUserAgent = ''
              let headerAuthorization = ''
              if (config.header) {
                try {
                  const headerObj = JSON.parse(config.header)
                  if (headerObj['User-Agent']) {
                    headerUserAgent = Array.isArray(headerObj['User-Agent'])
                      ? headerObj['User-Agent'].join(', ')
                      : headerObj['User-Agent']
                  }
                  if (headerObj['Authorization']) {
                    headerAuthorization = Array.isArray(headerObj['Authorization'])
                      ? headerObj['Authorization'][0]
                      : headerObj['Authorization']
                  }
                } catch {}
              }
              const isClientMode = config.process_mode === 'client'
              const yamlConfig: Record<string, any> = {
                type: config.type,
                path: `./proxy_providers/${config.name}.yaml`,
                interval: config.interval,
              }
              if (isClientMode) {
                yamlConfig.url = sub.url
              } else {
                const baseUrl = typeof window !== 'undefined' ? window.location.origin : ''
                yamlConfig.url = `${baseUrl}/api/proxy-provider/${config.id}?token=${userToken}`
              }
              if (config.proxy && config.proxy !== 'DIRECT') yamlConfig.proxy = config.proxy
              if (config.size_limit > 0) yamlConfig['size-limit'] = config.size_limit
              if (headerUserAgent || headerAuthorization) {
                yamlConfig.header = {}
                if (headerUserAgent) {
                  yamlConfig.header['User-Agent'] = headerUserAgent.split(',').map((s) => s.trim())
                }
                if (headerAuthorization) yamlConfig.header['Authorization'] = [headerAuthorization]
              }
              if (config.health_check_enabled) {
                yamlConfig['health-check'] = {
                  enable: true,
                  url: config.health_check_url,
                  interval: config.health_check_interval,
                  timeout: config.health_check_timeout,
                  lazy: config.health_check_lazy,
                  'expected-status': config.health_check_expected_status,
                }
              }
              if (isClientMode) {
                if (config.filter) yamlConfig.filter = config.filter
                if (config.exclude_filter) yamlConfig['exclude-filter'] = config.exclude_filter
                if (config.exclude_type) yamlConfig['exclude-type'] = config.exclude_type
                if (config.override) {
                  try {
                    yamlConfig.override = JSON.parse(config.override)
                  } catch {}
                }
              }
              const yamlObj: Record<string, any> = {}
              yamlObj[config.name] = yamlConfig
              const yamlStr = dumpYAML(yamlObj, { indent: 2, lineWidth: -1 })
              navigator.clipboard.writeText(yamlStr)
              toast.success(t('proxyProvider.configCopied'))
            }}
            onPreview={handlePreviewProxyProvider}
            actions={{
              toggleProcessMode: (config) => toggleProcessModeMutation.mutate(config),
              togglePending: toggleProcessModeMutation.isPending,
              delete: (id) => deleteProxyProviderMutation.mutate(id),
            }}
          />
        )}
      </section>

      {/* 编辑文件 Dialog — 拆到 ./subscribe-files/dialogs/edit-file-dialog */}
      <EditFileDialog
        open={editDialogOpen}
        onOpenChange={(open) => {
          setEditDialogOpen(open)
          if (!open) {
            setEditingFile(null)
            setEditorValue('')
            setIsDirty(false)
            setValidationError(null)
          }
        }}
        file={editingFile}
        value={editorValue}
        onValueChange={(next) => {
          setEditorValue(next)
          setIsDirty(next !== (fileContentQuery.data?.content ?? ''))
          if (validationError) setValidationError(null)
        }}
        isDirty={isDirty}
        validationError={validationError}
        latestVersion={fileContentQuery.data?.latest_version}
        loading={fileContentQuery.isLoading}
        saving={saveMutation.isPending}
        onSave={handleSave}
        onReset={handleReset}
      />

      {/* 编辑订阅信息 Dialog — 拆到 ./subscribe-files/dialogs/edit-metadata-dialog */}
      <EditMetadataDialog
        open={editMetadataDialogOpen}
        onOpenChange={(open) => {
          setEditMetadataDialogOpen(open)
          if (!open) {
            setEditingMetadata(null)
            setMetadataForm({
              name: '',
              description: '',
              filename: '',
              template_filename: '',
              selected_tags: [],
              selected_node_ids: [],
              selected_custom_rule_ids: [],
              selected_override_script_ids: [],
              stats_server_ids: '',
              traffic_limit: '',
              custom_short_code: '',
              raw_output: false,
            })
          }
        }}
        form={metadataForm}
        onFormChange={setMetadataForm}
        templates={templatesData ?? []}
        customRules={customRulesList ?? []}
        overrideScripts={overrideScriptsList ?? []}
        nodeTags={nodeTagsData ?? []}
        allNodes={(allNodesData?.nodes ?? []).map((n: any) => ({
          id: n.id,
          node_name: n.node_name,
          protocol: n.protocol || '',
          original_server: n.original_server || '',
          tag: n.tag || '',
        }))}
        remoteServers={remoteServersData?.servers ?? []}
        onSubmit={handleUpdateMetadata}
        saving={updateMetadataMutation.isPending}
        isAdmin={isAdmin}
      />

      {/* 编辑配置对话框 — 拆到 ./subscribe-files/dialogs/edit-config-dialog */}
      <EditConfigDialog
        open={editConfigDialogOpen}
        onOpenChange={(open) => {
          setEditConfigDialogOpen(open)
          if (!open) {
            setEditingConfigFile(null)
            setConfigContent('')
          }
        }}
        file={editingConfigFile}
        content={configContent}
        onContentChange={setConfigContent}
        onSave={handleSaveConfig}
        saving={saveConfigMutation.isPending}
        onEditNodes={handleEditNodes}
      />

      {/* 编辑节点对话框 — 拆到 ./subscribe-files/dialogs/edit-nodes-host-dialog(适配桌面/移动两套) */}
      <EditNodesHostDialog
        open={editNodesDialogOpen}
        onOpenChange={handleEditNodesDialogOpenChange}
        isMobile={isMobile}
        fileName={editingNodesFile?.name}
        proxyGroups={proxyGroups}
        availableNodes={availableNodes}
        allNodes={nodesQuery.data?.nodes || []}
        onProxyGroupsChange={setProxyGroups}
        onSave={handleSaveNodes}
        saving={saveConfigMutation.isPending}
        showAllNodes={showAllNodes}
        onShowAllNodesChange={setShowAllNodes}
        onRemoveNodeFromGroup={handleRemoveNodeFromGroup}
        onRemoveGroup={handleRemoveGroup}
        onRenameGroup={handleRenameGroup}
        proxyProviderConfigs={enableProxyProvider ? proxyProviderConfigs : []}
      />

      {/* 批量删除代理集合确认对话框 — 拆到 ./subscribe-files/dialogs/batch-delete-provider-dialog */}
      <BatchDeleteProviderDialog
        open={batchDeleteDialogOpen}
        onOpenChange={setBatchDeleteDialogOpen}
        count={selectedProxyProviderIds.size}
        onConfirm={() => batchDeleteProxyProviderMutation.mutate(Array.from(selectedProxyProviderIds))}
        deleting={batchDeleteProxyProviderMutation.isPending}
      />

      {/* 代理集合配置对话框 — 拆到 ./subscribe-files/dialogs/proxy-provider-edit-dialog */}
      <ProxyProviderEditDialog
        open={proxyProviderDialogOpen}
        onOpenChange={(open) => {
          setProxyProviderDialogOpen(open)
          if (!open) {
            setSelectedExternalSub(null)
            setEditingProxyProvider(null)
          }
        }}
        editing={editingProxyProvider}
        externalSubs={externalSubs}
        selectedExternalSub={selectedExternalSub}
        onSelectedExternalSubChange={setSelectedExternalSub}
        form={proxyProviderForm}
        onFormChange={setProxyProviderForm}
        userToken={userToken}
        previewYAML={generateProxyProviderYAML()}
        saving={createProxyProviderMutation.isPending || updateProxyProviderMutation.isPending}
        onSave={() => {
          // 构建 header JSON(原内联 onClick 提交逻辑,移到这里集中)
          const headerObj: Record<string, string[]> = {}
          if (proxyProviderForm.header_user_agent) {
            headerObj['User-Agent'] = proxyProviderForm.header_user_agent.split(',').map((s) => s.trim())
          }
          if (proxyProviderForm.header_authorization) {
            headerObj['Authorization'] = [proxyProviderForm.header_authorization]
          }

          const payload = {
            name: proxyProviderForm.name,
            type: proxyProviderForm.type,
            interval: proxyProviderForm.interval,
            proxy: proxyProviderForm.proxy,
            size_limit: proxyProviderForm.size_limit,
            header: Object.keys(headerObj).length > 0 ? JSON.stringify(headerObj) : '',
            health_check_enabled: proxyProviderForm.health_check_enabled,
            health_check_url: proxyProviderForm.health_check_url,
            health_check_interval: proxyProviderForm.health_check_interval,
            health_check_timeout: proxyProviderForm.health_check_timeout,
            health_check_lazy: proxyProviderForm.health_check_lazy,
            health_check_expected_status: proxyProviderForm.health_check_expected_status,
            filter: proxyProviderForm.filter,
            exclude_filter: proxyProviderForm.exclude_filter,
            exclude_type: proxyProviderForm.exclude_type.join(','),
            override: overrideFormToJSON(proxyProviderForm.override),
            process_mode: proxyProviderForm.process_mode,
          }

          if (editingProxyProvider) {
            updateProxyProviderMutation.mutate({
              id: editingProxyProvider.id,
              external_subscription_id: editingProxyProvider.external_subscription_id,
              ...payload,
            })
          } else {
            if (!selectedExternalSub) {
              toast.error(t('proxyProvider.dialog.selectExternalSubFirst'))
              return
            }
            createProxyProviderMutation.mutate({
              external_subscription_id: selectedExternalSub.id,
              ...payload,
            })
          }
        }}
      />

      <MissingNodesReplaceDialog
        open={missingNodesDialogOpen}
        onOpenChange={setMissingNodesDialogOpen}
        missingNodes={missingNodes}
        replacementChoice={replacementChoice}
        onReplacementChoiceChange={setReplacementChoice}
        replacementOptions={missingNodeReplacementOptions}
        onConfirm={handleApplyReplacement}
        confirmText={t('editConfig.applyReplace')}
      />

      {/* 流量统计范围已改为内联 Popover,由 files-list-section 在流量列按钮上挂载 */}

      {/* 代理集合Pro对话框 — 拆到 ./subscribe-files/dialogs/proxy-provider-pro-dialog */}
      <ProxyProviderProDialog
        open={proxyProviderProDialogOpen}
        onOpenChange={setProxyProviderProDialogOpen}
        externalSubs={externalSubs}
        selectedExternalSub={proSelectedExternalSub}
        onSelectedExternalSubChange={(sub) => {
          setProSelectedExternalSub(sub)
          // 切换外部订阅时清空上次的创建结果(原 onValueChange 内联行为)
          setProCreationResults([])
        }}
        namePrefix={proNamePrefix}
        onNamePrefixChange={setProNamePrefix}
        enableGeoIPMatching={enableGeoIPMatching}
        onEnableGeoIPMatchingChange={setEnableGeoIPMatching}
        onBatchCreateByRegion={handleBatchCreateByRegion}
        onBatchCreateByProtocol={handleBatchCreateByProtocol}
        creatingRegion={proCreatingRegion}
        creatingProtocol={proCreatingProtocol}
        creationResults={proCreationResults}
      />

      {/* 代理集合预览对话框（MMW 模式） — 拆到 ./subscribe-files/dialogs/preview-dialog */}
      <PreviewDialog
        open={previewDialogOpen}
        onOpenChange={setPreviewDialogOpen}
        configName={previewConfigName}
        content={previewContent}
        loading={previewLoading}
      />

      {/* 编辑外部订阅对话框 — 拆到 ./subscribe-files/dialogs/edit-external-sub-dialog */}
      <EditExternalSubDialog
        open={editExternalSubDialogOpen}
        onOpenChange={(open) => {
          setEditExternalSubDialogOpen(open)
          if (!open) setEditingExternalSub(null)
        }}
        editing={editingExternalSub}
        form={editExternalSubForm}
        onFormChange={setEditExternalSubForm}
        onSubmit={(editing, form) => {
          updateExternalSubMutation.mutate({
            id: editing.id,
            name: editing.name,
            url: form.url,
            user_agent: editing.user_agent,
            traffic_mode: form.traffic_mode,
          })
          setEditExternalSubDialogOpen(false)
          setEditingExternalSub(null)
        }}
        saving={updateExternalSubMutation.isPending}
      />
    </main>
  )
}
