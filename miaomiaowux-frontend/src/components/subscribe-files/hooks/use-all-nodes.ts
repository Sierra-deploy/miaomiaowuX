// 获取全部节点(带 tag)+ 按 tag 分组的派生数据。
//
// 外部订阅卡片用 `nodesByTag[sub.name]` 在 tooltip 里列出该订阅下的节点名;
// 仅在外部订阅卡片展开时才查(`enabled` 由父端控制),避免页面初始加载就拉一遍全量节点。
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

interface NodeWithTag {
  id: number
  node_name: string
  tag: string
}

export function useAllNodes(opts: { enabled: boolean }) {
  const { data } = useQuery({
    queryKey: ['all-nodes-with-tags'],
    queryFn: async () => {
      const response = await api.get('/api/admin/nodes')
      return response.data as { nodes: NodeWithTag[] }
    },
    enabled: opts.enabled,
  })

  // 按 tag 分组 — 无 tag 落到 '手动输入' 桶
  const nodesByTag = useMemo(() => {
    const nodes = data?.nodes ?? []
    const grouped: Record<string, string[]> = {}
    for (const node of nodes) {
      const tag = node.tag || '手动输入'
      if (!grouped[tag]) grouped[tag] = []
      grouped[tag].push(node.node_name)
    }
    return grouped
  }, [data])

  return {
    allNodesData: data,
    allNodesLoaded: !!data,
    nodesByTag,
  }
}
