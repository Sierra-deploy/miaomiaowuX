import { memo } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { Card } from '@/components/ui/card'

interface DroppableAvailableZoneProps {
  children: React.ReactNode
}

// 可用节点区域容器:接收从代理组拖回的节点
export const DroppableAvailableZone = memo(function DroppableAvailableZone({ children }: DroppableAvailableZoneProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: 'available-zone',
    data: { type: 'available-zone' },
  })

  return (
    <Card
      ref={setNodeRef}
      className={`flex flex-col flex-1 transition-all duration-75 ${
        isOver ? 'ring-2 ring-primary shadow-lg scale-[1.02]' : ''
      }`}
    >
      {children}
    </Card>
  )
})
