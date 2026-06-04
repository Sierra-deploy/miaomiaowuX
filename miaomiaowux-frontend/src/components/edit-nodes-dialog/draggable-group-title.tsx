import React, { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { GripVertical, Check } from 'lucide-react'
import { useDraggable } from '@dnd-kit/core'
import { Twemoji } from '@/components/twemoji'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { CardTitle } from '@/components/ui/card'
import type { DragItemData } from './types'

interface DraggableGroupTitleProps {
  groupName: string
  isEditing: boolean
  editingValue: string
  onEditingValueChange: (value: string) => void
  onSubmitEdit: () => void
  onCancelEdit: () => void
  onStartEdit: (groupName: string) => void
}

// 可拖动的代理组标题。拖到其他代理组 → 把整个代理组作为节点添加进去(支持嵌套引用)
export const DraggableGroupTitle = memo(function DraggableGroupTitle({
  groupName,
  isEditing,
  editingValue,
  onEditingValueChange,
  onSubmitEdit,
  onCancelEdit,
  onStartEdit,
}: DraggableGroupTitleProps) {
  const { t } = useTranslation('nodes')
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `group-title-${groupName}`,
    data: {
      type: 'group-title',
      groupName,
    } as DragItemData,
  })

  const style: React.CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div ref={setNodeRef} style={style} className='flex items-center gap-2 group/title'>
      <div {...attributes} {...listeners} className='cursor-move' style={{ touchAction: 'none' }}>
        <GripVertical className='h-3 w-3 text-muted-foreground flex-shrink-0' />
      </div>
      {isEditing ? (
        <div className='flex items-center gap-1 flex-1 min-w-0'>
          <Input
            value={editingValue}
            onChange={(e) => onEditingValueChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSubmitEdit()
              else if (e.key === 'Escape') onCancelEdit()
            }}
            className='h-6 text-base flex-1 min-w-0'
            placeholder={t('editNodesDialog.editNamePlaceholder')}
            autoFocus
          />
          <Button size='sm' className='h-6 w-6 p-0' onClick={onSubmitEdit} variant='ghost'>
            <Check className='h-3 w-3 text-green-600' />
          </Button>
        </div>
      ) : (
        <CardTitle
          className='text-base truncate cursor-text hover:text-foreground/80 flex-1 min-w-0'
          onClick={() => onStartEdit(groupName)}
          title={t('editNodesDialog.clickToEditName')}
        >
          <Twemoji>{groupName}</Twemoji>
        </CardTitle>
      )}
    </div>
  )
})
