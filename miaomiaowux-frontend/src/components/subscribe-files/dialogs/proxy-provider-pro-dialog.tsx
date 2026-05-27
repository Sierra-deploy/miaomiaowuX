import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'

export interface ExternalSubRef {
  id: number
  name: string
}

export interface ProviderCreationResult {
  name: string
  success: boolean
  error?: string
}

interface ProxyProviderProDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  // 选项 + 候选
  externalSubs: ExternalSubRef[]
  selectedExternalSub: ExternalSubRef | null
  onSelectedExternalSubChange: (sub: ExternalSubRef | null) => void
  // 名称前缀
  namePrefix: string
  onNamePrefixChange: (value: string) => void
  // 根据 IP 位置分组开关
  enableGeoIPMatching: boolean
  onEnableGeoIPMatchingChange: (value: boolean) => void
  // 批量创建动作 + 进行中标志
  onBatchCreateByRegion: () => void
  onBatchCreateByProtocol: () => void
  creatingRegion: boolean
  creatingProtocol: boolean
  // 上次创建结果(成功/失败列表)
  creationResults: ProviderCreationResult[]
}

// "代理集合 Pro / 基础"对话框:从某个外部订阅按地区或按协议批量创建代理集合。
// 从 routes/subscribe-files.index.tsx L5679 提取,所有 mutation / state 仍由父端持有。
export function ProxyProviderProDialog({
  open,
  onOpenChange,
  externalSubs,
  selectedExternalSub,
  onSelectedExternalSubChange,
  namePrefix,
  onNamePrefixChange,
  enableGeoIPMatching,
  onEnableGeoIPMatchingChange,
  onBatchCreateByRegion,
  onBatchCreateByProtocol,
  creatingRegion,
  creatingProtocol,
  creationResults,
}: ProxyProviderProDialogProps) {
  const { t } = useTranslation('subscribe')
  const disabled = !selectedExternalSub || !namePrefix.trim() || creatingRegion || creatingProtocol

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-md'>
        <DialogHeader>
          <DialogTitle>{t('proxyProvider.basicDialog.title')}</DialogTitle>
          <DialogDescription>{t('proxyProvider.basicDialog.description')}</DialogDescription>
        </DialogHeader>

        <div className='space-y-4'>
          {/* 选择外部订阅 */}
          <div className='space-y-2'>
            <Label>{t('proxyProvider.basicDialog.selectExternalSub')}</Label>
            <Select
              value={selectedExternalSub?.id?.toString() || ''}
              onValueChange={(v) => {
                const sub = externalSubs.find((s) => s.id === parseInt(v))
                onSelectedExternalSubChange(sub || null)
                onNamePrefixChange(sub?.name || '')
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder={t('proxyProvider.basicDialog.selectExternalSubPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {externalSubs.map((sub) => (
                  <SelectItem key={sub.id} value={sub.id.toString()}>
                    {sub.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* 名称前缀 */}
          <div className='space-y-2'>
            <Label>{t('proxyProvider.basicDialog.namePrefix')}</Label>
            <Input
              placeholder={t('proxyProvider.basicDialog.namePrefixPlaceholder')}
              value={namePrefix}
              onChange={(e) => onNamePrefixChange(e.target.value)}
            />
            <p className='text-muted-foreground text-xs'>{t('proxyProvider.basicDialog.namePrefixHint')}</p>
          </div>

          {/* 根据 IP 位置分组开关 */}
          <div className='flex items-center justify-between'>
            <div className='space-y-0.5'>
              <Label>{t('proxyProvider.basicDialog.groupByIp')}</Label>
              <p className='text-muted-foreground text-xs'>{t('proxyProvider.basicDialog.groupByIpHint')}</p>
            </div>
            <Switch checked={enableGeoIPMatching} onCheckedChange={onEnableGeoIPMatchingChange} />
          </div>

          {/* 分裂按钮 */}
          <div className='flex gap-2'>
            <Button className='flex-1' disabled={disabled} onClick={onBatchCreateByRegion}>
              {creatingRegion && <RefreshCw className='mr-2 h-4 w-4 animate-spin' />}
              {t('proxyProvider.basicDialog.splitByRegion')}
            </Button>
            <Button className='flex-1' variant='outline' disabled={disabled} onClick={onBatchCreateByProtocol}>
              {creatingProtocol && <RefreshCw className='mr-2 h-4 w-4 animate-spin' />}
              {t('proxyProvider.basicDialog.splitByProtocol')}
            </Button>
          </div>

          {/* 创建结果 */}
          {creationResults.length > 0 && (
            <div className='space-y-2'>
              <Label>
                {t('proxyProvider.basicDialog.creationResults')} (
                {creationResults.filter((r) => r.success).length}/{creationResults.length})
              </Label>
              <ScrollArea className='h-[200px] rounded-md border p-2'>
                {creationResults.map((result, idx) => (
                  <div key={idx} className='flex items-center gap-2 py-1 text-sm'>
                    {result.success ? (
                      <Badge variant='default' className='bg-green-500'>
                        {t('proxyProvider.basicDialog.success')}
                      </Badge>
                    ) : (
                      <Badge variant='destructive'>{t('proxyProvider.basicDialog.failed')}</Badge>
                    )}
                    <span className='flex-1 truncate'>{result.name}</span>
                    {result.error && <span className='text-destructive text-xs'>({result.error})</span>}
                  </div>
                ))}
              </ScrollArea>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            {t('actions.close', { ns: 'common' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
