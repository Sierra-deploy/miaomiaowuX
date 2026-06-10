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
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, ChevronUp, Edit, Network, Settings, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
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
import { NodePicker, type NodePickerItem } from './node-picker'

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
  selected_node_ids?: number[]
  // 「覆写配置」列下拉:在选定具体规则 / 脚本时持久化为 id 数组
  selected_custom_rule_ids?: number[]
  selected_override_script_ids?: number[]
  latest_version?: number
  updated_at: string
}

// 覆写下拉候选项(从 useSupportData 拿过来后过滤 enabled=true 的最小信息)
export interface OverrideRuleRef {
  id: number
  name: string
  type: string
}
export interface OverrideScriptItemRef {
  id: number
  name: string
  hook: string
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
  // 系统级总开关 `enable_override_scripts` 的副本 — false 时整列「覆写配置」消失。
  // 既然后端只在开关 ON 时跑脚本,前端关掉就别让用户做无效配置(jimlee 实际踩坑)。
  overrideEnabled: boolean
  // 「覆写配置」Popover 下拉所需:启用的规则 / 脚本候选 + 提交回调。父端从 useSupportData 过滤
  // enabled=true 后传入;onUpdateOverrideConfig 内部走 updateMetadataMutation,但只透传需要变的字段
  enabledCustomRules: OverrideRuleRef[]
  enabledOverrideScripts: OverrideScriptItemRef[]
  onUpdateOverrideConfig: (
    file: SubscribeFileRef,
    payload: {
      auto_sync_custom_rules: boolean
      selected_custom_rule_ids: number[]
      selected_override_script_ids: number[]
    },
  ) => void
  // 管理员点击流量列触发 — 改为内嵌 Popover,父端只需提供服务器列表 + 保存回调
  trafficScopeServers?: { id: number; name: string }[]
  onSaveTrafficScope?: (file: SubscribeFileRef, statsServerIds: string) => void
  savingTrafficScope?: boolean
  // "选择节点" Popover:行内快捷入口,父端提供全节点 + 保存回调
  allNodes?: NodePickerItem[]
  onSaveSelectedNodes?: (file: SubscribeFileRef, nodeIds: number[]) => void
  savingSelectedNodes?: boolean
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
  overrideEnabled,
  enabledCustomRules,
  enabledOverrideScripts,
  onUpdateOverrideConfig,
  trafficScopeServers,
  onSaveTrafficScope,
  savingTrafficScope,
  allNodes,
  onSaveSelectedNodes,
  savingSelectedNodes,
  inlineUpdate,
  updateUserShortCode,
  updateMetadataPending,
  deletePending,
}: FilesListSectionProps) {
  const { t } = useTranslation('subscribe')

  // 「覆写配置」Popover 渲染 — desktop 列 + mobile 卡片共用。算法移植自妙妙屋
  // miaomiaowu/src/routes/subscribe-files.index.tsx L2890-3060。
  //
  // 状态机:
  //   - !auto_sync_custom_rules           → 未启用(下拉里「不启用」高亮)
  //   - auto_sync_custom_rules && 两个 id 数组都空 → 全部启用(下拉里「全部启用」高亮)
  //   - 任一数组非空                     → 部分勾选(对应项高亮)
  //
  // 切换语义:
  //   - 当前未启用 → 单独勾某项 = 启用 + 只选该项
  //   - 当前全部启用 → 单独取消某项 = 启用 + 选除该项外全部
  //   - 当前部分勾选 → toggle 该项
  //   - 选项达到全集 → 自动清空回退「全部启用」(避免持久化冗余 ID 列表)
  //   - 全部空 → auto_sync_custom_rules=false (回退「不启用」)
  const renderOverridePopover = (file: SubscribeFileRef, triggerClassName?: string) => {
    const ruleIds = file.selected_custom_rule_ids || []
    const scriptIds = file.selected_override_script_ids || []
    const totalSelected = ruleIds.length + scriptIds.length
    const totalAvailable = enabledCustomRules.length + enabledOverrideScripts.length
    const isEnabled = file.auto_sync_custom_rules

    const triggerLabel = !isEnabled
      ? t('management.fileList.overrideConfigDisabled')
      : totalSelected === 0
        ? t('management.fileList.overrideConfigAll', { count: totalAvailable })
        : t('management.fileList.overrideConfigSelected', { count: totalSelected })

    // 通用 commit:输入两个数组,根据情况持久化。
    //
    // 「全集自动回退」语义:用户在「部分勾选」中继续勾选,直到达到全集时,自动回退成「全部启用」
    // (持久化两个数组都空、auto_sync=true),避免存一堆 ID 列表。
    //
    // 但**只在 isEnabled && totalSelected > 0 时**(即已经在「部分勾选」中)启用回退,
    // 否则从「未启用」点单项时,若 enabledCustomRules / enabledOverrideScripts 只有 1 个,
    // 立刻被误识别为「填满全集」→ 清空 → auto_sync=false → UI 没反应。
    // 这正是「点击创建的覆写脚本无效」的 bug 根因。
    const commit = (newRuleIds: number[], newScriptIds: number[]) => {
      if (
        isEnabled &&
        totalSelected > 0 &&
        newRuleIds.length === enabledCustomRules.length &&
        newScriptIds.length === enabledOverrideScripts.length
      ) {
        newRuleIds = []
        newScriptIds = []
      }
      const allEmpty = newRuleIds.length === 0 && newScriptIds.length === 0
      onUpdateOverrideConfig(file, {
        auto_sync_custom_rules: !allEmpty,
        selected_custom_rule_ids: newRuleIds,
        selected_override_script_ids: newScriptIds,
      })
    }

    const toggleRule = (ruleId: number) => {
      let nextRules: number[]
      let nextScripts: number[]
      if (!isEnabled) {
        nextRules = [ruleId]
        nextScripts = []
      } else if (totalSelected === 0) {
        nextRules = enabledCustomRules.filter((r) => r.id !== ruleId).map((r) => r.id)
        nextScripts = enabledOverrideScripts.map((s) => s.id)
      } else {
        nextRules = ruleIds.includes(ruleId)
          ? ruleIds.filter((id) => id !== ruleId)
          : [...ruleIds, ruleId]
        nextScripts = scriptIds
      }
      commit(nextRules, nextScripts)
    }

    const toggleScript = (scriptId: number) => {
      let nextRules: number[]
      let nextScripts: number[]
      if (!isEnabled) {
        nextScripts = [scriptId]
        nextRules = []
      } else if (totalSelected === 0) {
        nextScripts = enabledOverrideScripts.filter((s) => s.id !== scriptId).map((s) => s.id)
        nextRules = enabledCustomRules.map((r) => r.id)
      } else {
        nextScripts = scriptIds.includes(scriptId)
          ? scriptIds.filter((id) => id !== scriptId)
          : [...scriptIds, scriptId]
        nextRules = ruleIds
      }
      commit(nextRules, nextScripts)
    }

    return (
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant='outline'
            size='sm'
            className={cn('h-8 text-xs justify-between', triggerClassName)}
            disabled={updateMetadataPending}
          >
            <span className='truncate'>{triggerLabel}</span>
            <ChevronDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
          </Button>
        </PopoverTrigger>
        <PopoverContent className='w-[240px] p-1' align='start'>
          <div className='flex max-h-[400px] flex-col overflow-y-auto'>
            <Button
              variant='ghost'
              size='sm'
              className={cn('justify-start text-xs h-8', !isEnabled && 'bg-accent')}
              onClick={() =>
                onUpdateOverrideConfig(file, {
                  auto_sync_custom_rules: false,
                  selected_custom_rule_ids: [],
                  selected_override_script_ids: [],
                })
              }
            >
              {!isEnabled && <Check className='mr-2 h-3 w-3' />}
              <span className={!isEnabled ? '' : 'ml-5'}>
                {t('management.fileList.overrideOptionDisable')}
              </span>
            </Button>
            <Button
              variant='ghost'
              size='sm'
              className={cn(
                'justify-start text-xs h-8',
                isEnabled && totalSelected === 0 && 'bg-accent',
              )}
              onClick={() =>
                onUpdateOverrideConfig(file, {
                  auto_sync_custom_rules: true,
                  selected_custom_rule_ids: [],
                  selected_override_script_ids: [],
                })
              }
            >
              {isEnabled && totalSelected === 0 && <Check className='mr-2 h-3 w-3' />}
              <span className={isEnabled && totalSelected === 0 ? '' : 'ml-5'}>
                {t('management.fileList.overrideOptionEnableAll')}
              </span>
            </Button>
            {enabledCustomRules.length > 0 && (
              <>
                <div className='border-t mt-1 px-2 pt-1.5 py-1.5 text-xs font-medium text-muted-foreground'>
                  {t('management.fileList.overrideGroupCustomRules')}
                </div>
                {enabledCustomRules.map((rule) => {
                  const isSelected =
                    isEnabled && (totalSelected === 0 || ruleIds.includes(rule.id))
                  return (
                    <Button
                      key={`rule-${rule.id}`}
                      variant='ghost'
                      size='sm'
                      className={cn('justify-start text-xs h-8', isSelected && 'bg-accent')}
                      onClick={() => toggleRule(rule.id)}
                    >
                      {isSelected && <Check className='mr-2 h-3 w-3' />}
                      <span className={isSelected ? '' : 'ml-5'}>{rule.name}</span>
                      <Badge variant='outline' className='ml-auto px-1 py-0 text-[10px]'>
                        {rule.type}
                      </Badge>
                    </Button>
                  )
                })}
              </>
            )}
            {enabledOverrideScripts.length > 0 && (
              <>
                <div className='border-t mt-1 px-2 pt-1.5 py-1.5 text-xs font-medium text-muted-foreground'>
                  {t('management.fileList.overrideGroupScripts')}
                </div>
                {enabledOverrideScripts.map((script) => {
                  const isSelected =
                    isEnabled && (totalSelected === 0 || scriptIds.includes(script.id))
                  const hookLabel =
                    script.hook === 'post_fetch'
                      ? t('management.fileList.overrideHookPostFetch')
                      : t('management.fileList.overrideHookPreSaveNodes')
                  return (
                    <Button
                      key={`script-${script.id}`}
                      variant='ghost'
                      size='sm'
                      className={cn('justify-start text-xs h-8', isSelected && 'bg-accent')}
                      onClick={() => toggleScript(script.id)}
                    >
                      {isSelected && <Check className='mr-2 h-3 w-3' />}
                      <span className={isSelected ? '' : 'ml-5'}>{script.name}</span>
                      <Badge variant='outline' className='ml-auto px-1 py-0 text-[10px]'>
                        {hookLabel}
                      </Badge>
                    </Button>
                  )
                })}
              </>
            )}
          </div>
        </PopoverContent>
      </Popover>
    )
  }

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
                // 系统覆写脚本开关关闭时,「覆写配置」列直接从列表里抠掉(用 spread + 三元做条件 column)
                ...(overrideEnabled
                  ? [
                      {
                        header: t('management.fileList.ruleSync'),
                        cell: (file: SubscribeFileRef) => renderOverridePopover(file, 'w-[120px]'),
                        headerClassName: 'text-center',
                        cellClassName: 'text-center',
                        width: '140px',
                      },
                    ]
                  : []),
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
                        {(Array.isArray(templates) ? templates : []).map((tpl) => (
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
                      {/* 选择节点 — 行内 Popover 快捷入口;仅在父端提供 onSaveSelectedNodes 时显示 */}
                      {onSaveSelectedNodes && file.template_filename && (
                        <SelectNodesPopover
                          file={file}
                          allNodes={allNodes ?? []}
                          onSave={onSaveSelectedNodes}
                          saving={Boolean(savingSelectedNodes)}
                        />
                      )}
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
                  width: '180px',
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
                        {(Array.isArray(templates) ? templates : []).map((tpl) => (
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
                // mobile 同款 gate:系统覆写脚本开关关闭时,卡片字段也不渲染
                ...(overrideEnabled
                  ? [
                      {
                        label: t('management.fileList.mobileRuleSyncLabel'),
                        // mobile 同步用 Popover,触发按钮放大到 h-9 触屏友好;align='start' 跟 desktop 一致
                        value: (file: SubscribeFileRef) => renderOverridePopover(file, 'w-full h-9'),
                      },
                    ]
                  : []),
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

// SelectNodesPopover:行内快捷"选择节点"。点击图标打开 Popover,内嵌通用 NodePicker;
// 本地维护草稿态(避免每次 toggle 都发请求),点"保存"才提交回调,关闭时草稿丢弃。
function SelectNodesPopover({
  file,
  allNodes,
  onSave,
  saving,
}: {
  file: SubscribeFileRef
  allNodes: NodePickerItem[]
  onSave: (file: SubscribeFileRef, nodeIds: number[]) => void
  saving: boolean
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<number[]>(file.selected_node_ids ?? [])
  const { t: _t } = useTranslation('subscribe')
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        // 打开时同步当前文件的选择(避免上一个文件的草稿污染)
        if (o) setDraft(file.selected_node_ids ?? [])
      }}
    >
      <PopoverTrigger asChild>
        <Button variant='ghost' size='sm' title='选择节点' disabled={saving}>
          <Network className='h-4 w-4' />
        </Button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[480px] p-3'>
        <div className='space-y-3'>
          <div className='flex items-center justify-between'>
            <div className='text-sm font-medium'>选择该订阅使用的节点</div>
            <div className='text-[10px] text-muted-foreground truncate max-w-[220px]' title={file.name}>
              {file.name}
            </div>
          </div>
          {allNodes.length === 0 ? (
            <div className='text-xs text-muted-foreground border rounded-md p-4 text-center'>暂无节点</div>
          ) : (
            <NodePicker
              allNodes={allNodes}
              selectedNodeIds={draft}
              onChange={setDraft}
              listHeightClass='max-h-72'
              hintText='不选 = 该订阅使用全部节点。'
            />
          )}
          <div className='flex justify-end gap-2 pt-1'>
            <Button variant='outline' size='sm' onClick={() => setOpen(false)} disabled={saving}>
              取消
            </Button>
            <Button
              size='sm'
              onClick={() => {
                onSave(file, draft)
                setOpen(false)
              }}
              disabled={saving || allNodes.length === 0}
            >
              {saving ? '保存中...' : '保存'}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
