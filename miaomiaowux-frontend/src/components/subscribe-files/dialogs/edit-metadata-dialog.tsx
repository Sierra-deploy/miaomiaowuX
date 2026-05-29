import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

export interface MetadataFormData {
  name: string
  description: string
  filename: string
  template_filename: string
  selected_tags: string[]
  selected_custom_rule_ids: number[]
  selected_override_script_ids: number[]
  stats_server_ids: string
  traffic_limit: string
  custom_short_code: string
  raw_output: boolean
}

interface TemplateRef {
  filename: string
  name?: string
}
interface CustomRuleRef {
  id: number
  name: string
  type: string
}
interface OverrideScriptRef {
  id: number
  name: string
  hook: string
}
interface RemoteServerRef {
  id: number
  name: string
}

interface EditMetadataDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  form: MetadataFormData
  // setter 接收 next 或 (prev) => next,与原 inline 写法兼容
  onFormChange: (next: MetadataFormData | ((prev: MetadataFormData) => MetadataFormData)) => void
  // 候选数据(全部可选,空数组时对应 section 不渲染)
  templates: TemplateRef[]
  customRules: CustomRuleRef[]
  overrideScripts: OverrideScriptRef[]
  nodeTags: string[]
  remoteServers: RemoteServerRef[]
  // 提交回调,父端负责真正调 mutation
  onSubmit: () => void
  saving: boolean
  // 管理员限定字段:文件名 / 流量统计服务器 / 流量上限 / 自定义短码 — 非管理员隐藏
  isAdmin?: boolean
}

