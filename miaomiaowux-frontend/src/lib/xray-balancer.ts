// xray 路由负载均衡器(balancer)的共享类型与转换工具。
// routing-panel(服务管理) 与 node-routing-dialog(节点管理) 共用,保证 schema 与 observatory 派生一致。

export interface Balancer {
  tag: string
  selector: string[]
  strategy: 'random' | 'roundRobin' | 'leastPing' | 'leastLoad'
  fallbackTag?: string
  // probeURL/probeInterval 仅用于 UI 派生 observatory,不写进 xray 的 balancer 对象。
  probeURL?: string
  probeInterval?: string
}

export const DEFAULT_PROBE_URL = 'https://www.gstatic.com/generate_204'
export const DEFAULT_PROBE_INTERVAL = '10s'

// 策略本地化:给定 t 函数(xray 命名空间)+ 策略 key,返回当前语言下的策略文案;
// 兜底返回 strategy 原值,避免老/未知策略显示空白。
export function balancerStrategyLabel(t: (key: string) => string, strategy: string | undefined): string {
  const s = (strategy || 'random') as Balancer['strategy']
  const map: Record<Balancer['strategy'], string> = {
    random: 'balancerStrategyRandom',
    roundRobin: 'balancerStrategyRoundRobin',
    leastPing: 'balancerStrategyLeastPing',
    leastLoad: 'balancerStrategyLeastLoad',
  }
  return map[s] ? t(`routing.${map[s]}`) : s
}

// normalizeBalancers: 把 xray 原生 balancers(strategy 为对象 {type}) 归一化成 UI 形态(strategy 字符串)。
export function normalizeBalancers(raw: any): Balancer[] {
  return (raw || []).map((b: any) => ({
    tag: b.tag,
    selector: b.selector || [],
    strategy: (typeof b.strategy === 'object' ? b.strategy?.type : b.strategy) || 'random',
    fallbackTag: b.fallbackTag,
  }))
}

// toXrayBalancers: 把 UI 形态转回 xray 原生 schema(strategy 为对象;不含 probe 字段)。
export function toXrayBalancers(balancers: Balancer[]): any[] {
  return balancers.map((b) => {
    const xb: any = { tag: b.tag, selector: b.selector, strategy: { type: b.strategy } }
    if (b.fallbackTag) xb.fallbackTag = b.fallbackTag
    return xb
  })
}

// buildObservatory: 从 balancers 派生 xray 顶层观测站。leastPing→observatory,leastLoad→burstObservatory。
// 取所有该策略 balancer 的 selector 并集作为 subjectSelector;无匹配返回 null(表示清除观测站)。
export function buildObservatory(balancers: Balancer[], strategyType: 'leastPing' | 'leastLoad') {
  const subjects = new Set<string>()
  let probeURL = DEFAULT_PROBE_URL
  let probeInterval = DEFAULT_PROBE_INTERVAL
  for (const b of balancers) {
    if (b.strategy === strategyType) {
      for (const s of b.selector || []) subjects.add(s)
      if (b.probeURL) probeURL = b.probeURL
      if (b.probeInterval) probeInterval = b.probeInterval
    }
  }
  if (subjects.size === 0) return null
  return { subjectSelector: [...subjects], probeURL, probeInterval }
}
