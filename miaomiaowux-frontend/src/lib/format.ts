// 流量 / 速度 / 容量统一格式化工具。
//
// 历史上 formatBytes / formatTraffic / formatSpeed 在 5 个 routes 文件里被复制了 5 份,
// 风格各异(有的 .toFixed(2),有的变精度,有的 "K/s" vs "KB/s")。本模块给出两套:
//   - "标准版" (.toFixed(2) 固定 2 位)适合"已用流量 / 限额"等中间精度场景
//   - "短版"   (变精度 + 短后缀 K/M/G)适合 dashboard 紧凑展示
//
// 不替换 lib/sublink/utils.ts 里的 formatBytes(那是订阅子库内部使用,语义略有不同 — 它保留 trailing 0 抑制)。

const KIB = 1024

// 标准流量格式化:B 无小数;KB+ 固定 2 位小数。
// 与 xray-servers / users / subscribe-files 原内联实现行为一致。
export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(KIB)))
  if (i === 0) return `${bytes} B`
  return `${(bytes / Math.pow(KIB, i)).toFixed(2)} ${units[i]}`
}

// 标准速率格式化:B/s 整数;KB/s 1 位;MB/s+ 2 位。
// 与 xray-servers 原内联实现一致。
export function formatSpeed(bytesPerSec: number): string {
  if (!bytesPerSec) return '0 B/s'
  if (bytesPerSec < KIB) return `${Math.round(bytesPerSec)} B/s`
  if (bytesPerSec < KIB * KIB) return `${(bytesPerSec / KIB).toFixed(1)} KB/s`
  if (bytesPerSec < KIB * KIB * KIB) return `${(bytesPerSec / KIB / KIB).toFixed(2)} MB/s`
  return `${(bytesPerSec / KIB / KIB / KIB).toFixed(2)} GB/s`
}

// 永远以 GB 显示,2 位小数。subscribe-files 外部订阅流量字段专用。
export function formatTrafficGB(bytes: number): string {
  return `${(bytes / (KIB * KIB * KIB)).toFixed(2)} GB`
}

// dashboard 紧凑短版:KB 1 位、MB/GB/TB 2 位。
// 与 routes/index.tsx 原内联 formatBytes 一致。
export function formatBytesShort(bytes: number): string {
  if (!bytes) return '0 B'
  if (bytes < KIB) return `${bytes} B`
  if (bytes < KIB * KIB) return `${(bytes / KIB).toFixed(1)} KB`
  if (bytes < KIB * KIB * KIB) return `${(bytes / KIB / KIB).toFixed(2)} MB`
  if (bytes < KIB * KIB * KIB * KIB) return `${(bytes / KIB / KIB / KIB).toFixed(2)} GB`
  return `${(bytes / KIB / KIB / KIB / KIB).toFixed(2)} TB`
}

// dashboard 紧凑短版速率:K/s, M/s, G/s 短后缀,整数四舍五入。
// 与 routes/index.tsx 原内联 formatSpeed 一致。
export function formatSpeedShort(bytesPerSec: number): string {
  if (!bytesPerSec) return '0 B/s'
  if (bytesPerSec < KIB) return `${Math.round(bytesPerSec)} B/s`
  if (bytesPerSec < KIB * KIB) return `${Math.round(bytesPerSec / KIB)} K/s`
  if (bytesPerSec < KIB * KIB * KIB) return `${Math.round(bytesPerSec / KIB / KIB)} M/s`
  return `${Math.round(bytesPerSec / KIB / KIB / KIB)} G/s`
}
