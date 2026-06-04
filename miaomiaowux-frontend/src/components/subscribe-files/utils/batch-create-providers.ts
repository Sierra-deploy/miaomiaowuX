// 批量创建代理集合 — 按地区 / 按协议。
// 抽自 subscribe-files.index.tsx 的 handleBatchCreateByRegion / handleBatchCreateByProtocol。
//
// 使用 MMW 模式(妙妙屋处理),因为按地区需要 GeoIP 匹配仅 MMW 支持,
// 按协议保持一致也走 MMW。state 全部由调用方持有,这里只承接异步流程。
import { api } from '@/lib/api'
import { toast } from 'sonner'

type Translator = (key: string, vars?: Record<string, any>) => string

interface CreationResult {
  name: string
  success: boolean
  error?: string
  skipped?: boolean
}

// 地域分裂配置
// countryCode 用于 GeoIP 匹配(仅 MMW 模式生效)
export const REGION_CONFIGS = [
  {
    name: '香港节点',
    emoji: '🇭🇰',
    filter: '🇭🇰|港|HK|hk|Hong Kong|HongKong|hongkong',
    countryCode: 'HK',
  },
  {
    name: '美国节点',
    emoji: '🇺🇸',
    filter:
      '🇺🇸|美|波特兰|达拉斯|俄勒冈|凤凰城|费利蒙|硅谷|拉斯维加斯|洛杉矶|圣何塞|圣克拉拉|西雅图|芝加哥|US|United States|UnitedStates',
    countryCode: 'US',
  },
  {
    name: '日本节点',
    emoji: '🇯🇵',
    filter: '🇯🇵|日本|川日|东京|大阪|泉日|埼玉|沪日|深日|JP|Japan',
    countryCode: 'JP',
  },
  {
    name: '新加坡节点',
    emoji: '🇸🇬',
    filter: '🇸🇬|新加坡|坡|狮城|SG|Singapore',
    countryCode: 'SG',
  },
  {
    name: '台湾节点',
    emoji: '🇹🇼',
    filter: '🇹🇼|台|新北|彰化|TW|Taiwan',
    countryCode: 'TW',
  },
  {
    name: '韩国节点',
    emoji: '🇰🇷',
    filter: '🇰🇷|韩|KR|Korea|KOR|首尔',
    countryCode: 'KR',
  },
  {
    name: '加拿大节点',
    emoji: '🇨🇦',
    filter: '🇨🇦|加拿大|CA|Canada',
    countryCode: 'CA',
  },
  {
    name: '英国节点',
    emoji: '🇬🇧',
    filter: '🇬🇧|英|UK|伦敦|英格兰|GB|United Kingdom',
    countryCode: 'GB',
  },
  {
    name: '法国节点',
    emoji: '🇫🇷',
    filter: '🇫🇷|法|FR|France|巴黎',
    countryCode: 'FR',
  },
  {
    name: '德国节点',
    emoji: '🇩🇪',
    filter: '🇩🇪|德|DE|Germany|法兰克福',
    countryCode: 'DE',
  },
  {
    name: '荷兰节点',
    emoji: '🇳🇱',
    filter: '🇳🇱|荷|NL|Netherlands|阿姆斯特丹',
    countryCode: 'NL',
  },
  {
    name: '土耳其节点',
    emoji: '🇹🇷',
    filter: '🇹🇷|土耳其|TR|Turkey|伊斯坦布尔',
    countryCode: 'TR',
  },
  {
    name: '其他地区',
    emoji: '🌍',
    filter: '',
    excludeFilter:
      '🇭🇰|🇺🇸|🇯🇵|🇸🇬|🇹🇼|🇰🇷|🇨🇦|🇬🇧|🇫🇷|🇩🇪|🇳🇱|🇹🇷|港|HK|hk|Hong Kong|HongKong|hongkong|美|波特兰|达拉斯|俄勒冈|凤凰城|费利蒙|硅谷|拉斯维加斯|洛杉矶|圣何塞|圣克拉拉|西雅图|芝加哥|US|United States|UnitedStates|日本|川日|东京|大阪|泉日|埼玉|沪日|深日|JP|Japan|新加坡|坡|狮城|SG|Singapore|台|新北|彰化|TW|Taiwan|韩|KR|Korea|KOR|首尔|加拿大|CA|Canada|英|UK|伦敦|英格兰|GB|United Kingdom|法|FR|France|巴黎|德|DE|Germany|法兰克福|荷|NL|Netherlands|阿姆斯特丹|土耳其|TR|Turkey|伊斯坦布尔',
    countryCode: '',
  },
]

