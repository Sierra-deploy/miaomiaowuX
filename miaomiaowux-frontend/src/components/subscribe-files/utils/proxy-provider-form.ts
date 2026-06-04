// 代理集合 form 的类型 + 默认值 + 协议类型常量。从主文件抽出,供 dialog / 主页面共用。
import { defaultOverrideForm, type OverrideForm } from './override-form'

// 与主文件 ProxyProviderConfig 表对应的表单 shape
export type ProxyProviderForm = {
  name: string
  type: string
  interval: number
  proxy: string
  size_limit: number
  header_user_agent: string
  header_authorization: string
  health_check_enabled: boolean
  health_check_url: string
  health_check_interval: number
  health_check_timeout: number
  health_check_lazy: boolean
  health_check_expected_status: number
  filter: string
  exclude_filter: string
  exclude_type: string[]
  override: OverrideForm
  process_mode: 'client' | 'mmw'
}

export const defaultProxyProviderForm: ProxyProviderForm = {
  name: '',
  type: 'http',
  interval: 3600,
  proxy: 'DIRECT',
  size_limit: 0,
  header_user_agent: 'Clash/v1.18.0',
  header_authorization: '',
  health_check_enabled: true,
  health_check_url: 'https://www.gstatic.com/generate_204',
  health_check_interval: 300,
  health_check_timeout: 5000,
  health_check_lazy: true,
  health_check_expected_status: 204,
  filter: '',
  exclude_filter: '',
  exclude_type: [],
  override: { ...defaultOverrideForm },
  process_mode: 'client',
}

// 代理协议类型列表(与主文件 PROXY_TYPES 一致)
// 注:lib/template-v3-utils.ts 也有 PROXY_TYPES,内容相同,但属于另一个独立子库,各自维护
export const PROXY_TYPES = [
  'vmess',
  'vless',
  'trojan',
  'ss',
  'ssr',
  'socks5',
  'http',
  'hysteria',
  'hysteria2',
  'tuic',
  'wireguard',
  'anytls',
]

export const IP_VERSION_OPTIONS: Array<{ value: '' | OverrideForm['ip_version']; labelKey: string }> = [
  { value: '', labelKey: 'default' },
  { value: 'dual', labelKey: 'dual' },
  { value: 'ipv4', labelKey: 'ipv4' },
  { value: 'ipv6', labelKey: 'ipv6' },
  { value: 'ipv4-prefer', labelKey: 'ipv4-prefer' },
  { value: 'ipv6-prefer', labelKey: 'ipv6-prefer' },
]
