// 「代理集合配置」Card section — 从 routes/subscribe-files.index.tsx L3349-L4144 提取(796 行)。
//
// 内含:
//   - Collapsible 卡片头(显示 N 个配置)
//   - 顶部操作栏:批量删除、创建基础(Pro)、创建高级
//   - 订阅筛选 chip 行(点 chip 切换该订阅下所有 provider 的选中状态)
//   - DataTable(desktop) + mobileCard,每行有切换 process_mode(client↔mmw) + 预览(仅 mmw) + 编辑 + 复制 YAML + 删除
//
// 设计:所有 state / mutation / 复杂副作用都由父端持有,这里只负责渲染 + 触发 callback。
//      "编辑"和"复制 YAML"两个回调中的复杂逻辑(header JSON 解析 / YAML 生成)留在父端共享。
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, Copy, Edit, Eye, Settings, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { DataTable, type DataTableColumn } from '@/components/data-table'

// 简化的代理集合 config(只声明本组件用到的字段);完整 ProxyProviderConfig 定义在主文件
export interface ProxyProviderConfigRef {
  id: number
  external_subscription_id: number
  name: string
  type: string
  interval: number
  proxy: string
  size_limit: number
  header: string
  health_check_enabled: boolean
  health_check_url: string
  health_check_interval: number
  health_check_timeout: number
  health_check_lazy: boolean
  health_check_expected_status: number
  filter: string
  exclude_filter: string
  exclude_type: string
  override: string
  process_mode: 'client' | 'mmw'
}

interface ExternalSubRef {
  id: number
  name: string
}

interface ProxyProvidersSectionProps {
  // 数据 / 加载
  configs: ProxyProviderConfigRef[]
  filteredConfigs: ProxyProviderConfigRef[]
  loading: boolean
  externalSubs: ExternalSubRef[]
  // 折叠
  expanded: boolean
  onExpandedChange: (v: boolean) => void
  // 筛选当前选中的 sub id(或 'all')
  filterSubId: number | 'all'
  onFilterSubIdChange: (v: number | 'all') => void
  // 多选状态
  selectedIds: Set<number>
  onSelectedIdsChange: (next: Set<number>) => void
  onSelectAll: (checked: boolean) => void
  onSelectOne: (id: number, checked: boolean) => void
  // 父端打开各种对话框 / 触发动作
  onOpenBatchDelete: () => void
  onOpenCreateBasic: () => void
  onOpenCreateAdvanced: () => void
  // 编辑某条 — 父端在回调里 setEditing + 解析 header + setForm + setOpen
  onEdit: (config: ProxyProviderConfigRef) => void
  // 复制 YAML — 父端拼接 + clipboard + toast
  onCopyYAML: (config: ProxyProviderConfigRef) => void
  // 预览 raw — 仅 mmw 模式可用,父端打开 PreviewDialog
  onPreview: (config: ProxyProviderConfigRef) => void
  // 切换 process_mode mutation 代理
  actions: {
    toggleProcessMode: (config: ProxyProviderConfigRef) => void
    togglePending: boolean
    delete: (id: number) => void
  }
}

