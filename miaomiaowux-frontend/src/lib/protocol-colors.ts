// 协议名 → tailwind 颜色类。
//
// 项目里有两套协议命名:
//   - Xray 侧:VLESS / VMess / Trojan / Shadowsocks2022 / Socks5 / Hysteria2 / HTTP / Tunnel / Freedom / Blackhole(PascalCase)
//   - Clash 侧:vmess / vless / trojan / ss / shadowsocks / socks5 / hysteria / hysteria2 / tuic / anytls / wireguard(lowercase)
// 两套样式也不一样:Xray wizard 用 text-color(在 Button 上),Clash badge 用 bg+text(在 Badge 上)。
// 所以分两个 helper,各取并集自原 5 处复制定义。

// Xray 协议(text-color,用于 wizard 选择按钮)
const XRAY_PROTOCOL_COLORS: Record<string, string> = {
  VLESS: 'text-purple-700 dark:text-purple-400',
  VMess: 'text-blue-700 dark:text-blue-400',
  Trojan: 'text-red-700 dark:text-red-400',
  Shadowsocks2022: 'text-green-700 dark:text-green-400',
  Socks5: 'text-yellow-700 dark:text-yellow-400',
  Hysteria2: 'text-teal-700 dark:text-teal-400',
  HTTP: 'text-cyan-700 dark:text-cyan-400',
  Tunnel: 'text-orange-700 dark:text-orange-400',
  Freedom: 'text-emerald-700 dark:text-emerald-400',
  Blackhole: 'text-gray-700 dark:text-gray-400',
}

export function getXrayProtocolColor(name: string): string {
  return XRAY_PROTOCOL_COLORS[name] || 'text-gray-700 dark:text-gray-400'
}

// Clash 协议(bg + text,用于节点 Badge)
const CLASH_PROTOCOL_COLORS: Record<string, string> = {
  vmess: 'bg-blue-500/10 text-blue-700 dark:text-blue-400',
  vless: 'bg-purple-500/10 text-purple-700 dark:text-purple-400',
  trojan: 'bg-red-500/10 text-red-700 dark:text-red-400',
  ss: 'bg-green-500/10 text-green-700 dark:text-green-400',
  shadowsocks: 'bg-green-500/10 text-green-700 dark:text-green-400',
  socks5: 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400',
  hysteria: 'bg-pink-500/10 text-pink-700 dark:text-pink-400',
  hysteria2: 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-400',
  tuic: 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-400',
  anytls: 'bg-teal-500/10 text-teal-700 dark:text-teal-400',
  wireguard: 'bg-orange-500/10 text-orange-700 dark:text-orange-400',
}

// getClashProtocolColor:大小写不敏感,支持 generator 的链式代理 "vless ⇋ trojan" 写法(取首段)。
export function getClashProtocolColor(protocol: string): string {
  if (!protocol) return ''
  const normalized = protocol.toLowerCase().split('⇋')[0].trim()
  return CLASH_PROTOCOL_COLORS[normalized] || ''
}
