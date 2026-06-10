// 订阅文件页面用到的支持数据(下拉候选 / 流量统计)。
// 这些 query 都是纯读、无 mutation,聚合成一个 hook 给主页面调用,减少 SubscribeFilesPage 顶部的 useQuery 数量。
//
// 注意:`remote-servers` queryKey 在 xray-servers / nodes / routes/index 多处复用,所有调用方必须返回相同形状
// `{ servers?: [...] }` 才能共享缓存,否则先到者的形状会污染后到者(历史上踩过 `.map is not a function` 的坑)。
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

export interface TemplateRef {
  filename: string
  name?: string
}

export interface CustomRuleRef {
  id: number
  name: string
  type: string
}

export interface OverrideScriptRef {
  id: number
  name: string
  hook: string
}

export interface RemoteServerRef {
  id: number
  name: string
}

export interface TrafficInfo {
  used: number
  limit: number
}

export function useSupportData() {
  const { data: templates } = useQuery({
    queryKey: ['template-v3-list'],
    queryFn: async () => {
      const { data } = await api.get('/api/admin/template-v3')
      const list = data?.templates
      return Array.isArray(list) ? (list as TemplateRef[]) : []
    },
  })

  const { data: nodeTags } = useQuery({
    queryKey: ['node-tags'],
    queryFn: async () => {
      const { data } = await api.get('/api/admin/nodes/tags')
      const tags = data?.tags
      return Array.isArray(tags) ? (tags as string[]) : []
    },
  })

  const { data: remoteServers } = useQuery({
    queryKey: ['remote-servers'],
    queryFn: async () => {
      const { data } = await api.get('/api/admin/remote-servers')
      return data as { servers?: RemoteServerRef[] }
    },
  })

  const { data: customRules } = useQuery({
    queryKey: ['custom-rules-for-select'],
    queryFn: async () => {
      const { data } = await api.get('/api/admin/custom-rules')
      return Array.isArray(data) ? (data as CustomRuleRef[]) : []
    },
  })

  const { data: overrideScripts } = useQuery({
    queryKey: ['override-scripts-for-select'],
    queryFn: async () => {
      const { data } = await api.get('/api/admin/override-scripts')
      return Array.isArray(data) ? (data as OverrideScriptRef[]) : []
    },
  })

  // 系统级总开关 `enable_override_scripts`。后端 subscription.go 用它 gate 整个覆写流程,
  // 关闭时即便用户勾了脚本也不会执行。前端用它 gate 订阅列表「覆写配置」列 + 编辑订阅
  // dialog 的覆写勾选区 — 关闭时直接隐藏,避免用户配置了没生效的困惑。
  const { data: overrideEnabledData } = useQuery({
    queryKey: ['system-settings', 'override-scripts'],
    queryFn: async () => {
      const { data } = await api.get('/api/admin/system-settings/override-scripts')
      return data as { enable_override_scripts?: boolean }
    },
  })

  // 流量统计接口可能耗时(后端聚合) — 30s staleTime + 60s refetchInterval
  const { data: traffic, isLoading: isTrafficLoading } = useQuery({
    queryKey: ['subscribe-files-traffic'],
    queryFn: async () => {
      const { data } = await api.get('/api/admin/subscribe-files/traffic')
      return data.traffic as Record<string, TrafficInfo>
    },
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
  })

  return {
    templates: templates ?? [],
    nodeTags: nodeTags ?? [],
    remoteServers: remoteServers?.servers ?? [],
    // 保留 raw shape 供原本传 `remoteServersData?.servers ?? []` 的旧调用点
    remoteServersRaw: remoteServers,
    customRules: customRules ?? [],
    overrideScripts: overrideScripts ?? [],
    overrideEnabled: overrideEnabledData?.enable_override_scripts ?? false,
    traffic,
    isTrafficLoading,
  }
}
