// 「订阅文件列表」Card section — 从 routes/subscribe-files.index.tsx L2782-L3322 提取(540 行)。
//
// 表/卡片有大量受控字段:
//   - 自定义短码 / 用户短码(回车保存)
//   - V3 模板选择
//   - 规则自动同步开关
//   - 上下移排序
//   - 编辑信息 / 编辑配置 / 删除
//
// 设计:所有 state / mutation / 副作用都由父端持有,这里只接 props + 回调。
//      `isAdmin` 决定隐藏某些只对管理员开放的列(自定义连接 / 描述 / 上下移)。
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, Edit, Settings, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
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
import { TrafficScopePopover } from '../dialogs/traffic-scope-drawer'

// 文件 / 模板的最小引用形(只声明本组件用到的字段)
export interface SubscribeFileRef {
  id: number
  name: string
  description: string
  type: 'create' | 'import' | 'upload' | 'package'
  filename: string
  file_short_code: string
  custom_short_code: string
  auto_sync_custom_rules: boolean
  template_filename: string
  selected_tags: string[]
  latest_version?: number
  updated_at: string
}

interface TemplateRef {
  filename: string
  name?: string
}

export interface TrafficInfo {
  used: number
  limit: number
}

const TYPE_COLORS: Record<string, string> = {
  create: 'bg-blue-500/10 text-blue-700 dark:text-blue-400',
  import: 'bg-green-500/10 text-green-700 dark:text-green-400',
  upload: 'bg-purple-500/10 text-purple-700 dark:text-purple-400',
  package: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
}

interface FilesListSectionProps {
  files: SubscribeFileRef[]
  loading: boolean
  // 管理员限定列:自定义连接 / 描述 / 上下移
  isAdmin: boolean
  // 流量数据(file.id → { used, limit })
  trafficData: Record<string, TrafficInfo> | undefined
  isTrafficLoading: boolean
  // 用户短码 + 自定义短码(显示在"自定义连接" Popover 里,可编辑)
  myUserShortCode: string
  myCustomUserShortCode: string
  // V3 模板下拉候选
  templates: TemplateRef[]
  // 通用日期格式器
  dateFormatter: Intl.DateTimeFormat
  // 父端动作
  onEditMetadata: (file: SubscribeFileRef) => void
  onEditConfig: (file: SubscribeFileRef) => void
  onDelete: (id: number) => void
  onMoveUp: (file: SubscribeFileRef) => void
  onMoveDown: (file: SubscribeFileRef) => void
  onToggleAutoSync: (id: number, checked: boolean) => void
  // 管理员点击流量列触发 — 改为内嵌 Popover,父端只需提供服务器列表 + 保存回调
  trafficScopeServers?: { id: number; name: string }[]
  onSaveTrafficScope?: (file: SubscribeFileRef, statsServerIds: string) => void
  savingTrafficScope?: boolean
  // mutation 状态 + 调用代理
  inlineUpdate: (payload: { id: number; data: Record<string, any> }) => void
  updateUserShortCode: (value: string) => void
  updateMetadataPending: boolean
  deletePending: boolean
}

