import React, { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { GripVertical, Plus, Check, Search, Settings2, Eye, EyeOff, Smile } from 'lucide-react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  pointerWithin,
  closestCenter,
  type CollisionDetection,
} from '@dnd-kit/core'
import { SortableContext, rectSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { Twemoji } from '@/components/twemoji'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useProxyGroupCategories } from '@/hooks/use-proxy-groups'

import { DragStateContext } from './drag-state-context'
import { DroppableAllGroupsZone } from './droppable-all-groups-zone'
import { DroppableRemoveFromAllZone } from './droppable-remove-from-all-zone'
import { DroppableAvailableZone } from './droppable-available-zone'
import { SortableCard } from './sortable-card'
import { DraggableAvailableNode } from './draggable-available-node'
import { DraggableProxyProvider } from './draggable-proxy-provider'
import { DraggableAvailableHeader } from './draggable-available-header'
import {
  PROXY_SERVICE_EMOJIS,
  SPECIAL_NODES,
  type ActiveDragItem,
  type DragItemData,
  type Node,
  type ProxyGroup,
} from './types'

interface EditNodesDialogProps {
  allNodes?: Node[]
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  proxyGroups: ProxyGroup[]
  availableNodes: string[]
  onProxyGroupsChange: (groups: ProxyGroup[]) => void
  onSave: () => void
  isSaving?: boolean
  showAllNodes?: boolean
  onShowAllNodesChange?: (show: boolean) => void
  onConfigureChainProxy?: () => void
  cancelButtonText?: string
  saveButtonText?: string
  showSpecialNodesAtBottom?: boolean // 是否在底部显示特殊节点
  proxyProviderConfigs?: Array<{ id: number; name: string; process_mode?: string }> // 代理集合配置列表
  // 保留旧的 props 以保持向后兼容,但不再使用
  draggedNode?: any
  onDragStart?: any
  onDragEnd?: any
  dragOverGroup?: any
  onDragEnterGroup?: any
  onDragLeaveGroup?: any
  onDrop?: any
  onDropToAvailable?: any
  onRemoveNodeFromGroup?: (groupName: string, nodeIndex: number) => void
  onRemoveGroup?: (groupName: string) => void
  onRenameGroup?: (oldName: string, newName: string) => void
  handleCardDragStart?: any
  handleCardDragEnd?: any
  handleNodeDragEnd?: any
  activeGroupTitle?: any
  activeCard?: any
}

