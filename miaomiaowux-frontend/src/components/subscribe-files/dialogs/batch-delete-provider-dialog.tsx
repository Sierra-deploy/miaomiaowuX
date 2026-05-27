import { useTranslation } from 'react-i18next'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

interface BatchDeleteProviderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  // 待删除的代理集合数量(显示在确认文案里)
  count: number
  // 确认删除回调,父端持有 mutation
  onConfirm: () => void
  deleting: boolean
}

// "批量删除代理集合"确认对话框。
// 从 routes/subscribe-files.index.tsx L4862 提取,行为 1:1。
export function BatchDeleteProviderDialog({ open, onOpenChange, count, onConfirm, deleting }: BatchDeleteProviderDialogProps) {
  const { t } = useTranslation('subscribe')
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('proxyProvider.batchDeleteConfirmTitle')}</AlertDialogTitle>
          <AlertDialogDescription>{t('proxyProvider.batchDeleteConfirmDesc', { count })}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('actions.cancel', { ns: 'common' })}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={deleting}>
            {deleting ? t('proxyProvider.deleting') : t('proxyProvider.confirmDelete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
