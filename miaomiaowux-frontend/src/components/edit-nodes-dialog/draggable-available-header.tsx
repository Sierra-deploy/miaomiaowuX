import React, { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { GripVertical } from 'lucide-react'
import { useDraggable } from '@dnd-kit/core'
import { CardTitle, CardDescription } from '@/components/ui/card'
import type { DragItemData } from './types'

interface DraggableAvailableHeaderProps {
  filteredNodes: string[]
  totalNodes: number
}

// "可用节点"卡片标题:也是可拖动的,拖到代理组 → 把当前筛选后的所有节点批量添加
export const DraggableAvailableHeader = memo(function DraggableAvailableHeader({
  filteredNodes,
  totalNodes,
}: DraggableAvailableHeaderProps) {
  const { t } = useTranslation('nodes')
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: 'available-header',
    data: {
      type: 'available-header',
      nodeNames: filteredNodes,
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
      className='flex items-center gap-2 cursor-move rounded-md px-2 py-1 hover:bg-accent transition-colors'
    >
      <GripVertical className='h-4 w-4 text-muted-foreground flex-shrink-0' />
      <div>
        <CardTitle className='text-base'>{t('editNodesDialog.availableNodes')}</CardTitle>
        <CardDescription className='text-xs'>
          {t('editNodesDialog.nodesCount', { filtered: filteredNodes.length, total: totalNodes })}
        </CardDescription>
      </div>
    </div>
  )
})