// "编辑订阅信息"对话框:名称/描述/文件名/模板/规则/脚本/节点标签/流量统计服务器/流量上限/短码/原始输出。
// 从 routes/subscribe-files.index.tsx L4791 提取,JSX 1:1。所有状态 + mutation 仍由父端持有。
export function EditMetadataDialog({
  open,
  onOpenChange,
  form,
  onFormChange,
  templates,
  customRules,
  overrideScripts,
  nodeTags,
  remoteServers,
  onSubmit,
  saving,
  isAdmin = false,
}: EditMetadataDialogProps) {
  const { t } = useTranslation('subscribe')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>{t('editMetadata.title')}</DialogTitle>
          <DialogDescription>{t('editMetadata.description')}</DialogDescription>
        </DialogHeader>
        <ScrollArea className='max-h-[70vh]'>
          <div className='space-y-4 py-4 pr-4'>
            <div className='space-y-2'>
              <Label htmlFor='metadata-name'>{t('form.subscriptionName')} *</Label>
              <Input
                id='metadata-name'
                value={form.name}
                onChange={(e) => onFormChange({ ...form, name: e.target.value })}
                placeholder={t('editMetadata.namePlaceholder')}
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='metadata-description'>
                {t('form.description')} ({t('actions.optional', { ns: 'common' })})
              </Label>
              <Textarea
                id='metadata-description'
                value={form.description}
                onChange={(e) => onFormChange({ ...form, description: e.target.value })}
                placeholder={t('editMetadata.descriptionPlaceholder')}
                rows={3}
              />
            </div>
            {isAdmin && (
              <div className='space-y-2'>
                <Label htmlFor='metadata-filename'>{t('form.filename')} *</Label>
                <Input
                  id='metadata-filename'
                  value={form.filename}
                  onChange={(e) => onFormChange({ ...form, filename: e.target.value })}
                  placeholder={t('editMetadata.filenamePlaceholder')}
                />
                <p className='text-muted-foreground text-xs'>{t('editMetadata.filenameHint')}</p>
              </div>
            )}
            <div className='space-y-2'>
              <Label>V3 模板</Label>
              <Select
                value={form.template_filename}
                onValueChange={(v) =>
                  onFormChange((prev) => ({ ...prev, template_filename: v === '__none__' ? '' : v }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder='不使用模板' />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='__none__'>不使用模板</SelectItem>
                  {templates.map((tpl) => (
                    <SelectItem key={tpl.filename} value={tpl.filename}>
                      {tpl.name || tpl.filename}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {customRules.length > 0 && (
              <div className='space-y-2'>
                <Label>生效的覆写规则</Label>
                <p className='text-muted-foreground text-xs'>
                  不勾选则该订阅应用你全部启用的覆写规则;勾选后仅应用所选规则。
                </p>
                <div className='flex flex-col gap-1.5 rounded-md border p-2 max-h-40 overflow-y-auto'>
                  {customRules.map((rule) => (
                    <label key={rule.id} className='flex items-center gap-2 text-sm'>
                      <Checkbox
                        checked={form.selected_custom_rule_ids.includes(rule.id)}
                        onCheckedChange={(checked) => {
                          onFormChange((prev) => ({
                            ...prev,
                            selected_custom_rule_ids:
                              checked === true
                                ? [...prev.selected_custom_rule_ids, rule.id]
                                : prev.selected_custom_rule_ids.filter((id) => id !== rule.id),
                          }))
                        }}
                      />
                      <span>
                        {rule.name} <span className='text-muted-foreground'>({rule.type})</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            {overrideScripts.length > 0 && (
              <div className='space-y-2'>
                <Label>生效的覆写脚本</Label>
                <p className='text-muted-foreground text-xs'>
                  不勾选则该订阅应用你全部启用的覆写脚本;勾选后仅应用所选脚本。
                </p>
                <div className='flex flex-col gap-1.5 rounded-md border p-2 max-h-40 overflow-y-auto'>
                  {overrideScripts.map((script) => (
                    <label key={script.id} className='flex items-center gap-2 text-sm'>
                      <Checkbox
                        checked={form.selected_override_script_ids.includes(script.id)}
                        onCheckedChange={(checked) => {
                          onFormChange((prev) => ({
                            ...prev,
                            selected_override_script_ids:
                              checked === true
                                ? [...prev.selected_override_script_ids, script.id]
                                : prev.selected_override_script_ids.filter((id) => id !== script.id),
                          }))
                        }}
                      />
                      <span>
                        {script.name} <span className='text-muted-foreground'>({script.hook})</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            {form.template_filename && nodeTags.length > 0 && (
              <div className='space-y-2'>
                <Label>节点标签筛选</Label>
                <div className='flex flex-wrap gap-2'>
                  {nodeTags.map((tag) => (
                    <label key={tag} className='flex items-center gap-1.5 text-sm'>
                      <Checkbox
                        checked={form.selected_tags.includes(tag)}
                        onCheckedChange={(checked) => {
                          onFormChange((prev) => ({
                            ...prev,
                            selected_tags: checked ? [...prev.selected_tags, tag] : prev.selected_tags.filter((t) => t !== tag),
                          }))
                        }}
                      />
                      {tag}
                    </label>
                  ))}
                </div>
                <p className='text-xs text-muted-foreground'>不选则包含所有节点</p>
              </div>
            )}
            {isAdmin && (
              <>
                <div className='space-y-2'>
                  <Label>流量统计服务器</Label>
                  <div className='flex flex-wrap gap-2'>
                    {remoteServers.map((server) => {
                      const selected = form.stats_server_ids.split(',').filter(Boolean).includes(String(server.id))
                      return (
                        <label key={server.id} className='flex items-center gap-1.5 text-sm'>
                          <Checkbox
                            checked={selected}
                            onCheckedChange={(checked) => {
                              onFormChange((prev) => {
                                const ids = prev.stats_server_ids.split(',').filter(Boolean)
                                const newIds = checked
                                  ? [...ids, String(server.id)]
                                  : ids.filter((id) => id !== String(server.id))
                                return { ...prev, stats_server_ids: newIds.join(',') }
                              })
                            }}
                          />
                          {server.name}
                        </label>
                      )
                    })}
                  </div>
                  <p className='text-xs text-muted-foreground'>不选则汇总所有服务器流量</p>
                </div>
                <div className='space-y-2'>
                  <Label>流量上限 (GB)</Label>
                  <Input
                    type='number'
                    placeholder='留空则跟随服务器'
                    value={form.traffic_limit}
                    onChange={(e) => onFormChange((prev) => ({ ...prev, traffic_limit: e.target.value }))}
                  />
                </div>
                <div className='space-y-2'>
                  <Label>自定义短码</Label>
                  <Input
                    placeholder='留空使用自动生成'
                    value={form.custom_short_code}
                    onChange={(e) => onFormChange((prev) => ({ ...prev, custom_short_code: e.target.value }))}
                  />
                </div>
              </>
            )}
            <div className='flex items-center justify-between'>
              <Label>原始输出</Label>
              <Switch
                checked={form.raw_output}
                onCheckedChange={(v) => onFormChange((prev) => ({ ...prev, raw_output: v }))}
              />
            </div>
          </div>
        </ScrollArea>
        <DialogFooter>
          <Button variant='outline' onClick={() => onOpenChange(false)} disabled={saving}>
            {t('actions.cancel', { ns: 'common' })}
          </Button>
          <Button onClick={onSubmit} disabled={saving}>
            {saving ? t('actions.saving', { ns: 'common' }) : t('actions.save', { ns: 'common' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
