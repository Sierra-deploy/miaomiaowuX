// @ts-nocheck
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, Trash2, ArrowRight, Share2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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

type TunnelInfo = {
  server_id: number
  server_name: string
  is_federated: boolean
  tag: string
  listen_port: number
  target_address: string
  target_port: number
  network: string
}

export function TunnelManagerDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const { t } = useTranslation('xray')
  const queryClient = useQueryClient()
  const [pendingDelete, setPendingDelete] = useState<TunnelInfo | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['tunnels'],
    queryFn: async () => {
      const res = await api.get('/api/admin/tunnels')
      return (res.data.tunnels || []) as TunnelInfo[]
    },
    enabled: open,
  })
  const tunnels = data || []

  const deleteMutation = useMutation({
    mutationFn: async (tunnel: TunnelInfo) => {
      await api.post(
        `/api/admin/remote/inbounds?server_id=${tunnel.server_id}`,
        { action: 'remove', tag: tunnel.tag }
      )
    },
    onSuccess: () => {
      toast.success(t('tunnelManager.deleteSuccess'))
      queryClient.invalidateQueries({ queryKey: ['tunnels'] })
      queryClient.invalidateQueries({ queryKey: ['nodes'] })
      setPendingDelete(null)
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.error || t('tunnelManager.deleteFailed'))
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-2xl'>
        <DialogHeader>
          <DialogTitle>{t('tunnelManager.title')}</DialogTitle>
          <DialogDescription>{t('tunnelManager.desc')}</DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className='text-muted-foreground flex items-center justify-center gap-2 py-12 text-sm'>
            <Loader2 className='h-4 w-4 animate-spin' />
            {t('tunnelManager.loading')}
          </div>
        ) : tunnels.length === 0 ? (
          <div className='text-muted-foreground py-12 text-center text-sm'>
            {t('tunnelManager.empty')}
          </div>
        ) : (
          <div className='max-h-[60vh] space-y-2 overflow-auto'>
            {tunnels.map((tn) => (
              <div
                key={`${tn.server_id}-${tn.tag}`}
                className='flex items-center justify-between gap-3 rounded-lg border p-3'
              >
                <div className='min-w-0 flex-1 space-y-1'>
                  <div className='flex items-center gap-2'>
                    <Badge variant='secondary' className='font-mono text-xs'>
                      {tn.tag}
                    </Badge>
                    {tn.is_federated && (
                      <Badge variant='outline' className='gap-1 text-xs'>
                        <Share2 className='h-3 w-3' />
                        {t('tunnelManager.federated')}
                      </Badge>
                    )}
                  </div>
                  <div className='text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs'>
                    <span>{tn.server_name}</span>
                    <span className='font-mono'>:{tn.listen_port}</span>
                    <ArrowRight className='h-3 w-3' />
                    <span className='font-mono'>
                      {tn.target_address}:{tn.target_port}
                    </span>
                    {tn.network && (
                      <Badge variant='outline' className='text-[10px] uppercase'>
                        {tn.network}
                      </Badge>
                    )}
                  </div>
                </div>
                <Button
                  variant='ghost'
                  size='icon'
                  className='text-destructive shrink-0'
                  onClick={() => setPendingDelete(tn)}
                >
                  <Trash2 className='h-4 w-4' />
                </Button>
              </div>
            ))}
          </div>
        )}
      </DialogContent>

      <AlertDialog
        open={!!pendingDelete}
        onOpenChange={(v) => !v && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('tunnelManager.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete &&
                t('tunnelManager.deleteConfirm', { tag: pendingDelete.tag })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('tunnelManager.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className='bg-destructive text-destructive-foreground hover:bg-destructive/90'
              disabled={deleteMutation.isPending}
              onClick={() => pendingDelete && deleteMutation.mutate(pendingDelete)}
            >
              {deleteMutation.isPending && (
                <Loader2 className='mr-2 h-4 w-4 animate-spin' />
              )}
              {t('tunnelManager.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}
