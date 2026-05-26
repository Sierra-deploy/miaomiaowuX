import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { getClashProtocolColor } from '@/lib/protocol-colors'

interface ProtocolBadgeProps {
  protocol: string
  className?: string
  // 默认大写显示;某些场景(如生成器节点表)需要原样,可以传 raw=true
  raw?: boolean
}

// Clash 协议徽章 — 节点表格、节点选择、测速等列表里展示节点协议时统一用这个。
// 颜色按 lib/protocol-colors.ts 的 getClashProtocolColor 取(支持链式 "vless ⇋ trojan" 写法)。
export function ProtocolBadge({ protocol, className, raw }: ProtocolBadgeProps) {
  return (
    <Badge variant='secondary' className={cn('text-[10px]', getClashProtocolColor(protocol), className)}>
      {raw ? protocol : (protocol || '?').toUpperCase()}
    </Badge>
  )
}
