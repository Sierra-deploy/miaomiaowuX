// 「外部订阅」Card section — 从 routes/subscribe-files.index.tsx L3322-L3945 提取。
//
// 设计:
//   - 所有 state / mutation 仍由父端持有,本组件通过 props 接收数据 + 回调
//   - 4 个 mutation 合并到一个 `actions` 对象,减少 prop 噪音
//   - 编辑按钮的副作用(setEditing + setForm + setOpen 三连)合并为单个 `onEdit(sub)` 回调
//   - 删除确认对话框沿用原 AlertDialog 内联结构,不再抽
import { useTranslation } from 'react-i18next'
import {
  ChevronDown,
  ChevronUp,
  Download,
  Edit,
  ExternalLink,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Progress } from '@/components/ui/progress'
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
import { Twemoji } from '@/components/twemoji'
import { formatTrafficGB } from '@/lib/format'

// 外部订阅模型(简化形,只声明本组件用得到的字段)
export interface ExternalSubscription {
  id: number
  name: string
  url: string
  user_agent?: string
  node_count: number
  upload: number
  download: number
  total: number
  expire?: number | string
  last_sync_at?: string
  traffic_mode?: 'download' | 'upload' | 'both'
}

// 编辑按钮要写回父端的表单 shape
export interface EditExternalSubFormData {
  name: string
  url: string
  user_agent?: string
  traffic_mode: 'download' | 'upload' | 'both'
}

interface ExternalSubsSectionProps {
  // 数据 / 加载态
  externalSubs: ExternalSubscription[]
  loading: boolean
  // 节点 tag → name[] 映射(用于显示节点数 + tooltip 列表)
  nodesByTag: Record<string, string[]>
  // 真节点数据已加载?用于决定优先用实际节点数还是 DB 缓存的 node_count
  allNodesLoaded: boolean
  // 折叠状态(受控)
  expanded: boolean
  onExpandedChange: (v: boolean) => void
  // 单订阅同步状态(只有一个 id 在同步,父端的 syncingSingleId)
  syncingSingleId: number | null
  // 通用日期格式器(由父端构造,避免每个组件各自创建)
  dateFormatter: Intl.DateTimeFormat
  // 4 个 mutation 的代理
  actions: {
    syncAll: () => void
    syncAllPending: boolean
    syncSingle: (id: number) => void
    update: (payload: { id: number; name: string; url: string; user_agent?: string; traffic_mode: 'download' | 'upload' | 'both' }) => void
    updatePending: boolean
    delete: (id: number) => void
    deletePending: boolean
  }
  // 打开编辑对话框 — 父端在回调里 setEditing + setForm + setOpen
  onEdit: (sub: ExternalSubscription, form: EditExternalSubFormData) => void
}