export function FilesListSection({
  files,
  loading,
  isAdmin,
  trafficData,
  isTrafficLoading,
  myUserShortCode,
  myCustomUserShortCode,
  templates,
  dateFormatter,
  onEditMetadata,
  onEditConfig,
  onDelete,
  onMoveUp,
  onMoveDown,
  onToggleAutoSync,
  trafficScopeServers,
  onSaveTrafficScope,
  savingTrafficScope,
  inlineUpdate,
  updateUserShortCode,
  updateMetadataPending,
  deletePending,
}: FilesListSectionProps) {
  const { t } = useTranslation('subscribe')

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('management.fileList.title')} ({files.length})</CardTitle>
        <CardDescription>{t('management.fileList.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className='text-muted-foreground py-8 text-center'>{t('actions.loading', { ns: 'common' })}</div>
        ) : files.length === 0 ? (
          <div className='text-muted-foreground py-8 text-center'>{t('management.noFilesHint')}</div>
        ) : (
          <DataTable
            data={files}
            getRowKey={(file) => file.id}
            emptyText={t('management.noFilesHint')}
            columns={
              ([
                {
                  header: t('management.fileList.subscriptionName'),
                  cell: (file) => (
                    <div className='flex flex-wrap items-center gap-2'>
                      <Badge variant='outline' className={TYPE_COLORS[file.type]}>
                        {t(`management.typeLabels.${file.type}`)}
                      </Badge>
                      <span className='font-medium'>{file.name}</span>
                      {file.latest_version && <Badge variant='secondary'>v{file.latest_version}</Badge>}
                    </div>
                  ),
                },
                {
                  header: t('management.fileList.descriptionCol'),
                  cell: (file) =>
                    file.description ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className='text-muted-foreground block cursor-help truncate text-sm'>{file.description}</span>
                        </TooltipTrigger>
                        <TooltipContent className='max-w-xs'>{file.description}</TooltipContent>
                      </Tooltip>
                    ) : (
                      <span className='text-muted-foreground text-sm'>-</span>
                    ),
                  cellClassName: 'max-w-[200px]',
                },
                {
                  header: t('management.fileList.lastUpdated'),
                  cell: (file) => (
                    <span className='text-muted-foreground text-sm whitespace-nowrap'>
                      {file.updated_at ? dateFormatter.format(new Date(file.updated_at)) : '-'}
                    </span>
                  ),
                  width: '140px',
                },
                {
                  header: t('management.fileList.ruleSync'),
                  cell: (file) => (
                    <Switch
                      checked={file.auto_sync_custom_rules || false}
                      onCheckedChange={(checked) => onToggleAutoSync(file.id, checked)}
                    />
                  ),
                  headerClassName: 'text-center',
                  cellClassName: 'text-center',
                  width: '80px',
                },
                {
                  header: '自定义连接',
                  cell: (file) => {
                    const code = file.custom_short_code || file.file_short_code
                    return (
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button variant='outline' size='sm' className='h-7 text-xs font-mono px-2'>
                            {code || '-'}
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className='w-64 p-3' align='start'>
                          <div className='space-y-2'>
                            <Label className='text-xs'>自定义短码（文件）</Label>
                            <Input
                              className='h-8 text-xs font-mono'
                              defaultValue={file.custom_short_code || ''}
                              placeholder={file.file_short_code || '留空使用自动短码'}
                              autoFocus
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  const val = (e.target as HTMLInputElement).value.trim()
                                  if (val !== (file.custom_short_code || '')) {
                                    inlineUpdate({ id: file.id, data: { custom_short_code: val } })
                                  }
                                }
                              }}
                            />
                            <p className='text-[10px] text-muted-foreground'>
                              回车保存，留空恢复自动短码{file.file_short_code ? ` (${file.file_short_code})` : ''}
                            </p>
                            <div className='pt-2 border-t space-y-1'>
                              <Label className='text-xs'>用户短码</Label>
                              <Input
                                className='h-8 text-xs font-mono'
                                defaultValue={myCustomUserShortCode}
                                placeholder={myUserShortCode ? `当前生效: ${myUserShortCode}(留空恢复自动)` : '留空使用自动短码'}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    const val = (e.target as HTMLInputElement).value.trim()
                                    if (val !== myCustomUserShortCode) {
                                      updateUserShortCode(val)
                                    }
                                  }
                                }}
                              />
                              <p className='text-[10px] text-muted-foreground'>回车保存。当前生效短码:{myUserShortCode || '—'}</p>
                            </div>
                          </div>
                        </PopoverContent>
                      </Popover>
                    )
                  },
                  width: '110px',
                },
                {
                  header: 'V3 模板',
                  cell: (file) => (
                    <Select
                      value={file.template_filename || '__none__'}
                      onValueChange={(v) => {
                        const val = v === '__none__' ? '' : v
                        inlineUpdate({ id: file.id, data: { template_filename: val } })
                      }}
                    >
                      <SelectTrigger className='h-7 text-xs w-28'>
                        <SelectValue placeholder='选择模板' />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value='__none__'>选择模板</SelectItem>
                        {templates.map((tpl) => (
                          <SelectItem key={tpl.filename} value={tpl.filename}>
                            {tpl.name || tpl.filename.replace(/_v3\.yaml$|__v3\.yaml$|\.yaml$/, '')}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ),
                  width: '140px',
                },
                {
                  header: '流量',
                  cell: (file) => {
                    const clickable = isAdmin && !!onSaveTrafficScope
                    if (isTrafficLoading || !trafficData) {
                      return <div className='h-2 w-16 animate-pulse rounded bg-muted' />
                    }
                    const tr = trafficData[String(file.id)]
                    const formatSize = (bytes: number) => {
                      const gb = bytes / (1024 * 1024 * 1024)
                      return gb >= 1 ? `${gb.toFixed(1)}G` : `${(bytes / (1024 * 1024)).toFixed(0)}M`
                    }
                    const wrapInPopover = (el: ReactNode) =>
                      clickable ? (
                        <TrafficScopePopover
                          file={file as any}
                          servers={trafficScopeServers || []}
                          onSave={(_id, ids) => onSaveTrafficScope!(file, ids)}
                          saving={!!savingTrafficScope}
                        >
                          {el}
                        </TrafficScopePopover>
                      ) : el
                    if (!tr || (tr.used === 0 && tr.limit === 0)) {
                      const dash = <button type='button' className='text-xs text-muted-foreground hover:underline'>-</button>
                      if (clickable) {
                        return wrapInPopover(dash)
                      }
                      return <span className='text-xs text-muted-foreground'>-</span>
                    }
                    const pct = tr.limit > 0 ? Math.min(100, (tr.used / tr.limit) * 100) : 0
                    const inner = (
                      <div className='w-20 space-y-0.5'>
                        <Progress value={pct} className='h-2' />
                        <span className='text-[10px] text-muted-foreground block'>
                          {tr.limit > 0 ? `${Math.round(pct)}%` : formatSize(tr.used)}
                        </span>
                      </div>
                    )
                    return (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          {clickable ? (
                            wrapInPopover(<button type='button' className='block w-20 text-left hover:opacity-80'>{inner}</button>)
                          ) : inner}
                        </TooltipTrigger>
                        <TooltipContent>
                          {formatSize(tr.used)}{tr.limit > 0 ? ` / ${formatSize(tr.limit)}` : ''}
                          {clickable && <div className='text-[10px] mt-0.5'>点击配置统计范围</div>}
                        </TooltipContent>
                      </Tooltip>
                    )
                  },
                  width: '100px',
                },
                {
                  header: '',
                  cell: (file) => (
                    <div className='flex items-center gap-0.5'>
                      <Button variant='ghost' size='icon' className='h-7 w-7' onClick={() => onMoveUp(file)} disabled={files.indexOf(file) === 0}>
                        <ChevronUp className='h-4 w-4' />
                      </Button>
                      <Button variant='ghost' size='icon' className='h-7 w-7' onClick={() => onMoveDown(file)} disabled={files.indexOf(file) === files.length - 1}>
                        <ChevronDown className='h-4 w-4' />
                      </Button>
                    </div>
                  ),
                  width: '70px',
                },
                {
                  header: t('management.fileList.actions'),
                  cell: (file) => (
                    <div className='flex items-center gap-1'>
                      <Button variant='ghost' size='sm' title={t('management.fileList.editInfo')} onClick={() => onEditMetadata(file)} disabled={updateMetadataPending}>
                        <Settings className='h-4 w-4' />
                      </Button>
                      <Button variant='ghost' size='sm' title={t('management.fileList.editConfig')} onClick={() => onEditConfig(file)}>
                        <Edit className='h-4 w-4' />
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant='ghost' size='sm' className='text-destructive hover:text-destructive' disabled={deletePending}>
                            <Trash2 className='h-4 w-4' />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{t('management.fileList.deleteConfirmTitle')}</AlertDialogTitle>
                            <AlertDialogDescription>{t('management.fileList.deleteConfirmDesc', { name: file.name })}</AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{t('actions.cancel', { ns: 'common' })}</AlertDialogCancel>
                            <AlertDialogAction onClick={() => onDelete(file.id)}>
                              {t('actions.delete', { ns: 'common' })}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  ),
                  headerClassName: 'text-center',
                  cellClassName: 'text-center',
                  width: '140px',
                },
              ] as DataTableColumn<SubscribeFileRef>[]).filter(
                (c) => isAdmin || (c.header !== '' && c.header !== t('management.fileList.descriptionCol') && c.header !== '自定义连接'),
              )
            }
            mobileCard={{
              header: (file) => (
                <div className='mb-1 flex items-center justify-between gap-2'>
                  <div className='flex min-w-0 flex-1 items-center gap-2'>
                    <Badge variant='outline' className={TYPE_COLORS[file.type]}>
                      {t(`management.typeLabels.${file.type}`)}
                    </Badge>
                    <div className='truncate text-sm font-medium'>{file.name}</div>
                  </div>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant='outline'
                        size='icon'
                        className='text-destructive hover:text-destructive hover:bg-destructive/10 size-8 shrink-0'
                        disabled={deletePending}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Trash2 className='size-4' />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>{t('management.fileList.deleteConfirmTitle')}</AlertDialogTitle>
                        <AlertDialogDescription>{t('management.fileList.deleteConfirmDesc', { name: file.name })}</AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{t('actions.cancel', { ns: 'common' })}</AlertDialogCancel>
                        <AlertDialogAction onClick={() => onDelete(file.id)}>{t('actions.delete', { ns: 'common' })}</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              ),
              fields: [
                {
                  label: t('management.fileList.mobileDescriptionLabel'),
                  value: (file) => <span className='line-clamp-1 text-xs'>{file.description}</span>,
                  hidden: (file) => !file.description,
                },
                {
                  label: t('management.fileList.mobileFileLabel'),
                  value: (file) => <span className='font-mono break-all'>{file.filename}</span>,
                },
                {
                  label: t('management.fileList.mobileUpdateTimeLabel'),
                  value: (file) => (
                    <div className='flex flex-wrap items-center gap-2'>
                      <span>{file.updated_at ? dateFormatter.format(new Date(file.updated_at)) : '-'}</span>
                      {file.latest_version && (
                        <>
                          <span className='text-muted-foreground'>·</span>
                          <Badge variant='secondary' className='text-xs'>v{file.latest_version}</Badge>
                        </>
                      )}
                    </div>
                  ),
                },
                ...(isAdmin
                  ? [
                      {
                        label: '自定义连接',
                        value: (file: SubscribeFileRef) => {
                          const code = file.custom_short_code || file.file_short_code
                          return (
                            <Popover>
                              <PopoverTrigger asChild>
                                <Button variant='outline' size='sm' className='h-7 text-xs font-mono px-2'>
                                  {code || '-'}
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent className='w-56 p-3' align='start'>
                                <div className='space-y-2'>
                                  <Label className='text-xs'>自定义短码</Label>
                                  <Input
                                    className='h-8 text-xs font-mono'
                                    defaultValue={file.custom_short_code || ''}
                                    placeholder={file.file_short_code || '留空使用自动短码'}
                                    autoFocus
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') {
                                        const val = (e.target as HTMLInputElement).value.trim()
                                        if (val !== (file.custom_short_code || '')) {
                                          inlineUpdate({ id: file.id, data: { custom_short_code: val } })
                                        }
                                      }
                                    }}
                                  />
                                  <p className='text-[10px] text-muted-foreground'>
                                    回车保存{file.file_short_code ? `，自动短码: ${file.file_short_code}` : ''}
                                  </p>
                                  <div className='pt-2 border-t space-y-1'>
                                    <Label className='text-xs'>用户短码</Label>
                                    <Input
                                      className='h-8 text-xs font-mono'
                                      defaultValue={myCustomUserShortCode}
                                      placeholder={myUserShortCode ? `当前生效: ${myUserShortCode}(留空恢复自动)` : '留空使用自动短码'}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                          const val = (e.target as HTMLInputElement).value.trim()
                                          if (val !== myCustomUserShortCode) {
                                            updateUserShortCode(val)
                                          }
                                        }
                                      }}
                                    />
                                    <p className='text-[10px] text-muted-foreground'>回车保存。当前生效短码:{myUserShortCode || '—'}</p>
                                  </div>
                                </div>
                              </PopoverContent>
                            </Popover>
                          )
                        },
                      },
                    ]
                  : []),
                {
                  label: 'V3 模板',
                  value: (file) => (
                    <Select
                      value={file.template_filename || '__none__'}
                      onValueChange={(v) => {
                        const val = v === '__none__' ? '' : v
                        inlineUpdate({ id: file.id, data: { template_filename: val } })
                      }}
                    >
                      <SelectTrigger className='h-7 text-xs w-32'>
                        <SelectValue placeholder='选择模板' />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value='__none__'>选择模板</SelectItem>
                        {templates.map((tpl) => (
                          <SelectItem key={tpl.filename} value={tpl.filename}>
                            {tpl.name || tpl.filename.replace(/_v3\.yaml$|__v3\.yaml$|\.yaml$/, '')}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ),
                },
                {
                  label: '流量',
                  value: (file) => {
                    const clickable = isAdmin && !!onSaveTrafficScope
                    if (isTrafficLoading || !trafficData) {
                      return <div className='h-2 w-20 animate-pulse rounded bg-muted' />
                    }
                    const tr = trafficData[String(file.id)]
                    const formatSize = (bytes: number) => {
                      const gb = bytes / (1024 * 1024 * 1024)
                      return gb >= 1 ? `${gb.toFixed(1)}G` : `${(bytes / (1024 * 1024)).toFixed(0)}M`
                    }
                    const wrap = (el: ReactNode) =>
                      clickable ? (
                        <TrafficScopePopover
                          file={file as any}
                          servers={trafficScopeServers || []}
                          onSave={(_id, ids) => onSaveTrafficScope!(file, ids)}
                          saving={!!savingTrafficScope}
                        >
                          {el}
                        </TrafficScopePopover>
                      ) : el
                    if (!tr || (tr.used === 0 && tr.limit === 0)) {
                      if (clickable) return wrap(<button type='button' className='text-xs text-muted-foreground hover:underline'>-</button>)
                      return <span className='text-xs text-muted-foreground'>-</span>
                    }
                    const pct = tr.limit > 0 ? Math.min(100, (tr.used / tr.limit) * 100) : 0
                    const inner = (
                      <div className='w-24 space-y-0.5'>
                        <Progress value={pct} className='h-2' />
                        <span className='text-[10px] text-muted-foreground'>
                          {formatSize(tr.used)}{tr.limit > 0 ? ` / ${formatSize(tr.limit)}` : ''}
                        </span>
                      </div>
                    )
                    return clickable ? wrap(
                      <button type='button' className='block w-24 text-left hover:opacity-80'>{inner}</button>
                    ) : inner
                  },
                },
                {
                  label: t('management.fileList.mobileRuleSyncLabel'),
                  value: (file) => (
                    <div className='flex items-center gap-2'>
                      <Switch checked={file.auto_sync_custom_rules || false} onCheckedChange={(checked) => onToggleAutoSync(file.id, checked)} />
                      <span className='text-xs'>
                        {file.auto_sync_custom_rules ? t('management.fileList.ruleSyncEnabled') : t('management.fileList.ruleSyncDisabled')}
                      </span>
                    </div>
                  ),
                },
              ],
              actions: (file) => (
                <>
                  <Button variant='outline' size='sm' className='flex-1' onClick={() => onEditMetadata(file)} disabled={updateMetadataPending}>
                    <Settings className='mr-1 h-4 w-4' />
                    {t('management.fileList.editInfo')}
                  </Button>
                  <Button variant='outline' size='sm' className='flex-1' onClick={() => onEditConfig(file)}>
                    <Edit className='mr-1 h-4 w-4' />
                    {t('management.fileList.editConfig')}
                  </Button>
                </>
              ),
            }}
          />
        )}
      </CardContent>
    </Card>
  )
}
