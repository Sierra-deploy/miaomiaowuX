import React, { memo, useContext } from 'react'
import { GripVertical, X } from 'lucide-react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Twemoji } from '@/components/twemoji'
import { Button } from '@/components/ui/button'
import { DragStateContext } from './drag-state-context'
import type { DragItemData } from './types'

interface SortableProxyProps {
  proxy: string
  groupName: string
  index: number
  isMmwProvider: boolean
  onRemove: (groupName: string, index: number) => void
}

// 代理组卡片内的"普通节点项":可拖动 + 可排序。如果该 proxy 实际上是 MMW 模式的代理集合名,
// 走紫色样式,行为上和 SortableUseItem 一致(但 dnd data.type 仍是 use-item 以确保 drop 逻辑统一)。
export const SortableProxy = memo(function SortableProxy({
  proxy,
  groupName,
  index,
  isMmwProvider,
  onRemove,
}: SortableProxyProps) {
  const { isActiveDragging } = useContext(DragStateContext)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } = useSortable({
    id: `${groupName}-${proxy}`,
    transition: {
      duration: 150,
      easing: 'ease-out',
    },
    data: {
      type: isMmwProvider ? 'use-item' : 'group-node',
      groupName,
      nodeName: proxy,
      providerName: isMmwProvider ? proxy : undefined,
      index,
    } as DragItemData,
  })

  // 拖拽中 + 当前项被悬停 + 当前项不是正在拖拽的项 → 显示插入指示器
  const showDropIndicator = isActiveDragging && isOver && !isDragging

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition || 'transform 150ms ease-out',
    opacity: isDragging ? 0.5 : 1,
    touchAction: 'none',
    pointerEvents: isActiveDragging && !isDragging ? 'none' : 'auto',
  }

  // MMW 代理集合使用紫色样式
  if (isMmwProvider) {
    return (
      <div className='relative' style={{ pointerEvents: isActiveDragging && !isDragging ? 'none' : 'auto' }}>
        {showDropIndicator && <div className='absolute -top-0.5 left-0 right-0 h-1 bg-blue-500 rounded-full z-10' />}
        <div
          ref={setNodeRef}
          style={style}
          {...attributes}
          {...listeners}
          className={`flex items-center gap-2 p-2 rounded border border-purple-300 dark:border-purple-700 bg-purple-50 dark:bg-purple-950/20 cursor-move ${
            showDropIndicator ? 'border-blue-400 bg-blue-100 dark:bg-blue-950/30' : ''
          } ${isDragging ? 'shadow-lg' : ''}`}
          data-use-item
        >
          <GripVertical className='h-4 w-4 text-purple-500 flex-shrink-0' />
          <span className='text-sm truncate flex-1 text-purple-700 dark:text-purple-300'>📦 {proxy}</span>
          <Button
            variant='ghost'
            size='sm'
            className='h-6 w-6 p-0 flex-shrink-0'
            onPointerDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onRemove(groupName, index)
            }}
          >
            <X className='h-4 w-4 text-purple-400 hover:text-destructive' />
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className='relative' style={{ pointerEvents: isActiveDragging && !isDragging ? 'none' : 'auto' }}>
      {showDropIndicator && <div className='absolute -top-0.5 left-0 right-0 h-1 bg-blue-500 rounded-full z-10' />}
      <div
        ref={setNodeRef}
        style={style}
        {...attributes}
        {...listeners}
        className={`flex items-center gap-2 p-2 rounded border hover:border-border hover:bg-accent group/item cursor-move ${
          showDropIndicator ? 'border-blue-400 bg-blue-50 dark:bg-blue-950/30' : ''
        }`}
        data-proxy-item
      >
        <GripVertical className='h-4 w-4 text-muted-foreground flex-shrink-0' />
        <span className='text-sm truncate flex-1'>
          <Twemoji>{proxy}</Twemoji>
        </span>
        <Button
          variant='ghost'
          size='sm'
          className='h-6 w-6 p-0 flex-shrink-0'
          onPointerDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onRemove(groupName, index)
          }}
        >
          <X className='h-4 w-4 text-muted-foreground hover:text-destructive' />
        </Button>
      </div>
    </div>
  )
})
