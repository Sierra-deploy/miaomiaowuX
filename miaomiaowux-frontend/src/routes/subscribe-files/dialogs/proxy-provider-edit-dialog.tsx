// 代理集合配置对话框 — 创建 / 编辑代理集合(client / mmw 双模式)。
// 从 routes/subscribe-files.index.tsx L4873 提取(原 794 行内联 JSX)。
//
// 设计:所有 form 状态和 mutations 都由父端持有,本组件纯展示 + 调 callback;
// 复杂的 submit 拼装(header JSON / create vs update 分支)上抛 onSave,父端写。
import { useTranslation } from 'react-i18next'
import { Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'

import {
  IP_VERSION_OPTIONS,
  PROXY_TYPES,
  type ProxyProviderForm,
} from '../utils/proxy-provider-form'
import type { OverrideForm } from '../utils/override-form'

// 简化的 editing target — 只用到 id / name(对话标题 + 拼接 url)
export interface ProxyProviderEditTarget {
  id: number
  name: string
}

// 简化的 external sub ref
export interface ExternalSubRef {
  id: number
  name: string
}

interface ProxyProviderEditDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  // 编辑模式 vs 新建模式(为 null 即新建)
  editing: ProxyProviderEditTarget | null
  // 仅新建模式下:外部订阅候选 + 当前选择
  externalSubs: ExternalSubRef[]
  selectedExternalSub: ExternalSubRef | null
  onSelectedExternalSubChange: (sub: ExternalSubRef | null) => void
  // 表单 + setter
  form: ProxyProviderForm
  onFormChange: (next: ProxyProviderForm | ((prev: ProxyProviderForm) => ProxyProviderForm)) => void
  // 用户 token,用于显示 mmw 模式订阅 URL
  userToken?: string
  // 预览 YAML — 父端通过 generateProxyProviderYAML() 算好后传入
  previewYAML: string
  // 提交 — 父端持有 mutations + header 拼装逻辑
  onSave: () => void
  saving: boolean
}