export function ProxyProvidersSection({
  configs,
  filteredConfigs,
  loading,
  externalSubs,
  expanded,
  onExpandedChange,
  filterSubId,
  onFilterSubIdChange,
  selectedIds,
  onSelectedIdsChange,
  onSelectAll,
  onSelectOne,
  onOpenBatchDelete,
  onOpenCreateBasic,
  onOpenCreateAdvanced,
  onEdit,
  onCopyYAML,
  onPreview,
  actions,
}: ProxyProvidersSectionProps) {
  const { t } = useTranslation('subscribe')

  return (
    <Collapsible open={expanded} onOpenChange={onExpandedChange}>
      <Card>
        <CollapsibleTrigger asChild>
          <CardHeader className='hover:bg-muted/50 cursor-pointer transition-colors'>
            <div className='flex items-center justify-between'>
              <div>
                <CardTitle className='text-base'>{t('proxyProvider.title')}</CardTitle>
                <CardDescription>{t('proxyProvider.description')}</CardDescription>
              </div>
              <div className='flex items-center gap-2'>
                <Badge variant='secondary'>{t('proxyProvider.configCount', { count: configs.length })}</Badge>
                {expanded ? <ChevronUp className='h-4 w-4' /> : <ChevronDown className='h-4 w-4' />}
              </div>
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className='pt-0'>
            {/* 操作栏 */}
            <div className='mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between'>
              <div className='flex items-center gap-2'>
                {selectedIds.size > 0 && (
                  <>
                    <Badge variant='secondary'>{t('proxyProvider.selectedCount', { count: selectedIds.size })}</Badge>
                    <Button size='sm' variant='destructive' onClick={onOpenBatchDelete}>
                      <Trash2 className='mr-1 h-4 w-4' />
                      {t('proxyProvider.batchDelete')}
                    </Button>
                  </>
                )}
              </div>
              <div className='flex flex-col gap-2 sm:flex-row'>
                <Button size='sm' variant='outline' className='w-full sm:w-auto' onClick={onOpenCreateBasic}>
                  <Settings className='mr-2 h-4 w-4' />
                  {t('proxyProvider.createBasic')}
                </Button>
                <Button size='sm' className='w-full sm:w-auto' onClick={onOpenCreateAdvanced}>
                  <Settings className='mr-2 h-4 w-4' />
                  {t('proxyProvider.createAdvanced')}
                </Button>
              </div>
            </div>

            {/* 订阅筛选 chip — 点 chip 切换该订阅下所有 provider 的选中状态 */}
            {externalSubs.length > 0 && (
              <div className='mb-4 flex flex-wrap gap-2'>
                <Button
                  size='sm'
                  variant={filterSubId === 'all' ? 'default' : 'outline'}
                  onClick={() => {
                    onFilterSubIdChange('all')
                    const allIds = new Set(configs.map((c) => c.id))
                    const isAllSelected = configs.length > 0 && configs.every((c) => selectedIds.has(c.id))
                    onSelectedIdsChange(isAllSelected ? new Set() : allIds)
                  }}
                >
                  {t('proxyProvider.allFilter')} ({configs.length})
                </Button>
                {externalSubs.map((sub) => {
                  const subConfigs = configs.filter((c) => c.external_subscription_id === sub.id)
                  if (subConfigs.length === 0) return null
                  const subConfigIds = new Set(subConfigs.map((c) => c.id))
                  const isAllSelected = subConfigs.length > 0 && subConfigs.every((c) => selectedIds.has(c.id))
                  return (
                    <Button
                      key={sub.id}
                      size='sm'
                      variant={filterSubId === sub.id ? 'default' : 'outline'}
                      onClick={() => {
                        onFilterSubIdChange(sub.id)
                        onSelectedIdsChange(isAllSelected ? new Set() : subConfigIds)
                      }}
                    >
                      {sub.name} ({subConfigs.length})
                    </Button>
                  )
                })}
              </div>
            )}

            {loading ? (
              <div className='text-muted-foreground py-4 text-center'>{t('actions.loading', { ns: 'common' })}</div>
            ) : filteredConfigs.length === 0 ? (
              <div className='text-muted-foreground py-8 text-center'>
                <p>{t('proxyProvider.noConfigs')}</p>
                <p className='mt-1 text-sm'>{t('proxyProvider.noConfigsHint')}</p>
              </div>
            ) : (
              <DataTable
                data={filteredConfigs}
                getRowKey={(config) => config.id}
                columns={
                  [
                    {
                      header: (
                        <Checkbox
                          checked={filteredConfigs.length > 0 && filteredConfigs.every((c) => selectedIds.has(c.id))}
                          onCheckedChange={(checked) => onSelectAll(!!checked)}
                          aria-label={t('proxyProvider.selectAll')}
                        />
                      ),
                      cell: (config) => (
                        <Checkbox
                          checked={selectedIds.has(config.id)}
                          onCheckedChange={(checked) => onSelectOne(config.id, !!checked)}
                          aria-label={t('proxyProvider.selectItem', { name: config.name })}
                        />
                      ),
                      width: '40px',
                      cellClassName: 'text-center',
                      headerClassName: 'text-center',
                    },
                    {
                      header: t('proxyProvider.columns.name'),
                      cell: (config) => <div className='font-medium'>{config.name}</div>,
                    },
                    {
                      header: t('proxyProvider.columns.linkedSub'),
                      cell: (config) => {
                        const sub = externalSubs.find((s) => s.id === config.external_subscription_id)
                        return sub ? (
                          <Badge variant='outline'>{sub.name}</Badge>
                        ) : (
                          <span className='text-muted-foreground'>{t('proxyProvider.unknown')}</span>
                        )
                      },
                    },
                    {
                      header: t('proxyProvider.columns.processMode'),
                      cell: (config) => (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant='ghost'
                              size='sm'
                              className='h-auto p-0.5'
                              onClick={() => actions.toggleProcessMode(config)}
                              disabled={actions.togglePending}
                            >
                              <Badge variant={config.process_mode === 'mmw' ? 'default' : 'secondary'} className='cursor-pointer hover:opacity-80'>
                                {config.process_mode === 'mmw' ? t('proxyProvider.mmwProcess') : t('proxyProvider.clientProcess')}
                              </Badge>
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {t('proxyProvider.switchTo')}
                            {config.process_mode === 'mmw' ? t('proxyProvider.clientProcess') : t('proxyProvider.mmwProcess')}
                          </TooltipContent>
                        </Tooltip>
                      ),
                      headerClassName: 'text-center',
                      cellClassName: 'text-center',
                    },
                    {
                      header: t('proxyProvider.columns.filterRule'),
                      cell: (config) => (
                        <div className='text-muted-foreground max-w-[150px] truncate text-xs'>
                          {config.filter || config.exclude_filter || config.exclude_type ? (
                            <span>
                              {config.filter && t('proxyProvider.filterKeep', { filter: config.filter })}
                              {config.exclude_filter && ` ${t('proxyProvider.filterExclude', { filter: config.exclude_filter })}`}
                              {config.exclude_type && ` ${t('proxyProvider.filterExcludeType', { filter: config.exclude_type })}`}
                            </span>
                          ) : (
                            '-'
                          )}
                        </div>
                      ),
                    },
                    {
                      header: t('proxyProvider.columns.actions'),
                      cell: (config) => (
                        <div className='flex items-center gap-1'>
                          {config.process_mode === 'mmw' && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button variant='ghost' size='sm' onClick={() => onPreview(config)}>
                                  <Eye className='h-4 w-4' />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>{t('proxyProvider.previewResult')}</TooltipContent>
                            </Tooltip>
                          )}
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button variant='ghost' size='sm' onClick={() => onEdit(config)}>
                                <Edit className='h-4 w-4' />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{t('proxyProvider.editConfig')}</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button variant='ghost' size='sm' onClick={() => onCopyYAML(config)}>
                                <Copy className='h-4 w-4' />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{t('proxyProvider.copyConfig')}</TooltipContent>
                          </Tooltip>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button variant='ghost' size='sm' className='text-destructive hover:text-destructive'>
                                <Trash2 className='h-4 w-4' />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>{t('externalSub.deleteConfirmTitle')}</AlertDialogTitle>
                                <AlertDialogDescription>
                                  {t('proxyProvider.deleteConfirmDesc', { name: config.name })}
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>{t('actions.cancel', { ns: 'common' })}</AlertDialogCancel>
                                <AlertDialogAction onClick={() => actions.delete(config.id)}>
                                  {t('actions.delete', { ns: 'common' })}
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      ),
                      headerClassName: 'text-center',
                      cellClassName: 'text-center',
                      width: '120px',
                    },
                  ] as DataTableColumn<ProxyProviderConfigRef>[]
                }
                mobileCard={{
                  header: (config) => (
                    <div className='mb-1 flex items-center justify-between gap-2'>
                      <div className='flex min-w-0 flex-1 items-center gap-2'>
                        <Checkbox
                          checked={selectedIds.has(config.id)}
                          onCheckedChange={(checked) => onSelectOne(config.id, !!checked)}
                          onClick={(e) => e.stopPropagation()}
                          aria-label={t('proxyProvider.selectItem', { name: config.name })}
                          className='shrink-0'
                        />
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant='ghost'
                              size='sm'
                              className='h-auto shrink-0 p-0'
                              onClick={(e) => {
                                e.stopPropagation()
                                actions.toggleProcessMode(config)
                              }}
                              disabled={actions.togglePending}
                            >
                              <Badge variant={config.process_mode === 'mmw' ? 'default' : 'secondary'} className='cursor-pointer hover:opacity-80'>
                                {config.process_mode === 'mmw' ? t('proxyProvider.mmwShort') : t('proxyProvider.clientShort')}
                              </Badge>
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {t('proxyProvider.switchTo')}
                            {config.process_mode === 'mmw' ? t('proxyProvider.clientProcess') : t('proxyProvider.mmwProcess')}
                          </TooltipContent>
                        </Tooltip>
                        <div className='truncate text-sm font-medium'>{config.name}</div>
                      </div>
                      <div className='flex items-center gap-1'>
                        {config.process_mode === 'mmw' && (
                          <Button
                            variant='outline'
                            size='icon'
                            className='size-8 shrink-0'
                            onClick={(e) => {
                              e.stopPropagation()
                              onPreview(config)
                            }}
                          >
                            <Eye className='size-4' />
                          </Button>
                        )}
                        <Button
                          variant='outline'
                          size='icon'
                          className='size-8 shrink-0'
                          onClick={(e) => {
                            e.stopPropagation()
                            onEdit(config)
                          }}
                        >
                          <Edit className='size-4' />
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant='outline'
                              size='icon'
                              className='text-destructive size-8 shrink-0'
                              onClick={(e) => e.stopPropagation()}
                            >
                              <Trash2 className='size-4' />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>{t('externalSub.deleteConfirmTitle')}</AlertDialogTitle>
                              <AlertDialogDescription>
                                {t('proxyProvider.deleteConfirmDesc', { name: config.name })}
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>{t('actions.cancel', { ns: 'common' })}</AlertDialogCancel>
                              <AlertDialogAction onClick={() => actions.delete(config.id)}>
                                {t('actions.delete', { ns: 'common' })}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </div>
                  ),
                  fields: [
                    {
                      label: t('proxyProvider.mobileLinkedSubLabel'),
                      value: (config) => {
                        const sub = externalSubs.find((s) => s.id === config.external_subscription_id)
                        return sub?.name || t('proxyProvider.unknown')
                      },
                    },
                    {
                      label: t('proxyProvider.mobileFilterLabel'),
                      value: (config) => config.filter || config.exclude_filter || config.exclude_type || '-',
                    },
                  ],
                }}
              />
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  )
}
