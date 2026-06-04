import React, { memo, useContext } from 'react'
import { GripVertical } from 'lucide-react'
import { useDraggable } from '@dnd-kit/core'
import { Twemoji } from '@/components/twemoji'
import { DragStateContext } from './drag-state-context'
import type { DragItemData } from './types'

interface DraggableAvailableNodeProps {
  proxy: string
  index: number
}

// 右侧"可用节点"列表里的一项。从这里拖到左侧任意代理组卡片即添加。
export const DraggableAvailableNode = memo(function DraggableAvailableNode({
  proxy,
  index,
}: DraggableAvailableNodeProps) {
  const { isActiveDragging } = useContext(DragStateContext)
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `available-node-${proxy}-${index}`,
    data: {
      type: 'available-node',
      nodeName: proxy,
      index,
    } as DragItemData,
  })

  const style: React.CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    opacity: isDragging ? 0.5 : 1,
    touchAction: 'none',
    // 拖拽时禁用非拖拽元素的指针事件,避免 hover 效果触发
    pointerEvents: isActiveDragging && !isDragging ? 'none' : 'auto',
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className='flex items-center gap-2 p-2 rounded border hover:border-border hover:bg-accent cursor-move transition-colors duration-75'
    >
      <GripVertical className='h-4 w-4 text-muted-foreground flex-shrink-0' />
      <span className='text-sm truncate flex-1'>
        <Twemoji>{proxy}</Twemoji>
      </span>
    </div>
  )
})
