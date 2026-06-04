import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'

interface FileRef {
  name: string
  filename: string
}

interface EditFileDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  // 当前编辑的文件元信息(只读)
  file: FileRef | null
  // YAML 编辑器内容 — 父端持有 state
  value: string
  onValueChange: (next: string) => void
  // dirty 标志(value 是否与原始内容不一致)由父端计算并下传,本组件只展示
  isDirty: boolean
  // 校验错误(YAML 解析失败等)
  validationError: string | null
  // 服务器返回的版本号(可选)
  latestVersion?: number | string | null
  // loading + saving 状态
  loading: boolean
  saving: boolean
  // 父端动作
  onSave: () => void
  onReset: () => void
}

// "编辑文件"对话框:订阅 YAML 文本编辑器 + 保存/撤销/版本号 Badge。
// 从 routes/subscribe-files.index.tsx L4762 提取,行为 1:1。
// 注:文件内容拉取(useQuery)、保存(useMutation)、isDirty 计算都由父端持有,
// 这个 dialog 只负责展示和触发回调。
export function EditFileDialog({
  open,
  onOpenChange,
  file,
  value,
  onValueChange,
  isDirty,
  validationError,
  latestVersion,
  loading,
  saving,
  onSave,
  onReset,
}: EditFileDialogProps) {
  const { t } = useTranslation('subscribe')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='flex h-[90vh] max-w-4xl flex-col p-0'>
        <DialogHeader className='px-6 pt-6'>
          <DialogTitle>{file?.name || t('editFile.title')}</DialogTitle>
          <DialogDescription>{t('editFile.editFilename', { filename: file?.filename })}</DialogDescription>
        </DialogHeader>

        <div className='flex flex-1 flex-col overflow-hidden px-6'>
          <div className='flex items-center gap-3 py-4'>
            <Button size='sm' onClick={onSave} disabled={!file || !isDirty || saving || loading}>
              {saving ? t('editFile.saving') : t('editFile.saveChanges')}
            </Button>
            <Button size='sm' variant='outline' disabled={!isDirty || loading || saving} onClick={onReset}>
              {t('editFile.revertChanges')}
            </Button>
            {latestVersion ? (
              <Badge variant='secondary'>{t('editFile.version', { version: latestVersion })}</Badge>
            ) : null}
          </div>

          {validationError ? (
            <div className='border-destructive/60 bg-destructive/10 text-destructive mb-4 rounded-md border p-3 text-sm'>
              {validationError}
            </div>
          ) : null}

          <div className='bg-muted/20 mb-4 flex-1 overflow-hidden rounded-lg border'>
            {loading ? (
              <div className='text-muted-foreground p-4 text-center'>{t('actions.loading', { ns: 'common' })}</div>
            ) : (
              <Textarea
                value={value}
                onChange={(e) => onValueChange(e.target.value)}
                className='h-full w-full resize-none border-0 bg-transparent font-mono text-sm focus-visible:ring-0 focus-visible:ring-offset-0'
                disabled={!file || saving}
                spellCheck={false}
              />
            )}
          </div>
        </div>

        <DialogFooter className='px-6 pb-6'>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            {t('actions.close', { ns: 'common' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
