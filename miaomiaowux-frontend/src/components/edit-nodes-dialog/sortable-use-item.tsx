import React, { memo, useContext } from 'react'
import { GripVertical, X } from 'lucide-react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Button } from '@/components/ui/button'
import { DragStateContext } from './drag-state-context'
import type { DragItemData } from './types'

interface SortableUseItemProps {
  providerName: string
  groupName: string
  index: number
  onRemove: () => void
}

// 代理组卡片内的"代理集合 (use 数组项)":紫色样式,可拖动 + 可排序。
export const SortableUseItem = memo(function SortableUseItem({
  providerName,
  groupName,
  index,
  onRemove,
}: SortableUseItemProps) {
  const { isActiveDragging } = useContext(DragStateContext)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } = useSortable({
    id: `use-${groupName}-${providerName}`,
    transition: {
      duration: 150,
      easing: 'ease-out',
    },
    data: {
      type: 'use-item',
      groupName,
      providerName,
      index,
    } as DragItemData,
  })

  const showDropIndicator = isActiveDragging && isOver && !isDragging

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition || 'transform 150ms ease-out',
    opacity: isDragging ? 0.5 : 1,
    touchAction: 'none',
    pointerEvents: isActiveDragging && !isDragging ? 'none' : 'auto',
  }

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
        <span className='text-sm truncate flex-1 text-purple-700 dark:text-purple-300'>📦 {providerName}</span>
        <Button
          variant='ghost'
          size='sm'
          className='h-6 w-6 p-0 flex-shrink-0'
          onPointerDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
        >
          <X className='h-4 w-4 text-purple-400 hover:text-destructive' />
        </Button>
      </div>
    </div>
  )
})
