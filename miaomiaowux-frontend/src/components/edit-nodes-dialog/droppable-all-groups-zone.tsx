import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { useDroppable } from '@dnd-kit/core'

// 快捷拖放区:把节点拖到这里 → 添加到所有代理组
export const DroppableAllGroupsZone = memo(function DroppableAllGroupsZone() {
  const { t } = useTranslation('nodes')
  const { setNodeRef, isOver } = useDroppable({
    id: 'all-groups-zone',
    data: { type: 'all-groups-zone' },
  })

  return (
    <div
      ref={setNodeRef}
      className={`w-40 h-20 border-2 rounded-lg flex items-center justify-center text-sm transition-all ${
        isOver ? 'border-primary bg-primary/10 border-solid' : 'border-dashed border-muted-foreground/30 bg-muted/20'
      }`}
    >
      <span className={isOver ? 'text-primary font-medium' : 'text-muted-foreground'}>
        {t('editNodesDialog.addToAllGroups')}
      </span>
    </div>
  )
})
