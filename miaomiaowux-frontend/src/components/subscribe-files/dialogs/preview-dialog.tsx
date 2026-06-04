import { useTranslation } from 'react-i18next'
import { RefreshCw, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'

interface PreviewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  // 配置名(用于标题)、内容、loading 都由父组件提供 — 这个对话框只负责显示
  configName: string
  content: string
  loading: boolean
}

// 代理集合配置 raw YAML 预览对话框(MMW 模式专用)。
// 从 routes/subscribe-files.index.tsx L6168 提取,行为完全一致 — 只是物理位置移动 + 复制按钮换用 useCopyToClipboard hook。
export function PreviewDialog({ open, onOpenChange, configName, content, loading }: PreviewDialogProps) {
  const { t } = useTranslation('subscribe')
  const copy = useCopyToClipboard()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[80vh] max-w-3xl'>
        <DialogHeader>
          <DialogTitle>{t('proxyProvider.previewTitle', { name: configName })}</DialogTitle>
          <DialogDescription>{t('proxyProvider.previewDesc')}</DialogDescription>
        </DialogHeader>

        <div className='relative'>
          {loading ? (
            <div className='flex items-center justify-center py-8'>
              <RefreshCw className='text-muted-foreground h-6 w-6 animate-spin' />
              <span className='text-muted-foreground ml-2'>{t('actions.loading', { ns: 'common' })}</span>
            </div>
          ) : (
            <ScrollArea className='h-[50vh] rounded-md border'>
              <pre className='p-4 font-mono text-xs break-all whitespace-pre-wrap'>{content}</pre>
            </ScrollArea>
          )}
        </div>

        <DialogFooter className='flex-row gap-2 sm:justify-between'>
          <Button
            variant='outline'
            size='sm'
            onClick={() => copy(content, { success: t('proxyProvider.copiedToClipboard') })}
            disabled={loading || !content}
          >
            <Copy className='mr-2 h-4 w-4' />
            {t('actions.copy', { ns: 'common' })}
          </Button>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            {t('actions.close', { ns: 'common' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
