import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Download, Upload, HardDrive, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { api, AUTH_HEADER } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface BackupDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function BackupDialog({ open, onOpenChange }: BackupDialogProps) {
  const { t } = useTranslation('common')
  const [backupFile, setBackupFile] = useState<File | null>(null)
  const [isDownloading, setIsDownloading] = useState(false)

  // Download backup
  const handleDownload = async () => {
    setIsDownloading(true)
    try {
      const response = await api.get('/api/admin/backup/download', {
        responseType: 'blob',
      })
      const url = window.URL.createObjectURL(new Blob([response.data]))
      const link = document.createElement('a')
      link.href = url
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      link.setAttribute('download', `miaomiaowux-backup-${timestamp}.zip`)
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.URL.revokeObjectURL(url)
      toast.success(t('backup.downloadSuccess'))
    } catch {
      toast.error(t('backup.downloadFailed'))
    } finally {
      setIsDownloading(false)
    }
  }

  // Restore backup — 用 fetch 直接调用,绕开 axios 1.x 对 FormData 的 transformRequest
  // (历史上 axios 在某些环境下会把 FormData 序列化错误,导致后端 r.FormFile 永远读不到分隔符,
  // UI 卡在"恢复中"。fetch 浏览器原生处理 multipart + boundary,稳。)
  const restoreMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData()
      formData.append('backup', file)
      const token = useAuthStore.getState().auth.accessToken
      const url = (api.defaults.baseURL ?? '') + '/api/admin/backup/restore'
      const res = await fetch(url, {
        method: 'POST',
        body: formData,
        headers: token ? { [AUTH_HEADER]: token } : {},
      })
      const text = await res.text()
      if (!res.ok) {
        let msg = text
        try {
          const j = JSON.parse(text)
          msg = j.error || j.message || text
        } catch {
          // raw text
        }
        throw new Error(msg || `HTTP ${res.status}`)
      }
      return text ? JSON.parse(text) : {}
    },
    onSuccess: () => {
      toast.success(t('backup.restoreSuccess'))
      setBackupFile(null)
      onOpenChange(false)
      setTimeout(() => {
        window.location.reload()
      }, 1500)
    },
    onError: (e: Error) => {
      toast.error(t('backup.restoreFailed'), { description: e.message })
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2'>
            <HardDrive className='size-5' /> {t('backup.title')}
          </DialogTitle>
          <DialogDescription>
            {t('backup.description')}
          </DialogDescription>
        </DialogHeader>

        <div className='space-y-6'>
          {/* Download backup */}
          <div className='space-y-2'>
            <Label>{t('backup.downloadLabel')}</Label>
            <Button
              onClick={handleDownload}
              disabled={isDownloading}
              className='w-full'
            >
              <Download className='size-4 mr-2' />
              {isDownloading ? t('backup.downloading') : t('backup.downloadButton')}
            </Button>
          </div>

          {/* Restore backup */}
          <div className='space-y-3'>
            <Label>{t('backup.restoreLabel')}</Label>
            <Input
              type='file'
              accept='.zip'
              onChange={(e) => setBackupFile(e.target.files?.[0] || null)}
              className='cursor-pointer'
            />
            <Button
              onClick={() => backupFile && restoreMutation.mutate(backupFile)}
              disabled={!backupFile || restoreMutation.isPending}
              variant='destructive'
              className='w-full'
            >
              <Upload className='size-4 mr-2' />
              {restoreMutation.isPending ? t('backup.restoring') : t('backup.restoreButton')}
            </Button>
            <div className='flex items-start gap-2 text-xs text-muted-foreground'>
              <AlertTriangle className='size-4 shrink-0 text-destructive' />
              <span>{t('backup.restoreWarning')}</span>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