export function ProxyProviderEditDialog({
  open,
  onOpenChange,
  editing,
  externalSubs,
  selectedExternalSub,
  onSelectedExternalSubChange,
  form,
  onFormChange,
  userToken,
  previewYAML,
  onSave,
  saving,
}: ProxyProviderEditDialogProps) {
  const { t } = useTranslation('subscribe')
  const copy = useCopyToClipboard()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[85vh] w-[95vw] overflow-y-auto sm:w-auto sm:!max-w-fit'>
        <DialogHeader>
          <DialogTitle>{editing ? t('proxyProvider.dialog.editTitle') : t('proxyProvider.dialog.createTitle')}</DialogTitle>
          <DialogDescription>
            {editing
              ? t('proxyProvider.dialog.editDesc', { name: editing.name })
              : selectedExternalSub
                ? t('proxyProvider.dialog.createForSubDesc', { name: selectedExternalSub.name })
                : t('proxyProvider.dialog.createNewDesc')}
          </DialogDescription>
        </DialogHeader>
        <div className='w-full sm:w-[600px] sm:max-w-[80vw]'>
          <div className='space-y-6'>
            {/* 基础配置 */}
            <div className='space-y-4'>
              <h4 className='text-sm font-medium'>{t('proxyProvider.dialog.basicConfig')}</h4>
              <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
                {/* 外部订阅选择器 - 仅在创建模式下显示 */}
                {!editing && (
                  <div className='space-y-2 sm:col-span-2'>
                    <Label htmlFor='pp-subscription'>{t('proxyProvider.dialog.externalSubLabel')} *</Label>
                    <select
                      id='pp-subscription'
                      className='border-input flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-sm transition-colors'
                      value={selectedExternalSub?.id || ''}
                      onChange={(e) => {
                        const sub = externalSubs.find((s) => s.id === Number(e.target.value))
                        onSelectedExternalSubChange(sub || null)
                      }}
                    >
                      <option value=''>{t('proxyProvider.dialog.selectExternalSub')}</option>
                      {externalSubs.map((sub) => (
                        <option key={sub.id} value={sub.id}>
                          {sub.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div className='space-y-2'>
                  <Label htmlFor='pp-name'>{t('proxyProvider.dialog.providerName')}</Label>
                  <Input
                    id='pp-name'
                    value={form.name}
                    onChange={(e) => onFormChange((prev) => ({ ...prev, name: e.target.value }))}
                    placeholder={t('proxyProvider.dialog.providerNamePlaceholder')}
                  />
                </div>
                {/* 妙妙屋处理模式显示 URL */}
                {form.process_mode === 'mmw' && (
                  <div className='space-y-2'>
                    <Label>{t('proxyProvider.dialog.subscriptionUrl')}</Label>
                    <div className='flex items-center gap-2'>
                      <Input
                        value={(() => {
                          const baseUrl = typeof window !== 'undefined' ? window.location.origin : ''
                          const configId = editing?.id || '{config_id}'
                          return `${baseUrl}/api/proxy-provider/${configId}?token=${userToken || '{user_token}'}`
                        })()}
                        readOnly
                        className='bg-muted font-mono text-xs'
                      />
                      <Button
                        type='button'
                        variant='outline'
                        size='sm'
                        onClick={() => {
                          const baseUrl = typeof window !== 'undefined' ? window.location.origin : ''
                          const configId = editing?.id || '{config_id}'
                          const url = `${baseUrl}/api/proxy-provider/${configId}?token=${userToken || '{user_token}'}`
                          copy(url, { success: t('proxyProvider.dialog.urlCopied') })
                        }}
                      >
                        <Copy className='h-4 w-4' />
                      </Button>
                    </div>
                    {!editing && (
                      <p className='text-muted-foreground text-xs'>{t('proxyProvider.dialog.configIdHint')}</p>
                    )}
                  </div>
                )}
                <div className='space-y-2'>
                  <Label htmlFor='pp-type'>{t('proxyProvider.dialog.type')}</Label>
                  <select
                    id='pp-type'
                    className='border-input flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-sm transition-colors'
                    value={form.type}
                    onChange={(e) => onFormChange((prev) => ({ ...prev, type: e.target.value }))}
                  >
                    <option value='http'>http</option>
                    <option value='file'>file</option>
                  </select>
                </div>
                <div className='space-y-2'>
                  <Label htmlFor='pp-interval'>{t('proxyProvider.dialog.updateInterval')}</Label>
                  <Input
                    id='pp-interval'
                    type='number'
                    value={form.interval}
                    onChange={(e) => onFormChange((prev) => ({ ...prev, interval: parseInt(e.target.value) || 3600 }))}
                  />
                </div>
                <div className='space-y-2'>
                  <Label htmlFor='pp-proxy'>{t('proxyProvider.dialog.downloadProxy')}</Label>
                  <Input
                    id='pp-proxy'
                    value={form.proxy}
                    onChange={(e) => onFormChange((prev) => ({ ...prev, proxy: e.target.value }))}
                    placeholder='DIRECT'
                  />
                </div>
                <div className='space-y-2'>
                  <Label htmlFor='pp-size-limit'>{t('proxyProvider.dialog.fileSizeLimit')}</Label>
                  <Input
                    id='pp-size-limit'
                    type='number'
                    value={form.size_limit}
                    onChange={(e) => onFormChange((prev) => ({ ...prev, size_limit: parseInt(e.target.value) || 0 }))}
                  />
                </div>
              </div>
            </div>

            {/* 请求头配置 */}
            <div className='space-y-4'>
              <h4 className='text-sm font-medium'>{t('proxyProvider.dialog.requestHeaders')}</h4>
              <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
                <div className='space-y-2'>
                  <Label htmlFor='pp-user-agent'>User-Agent</Label>
                  <Input
                    id='pp-user-agent'
                    value={form.header_user_agent}
                    onChange={(e) => onFormChange((prev) => ({ ...prev, header_user_agent: e.target.value }))}
                    placeholder='Clash/v1.18.0'
                  />
                </div>
                <div className='space-y-2'>
                  <Label htmlFor='pp-authorization'>Authorization</Label>
                  <Input
                    id='pp-authorization'
                    value={form.header_authorization}
                    onChange={(e) => onFormChange((prev) => ({ ...prev, header_authorization: e.target.value }))}
                    placeholder={t('proxyProvider.dialog.authTokenPlaceholder')}
                  />
                </div>
              </div>
            </div>

            {/* 健康检查配置 */}
            <div className='space-y-4'>
              <div className='flex items-center justify-between'>
                <h4 className='text-sm font-medium'>{t('proxyProvider.dialog.healthCheck')}</h4>
                <Switch
                  checked={form.health_check_enabled}
                  onCheckedChange={(checked) =>
                    onFormChange((prev) => ({ ...prev, health_check_enabled: checked }))
                  }
                />
              </div>
              {form.health_check_enabled && (
                <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
                  <div className='space-y-2 sm:col-span-2'>
                    <Label htmlFor='pp-hc-url'>{t('proxyProvider.dialog.healthCheckUrl')}</Label>
                    <Input
                      id='pp-hc-url'
                      value={form.health_check_url}
                      onChange={(e) => onFormChange((prev) => ({ ...prev, health_check_url: e.target.value }))}
                    />
                  </div>
                  <div className='space-y-2'>
                    <Label htmlFor='pp-hc-interval'>{t('proxyProvider.dialog.healthCheckInterval')}</Label>
                    <Input
                      id='pp-hc-interval'
                      type='number'
                      value={form.health_check_interval}
                      onChange={(e) =>
                        onFormChange((prev) => ({ ...prev, health_check_interval: parseInt(e.target.value) || 300 }))
                      }
                    />
                  </div>
                  <div className='space-y-2'>
                    <Label htmlFor='pp-hc-timeout'>{t('proxyProvider.dialog.healthCheckTimeout')}</Label>
                    <Input
                      id='pp-hc-timeout'
                      type='number'
                      value={form.health_check_timeout}
                      onChange={(e) =>
                        onFormChange((prev) => ({ ...prev, health_check_timeout: parseInt(e.target.value) || 5000 }))
                      }
                    />
                  </div>
                  <div className='space-y-2'>
                    <Label htmlFor='pp-hc-status'>{t('proxyProvider.dialog.healthCheckExpectedStatus')}</Label>
                    <Input
                      id='pp-hc-status'
                      type='number'
                      value={form.health_check_expected_status}
                      onChange={(e) =>
                        onFormChange((prev) => ({
                          ...prev,
                          health_check_expected_status: parseInt(e.target.value) || 204,
                        }))
                      }
                    />
                  </div>
                  <div className='flex items-center space-x-2'>
                    <Checkbox
                      id='pp-hc-lazy'
                      checked={form.health_check_lazy}
                      onCheckedChange={(checked) =>
                        onFormChange((prev) => ({ ...prev, health_check_lazy: !!checked }))
                      }
                    />
                    <Label htmlFor='pp-hc-lazy' className='text-sm'>
                      {t('proxyProvider.dialog.lazyMode')}
                    </Label>
                  </div>
                </div>
              )}
            </div>

            {/* 高级配置处理方式 */}
            <div className='space-y-3'>
              <h4 className='text-sm font-medium'>{t('proxyProvider.dialog.advancedProcessMode')}</h4>
              <div className='grid grid-cols-1 gap-2 sm:grid-cols-2'>
                <Button
                  type='button'
                  variant={form.process_mode === 'client' ? 'default' : 'outline'}
                  className='flex h-auto flex-col items-start px-4 py-3 text-left'
                  onClick={() => onFormChange((prev) => ({ ...prev, process_mode: 'client' }))}
                >
                  <span className='font-medium'>{t('proxyProvider.dialog.clientProcessLabel')}</span>
                  <span className='text-xs font-normal opacity-70'>{t('proxyProvider.dialog.clientProcessDesc')}</span>
                </Button>
                <Button
                  type='button'
                  variant={form.process_mode === 'mmw' ? 'default' : 'outline'}
                  className='flex h-auto flex-col items-start px-4 py-3 text-left'
                  onClick={() => onFormChange((prev) => ({ ...prev, process_mode: 'mmw' }))}
                >
                  <span className='font-medium'>{t('proxyProvider.dialog.mmwProcessLabel')}</span>
                  <span className='text-xs font-normal opacity-70'>{t('proxyProvider.dialog.mmwProcessDesc')}</span>
                </Button>
              </div>
            </div>

            {/* 高级配置 */}
            <div className='space-y-4'>
              <h4 className='text-sm font-medium'>
                {t('proxyProvider.dialog.advancedConfig')}{' '}
                {form.process_mode === 'client'
                  ? t('proxyProvider.dialog.advancedConfigOutput')
                  : t('proxyProvider.dialog.advancedConfigMmw')}
              </h4>
              <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
                <div className='space-y-2'>
                  <Label htmlFor='pp-filter'>{t('proxyProvider.dialog.nodeFilter')}</Label>
                  <Input
                    id='pp-filter'
                    value={form.filter}
                    onChange={(e) => onFormChange((prev) => ({ ...prev, filter: e.target.value }))}
                    placeholder={t('proxyProvider.dialog.nodeFilterPlaceholder')}
                  />
                  <p className='text-muted-foreground text-xs'>{t('proxyProvider.dialog.nodeFilterHint')}</p>
                </div>
                <div className='space-y-2'>
                  <Label htmlFor='pp-exclude-filter'>{t('proxyProvider.dialog.nodeExclude')}</Label>
                  <Input
                    id='pp-exclude-filter'
                    value={form.exclude_filter}
                    onChange={(e) => onFormChange((prev) => ({ ...prev, exclude_filter: e.target.value }))}
                    placeholder={t('proxyProvider.dialog.nodeExcludePlaceholder')}
                  />
                  <p className='text-muted-foreground text-xs'>{t('proxyProvider.dialog.nodeExcludeHint')}</p>
                </div>
              </div>
              <div className='space-y-2'>
                <Label>{t('proxyProvider.dialog.excludeProtocolType')}</Label>
                <div className='flex flex-wrap gap-1.5'>
                  {PROXY_TYPES.map((type) => {
                    const isSelected = form.exclude_type.includes(type)
                    return (
                      <Button
                        key={type}
                        type='button'
                        variant={isSelected ? 'default' : 'outline'}
                        size='sm'
                        className='h-7 px-2.5 text-xs'
                        onClick={() => {
                          if (isSelected) {
                            onFormChange((prev) => ({
                              ...prev,
                              exclude_type: prev.exclude_type.filter((tt) => tt !== type),
                            }))
                          } else {
                            onFormChange((prev) => ({ ...prev, exclude_type: [...prev.exclude_type, type] }))
                          }
                        }}
                      >
                        {type}
                      </Button>
                    )
                  })}
                </div>
              </div>
              {/* 覆写配置 */}
              <div className='space-y-3'>
                <h4 className='text-sm font-medium'>{t('proxyProvider.dialog.overrideConfig')}</h4>

                {/* 连接设置 */}
                <div className='space-y-2'>
                  <Label className='text-muted-foreground text-xs'>
                    {t('proxyProvider.dialog.connectionSettings')}
                  </Label>
                  <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
                    <div className='flex items-center justify-between'>
                      <Label htmlFor='pp-override-tfo' className='text-xs'>TCP Fast Open</Label>
                      <Switch
                        id='pp-override-tfo'
                        checked={form.override.tfo}
                        onCheckedChange={(checked) =>
                          onFormChange((prev) => ({ ...prev, override: { ...prev.override, tfo: checked } }))
                        }
                      />
                    </div>
                    <div className='flex items-center justify-between'>
                      <Label htmlFor='pp-override-mptcp' className='text-xs'>Multipath TCP</Label>
                      <Switch
                        id='pp-override-mptcp'
                        checked={form.override.mptcp}
                        onCheckedChange={(checked) =>
                          onFormChange((prev) => ({ ...prev, override: { ...prev.override, mptcp: checked } }))
                        }
                      />
                    </div>
                    <div className='flex items-center justify-between'>
                      <Label htmlFor='pp-override-udp' className='text-xs'>{t('proxyProvider.dialog.enableUdp')}</Label>
                      <Switch
                        id='pp-override-udp'
                        checked={form.override.udp}
                        onCheckedChange={(checked) =>
                          onFormChange((prev) => ({ ...prev, override: { ...prev.override, udp: checked } }))
                        }
                      />
                    </div>
                    <div className='flex items-center justify-between'>
                      <Label htmlFor='pp-override-uot' className='text-xs'>UDP over TCP</Label>
                      <Switch
                        id='pp-override-uot'
                        checked={form.override.udp_over_tcp}
                        onCheckedChange={(checked) =>
                          onFormChange((prev) => ({
                            ...prev,
                            override: { ...prev.override, udp_over_tcp: checked },
                          }))
                        }
                      />
                    </div>
                    <div className='flex items-center justify-between sm:col-span-2'>
                      <Label htmlFor='pp-override-skip-cert' className='text-xs'>
                        {t('proxyProvider.dialog.skipCertVerify')}
                      </Label>
                      <Switch
                        id='pp-override-skip-cert'
                        checked={form.override.skip_cert_verify}
                        onCheckedChange={(checked) =>
                          onFormChange((prev) => ({
                            ...prev,
                            override: { ...prev.override, skip_cert_verify: checked },
                          }))
                        }
                      />
                    </div>
                  </div>
                </div>

                {/* 代理设置 */}
                <div className='space-y-2'>
                  <Label htmlFor='pp-override-dialer-proxy' className='text-muted-foreground text-xs'>
                    {t('proxyProvider.dialog.chainProxy')}
                  </Label>
                  <Input
                    id='pp-override-dialer-proxy'
                    value={form.override.dialer_proxy}
                    onChange={(e) =>
                      onFormChange((prev) => ({
                        ...prev,
                        override: { ...prev.override, dialer_proxy: e.target.value },
                      }))
                    }
                    placeholder={t('proxyProvider.dialog.chainProxyPlaceholder')}
                    className='h-8 text-sm'
                  />
                </div>

                {/* 网络设置 */}
                <div className='space-y-2'>
                  <Label className='text-muted-foreground text-xs'>{t('proxyProvider.dialog.networkSettings')}</Label>
                  <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
                    <div className='space-y-1'>
                      <Label htmlFor='pp-override-interface' className='text-xs'>
                        {t('proxyProvider.dialog.outboundInterface')}
                      </Label>
                      <Input
                        id='pp-override-interface'
                        value={form.override.interface_name}
                        onChange={(e) =>
                          onFormChange((prev) => ({
                            ...prev,
                            override: { ...prev.override, interface_name: e.target.value },
                          }))
                        }
                        placeholder={t('proxyProvider.dialog.outboundInterfacePlaceholder')}
                        className='h-8 text-sm'
                      />
                    </div>
                    <div className='space-y-1'>
                      <Label htmlFor='pp-override-routing-mark' className='text-xs'>
                        {t('proxyProvider.dialog.routingMark')}
                      </Label>
                      <Input
                        id='pp-override-routing-mark'
                        value={form.override.routing_mark}
                        onChange={(e) =>
                          onFormChange((prev) => ({
                            ...prev,
                            override: { ...prev.override, routing_mark: e.target.value },
                          }))
                        }
                        placeholder={t('proxyProvider.dialog.routingMarkPlaceholder')}
                        className='h-8 text-sm'
                      />
                    </div>
                  </div>
                  <div className='space-y-1'>
                    <Label htmlFor='pp-override-ip-version' className='text-xs'>
                      {t('proxyProvider.dialog.ipVersionLabel')}
                    </Label>
                    <Select
                      value={form.override.ip_version}
                      onValueChange={(value) =>
                        onFormChange((prev) => ({
                          ...prev,
                          override: { ...prev.override, ip_version: value as OverrideForm['ip_version'] },
                        }))
                      }
                    >
                      <SelectTrigger id='pp-override-ip-version' className='h-8 text-sm'>
                        <SelectValue placeholder={t('proxyProvider.dialog.ipVersionPlaceholder')} />
                      </SelectTrigger>
                      <SelectContent>
                        {IP_VERSION_OPTIONS.map((opt) => (
                          <SelectItem key={opt.value || '_default'} value={opt.value || '_default'}>
                            {t(`ipVersion.${opt.labelKey}`, { defaultValue: opt.labelKey })}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* 节点名称修改 */}
                <div className='space-y-2'>
                  <Label className='text-muted-foreground text-xs'>{t('proxyProvider.dialog.nodeNameModify')}</Label>
                  <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
                    <div className='space-y-1'>
                      <Label htmlFor='pp-override-prefix' className='text-xs'>
                        {t('proxyProvider.dialog.namePrefix')}
                      </Label>
                      <Input
                        id='pp-override-prefix'
                        value={form.override.additional_prefix}
                        onChange={(e) =>
                          onFormChange((prev) => ({
                            ...prev,
                            override: { ...prev.override, additional_prefix: e.target.value },
                          }))
                        }
                        placeholder={t('proxyProvider.dialog.namePrefixPlaceholder')}
                        className='h-8 text-sm'
                      />
                    </div>
                    <div className='space-y-1'>
                      <Label htmlFor='pp-override-suffix' className='text-xs'>
                        {t('proxyProvider.dialog.nameSuffix')}
                      </Label>
                      <Input
                        id='pp-override-suffix'
                        value={form.override.additional_suffix}
                        onChange={(e) =>
                          onFormChange((prev) => ({
                            ...prev,
                            override: { ...prev.override, additional_suffix: e.target.value },
                          }))
                        }
                        placeholder={t('proxyProvider.dialog.nameSuffixPlaceholder')}
                        className='h-8 text-sm'
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* 生成的配置预览 */}
            <div className='space-y-2'>
              <div className='flex items-center justify-between'>
                <h4 className='text-sm font-medium'>{t('proxyProvider.dialog.configPreview')}</h4>
                <Button
                  variant='outline'
                  size='sm'
                  onClick={() => copy(previewYAML, { success: t('proxyProvider.configCopied') })}
                >
                  <Copy className='mr-1 h-4 w-4' />
                  {t('proxyProvider.dialog.copyBtn')}
                </Button>
              </div>
              <pre className='bg-muted overflow-x-auto rounded-md p-3 text-xs whitespace-pre-wrap'>{previewYAML}</pre>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            {t('actions.cancel', { ns: 'common' })}
          </Button>
          <Button onClick={onSave} disabled={!form.name || (!editing && !selectedExternalSub) || saving}>
            {editing ? t('proxyProvider.dialog.updateConfig') : t('proxyProvider.dialog.saveConfig')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
