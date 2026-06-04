import React, { memo } from 'react'
import { GripVertical } from 'lucide-react'
import { useDraggable } from '@dnd-kit/core'
import type { DragItemData } from './types'

interface DraggableProxyProviderProps {
  name: string
}

// 右侧"可用节点"列表下方的"代理集合 (proxy-provider)"项。拖到代理组 → 添加进 use 数组。
export const DraggableProxyProvider = memo(function DraggableProxyProvider({ name }: DraggableProxyProviderProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `proxy-provider-${name}`,
    data: {
      type: 'proxy-provider',
      providerName: name,
    } as DragItemData,
  })

  const style: React.CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    opacity: isDragging ? 0.5 : 1,
    touchAction: 'none',
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className='flex items-center gap-2 p-2 rounded border border-purple-200 dark:border-purple-800 hover:border-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/30 cursor-move transition-colors duration-75'
    >
      <GripVertical className='h-4 w-4 text-purple-500 flex-shrink-0' />
      <span className='text-sm truncate flex-1 text-purple-700 dark:text-purple-300'>📦 {name}</span>
    </div>
  )
})