// 协议分裂配置
export const PROTOCOL_CONFIGS = [
  {
    name: 'anytls',
    excludeType: 'wireguard|vmess|vless|trojan|ss|socks5|http|ssr|hysteria|tuic|hysteria2',
  },
  {
    name: 'wireguard',
    excludeType: 'anytls|vmess|vless|trojan|ss|socks5|http|ssr|hysteria|tuic|hysteria2',
  },
  {
    name: 'vmess',
    excludeType: 'anytls|wireguard|vless|trojan|ss|socks5|http|ssr|hysteria|tuic|hysteria2',
  },
  {
    name: 'vless',
    excludeType: 'anytls|wireguard|vmess|trojan|ss|socks5|http|ssr|hysteria|tuic|hysteria2',
  },
  {
    name: 'trojan',
    excludeType: 'anytls|wireguard|vmess|vless|ss|socks5|http|ssr|hysteria|tuic|hysteria2',
  },
  {
    name: 'ss',
    excludeType: 'anytls|wireguard|vmess|vless|trojan|socks5|http|ssr|hysteria|tuic|hysteria2',
  },
  {
    name: 'socks5',
    excludeType: 'anytls|wireguard|vmess|vless|trojan|ss|http|ssr|hysteria|tuic|hysteria2',
  },
  {
    name: 'http',
    excludeType: 'anytls|wireguard|vmess|vless|trojan|ss|socks5|ssr|hysteria|tuic|hysteria2',
  },
  {
    name: 'ssr',
    excludeType: 'anytls|wireguard|vmess|vless|trojan|ss|socks5|http|hysteria|tuic|hysteria2',
  },
  {
    name: 'hysteria',
    excludeType: 'anytls|wireguard|vmess|vless|trojan|ss|socks5|http|ssr|tuic|hysteria2',
  },
  {
    name: 'tuic',
    excludeType: 'anytls|wireguard|vmess|vless|trojan|ss|socks5|http|ssr|hysteria|hysteria2',
  },
  {
    name: 'hysteria2',
    excludeType: 'anytls|wireguard|vmess|vless|trojan|ss|socks5|http|ssr|hysteria|tuic',
  },
]

interface BatchByRegionOpts {
  selectedExternalSub: { id: number } | null
  namePrefix: string
  enableGeoIPMatching: boolean
  setCreating: (v: boolean) => void
  setResults: (v: CreationResult[]) => void
  setNamePrefix: (v: string) => void
  invalidateProviders: () => void
  t: Translator
}

