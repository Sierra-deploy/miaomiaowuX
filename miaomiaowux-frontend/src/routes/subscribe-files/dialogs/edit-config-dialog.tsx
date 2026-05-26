import { useTranslation } from 'react-i18next'
import { Edit, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'

// 简化版的 SubscribeFile 引用,这里只用到 name / filename 两个字段。
// 完整定义在主文件 routes/subscribe-files.index.tsx,等 B1 后续会话把 types 也提出来时合并
interface FileRef {
  name: string
  filename: string
}

interface EditConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  // 当前被编辑的文件(用于 dialog 标题 + 关闭时 cleanup 时父端置 null)
  file: FileRef | null
  content: string
  onContentChange: (content: string) => void
  // 保存(父端持有 mutation,这里只触发)
  onSave: () => void
  saving: boolean
  // 跳转到"编辑节点"对话框 — 切到节点编辑工作流
  onEditNodes: (file: FileRef) => void
}

// "编辑配置"对话框:YAML 大文本编辑器 + 保存按钮 + "切去编辑节点"快捷入口。
// 从 routes/subscribe-files.index.tsx L5082 提取,逻辑 1:1。所有 state / mutation 仍由父组件持有。
export function EditConfigDialog({
  open,
  onOpenChange,
  file,
  content,
  onContentChange,
  onSave,
  saving,
  onEditNodes,
}: EditConfigDialogProps) {
  const { t } = useTranslation('subscribe')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='flex max-h-[90vh] w-[95vw] flex-col sm:w-[80vw] sm:!max-w-[80vw]'>
        <DialogHeader>
          <DialogTitle>{t('editConfig.title', { name: file?.name })}</DialogTitle>
          <DialogDescription>{file?.filename}</DialogDescription>
          <div className='flex justify-center gap-2 md:justify-end'>
            <Button
              variant='outline'
              size='sm'
              className='flex-1 md:flex-none'
              onClick={() => file && onEditNodes(file)}
            >
              <Edit className='mr-2 h-4 w-4' />
              {t('editConfig.editNodes')}
            </Button>
            <Button size='sm' className='flex-1 md:flex-none' onClick={onSave} disabled={saving}>
              <Save className='mr-2 h-4 w-4' />
              {saving ? t('editFile.saving') : t('actions.save', { ns: 'common' })}
            </Button>
          </div>
        </DialogHeader>
        <div className='flex-1 space-y-4 overflow-y-auto'>
          <div className='bg-muted/30 rounded-lg border'>
            <Textarea
              value={content}
              onChange={(e) => onContentChange(e.target.value)}
              className='min-h-[400px] resize-none border-0 bg-transparent font-mono text-xs'
              placeholder={t('editConfig.loadingConfig')}
            />
          </div>
          <div className='flex justify-end gap-2'>
            <Button onClick={onSave} disabled={saving}>
              <Save className='mr-2 h-4 max-w-md' />
              {saving ? t('editFile.saving') : t('actions.save', { ns: 'common' })}
            </Button>
          </div>
          <div className='bg-muted/50 rounded-lg border p-4'>
            <h3 className='mb-2 font-semibold'>{t('editConfig.usageTitle')}</h3>
            <ul className='text-muted-foreground space-y-1 text-sm'>
              <li>• {t('editConfig.usageStep1')}</li>
              <li>• {t('editConfig.usageStep2')}</li>
              <li>• {t('editConfig.usageStep3')}</li>
              <li>• {t('editConfig.usageStep4')}</li>
            </ul>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
