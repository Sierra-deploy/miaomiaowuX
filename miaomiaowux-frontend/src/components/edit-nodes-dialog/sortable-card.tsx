import React, { memo, useContext } from 'react'
import { useTranslation } from 'react-i18next'
import { GripVertical, X, Settings2 } from 'lucide-react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, rectSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { DragStateContext } from './drag-state-context'
import { DraggableGroupTitle } from './draggable-group-title'
import { ProxyTypeSelector } from './proxy-type-selector'
import { SortableProxy } from './sortable-proxy'
import { SortableUseItem } from './sortable-use-item'
import type { DragItemData, ProxyGroup } from './types'

interface SortableCardProps {
  group: ProxyGroup
  isEditing: boolean
  editingValue: string
  onEditingValueChange: (value: string) => void
  onSubmitEdit: () => void
  onCancelEdit: () => void
  onStartEdit: (groupName: string) => void
  onGroupTypeChange: (groupName: string, updatedGroup: ProxyGroup) => void
  onRemoveGroup: (groupName: string) => void
  onRemoveNodeFromGroup: (groupName: string, nodeIndex: number) => void
  onRemoveUseItem: (groupName: string, index: number) => void
  mmwProviderNames: Set<string>
}

// 主视图左侧每个代理组卡片:外层 useSortable(整卡片可排序) + 内层 useDroppable(接收节点放入)。
// 内部 SortableContext 把 proxies 和 use 合并到同一容器,解决"单个 use-item 无法拖动"的 bug。
export const SortableCard = memo(function SortableCard({
  group,
  isEditing,
  editingValue,
  onEditingValueChange,
  onSubmitEdit,
  onCancelEdit,
  onStartEdit,
  onGroupTypeChange,
  onRemoveGroup,
  onRemoveNodeFromGroup,
  onRemoveUseItem,
  mmwProviderNames,
}: SortableCardProps) {
  const { t } = useTranslation('nodes')
  const { isActiveDragging } = useContext(DragStateContext)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: group.name,
    data: {
      type: 'group-card',
      groupName: group.name,
    } as DragItemData,
    disabled: isEditing,
  })

  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `drop-${group.name}`,
    data: {
      type: 'proxy-group',
      groupName: group.name,
    },
  })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? 'none' : transition,
    opacity: isDragging ? 0.5 : 1,
    // 拖拽时禁用非拖拽卡片的指针事件,避免 hover 效果触发
    pointerEvents: isActiveDragging && !isDragging ? 'none' : 'auto',
  }

  return (
    <Card
      ref={(node) => {
        setNodeRef(node)
        setDropRef(node)
      }}
      style={style}
      className={`flex flex-col transition-all ${isOver ? 'ring-2 ring-primary shadow-lg scale-[1.02]' : ''}`}
    >
      <CardHeader className='pb-3'>
        {/* 顶部居中拖动按钮 */}
        <div
          className={`flex justify-center -mt-2 mb-2 ${isEditing ? 'cursor-not-allowed opacity-50' : 'cursor-move'}`}
          style={isEditing ? {} : { touchAction: 'none' }}
          {...(isEditing ? {} : attributes)}
          {...(isEditing ? {} : listeners)}
        >
          <div
            className={`group/drag-handle rounded-md px-3 py-1 transition-colors ${isEditing ? 'opacity-50' : ''} ${
              !isActiveDragging ? 'hover:bg-accent' : ''
            }`}
          >
            <GripVertical
              className={`h-4 w-4 text-muted-foreground transition-colors ${
                !isActiveDragging ? 'group-hover/drag-handle:text-foreground' : ''
              }`}
            />
          </div>
        </div>

        <div className='flex items-start justify-between gap-2'>
          <div className='flex-1 min-w-0'>
            <DraggableGroupTitle
              groupName={group.name}
              isEditing={isEditing}
              editingValue={editingValue}
              onEditingValueChange={onEditingValueChange}
              onSubmitEdit={onSubmitEdit}
              onCancelEdit={onCancelEdit}
              onStartEdit={onStartEdit}
            />
            <CardDescription className='text-xs'>
              {group.type} (
              {(group.use || []).length > 0
                ? t('editNodesDialog.nodesAndCollections', {
                    nodeCount: (group.proxies || []).length,
                    collectionCount: (group.use || []).length,
                  })
                : t('editNodesDialog.nodeCountOnly', { count: (group.proxies || []).length })}
              )
            </CardDescription>
          </div>
          {!isEditing && (
            <div className='flex items-center gap-1'>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant='ghost'
                    size='sm'
                    className='h-8 w-8 p-0 flex-shrink-0'
                    title={t('editNodesDialog.switchGroupTypeBtn')}
                  >
                    <Settings2 className='h-4 w-4 text-muted-foreground hover:text-foreground' />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className='w-48 p-2' align='end'>
                  <ProxyTypeSelector
                    group={group}
                    onChange={(updatedGroup) => onGroupTypeChange(group.name, updatedGroup)}
                  />
                </PopoverContent>
              </Popover>
              <Button
                variant='ghost'
                size='sm'
                className='h-8 w-8 p-0 flex-shrink-0'
                onClick={(e) => {
                  e.stopPropagation()
                  onRemoveGroup(group.name)
                }}
              >
                <X className='h-4 w-4 text-muted-foreground hover:text-destructive' />
              </Button>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className='flex-1 space-y-1 min-h-[200px]' data-card-content>
        {/* 合并 proxies 和 use 到同一个 SortableContext,解决单个 use-item 无法拖动的问题 */}
        <SortableContext
          items={[
            ...(group.proxies || []).filter((p) => p).map((p) => `${group.name}-${p}`),
            ...(group.use || []).map((providerName) => `use-${group.name}-${providerName}`),
          ]}
          strategy={rectSortingStrategy}
        >
          {/* 普通节点 */}
          {(group.proxies || []).map(
            (proxy, idx) =>
              proxy && (
                <SortableProxy
                  key={`${group.name}-${proxy}-${idx}`}
                  proxy={proxy}
                  groupName={group.name}
                  index={idx}
                  isMmwProvider={mmwProviderNames.has(proxy)}
                  onRemove={onRemoveNodeFromGroup}
                />
              ),
          )}

          {/* 代理集合 (use) 显示 */}
          {(group.use || []).map((providerName, idx) => (
            <SortableUseItem
              key={`use-${group.name}-${providerName}`}
              providerName={providerName}
              groupName={group.name}
              index={idx}
              onRemove={() => onRemoveUseItem(group.name, idx)}
            />
          ))}
        </SortableContext>

        {(group.proxies || []).filter((p) => p).length === 0 && (group.use || []).length === 0 && (
          <div
            className={`text-sm text-center py-8 transition-colors ${
              isOver ? 'text-primary font-medium' : 'text-muted-foreground'
            }`}
          >
            {t('editNodesDialog.dragNodeHere')}
          </div>
        )}
      </CardContent>
    </Card>
  )
})
