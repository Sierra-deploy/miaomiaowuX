import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@/stores/auth-store'
import { ConfirmDialog } from '@/components/confirm-dialog'

interface SignOutDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SignOutDialog({ open, onOpenChange }: SignOutDialogProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { auth } = useAuthStore()
  const queryClient = useQueryClient()

  const handleSignOut = () => {
    auth.reset()
    // 全清缓存,防止换用户登录后还看到上一个用户的数据(典型是订阅链接 'user-subscriptions':
    // 之前只挨个 remove 几个 key,user-subscriptions 不在列表里 → 换号后新用户看到旧 URL,直到刷新)
    queryClient.clear()
    navigate({
      to: '/',
      replace: true,
    })
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('signOut.title')}
      desc={t('signOut.description')}
      confirmText={t('signOut.confirm')}
      cancelBtnText={t('signOut.cancel')}
      handleConfirm={handleSignOut}
      className='sm:max-w-sm'
    />
  )
}