export async function batchCreateByRegion(opts: BatchByRegionOpts): Promise<void> {
  const {
    selectedExternalSub,
    namePrefix,
    enableGeoIPMatching,
    setCreating,
    setResults,
    setNamePrefix,
    invalidateProviders,
    t,
  } = opts

  if (!selectedExternalSub) {
    toast.error(t('toast.selectExternalSub'))
    return
  }
  if (!namePrefix.trim()) {
    toast.error(t('toast.enterNamePrefix'))
    return
  }

  setCreating(true)
  setResults([])
  const results: CreationResult[] = []
  const prefix = namePrefix.trim()

  // 先获取外部订阅的节点名称列表(仅用于非 GeoIP 模式)
  let nodeNames: string[] = []
  if (!enableGeoIPMatching) {
    try {
      const response = await api.get(
        `/api/user/external-subscriptions/nodes?id=${selectedExternalSub.id}`,
      )
      nodeNames = response.data.node_names || []
    } catch (error: any) {
      toast.error(t('toast.getNodeListFailed') + (error.response?.data?.error || error.message))
      setCreating(false)
      return
    }

    if (nodeNames.length === 0) {
      toast.error(t('toast.noNodesInSub'))
      setCreating(false)
      return
    }
  }

  // 非 GeoIP 模式的本地正则检查
  const checkRegionHasNodesLocal = (filter: string, excludeFilter?: string): boolean => {
    if (!filter && !excludeFilter) return true
    let matched = nodeNames
    if (filter) {
      const re = new RegExp(filter)
      matched = matched.filter((n) => re.test(n))
    }
    if (excludeFilter) {
      const re = new RegExp(excludeFilter)
      matched = matched.filter((n) => !re.test(n))
    }
    return matched.length > 0
  }

  // GeoIP 模式走后端 API
  const checkRegionHasNodes = async (
    filter: string,
    excludeFilter?: string,
    geoIPFilter?: string,
  ): Promise<boolean> => {
    if (enableGeoIPMatching) {
      try {
        const response = await api.post('/api/user/external-subscriptions/check-filter', {
          subscription_id: selectedExternalSub.id,
          filter: filter || '',
          exclude_filter: excludeFilter || '',
          geo_ip_filter: geoIPFilter || '',
        })
        return response.data.match_count > 0
      } catch (error) {
        console.error('检查过滤器失败:', error)
        return false
      }
    }
    return checkRegionHasNodesLocal(filter, excludeFilter)
  }

  let skippedCount = 0
  for (const region of REGION_CONFIGS) {
    const providerName = `${prefix}-${region.emoji}${region.name}`
    const geoIPFilter = enableGeoIPMatching ? region.countryCode || '' : ''
    const hasNodes = await checkRegionHasNodes(region.filter, region.excludeFilter, geoIPFilter)
    if (!hasNodes) {
      results.push({
        name: providerName,
        success: false,
        skipped: true,
        error: t('proxyProvider.basicDialog.noMatchNodes'),
      })
      skippedCount++
      setResults([...results])
      continue
    }

    try {
      await api.post('/api/user/proxy-provider-configs', {
        external_subscription_id: selectedExternalSub.id,
        name: providerName,
        type: 'http',
        interval: 3600,
        proxy: 'DIRECT',
        size_limit: 0,
        header: JSON.stringify({ 'User-Agent': ['Clash/v1.18.0'] }),
        health_check_enabled: true,
        health_check_url: 'https://www.gstatic.com/generate_204',
        health_check_interval: 300,
        health_check_timeout: 5000,
        health_check_lazy: true,
        health_check_expected_status: 204,
        filter: region.filter || '',
        exclude_filter: region.excludeFilter || '',
        exclude_type: '',
        geo_ip_filter: enableGeoIPMatching ? region.countryCode || '' : '',
        override: '',
        process_mode: 'mmw',
      })
      results.push({ name: providerName, success: true })
    } catch (error: any) {
      results.push({
        name: providerName,
        success: false,
        error: error.response?.data?.error || t('toast.createFailed'),
      })
    }
    setResults([...results])
  }

  setCreating(false)
  invalidateProviders()

  const successCount = results.filter((r) => r.success).length
  const failedCount = results.filter((r) => !r.success && !r.skipped).length
  if (skippedCount > 0) {
    toast.success(
      t('toast.creationComplete', { success: successCount, skipped: skippedCount, failed: failedCount }),
    )
  } else {
    toast.success(t('toast.creationCompleteSimple', { success: successCount, total: results.length }))
  }
  setNamePrefix('')
}

interface BatchByProtocolOpts {
  selectedExternalSub: { id: number } | null
  namePrefix: string
  setCreating: (v: boolean) => void
  setResults: (v: CreationResult[]) => void
  setNamePrefix: (v: string) => void
  invalidateProviders: () => void
  t: Translator
}

export async function batchCreateByProtocol(opts: BatchByProtocolOpts): Promise<void> {
  const {
    selectedExternalSub,
    namePrefix,
    setCreating,
    setResults,
    setNamePrefix,
    invalidateProviders,
    t,
  } = opts

  if (!selectedExternalSub) {
    toast.error(t('toast.selectExternalSub'))
    return
  }
  if (!namePrefix.trim()) {
    toast.error(t('toast.enterNamePrefix'))
    return
  }

  setCreating(true)
  setResults([])
  const results: CreationResult[] = []
  const prefix = namePrefix.trim()

  for (const protocol of PROTOCOL_CONFIGS) {
    const providerName = `${prefix}-${protocol.name}`
    try {
      await api.post('/api/user/proxy-provider-configs', {
        external_subscription_id: selectedExternalSub.id,
        name: providerName,
        type: 'http',
        interval: 3600,
        proxy: 'DIRECT',
        size_limit: 0,
        header: JSON.stringify({ 'User-Agent': ['Clash/v1.18.0'] }),
        health_check_enabled: true,
        health_check_url: 'https://www.gstatic.com/generate_204',
        health_check_interval: 300,
        health_check_timeout: 5000,
        health_check_lazy: true,
        health_check_expected_status: 204,
        filter: '',
        exclude_filter: '',
        exclude_type: protocol.excludeType,
        override: '',
        process_mode: 'mmw',
      })
      results.push({ name: providerName, success: true })
    } catch (error: any) {
      results.push({
        name: providerName,
        success: false,
        error: error.response?.data?.error || t('toast.createFailed'),
      })
    }
    setResults([...results])
  }

  setCreating(false)
  invalidateProviders()

  const successCount = results.filter((r) => r.success).length
  toast.success(t('toast.creationCompleteSimple', { success: successCount, total: results.length }))
  setNamePrefix('')
}