export function ExternalSubsSection({
  externalSubs,
  loading,
  nodesByTag,
  allNodesLoaded,
  expanded,
  onExpandedChange,
  syncingSingleId,
  dateFormatter,
  actions,
  onEdit,
}: ExternalSubsSectionProps) {
  const { t } = useTranslation('subscribe')

  return (
    <Collapsible open={expanded} onOpenChange={onExpandedChange}>
      <Card>
        <CollapsibleTrigger asChild>
          <CardHeader className='cursor-pointer'>
            <div className='flex items-center justify-between'>
              <div>
                <CardTitle className='flex items-center gap-2'>
                  <ExternalLink className='h-5 w-5' />
                  {t('externalSub.title')} ({externalSubs.length})
                </CardTitle>
                <CardDescription>{t('externalSub.description')}</CardDescription>
              </div>
              {expanded ? <ChevronUp className='h-5 w-5' /> : <ChevronDown className='h-5 w-5' />}
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent className='CollapsibleContent'>
          <CardContent>
            {/* 同步按钮 */}
            <div className='mb-4 flex justify-end'>
              <Button variant='outline' size='sm' onClick={actions.syncAll} disabled={actions.syncAllPending || externalSubs.length === 0}>
                <RefreshCw className={`mr-2 h-4 w-4 ${actions.syncAllPending ? 'animate-spin' : ''}`} />
                {actions.syncAllPending ? t('externalSub.syncing') : t('externalSub.syncAll')}
              </Button>
            </div>

            {loading ? (
              <div className='text-muted-foreground py-8 text-center'>{t('actions.loading', { ns: 'common' })}</div>
            ) : externalSubs.length === 0 ? (
              <div className='text-muted-foreground py-8 text-center'>{t('externalSub.noSubs')}</div>
            ) : (
              <DataTable
                data={externalSubs}
                getRowKey={(sub) => sub.id}
                emptyText={t('externalSub.noSubsShort')}
                columns={
                  [
                    {
                      header: t('externalSub.columns.name'),
                      cell: (sub) => sub.name,
                      cellClassName: 'font-medium',
                    },
                    {
                      header: t('externalSub.columns.subscriptionUrl'),
                      cell: (sub) => (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className='text-muted-foreground max-w-[200px] cursor-help truncate font-mono text-sm'>
                              {sub.url}
                            </div>
                          </TooltipTrigger>
                          <TooltipContent className='max-w-md font-mono text-xs break-all'>{sub.url}</TooltipContent>
                        </Tooltip>
                      ),
                    },
                    {
                      header: t('externalSub.columns.nodeCount'),
                      cell: (sub) => {
                        const nodes = nodesByTag[sub.name] ?? []
                        const nodeCount = allNodesLoaded ? nodes.length : sub.node_count
                        return (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge variant='secondary' className='cursor-help'>
                                {nodeCount}
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent className='max-h-60 max-w-64 overflow-y-auto p-2'>
                              <div className='mb-1 text-xs font-medium'>{t('externalSub.nodesOf', { name: sub.name })}</div>
                              {nodes.length > 0 ? (
                                <ul className='space-y-0.5'>
                                  {nodes.map((nodeName, idx) => (
                                    <li key={idx} className='truncate text-xs'>
                                      <Twemoji>{nodeName}</Twemoji>
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <div className='text-xs'>{t('externalSub.noNodes')}</div>
                              )}
                            </TooltipContent>
                          </Tooltip>
                        )
                      },
                      headerClassName: 'text-center',
                      cellClassName: 'text-center',
                    },
                    {
                      header: t('externalSub.columns.trafficUsage'),
                      cell: (sub) => {
                        if (sub.total <= 0) {
                          return <span className='text-muted-foreground text-sm'>-</span>
                        }
                        const mode = sub.traffic_mode || 'both'
                        const used = mode === 'download' ? sub.download : mode === 'upload' ? sub.upload : sub.upload + sub.download
                        const percentage = Math.min((used / sub.total) * 100, 100)
                        const remaining = Math.max(sub.total - used, 0)
                        const modeLabel =
                          mode === 'download'
                            ? t('externalSub.downloadOnly')
                            : mode === 'upload'
                              ? t('externalSub.uploadOnly')
                              : t('externalSub.uploadAndDownload')
                        return (
                          <div className='flex items-center gap-1'>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div className='w-20 cursor-help space-y-1'>
                                  <Progress value={percentage} className='h-2' />
                                  <div className='text-muted-foreground text-center text-xs'>{percentage.toFixed(0)}%</div>
                                </div>
                              </TooltipTrigger>
                              <TooltipContent className='space-y-1'>
                                <div className='text-xs'><span className='font-medium'>{t('externalSub.upload')}: </span>{formatTrafficGB(sub.upload)}</div>
                                <div className='text-xs'><span className='font-medium'>{t('externalSub.download')}: </span>{formatTrafficGB(sub.download)}</div>
                                <div className='text-xs'><span className='font-medium'>{t('externalSub.total')}: </span>{formatTrafficGB(sub.total)}</div>
                                <div className='text-xs'><span className='font-medium'>{t('externalSub.remaining')}: </span>{formatTrafficGB(remaining)}</div>
                                <div className='text-muted-foreground text-xs'>{t('externalSub.statsMode')}: {modeLabel}</div>
                              </TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant='ghost'
                                  size='icon'
                                  className='h-6 w-6'
                                  onClick={() => {
                                    const nextMode = mode === 'both' ? 'download' : mode === 'download' ? 'upload' : 'both'
                                    actions.update({ id: sub.id, name: sub.name, url: sub.url, user_agent: sub.user_agent, traffic_mode: nextMode })
                                  }}
                                  disabled={actions.updatePending}
                                >
                                  {mode === 'download' ? (
                                    <Download className='h-3 w-3' />
                                  ) : mode === 'upload' ? (
                                    <Upload className='h-3 w-3' />
                                  ) : (
                                    <svg className='h-3 w-3' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
                                      <path d='M12 5v14M5 12l7-7 7 7M5 12l7 7 7-7' />
                                    </svg>
                                  )}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent><span>{t('externalSub.switchStatsMode')}: {modeLabel}</span></TooltipContent>
                            </Tooltip>
                          </div>
                        )
                      },
                      width: '140px',
                    },
                    {
                      header: t('externalSub.columns.expireTime'),
                      cell: (sub) =>
                        sub.expire ? (
                          <span className='text-sm'>{dateFormatter.format(new Date(sub.expire))}</span>
                        ) : (
                          <span className='text-muted-foreground text-sm'>-</span>
                        ),
                    },
                    {
                      header: t('externalSub.columns.lastSync'),
                      cell: (sub) => (
                        <span className='text-muted-foreground text-sm'>
                          {sub.last_sync_at ? dateFormatter.format(new Date(sub.last_sync_at)) : '-'}
                        </span>
                      ),
                    },
                    {
                      header: t('externalSub.columns.actions'),
                      cell: (sub) => (
                        <div className='flex items-center gap-1'>
                          <Button
                            variant='ghost'
                            size='sm'
                            onClick={() =>
                              onEdit(sub, { name: sub.name, url: sub.url, user_agent: sub.user_agent, traffic_mode: sub.traffic_mode || 'both' })
                            }
                          >
                            <Edit className='h-4 w-4' />
                          </Button>
                          <Button
                            variant='ghost'
                            size='sm'
                            onClick={() => actions.syncSingle(sub.id)}
                            disabled={syncingSingleId === sub.id || actions.syncAllPending}
                          >
                            <RefreshCw className={`h-4 w-4 ${syncingSingleId === sub.id ? 'animate-spin' : ''}`} />
                          </Button>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button variant='ghost' size='sm' className='text-destructive hover:text-destructive' disabled={actions.deletePending}>
                                <Trash2 className='h-4 w-4' />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>{t('externalSub.deleteConfirmTitle')}</AlertDialogTitle>
                                <AlertDialogDescription>{t('externalSub.deleteConfirmDesc', { name: sub.name })}</AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>{t('actions.cancel', { ns: 'common' })}</AlertDialogCancel>
                                <AlertDialogAction onClick={() => actions.delete(sub.id)}>
                                  {t('actions.delete', { ns: 'common' })}
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      ),
                      headerClassName: 'text-center',
                      cellClassName: 'text-center',
                      width: '130px',
                    },
                  ] as DataTableColumn<ExternalSubscription>[]
                }
                mobileCard={{
                  header: (sub) => {
                    const nodes = nodesByTag[sub.name] ?? []
                    const nodeCount = allNodesLoaded ? nodes.length : sub.node_count
                    return (
                      <div className='mb-1 flex items-center justify-between gap-2'>
                        <div className='flex min-w-0 flex-1 items-center gap-2'>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge variant='secondary' className='cursor-help'>
                                {t('externalSub.nodeCountLabel', { count: nodeCount })}
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent className='max-h-60 max-w-64 overflow-y-auto p-2'>
                              <div className='mb-1 text-xs font-medium'>{t('externalSub.nodesOf', { name: sub.name })}</div>
                              {nodes.length > 0 ? (
                                <ul className='space-y-0.5'>
                                  {nodes.map((nodeName, idx) => (
                                    <li key={idx} className='truncate text-xs'>
                                      <Twemoji>{nodeName}</Twemoji>
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <div className='text-xs'>{t('externalSub.noNodes')}</div>
                              )}
                            </TooltipContent>
                          </Tooltip>
                          <div className='truncate text-sm font-medium'>{sub.name}</div>
                        </div>
                        <div className='flex items-center gap-1'>
                          <Button
                            variant='outline'
                            size='icon'
                            className='size-8 shrink-0'
                            onClick={(e) => {
                              e.stopPropagation()
                              onEdit(sub, { name: sub.name, url: sub.url, user_agent: sub.user_agent, traffic_mode: sub.traffic_mode || 'both' })
                            }}
                          >
                            <Edit className='size-4' />
                          </Button>
                          <Button
                            variant='outline'
                            size='icon'
                            className='size-8 shrink-0'
                            disabled={syncingSingleId === sub.id || actions.syncAllPending}
                            onClick={(e) => {
                              e.stopPropagation()
                              actions.syncSingle(sub.id)
                            }}
                          >
                            <RefreshCw className={`size-4 ${syncingSingleId === sub.id ? 'animate-spin' : ''}`} />
                          </Button>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                variant='outline'
                                size='icon'
                                className='text-destructive hover:text-destructive hover:bg-destructive/10 size-8 shrink-0'
                                disabled={actions.deletePending}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <Trash2 className='size-4' />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>{t('externalSub.deleteConfirmTitle')}</AlertDialogTitle>
                                <AlertDialogDescription>{t('externalSub.deleteConfirmDesc', { name: sub.name })}</AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>{t('actions.cancel', { ns: 'common' })}</AlertDialogCancel>
                                <AlertDialogAction onClick={() => actions.delete(sub.id)}>
                                  {t('actions.delete', { ns: 'common' })}
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      </div>
                    )
                  },
                  fields: [
                    {
                      label: t('externalSub.mobileUrlLabel'),
                      value: (sub) => <span className='font-mono text-xs break-all'>{sub.url}</span>,
                    },
                    {
                      label: t('externalSub.mobileTrafficLabel'),
                      value: (sub) => {
                        if (sub.total <= 0) return <span className='text-muted-foreground'>-</span>
                        const mode = sub.traffic_mode || 'both'
                        const used = mode === 'download' ? sub.download : mode === 'upload' ? sub.upload : sub.upload + sub.download
                        const percentage = Math.min((used / sub.total) * 100, 100)
                        const remaining = Math.max(sub.total - used, 0)
                        const modeLabel =
                          mode === 'download'
                            ? t('externalSub.downloadOnly')
                            : mode === 'upload'
                              ? t('externalSub.uploadOnly')
                              : t('externalSub.uploadAndDownload')
                        return (
                          <div className='flex items-center gap-2'>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div className='flex flex-1 cursor-help items-center gap-2'>
                                  <Progress value={percentage} className='h-2 max-w-20 flex-1' />
                                  <span className='text-xs whitespace-nowrap'>
                                    {formatTrafficGB(used)} / {formatTrafficGB(sub.total)}
                                  </span>
                                </div>
                              </TooltipTrigger>
                              <TooltipContent className='space-y-1'>
                                <div className='text-xs'><span className='font-medium'>{t('externalSub.upload')}: </span>{formatTrafficGB(sub.upload)}</div>
                                <div className='text-xs'><span className='font-medium'>{t('externalSub.download')}: </span>{formatTrafficGB(sub.download)}</div>
                                <div className='text-xs'><span className='font-medium'>{t('externalSub.remaining')}: </span>{formatTrafficGB(remaining)}</div>
                                <div className='text-muted-foreground text-xs'>{t('externalSub.statsMode')}: {modeLabel}</div>
                              </TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant='ghost'
                                  size='icon'
                                  className='h-6 w-6 shrink-0'
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    const nextMode = mode === 'both' ? 'download' : mode === 'download' ? 'upload' : 'both'
                                    actions.update({ id: sub.id, name: sub.name, url: sub.url, user_agent: sub.user_agent, traffic_mode: nextMode })
                                  }}
                                  disabled={actions.updatePending}
                                >
                                  {mode === 'download' ? (
                                    <Download className='h-3 w-3' />
                                  ) : mode === 'upload' ? (
                                    <Upload className='h-3 w-3' />
                                  ) : (
                                    <svg className='h-3 w-3' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
                                      <path d='M12 5v14M5 12l7-7 7 7M5 12l7 7 7-7' />
                                    </svg>
                                  )}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent><span>{t('externalSub.switchStatsMode')}: {modeLabel}</span></TooltipContent>
                            </Tooltip>
                          </div>
                        )
                      },
                    },
                    {
                      label: t('externalSub.mobileExpireLabel'),
                      value: (sub) => (sub.expire ? dateFormatter.format(new Date(sub.expire)) : '-'),
                    },
                    {
                      label: t('externalSub.mobileLastSyncLabel'),
                      value: (sub) => (sub.last_sync_at ? dateFormatter.format(new Date(sub.last_sync_at)) : '-'),
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
