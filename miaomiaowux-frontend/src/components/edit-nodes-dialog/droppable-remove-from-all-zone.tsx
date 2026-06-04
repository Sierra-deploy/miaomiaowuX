import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { useDroppable } from '@dnd-kit/core'

// 快捷拖放区:把节点拖到这里 → 从所有代理组里移除该节点
export const DroppableRemoveFromAllZone = memo(function DroppableRemoveFromAllZone() {
  const { t } = useTranslation('nodes')
  const { setNodeRef, isOver } = useDroppable({
    id: 'remove-from-all-zone',
    data: { type: 'remove-from-all-zone' },
  })

  return (
    <div
      ref={setNodeRef}
      className={`w-40 h-20 border-2 rounded-lg flex items-center justify-center text-sm transition-all ${
        isOver ? 'border-destructive bg-destructive/10 border-solid' : 'border-dashed border-muted-foreground/30 bg-muted/20'
      }`}
    >
      <span className={isOver ? 'text-destructive font-medium' : 'text-muted-foreground'}>
        {t('editNodesDialog.removeFromAllGroups')}
      </span>
    </div>
  )
})