export function EditNodesDialog({
  allNodes = [],
  open,
  onOpenChange,
  title,
  description: descriptionProp,
  proxyGroups,
  availableNodes,
  onProxyGroupsChange,
  onSave,
  isSaving = false,
  showAllNodes,
  onShowAllNodesChange,
  onConfigureChainProxy,
  cancelButtonText: _cancelButtonText,
  saveButtonText: saveButtonTextProp,
  showSpecialNodesAtBottom = false,
  proxyProviderConfigs = [],
  onRemoveNodeFromGroup,
  onRemoveGroup,
  onRenameGroup,
}: EditNodesDialogProps) {
  const { t } = useTranslation('nodes')
  const description = descriptionProp ?? t('editNodesDialog.defaultDescription')
  const saveButtonText = saveButtonTextProp ?? t('actions.confirm', { ns: 'common' })
  // 获取代理组配置
  const { data: proxyGroupCategories = [] } = useProxyGroupCategories()

  // 合并基础 emoji 和从 proxy-groups.json 获取的 emoji
  const allServiceEmojis = useMemo(() => {
    // 翻译静态 emoji 标签
    const staticEmojis = PROXY_SERVICE_EMOJIS.map((item) => ({
      emoji: item.emoji,
      label: t(item.labelKey) as string,
    }))

    // 从 proxy-groups.json 提取 emoji 列表
    const dynamicEmojis = proxyGroupCategories.map((category) => ({
      emoji: category.emoji,
      label: category.label,
    }))

    // 合并基础 emoji 和动态 emoji
    return [...staticEmojis, ...dynamicEmojis]
  }, [proxyGroupCategories, t])

  // 添加代理组对话框状态
  const [addGroupDialogOpen, setAddGroupDialogOpen] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [selectedEmoji, setSelectedEmoji] = useState('')

  // 组合最终代理组名称(emoji + 空格 + 名称)
  const finalGroupName = useMemo(() => {
    const trimmedName = newGroupName.trim()
    if (!trimmedName) return ''
    return selectedEmoji ? `${selectedEmoji} ${trimmedName}` : trimmedName
  }, [selectedEmoji, newGroupName])

  // 检查新代理组名称是否与现有组冲突
  const isGroupNameDuplicate = useMemo(() => {
    if (!finalGroupName) return false
    return proxyGroups.some((group) => group.name === finalGroupName)
  }, [finalGroupName, proxyGroups])

  // 代理组改名状态
  const [editingGroupName, setEditingGroupName] = useState<string | null>(null)
  const [editingGroupValue, setEditingGroupValue] = useState('')

  // 节点筛选状态
  const [nodeNameFilter, setNodeNameFilter] = useState('')
  const [nodeTagFilter, setNodeTagFilter] = useState<string>('all')

  // 统一的拖拽状态
  const [activeDragItem, setActiveDragItem] = useState<ActiveDragItem | null>(null)

  // 代理组列数(含右侧可用节点列)。0 = 自动按视窗宽度计算
  // 与 mmw 版本对齐 https://github.com/iluobei/miaomiaowu;localStorage key 用 mmwx 前缀避免和 mmw 冲突
  const [totalColumns, setTotalColumns] = useState<number>(() => {
    if (typeof window === 'undefined') return 0
    const stored = localStorage.getItem('mmwx-proxy-group-columns')
    return stored ? Number(stored) : 0
  })
  const maxColumns = 6
  const effectiveColumns =
    totalColumns ||
    Math.max(2, Math.min(maxColumns, Math.floor((typeof window !== 'undefined' ? window.innerWidth : 1280) * 0.95 / 260)))
  // 右侧"可用节点"面板占 1 列,左侧代理组网格分得其余
  const proxyGroupColumns = Math.max(1, effectiveColumns - 1)

  const handleColumnsChange = (cols: number) => {
    setTotalColumns(cols)
    if (typeof window !== 'undefined') {
      localStorage.setItem('mmwx-proxy-group-columns', String(cols))
    }
  }

  // 保存滚动位置
  const scrollContainerRef = React.useRef<HTMLDivElement>(null)
  const availableNodesScrollRef = React.useRef<HTMLDivElement>(null)

  // 提取唯一标签列表
  const uniqueTags = useMemo(() => {
    const tags = new Set<string>()
    allNodes.forEach((node) => {
      if (node.tag && node.tag.trim()) {
        tags.add(node.tag.trim())
      }
    })
    return Array.from(tags).sort()
  }, [allNodes])

  // 创建节点名称到标签的映射
  const nodeTagMap = useMemo(() => {
    const map = new Map<string, string>()
    allNodes.forEach((node) => {
      map.set(node.node_name, node.tag || '')
    })
    return map
  }, [allNodes])

  // MMW 模式代理集合名称集合(用于识别 proxies 中的代理集合引用)
  const mmwProviderNames = useMemo(() => {
    return new Set(proxyProviderConfigs.filter((c) => c.process_mode === 'mmw').map((c) => c.name))
  }, [proxyProviderConfigs])

  // 筛选可用节点
  const filteredAvailableNodes = useMemo(() => {
    let filtered = availableNodes

    // 按名称筛选
    if (nodeNameFilter.trim()) {
      const filterLower = nodeNameFilter.toLowerCase().trim()
      filtered = filtered.filter((nodeName) => nodeName.toLowerCase().includes(filterLower))
    }

    // 按标签筛选
    if (nodeTagFilter && nodeTagFilter !== 'all') {
      filtered = filtered.filter((nodeName) => {
        const tag = nodeTagMap.get(nodeName) || ''
        return tag === nodeTagFilter
      })
    }

    return filtered
  }, [availableNodes, nodeNameFilter, nodeTagFilter, nodeTagMap])

  // 统一的传感器配置 — 同时支持鼠标和触摸
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 100,
        tolerance: 5,
      },
    }),
  )

  // 自定义碰撞检测 — 优先指针检测,然后最近中心点
  const customCollisionDetection: CollisionDetection = React.useCallback((args) => {
    const pointerCollisions = pointerWithin(args)
    if (pointerCollisions.length > 0) {
      return pointerCollisions
    }
    return closestCenter(args)
  }, [])

  // 统一的拖拽开始处理
  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event
    const data = active.data.current as DragItemData

    // 锁定 body 滚动,防止 iPad 拖拽时背景滚动
    document.body.style.overflow = 'hidden'
    document.body.style.touchAction = 'none'

    setActiveDragItem({
      id: String(active.id),
      data,
    })
  }

  // 统一的拖拽结束处理
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event

    // 保存可用节点列表的滚动位置
    const availableNodesScrollTop = availableNodesScrollRef.current?.scrollTop ?? 0

    // 恢复 body 滚动
    document.body.style.overflow = ''
    document.body.style.touchAction = ''

    setActiveDragItem(null)

    const restoreAvailableNodesScroll = () => {
      requestAnimationFrame(() => {
        if (availableNodesScrollRef.current) {
          availableNodesScrollRef.current.scrollTop = availableNodesScrollTop
        }
      })
    }

    if (!over) return

    const activeData = active.data.current as DragItemData
    const overId = String(over.id)
    const overData = over.data.current as DragItemData | { type?: string; groupName?: string } | undefined

    // 获取目标代理组名称
    const getTargetGroupName = (): string | null => {
      if (overId === 'all-groups-zone') return 'all-groups'
      if (overId === 'remove-from-all-zone') return 'remove-from-all'
      if (overId === 'available-zone') return 'available'
      if (overId.startsWith('drop-')) return overId.replace('drop-', '')
      // 优先从 overData 中获取 groupName(适用于 group-node、use-item 等)
      if (overData?.groupName) return overData.groupName
      // 检查是否放在了某个代理组的节点上(排除 available-node、group-title)
      if (overId.includes('-') && !overId.startsWith('available-node-') && !overId.startsWith('group-title-')) {
        const groupName = proxyGroups.find((g) => overId.startsWith(`${g.name}-`))?.name
        if (groupName) return groupName
      }
      return null
    }

    // 计算在目标代理组中的插入位置
    const getInsertIndex = (group: ProxyGroup): number => {
      // overData 含 index(放在某节点或 use-item 上)
      if (overData && 'index' in overData && typeof overData.index === 'number' && overData.groupName === group.name) {
        // 如果是 use-item,index 已经是正确的位置(proxies.length + use 的 index)
        // 但我们需要将节点插入到 proxies 末尾
        if (overData.type === 'use-item') {
          return group.proxies.length
        }
        return overData.index
      }
      // 否则插入到末尾
      return group.proxies.length
    }

    // 计算在目标代理组 use 数组中的插入位置
    const getUseInsertIndex = (group: ProxyGroup): number => {
      const currentUse = group.use || []
      // overData 是 use-item 且在同一代理组
      if (
        overData &&
        'type' in overData &&
        overData.type === 'use-item' &&
        'index' in overData &&
        typeof overData.index === 'number' &&
        overData.groupName === group.name
      ) {
        // use-item 的 index 已经是 use 数组内的索引
        return Math.max(0, Math.min(overData.index, currentUse.length))
      }
      // overData 是 group-node,插入到 use 数组开头(紧跟在普通节点后面)
      if (overData && 'type' in overData && overData.type === 'group-node' && overData.groupName === group.name) {
        return 0
      }
      return currentUse.length
    }

    switch (activeData.type) {
      case 'available-node': {
        // 从可用节点拖到代理组
        const targetGroup = getTargetGroupName()
        if (!targetGroup || targetGroup === 'available') return

        const nodeName = activeData.nodeName!

        if (targetGroup === 'remove-from-all') {
          // 从所有代理组移除该节点
          const updatedGroups = proxyGroups.map((group) => {
            if (group.proxies.includes(nodeName)) {
              return { ...group, proxies: group.proxies.filter((p) => p !== nodeName) }
            }
            return group
          })
          onProxyGroupsChange(updatedGroups)
        } else if (targetGroup === 'all-groups') {
          // 添加到所有代理组(跳过与节点同名的代理组,防止代理组添加到自己内部)
          const updatedGroups = proxyGroups.map((group) => {
            if (group.name !== nodeName && !group.proxies.includes(nodeName)) {
              return { ...group, proxies: [...group.proxies, nodeName] }
            }
            return group
          })
          onProxyGroupsChange(updatedGroups)
        } else {
          // 阻止将代理组添加到自己内部
          if (nodeName === targetGroup) return

          // 添加到指定代理组
          const updatedGroups = proxyGroups.map((group) => {
            if (group.name === targetGroup && !group.proxies.includes(nodeName)) {
              const insertIndex = getInsertIndex(group)
              const newProxies = [...group.proxies]
              newProxies.splice(insertIndex, 0, nodeName)
              return { ...group, proxies: newProxies }
            }
            return group
          })
          onProxyGroupsChange(updatedGroups)
        }
        break
      }

      case 'available-header': {
        // 批量添加筛选后的节点
        const targetGroup = getTargetGroupName()
        if (!targetGroup || targetGroup === 'available') return

        const nodeNames = activeData.nodeNames || []

        if (targetGroup === 'remove-from-all') {
          const nodeNamesToRemove = new Set(nodeNames)
          const updatedGroups = proxyGroups.map((group) => {
            const newProxies = group.proxies.filter((p) => !nodeNamesToRemove.has(p))
            if (newProxies.length !== group.proxies.length) {
              return { ...group, proxies: newProxies }
            }
            return group
          })
          onProxyGroupsChange(updatedGroups)
        } else if (targetGroup === 'all-groups') {
          // 添加到所有代理组(过滤掉与代理组同名的节点)
          const updatedGroups = proxyGroups.map((group) => {
            const existingNodes = new Set(group.proxies)
            const newNodes = nodeNames.filter((name) => !existingNodes.has(name) && name !== group.name)
            if (newNodes.length > 0) {
              return { ...group, proxies: [...group.proxies, ...newNodes] }
            }
            return group
          })
          onProxyGroupsChange(updatedGroups)
        } else {
          // 添加到指定代理组
          const updatedGroups = proxyGroups.map((group) => {
            if (group.name === targetGroup) {
              const existingNodes = new Set(group.proxies)
              const newNodes = nodeNames.filter((name) => !existingNodes.has(name) && name !== group.name)
              if (newNodes.length > 0) {
                const insertIndex = getInsertIndex(group)
                const newProxies = [...group.proxies]
                newProxies.splice(insertIndex, 0, ...newNodes)
                return { ...group, proxies: newProxies }
              }
            }
            return group
          })
          onProxyGroupsChange(updatedGroups)
        }
        break
      }

      case 'group-node': {
        // 代理组内节点拖拽
        const sourceGroup = activeData.groupName!
        const targetGroup = getTargetGroupName()

        if (!targetGroup) return

        if (targetGroup === 'available') {
          // 从代理组移除节点(拖回可用节点区域)
          if (onRemoveNodeFromGroup && activeData.index !== undefined) {
            onRemoveNodeFromGroup(sourceGroup, activeData.index)
          }
          return
        }

        if (targetGroup === 'remove-from-all') {
          const nodeName = activeData.nodeName!
          const updatedGroups = proxyGroups.map((group) => {
            if (group.proxies.includes(nodeName)) {
              return { ...group, proxies: group.proxies.filter((p) => p !== nodeName) }
            }
            return group
          })
          onProxyGroupsChange(updatedGroups)
          return
        }

        if (sourceGroup === targetGroup) {
          // 同一代理组内排序
          const group = proxyGroups.find((g) => g.name === sourceGroup)
          if (!group) return

          const oldIndex = activeData.index!
          const nodeId = overId
          const targetNodeName = nodeId.replace(`${sourceGroup}-`, '')
          const newIndex = group.proxies.indexOf(targetNodeName)

          if (newIndex !== -1 && oldIndex !== newIndex) {
            const updatedGroups = proxyGroups.map((g) => {
              if (g.name === sourceGroup) {
                return { ...g, proxies: arrayMove(g.proxies, oldIndex, newIndex) }
              }
              return g
            })
            onProxyGroupsChange(updatedGroups)
          }
        } else if (targetGroup === 'all-groups') {
          const nodeName = activeData.nodeName!
          const updatedGroups = proxyGroups.map((group) => {
            if (group.name !== nodeName && !group.proxies.includes(nodeName)) {
              return { ...group, proxies: [...group.proxies, nodeName] }
            }
            return group
          })
          onProxyGroupsChange(updatedGroups)
        } else {
          // 跨代理组移动节点
          const nodeName = activeData.nodeName!

          // 阻止将代理组添加到自己内部
          if (nodeName === targetGroup) return

          const updatedGroups = proxyGroups.map((group) => {
            if (group.name === sourceGroup) {
              return { ...group, proxies: group.proxies.filter((_, i) => i !== activeData.index) }
            }
            if (group.name === targetGroup && !group.proxies.includes(nodeName)) {
              const insertIndex = getInsertIndex(group)
              const newProxies = [...group.proxies]
              newProxies.splice(insertIndex, 0, nodeName)
              return { ...group, proxies: newProxies }
            }
            return group
          })
          onProxyGroupsChange(updatedGroups)
        }
        break
      }

      case 'group-title': {
        // 代理组标题拖到其他代理组(作为节点添加)
        const sourceGroupName = activeData.groupName!
        const targetGroup = getTargetGroupName()

        if (!targetGroup || targetGroup === sourceGroupName || targetGroup === 'available') return

        if (targetGroup === 'all-groups') {
          const updatedGroups = proxyGroups.map((group) => {
            if (group.name !== sourceGroupName && !group.proxies.includes(sourceGroupName)) {
              return { ...group, proxies: [...group.proxies, sourceGroupName] }
            }
            return group
          })
          onProxyGroupsChange(updatedGroups)
        } else {
          const updatedGroups = proxyGroups.map((group) => {
            if (group.name === targetGroup && !group.proxies.includes(sourceGroupName)) {
              const insertIndex = getInsertIndex(group)
              const newProxies = [...group.proxies]
              newProxies.splice(insertIndex, 0, sourceGroupName)
              return { ...group, proxies: newProxies }
            }
            return group
          })
          onProxyGroupsChange(updatedGroups)
        }
        break
      }

      case 'group-card': {
        // 代理组卡片排序
        if (active.id === over.id) return

        const oldIndex = proxyGroups.findIndex((g) => g.name === active.id)
        const newIndex = proxyGroups.findIndex((g) => g.name === over.id)

        if (oldIndex !== -1 && newIndex !== -1) {
          onProxyGroupsChange(arrayMove(proxyGroups, oldIndex, newIndex))
        }
        break
      }

      case 'proxy-provider': {
        // 代理集合拖到代理组
        const providerName = activeData.providerName!
        const targetGroup = getTargetGroupName()

        if (!targetGroup || targetGroup === 'available' || targetGroup === 'remove-from-all') return

        if (targetGroup === 'all-groups') {
          const updatedGroups = proxyGroups.map((group) => {
            const currentUse = group.use || []
            if (!currentUse.includes(providerName)) {
              return { ...group, use: [...currentUse, providerName] }
            }
            return group
          })
          onProxyGroupsChange(updatedGroups)
        } else {
          const updatedGroups = proxyGroups.map((group) => {
            if (group.name === targetGroup) {
              const currentUse = group.use || []
              if (!currentUse.includes(providerName)) {
                const insertIndex = getUseInsertIndex(group)
                const newUse = [...currentUse]
                newUse.splice(insertIndex, 0, providerName)
                return { ...group, use: newUse }
              }
            }
            return group
          })
          onProxyGroupsChange(updatedGroups)
        }
        break
      }

      case 'use-item': {
        // use-item 拖放处理
        const sourceGroup = activeData.groupName!
        const sourceProviderName = activeData.providerName!
        const targetGroup = getTargetGroupName()

        if (!targetGroup) return

        // 同一代理组内排序
        if (targetGroup === sourceGroup && overData && 'type' in overData) {
          const group = proxyGroups.find((g) => g.name === sourceGroup)
          if (!group?.use) break

          const oldIndex = group.use.indexOf(sourceProviderName)
          if (oldIndex === -1) break

          let newIndex: number
          if (overData.type === 'use-item' && 'providerName' in overData) {
            newIndex = group.use.indexOf((overData as any).providerName)
          } else if (overData.type === 'group-node' && 'index' in overData) {
            // 放在某个节点上,移动到 use 数组开头
            newIndex = 0
          } else {
            break
          }

          if (newIndex !== -1 && oldIndex !== newIndex) {
            const updatedGroups = proxyGroups.map((g) => {
              if (g.name === sourceGroup && g.use) {
                return { ...g, use: arrayMove(g.use, oldIndex, newIndex) }
              }
              return g
            })
            onProxyGroupsChange(updatedGroups)
          }
        }
        // 跨代理组移动 use-item
        else if (targetGroup !== sourceGroup && targetGroup !== 'available' && targetGroup !== 'remove-from-all') {
          const updatedGroups = proxyGroups.map((group) => {
            if (group.name === sourceGroup && group.use) {
              return { ...group, use: group.use.filter((u) => u !== sourceProviderName) }
            }
            if (group.name === targetGroup) {
              const currentUse = group.use || []
              if (!currentUse.includes(sourceProviderName)) {
                const insertIndex = getUseInsertIndex(group)
                const newUse = [...currentUse]
                newUse.splice(insertIndex, 0, sourceProviderName)
                return { ...group, use: newUse }
              }
            }
            return group
          })
          onProxyGroupsChange(updatedGroups)
        }
        break
      }
    }

    // 恢复可用节点列表的滚动位置
    restoreAvailableNodesScroll()
  }

  // 保存滚动位置的包装函数
  const withScrollPreservation = <T extends (...args: any[]) => void>(fn: T) => {
    return (...args: Parameters<T>) => {
      const scrollTop = scrollContainerRef.current?.scrollTop ?? 0
      fn(...args)
      requestAnimationFrame(() => {
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTop = scrollTop
        }
      })
    }
  }

  // 包装删除节点函数
  const wrappedRemoveNodeFromGroup = React.useCallback(
    withScrollPreservation((groupName: string, nodeIndex: number) => {
      if (onRemoveNodeFromGroup) {
        onRemoveNodeFromGroup(groupName, nodeIndex)
      }
    }),
    [onRemoveNodeFromGroup],
  )

  // 包装删除代理组函数
  const wrappedRemoveGroup = React.useCallback(
    withScrollPreservation((groupName: string) => {
      if (onRemoveGroup) {
        onRemoveGroup(groupName)
      }
    }),
    [onRemoveGroup],
  )

  // 处理代理组改名
  const handleRenameGroupInternal = (oldName: string, newName: string) => {
    const trimmedName = newName.trim()
    if (!trimmedName || trimmedName === oldName) {
      setEditingGroupName(null)
      setEditingGroupValue('')
      return
    }

    const existingGroup = proxyGroups.find((group) => group.name === trimmedName && group.name !== oldName)
    if (existingGroup) {
      return
    }

    if (onRenameGroup) {
      onRenameGroup(oldName, trimmedName)
    }
    setEditingGroupName(null)
    setEditingGroupValue('')
  }

  const startEditingGroup = (groupName: string) => {
    setEditingGroupName(groupName)
    setEditingGroupValue(groupName)
  }

  const cancelEditingGroup = () => {
    setEditingGroupName(null)
    setEditingGroupValue('')
  }

  const submitEditingGroup = () => {
    if (editingGroupName && editingGroupValue) {
      handleRenameGroupInternal(editingGroupName, editingGroupValue)
    }
  }

  // 添加新代理组
  const handleAddGroup = () => {
    if (!finalGroupName) return

    const newGroup: ProxyGroup = {
      name: finalGroupName,
      type: 'select',
      proxies: [],
    }

    onProxyGroupsChange([newGroup, ...proxyGroups])
    setNewGroupName('')
    setSelectedEmoji('')
    setAddGroupDialogOpen(false)
  }

  const handleQuickSelect = (name: string) => {
    // 检测名称是否以 emoji 开头,自动分离 emoji 和名称
    const emojiRegex = /^([\p{Emoji}\p{Emoji_Component}️]+)\s*/u
    const match = name.match(emojiRegex)
    if (match) {
      setSelectedEmoji(match[1].trim())
      setNewGroupName(name.slice(match[0].length).trim())
    } else {
      setSelectedEmoji('')
      setNewGroupName(name)
    }
  }

  // 代理组类型变更处理
  const handleGroupTypeChange = React.useCallback(
    (groupName: string, updatedGroup: ProxyGroup) => {
      const updatedGroups = proxyGroups.map((g) => (g.name === groupName ? updatedGroup : g))
      onProxyGroupsChange(updatedGroups)
    },
    [proxyGroups, onProxyGroupsChange],
  )

  // 移除 use-item 的回调
  const handleRemoveUseItem = React.useCallback(
    (groupName: string, index: number) => {
      const updatedGroups = proxyGroups.map((g) => {
        if (g.name === groupName) {
          const newUse = (g.use || []).filter((_, i) => i !== index)
          return { ...g, use: newUse.length > 0 ? newUse : undefined }
        }
        return g
      })
      onProxyGroupsChange(updatedGroups)
    },
    [proxyGroups, onProxyGroupsChange],
  )

  // Context 值 — 用 useMemo 避免不必要的重渲染
  const dragStateValue = useMemo(
    () => ({
      isActiveDragging: !!activeDragItem,
    }),
    [activeDragItem],
  )

  // ================== 渲染 ==================

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className='!max-w-[95vw] w-[95vw] max-h-[90vh] flex flex-col'
          style={{ maxWidth: '95vw', width: '95vw' }}
        >
          <DndContext
            sensors={sensors}
            collisionDetection={customCollisionDetection}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <DragStateContext.Provider value={dragStateValue}>
              <DialogHeader>
                <div className='flex items-start justify-between gap-4'>
                  <div className='flex-1'>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>{description}</DialogDescription>
                    <p className='mt-2 text-sm text-primary flex flex-wrap items-center gap-1'>
                      <GripVertical className='h-4 w-4 inline' /> {t('editNodesDialog.dragHint')}
                      <Settings2 className='h-4 w-4 inline' /> {t('editNodesDialog.switchGroupType')}
                    </p>
                  </div>
                  {/* 快捷拖放区 */}
                  <div className='flex gap-2 mr-9'>
                    <DroppableRemoveFromAllZone />
                    <DroppableAllGroupsZone />
                  </div>
                </div>
              </DialogHeader>

              <div className='flex-1 flex flex-col py-4 min-h-0'>
                {/* 列数选择(总列数,含右侧"可用节点"面板) */}
                <div className='flex items-center justify-end gap-1 mb-2 flex-shrink-0'>
                  <span className='text-xs text-muted-foreground mr-1'>{t('editNodesDialog.columns')}</span>
                  {Array.from({ length: maxColumns - 1 }, (_, i) => i + 2).map((n) => (
                    <Button
                      key={n}
                      variant={effectiveColumns === n ? 'default' : 'ghost'}
                      size='icon'
                      className='h-6 w-6 text-xs'
                      onClick={() => handleColumnsChange(n)}
                    >
                      {n}
                    </Button>
                  ))}
                </div>

                <div className='flex-1 flex gap-4 min-h-0'>
                {/* 左侧:代理组 */}
                <div ref={scrollContainerRef} className='flex-1 overflow-y-auto pr-2'>
                  <SortableContext items={proxyGroups.map((g) => g.name)} strategy={rectSortingStrategy}>
                    <div
                      className='grid gap-4 pt-1'
                      style={{ gridTemplateColumns: `repeat(${proxyGroupColumns}, 1fr)` }}
                    >
                      {proxyGroups.map((group) => (
                        <SortableCard
                          key={group.name}
                          group={group}
                          isEditing={editingGroupName === group.name}
                          editingValue={editingGroupValue}
                          onEditingValueChange={setEditingGroupValue}
                          onSubmitEdit={submitEditingGroup}
                          onCancelEdit={cancelEditingGroup}
                          onStartEdit={startEditingGroup}
                          onGroupTypeChange={handleGroupTypeChange}
                          onRemoveGroup={wrappedRemoveGroup}
                          onRemoveNodeFromGroup={wrappedRemoveNodeFromGroup}
                          onRemoveUseItem={handleRemoveUseItem}
                          mmwProviderNames={mmwProviderNames}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </div>

                {/* 分割线 */}
                <div className='w-1 bg-border flex-shrink-0'></div>

                {/* 右侧:可用节点 */}
                <div className='w-64 flex-shrink-0 flex flex-col'>
                  {/* 操作按钮 */}
                  <div className='flex-shrink-0 mb-4'>
                    <div className='flex gap-2'>
                      <Button variant='outline' onClick={() => setAddGroupDialogOpen(true)} className='flex-1'>
                        <Plus className='h-4 w-4 mr-1' />
                        {t('editNodesDialog.addProxyGroup')}
                      </Button>
                      <Button onClick={onSave} disabled={isSaving} className='flex-1'>
                        {isSaving ? t('editNodesDialog.saving') : saveButtonText}
                      </Button>
                    </div>
                  </div>

                  {/* 隐藏/显示已添加节点按钮 */}
                  {showAllNodes !== undefined && onShowAllNodesChange && (
                    <div className='flex-shrink-0 mb-4'>
                      <Button
                        variant='outline'
                        className='w-full relative'
                        onClick={() => onShowAllNodesChange(!showAllNodes)}
                      >
                        {showAllNodes ? <Eye className='h-4 w-4 mr-2' /> : <EyeOff className='h-4 w-4 mr-2' />}
                        {showAllNodes ? t('editNodesDialog.showAddedNodes') : t('editNodesDialog.hideAddedNodes')}
                        {!showAllNodes && (
                          <span className='absolute -top-1 -right-1 h-4 w-4 bg-green-500 rounded-full flex items-center justify-center'>
                            <Check className='h-3 w-3 text-white' />
                          </span>
                        )}
                      </Button>
                    </div>
                  )}

                  {/* 配置链式代理按钮 */}
                  {onConfigureChainProxy && (
                    <div className='flex-shrink-0 mb-4'>
                      <Button variant='outline' className='w-full' onClick={onConfigureChainProxy}>
                        {t('editNodesDialog.configChainProxy')}
                      </Button>
                    </div>
                  )}

                  {/* 筛选控件 */}
                  <div className='flex-shrink-0 mb-4 flex gap-2 items-center'>
                    <div className='relative flex-1'>
                      <Search className='absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground' />
                      <Input
                        placeholder={t('editNodesDialog.filterByName')}
                        value={nodeNameFilter}
                        onChange={(e) => setNodeNameFilter(e.target.value)}
                        className='pl-8 h-9 text-sm'
                      />
                    </div>

                    {(uniqueTags.length > 0 || showSpecialNodesAtBottom || proxyProviderConfigs.length > 0) && (
                      <Select value={nodeTagFilter} onValueChange={setNodeTagFilter}>
                        <SelectTrigger className='h-9 text-sm w-[120px]'>
                          <SelectValue placeholder={t('editNodesDialog.allTags')} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value='all'>{t('editNodesDialog.all')}</SelectItem>
                          {uniqueTags.map((tag) => (
                            <SelectItem key={tag} value={tag}>
                              {tag}
                            </SelectItem>
                          ))}
                          {showSpecialNodesAtBottom && (
                            <SelectItem value='__special__'>{t('editNodesDialog.specialNodes')}</SelectItem>
                          )}
                          {proxyProviderConfigs.length > 0 && (
                            <SelectItem value='__provider__'>{t('editNodesDialog.proxyProviders')}</SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                    )}
                  </div>

                  {/* 可用节点卡片 */}
                  <DroppableAvailableZone>
                    <CardHeader className='pb-3 flex-shrink-0'>
                      <DraggableAvailableHeader
                        filteredNodes={filteredAvailableNodes}
                        totalNodes={availableNodes.length}
                      />
                    </CardHeader>
                    <CardContent
                      ref={availableNodesScrollRef}
                      className='flex-1 overflow-y-auto space-y-1 min-h-0'
                    >
                      {/* 普通节点 — 仅在非特殊筛选时显示 */}
                      {nodeTagFilter !== '__special__' &&
                        nodeTagFilter !== '__provider__' &&
                        filteredAvailableNodes.map((proxy, idx) => (
                          <DraggableAvailableNode key={`available-${proxy}-${idx}`} proxy={proxy} index={idx} />
                        ))}

                      {/* 代理集合区块 */}
                      {proxyProviderConfigs.length > 0 &&
                        (nodeTagFilter === 'all' || nodeTagFilter === '__provider__') && (
                          <>
                            {nodeTagFilter === 'all' && (
                              <div className='pt-3 pb-1 border-t mt-3'>
                                <span className='text-xs text-purple-600 dark:text-purple-400 font-medium'>
                                  📦 {t('editNodesDialog.proxyProviders')}
                                </span>
                              </div>
                            )}
                            {proxyProviderConfigs.map((config) => (
                              <DraggableProxyProvider key={`provider-${config.id}`} name={config.name} />
                            ))}
                          </>
                        )}

                      {/* 特殊节点区块 */}
                      {showSpecialNodesAtBottom && (nodeTagFilter === 'all' || nodeTagFilter === '__special__') && (
                        <>
                          {nodeTagFilter === 'all' && (
                            <div className='pt-3 pb-1 border-t mt-3'>
                              <span className='text-xs text-muted-foreground font-medium'>
                                {t('editNodesDialog.specialNodes')}
                              </span>
                            </div>
                          )}
                          {SPECIAL_NODES.map((node, idx) => (
                            <DraggableAvailableNode
                              key={`special-${node}-${idx}`}
                              proxy={node}
                              index={availableNodes.length + idx}
                            />
                          ))}
                        </>
                      )}
                    </CardContent>
                  </DroppableAvailableZone>
                </div>
                </div>
              </div>

              {/* DragOverlay */}
              <DragOverlay dropAnimation={null} style={{ cursor: 'grabbing' }}>
                {activeDragItem?.data.type === 'available-node' && (
                  <div className='flex items-center gap-2 p-2 rounded border bg-background shadow-2xl pointer-events-none'>
                    <GripVertical className='h-4 w-4 text-muted-foreground flex-shrink-0' />
                    <span className='text-sm truncate'>
                      <Twemoji>{activeDragItem.data.nodeName}</Twemoji>
                    </span>
                  </div>
                )}
                {activeDragItem?.data.type === 'available-header' && (
                  <div className='flex items-center gap-2 p-2 rounded border bg-background shadow-2xl pointer-events-none'>
                    <GripVertical className='h-4 w-4 text-muted-foreground flex-shrink-0' />
                    <span className='text-sm'>
                      {t('label.batchAdd', { count: activeDragItem.data.nodeNames?.length || 0 })}
                    </span>
                  </div>
                )}
                {activeDragItem?.data.type === 'group-node' && (
                  <div className='flex items-center gap-2 p-2 rounded border bg-background shadow-2xl pointer-events-none'>
                    <GripVertical className='h-4 w-4 text-muted-foreground flex-shrink-0' />
                    <span className='text-sm truncate'>
                      <Twemoji>{activeDragItem.data.nodeName}</Twemoji>
                    </span>
                  </div>
                )}
                {activeDragItem?.data.type === 'group-title' && (
                  <div className='flex items-center gap-2 p-2 rounded border bg-background shadow-2xl pointer-events-none'>
                    <GripVertical className='h-4 w-4 text-muted-foreground flex-shrink-0' />
                    <span className='text-sm truncate'>
                      <Twemoji>{activeDragItem.data.groupName}</Twemoji>
                    </span>
                  </div>
                )}
                {activeDragItem?.data.type === 'proxy-provider' && (
                  <div className='flex items-center gap-2 p-2 rounded border border-purple-400 bg-purple-50 dark:bg-purple-950/50 shadow-2xl pointer-events-none'>
                    <GripVertical className='h-4 w-4 text-purple-500 flex-shrink-0' />
                    <span className='text-sm truncate text-purple-700 dark:text-purple-300'>
                      📦 {activeDragItem.data.providerName}
                    </span>
                  </div>
                )}
                {activeDragItem?.data.type === 'use-item' && (
                  <div className='flex items-center gap-2 p-2 rounded border border-purple-400 bg-purple-50 dark:bg-purple-950/50 shadow-2xl pointer-events-none'>
                    <GripVertical className='h-4 w-4 text-purple-500 flex-shrink-0' />
                    <span className='text-sm truncate text-purple-700 dark:text-purple-300'>
                      📦 {activeDragItem.data.providerName}
                    </span>
                  </div>
                )}
                {activeDragItem?.data.type === 'group-card' &&
                  (() => {
                    const group = proxyGroups.find((g) => g.name === activeDragItem.data.groupName)
                    return (
                      <Card className='w-[240px] shadow-2xl opacity-95 pointer-events-none max-h-[400px] overflow-hidden'>
                        <CardHeader className='pb-3'>
                          <div className='flex justify-center -mt-2 mb-2'>
                            <div className='bg-accent rounded-md px-3 py-1'>
                              <GripVertical className='h-4 w-4 text-foreground' />
                            </div>
                          </div>
                          <div className='flex items-start justify-between gap-2'>
                            <div className='flex-1 min-w-0'>
                              <CardTitle className='text-base truncate'>
                                <Twemoji>{activeDragItem.data.groupName}</Twemoji>
                              </CardTitle>
                              <CardDescription className='text-xs'>
                                {group?.type || 'select'} (
                                {t('editNodesDialog.nodeCountOnly', { count: group?.proxies.length || 0 })})
                              </CardDescription>
                            </div>
                          </div>
                        </CardHeader>
                        <CardContent className='space-y-1 max-h-[280px] overflow-hidden'>
                          {group?.proxies.slice(0, 8).map((proxy, idx) => (
                            <div
                              key={`overlay-${proxy}-${idx}`}
                              className='flex items-center gap-2 p-2 rounded border bg-background'
                            >
                              <GripVertical className='h-4 w-4 text-muted-foreground flex-shrink-0' />
                              <span className='text-sm truncate flex-1'>
                                <Twemoji>{proxy}</Twemoji>
                              </span>
                            </div>
                          ))}
                          {(group?.proxies.length || 0) > 8 && (
                            <div className='text-xs text-center text-muted-foreground py-1'>
                              {t('label.moreNodes', { count: (group?.proxies.length || 0) - 8 })}
                            </div>
                          )}
                          {(group?.proxies.length || 0) === 0 && (
                            <div className='text-sm text-center py-4 text-muted-foreground'>{t('label.noNodes')}</div>
                          )}
                        </CardContent>
                      </Card>
                    )
                  })()}
              </DragOverlay>
            </DragStateContext.Provider>
          </DndContext>
        </DialogContent>
      </Dialog>

      {/* 添加代理组对话框 */}
      <Dialog
        open={addGroupDialogOpen}
        onOpenChange={(o) => {
          setAddGroupDialogOpen(o)
          if (!o) {
            setSelectedEmoji('')
            setNewGroupName('')
          }
        }}
      >
        <DialogContent className='max-w-2xl'>
          <DialogHeader>
            <DialogTitle>{t('editNodesDialog.addGroupDialog.title')}</DialogTitle>
            <DialogDescription>{t('editNodesDialog.addGroupDialog.description')}</DialogDescription>
          </DialogHeader>

          <div className='space-y-4'>
            <div>
              <div className='flex items-center gap-2'>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant='outline' size='icon' className='shrink-0 h-10 w-10'>
                      {selectedEmoji ? (
                        <Twemoji className='text-base'>{selectedEmoji}</Twemoji>
                      ) : (
                        <Smile className='h-4 w-4 text-muted-foreground' />
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className='w-72 p-2' align='start'>
                    <div className='grid grid-cols-6 gap-1'>
                      {allServiceEmojis.map(({ emoji, label }) => (
                        <Button
                          key={emoji}
                          variant={selectedEmoji === emoji ? 'secondary' : 'ghost'}
                          size='sm'
                          className='h-9 w-9 p-0'
                          title={label}
                          onClick={() => setSelectedEmoji(emoji)}
                        >
                          <Twemoji className='text-lg'>{emoji}</Twemoji>
                        </Button>
                      ))}
                    </div>
                    {selectedEmoji && (
                      <Button
                        variant='ghost'
                        size='sm'
                        className='w-full mt-2 text-muted-foreground'
                        onClick={() => setSelectedEmoji('')}
                      >
                        {t('editNodesDialog.addGroupDialog.clearSelection')}
                      </Button>
                    )}
                  </PopoverContent>
                </Popover>
                <Input
                  placeholder={t('editNodesDialog.addGroupDialog.namePlaceholder')}
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !isGroupNameDuplicate && finalGroupName) handleAddGroup()
                  }}
                  className={`flex-1 ${isGroupNameDuplicate ? 'border-destructive' : ''}`}
                />
              </div>
              {isGroupNameDuplicate && (
                <p className='text-sm text-destructive mt-1'>{t('editNodesDialog.addGroupDialog.duplicateName')}</p>
              )}
            </div>

            <div>
              <p className='text-sm text-muted-foreground mb-2'>
                {t('editNodesDialog.addGroupDialog.quickSelect')}
              </p>
              <div className='grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2'>
                {proxyGroupCategories.map((category) => {
                  const groupLabel = category.group_label
                  const isDuplicate = proxyGroups.some((g) => g.name === groupLabel)
                  return (
                    <Button
                      key={category.name}
                      variant='outline'
                      size='sm'
                      className={`justify-start text-left h-auto py-2 px-3 ${isDuplicate ? 'opacity-50' : ''}`}
                      onClick={() => handleQuickSelect(groupLabel)}
                      disabled={isDuplicate}
                    >
                      <Twemoji className='truncate'>{groupLabel}</Twemoji>
                    </Button>
                  )
                })}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant='outline' onClick={() => setAddGroupDialogOpen(false)}>
              {t('actions.cancel', { ns: 'common' })}
            </Button>
            <Button onClick={handleAddGroup} disabled={!finalGroupName || isGroupNameDuplicate}>
              {t('actions.save', { ns: 'common' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
