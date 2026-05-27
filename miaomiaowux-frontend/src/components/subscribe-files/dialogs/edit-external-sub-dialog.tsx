import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export type ExternalSubTrafficMode = 'download' | 'upload' | 'both'

export interface ExternalSubFormData {
  url: string
  traffic_mode: ExternalSubTrafficMode
}

interface ExternalSubRef {
  id: number
  name: string
  user_agent?: string
}

interface EditExternalSubDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  // 当前编辑对象(用于 mutation 时取 id/name/user_agent)
  editing: ExternalSubRef | null
  // 表单值 + setter 全部受控于父端,与原 inline 写法一致
  form: ExternalSubFormData
  onFormChange: (next: ExternalSubFormData | ((prev: ExternalSubFormData) => ExternalSubFormData)) => void
  // 提交保存的回调,父端负责真正 mutation.mutate + 收尾(setOpen(false) / setEditing(null))
  onSubmit: (editing: ExternalSubRef, form: ExternalSubFormData) => void
  saving: boolean
}

// "编辑外部订阅"对话框:改 URL + 改流量统计模式。
// 从 routes/subscribe-files.index.tsx L6130 提取,行为 1:1。
export function EditExternalSubDialog({
  open,
  onOpenChange,
  editing,
  form,
  onFormChange,
  onSubmit,
  saving,
}: EditExternalSubDialogProps) {
  const { t } = useTranslation('subscribe')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('externalSub.editTitle')}</DialogTitle>
          <DialogDescription>{t('externalSub.editDescription')}</DialogDescription>
        </DialogHeader>
        <div className='space-y-4'>
          <div className='space-y-2'>
            <Label>{t('externalSub.addressLabel')}</Label>
            <Input
              value={form.url}
              onChange={(e) => onFormChange((prev) => ({ ...prev, url: e.target.value }))}
              placeholder='https://example.com/subscribe'
            />
          </div>
          <div className='space-y-2'>
            <Label>{t('externalSub.trafficStatsMode')}</Label>
            <Select
              value={form.traffic_mode}
              onValueChange={(value: ExternalSubTrafficMode) =>
                onFormChange((prev) => ({ ...prev, traffic_mode: value }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='both'>{t('externalSub.trafficStatsModeDownloadUpload')}</SelectItem>
                <SelectItem value='download'>{t('externalSub.trafficStatsModeDownload')}</SelectItem>
                <SelectItem value='upload'>{t('externalSub.trafficStatsModeUpload')}</SelectItem>
              </SelectContent>
            </Select>
            <p className='text-muted-foreground text-xs'>{t('externalSub.trafficStatsModeHint')}</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            {t('actions.cancel', { ns: 'common' })}
          </Button>
          <Button
            onClick={() => editing && onSubmit(editing, form)}
            disabled={saving || !form.url || !editing}
          >
            {t('actions.save', { ns: 'common' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
