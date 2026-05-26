import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { ProxyGroup } from './types'

interface ProxyTypeSelectorProps {
  group: ProxyGroup
  onChange: (updatedGroup: ProxyGroup) => void
}

// 代理组类型选择器:在 SortableCard 头部的 Popover 内使用
export const ProxyTypeSelector = memo(function ProxyTypeSelector({ group, onChange }: ProxyTypeSelectorProps) {
  const { t } = useTranslation('nodes')
  const types = [
    { value: 'select', label: t('editNodesDialog.proxyType.select'), hasUrl: false, hasStrategy: false },
    { value: 'url-test', label: t('editNodesDialog.proxyType.urlTest'), hasUrl: true, hasStrategy: false },
    { value: 'fallback', label: t('editNodesDialog.proxyType.fallback'), hasUrl: true, hasStrategy: false },
    { value: 'load-balance', label: t('editNodesDialog.proxyType.loadBalance'), hasUrl: true, hasStrategy: true },
  ]

  const handleTypeSelect = (type: string) => {
    const typeConfig = types.find((tt) => tt.value === type)
    const updatedGroup: ProxyGroup = {
      ...group,
      type,
    }

    if (typeConfig?.hasUrl) {
      updatedGroup.url = group.url || 'https://www.gstatic.com/generate_204'
      updatedGroup.interval = group.interval || 300
    } else {
      delete updatedGroup.url
      delete updatedGroup.interval
    }

    if (typeConfig?.hasStrategy) {
      updatedGroup.strategy = group.strategy || 'round-robin'
    } else {
      delete updatedGroup.strategy
    }

    onChange(updatedGroup)
  }

  return (
    <div className='space-y-1'>
      {types.map(({ value, label }) => (
        <Button
          key={value}
          variant={group.type === value ? 'default' : 'ghost'}
          size='sm'
          className='w-full justify-start'
          onClick={() => handleTypeSelect(value)}
        >
          {label}
        </Button>
      ))}

      {group.type === 'load-balance' && (
        <div className='pt-2 border-t'>
          <p className='text-xs text-muted-foreground mb-1'>{t('editNodesDialog.strategy')}</p>
          <Select
            value={group.strategy || 'round-robin'}
            onValueChange={(value) => onChange({ ...group, strategy: value as ProxyGroup['strategy'] })}
          >
            <SelectTrigger className='h-8 text-xs'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='round-robin'>{t('editNodesDialog.strategyOptions.roundRobin')}</SelectItem>
              <SelectItem value='consistent-hashing'>{t('editNodesDialog.strategyOptions.consistentHashing')}</SelectItem>
              <SelectItem value='sticky-sessions'>{t('editNodesDialog.strategyOptions.stickySessions')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  )
})
