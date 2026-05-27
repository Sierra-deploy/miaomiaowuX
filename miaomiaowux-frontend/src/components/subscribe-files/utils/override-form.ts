// 订阅文件 override 表单的纯工具:类型、默认值、表单 ↔ JSON 互转。
// 从 routes/subscribe-files.index.tsx 提取出来,作为 B1 拆分的第一步(零行为变更,零状态)。

export type OverrideForm = {
  tfo: boolean
  mptcp: boolean
  udp: boolean
  udp_over_tcp: boolean
  skip_cert_verify: boolean
  dialer_proxy: string
  interface_name: string
  routing_mark: string
  ip_version: '' | 'dual' | 'ipv4' | 'ipv6' | 'ipv4-prefer' | 'ipv6-prefer'
  additional_prefix: string
  additional_suffix: string
}

export const defaultOverrideForm: OverrideForm = {
  tfo: false,
  mptcp: false,
  udp: true,
  udp_over_tcp: false,
  skip_cert_verify: false,
  dialer_proxy: '',
  interface_name: '',
  routing_mark: '',
  ip_version: '',
  additional_prefix: '',
  additional_suffix: '',
}

// Override 表单转 JSON(保存时)。
// 只持久化非默认值字段,避免在订阅文件 override 段塞一堆 udp: true / tfo: false 等冗余。
export function overrideFormToJSON(form: OverrideForm): string {
  const obj: Record<string, any> = {}

  if (form.tfo) obj['tfo'] = true
  if (form.mptcp) obj['mptcp'] = true
  if (!form.udp) obj['udp'] = false // udp 默认 true,只在被关掉时序列化
  if (form.udp_over_tcp) obj['udp-over-tcp'] = true
  if (form.skip_cert_verify) obj['skip-cert-verify'] = true
  if (form.dialer_proxy) obj['dialer-proxy'] = form.dialer_proxy
  if (form.interface_name) obj['interface-name'] = form.interface_name
  if (form.routing_mark) obj['routing-mark'] = parseInt(form.routing_mark)
  if (form.ip_version) obj['ip-version'] = form.ip_version
  if (form.additional_prefix) obj['additional-prefix'] = form.additional_prefix
  if (form.additional_suffix) obj['additional-suffix'] = form.additional_suffix

  return Object.keys(obj).length > 0 ? JSON.stringify(obj) : ''
}

// JSON 转 Override 表单(编辑时)。解析失败回退到默认值。
export function jsonToOverrideForm(json: string): OverrideForm {
  if (!json) return { ...defaultOverrideForm }

  try {
    const obj = JSON.parse(json)
    return {
      tfo: obj['tfo'] ?? false,
      mptcp: obj['mptcp'] ?? false,
      udp: obj['udp'] ?? true,
      udp_over_tcp: obj['udp-over-tcp'] ?? false,
      skip_cert_verify: obj['skip-cert-verify'] ?? false,
      dialer_proxy: obj['dialer-proxy'] ?? '',
      interface_name: obj['interface-name'] ?? '',
      routing_mark: obj['routing-mark']?.toString() ?? '',
      ip_version: obj['ip-version'] ?? '',
      additional_prefix: obj['additional-prefix'] ?? '',
      additional_suffix: obj['additional-suffix'] ?? '',
    }
  } catch {
    return { ...defaultOverrideForm }
  }
}
