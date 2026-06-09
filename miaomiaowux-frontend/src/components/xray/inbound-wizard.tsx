// @ts-nocheck
import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import {
  Eye,
  Loader2,
  X,
  ShieldCheck,
  CheckCircle,
  XCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import { getXrayProtocolColor } from '@/lib/protocol-colors'
import { api } from '@/lib/api'
import { generateInboundConfig } from '@/lib/xray-config-generator'
import { CertSelectField } from '@/components/xray/cert-select-field'
import { useIsMobile } from '@/hooks/use-mobile'
import { MobileInboundWizard } from './mobile-inbound-wizard'
import {
  getAllProtocols,
  getTransportOptions,
  getSecurityOptions,
} from '@/lib/xray-config-structure'
import {
  commonFields,
  transportFields,
  securityFields,
  protocolFields,
  clientFields,
  requiresFlow,
  getFlowField,
} from '@/lib/xray-form-fields'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  FLAG_OPTIONS,
  countryCodeToFlag,
  getGeoIPInfo,
} from '@/lib/country-flag'
import { Twemoji } from '@/components/twemoji'
import { ArrayField } from './array-field'
import { FormField } from './form-field'
import { VlessDecryptionField } from './vless-decryption-field'


// Security protocol display labels - needs t() at call site
const getSecurityLabel = (security: string, t: (key: string) => string): string => {
  if (security === 'None') return t('wizard.securityNone')
  if (security.includes('MLKEM768'))
    return security.replace('MLKEM768', t('wizard.postQuantum'))
  return security
}

type WizardMode = 'simple' | 'expert'

const pickSimpleTransport = (
  protocol: string,
  transportNames: string[]
): string => {
  if (transportNames.length === 0) return ''

  // Prefer transport that supports XTLS-Vision-REALITY
  for (const transport of transportNames) {
    const securities = getSecurityOptions(protocol, transport)
    if (securities.includes('XTLS-Vision-REALITY')) {
      return transport
    }
  }

  for (const transport of transportNames) {
    const securities = getSecurityOptions(protocol, transport)
    if (securities.some((security) => security.includes('REALITY'))) {
      return transport
    }
  }

  for (const transport of transportNames) {
    const securities = getSecurityOptions(protocol, transport)
    if (securities.length === 0 || securities.includes('None')) {
      return transport
    }
  }

  return transportNames[0]
}

const pickSimpleSecurity = (securities: string[], protocol?: string): string => {
  if (securities.length === 0) return ''
  // AnyTLS 的 REALITY 在 mihomo/clash 都不被支持,简易模式始终默认 TLS,避免普通用户误选不可用组合。
  if (protocol === 'Anytls' && securities.includes('TLS')) return 'TLS'
  if (securities.includes('XTLS-Vision-REALITY')) return 'XTLS-Vision-REALITY'

  const realitySecurity = securities.find((security) =>
    security.includes('REALITY')
  )
  if (realitySecurity) return realitySecurity

  if (securities.includes('None')) return 'None'
  return securities[0]
}

const generateBase64Key = (byteLength: number): string => {
  const array = new Uint8Array(byteLength)
  crypto.getRandomValues(array)
  let binary = ''
  for (let i = 0; i < array.length; i++) {
    binary += String.fromCharCode(array[i])
  }
  return btoa(binary)
}

// 判定 serverDomain 是否匹配证书 certDomain(含单级泛域名),只允许精确匹配或 *.base 形式且不跨级。
// 例:certDomainMatches('jpsk.2ha.me', '*.2ha.me') === true
//    certDomainMatches('a.b.2ha.me', '*.2ha.me') === false
const certDomainMatches = (serverDomain: string, certDomain: string): boolean => {
  if (!serverDomain || !certDomain) return false
  const a = serverDomain.toLowerCase().trim()
  const b = certDomain.toLowerCase().trim()
  if (b === a) return true
  if (b.startsWith('*.')) {
    const base = b.slice(2)
    if (a.endsWith('.' + base)) {
      const prefix = a.slice(0, -(base.length + 1))
      return prefix.length > 0 && !prefix.includes('.')
    }
  }
  return false
}

interface Server {
  id: number
  name: string
  host: string
  port: number
}

interface InboundWizardProps {
  servers: Server[]
  selectedServerIds: number[]
  onCancel: () => void
  onSubmit: (serverIds: number[], inbound: any, tag: string, nodeName?: string, forwardNodeId?: number) => Promise<void>
  skipServerSelection?: boolean
  usedPorts?: number[]
}

interface RealityDomainOption {
  domain: string
  target?: string
  success: boolean
  latency_ms?: number
  error?: string
  nginx_ssl_port?: number
}

interface DomainServerInfo {
  server_id: number
  server_name: string
  domain: string
}

type SSLSetupState = 'idle' | 'loading' | 'success' | 'error'

export function InboundWizard(props: InboundWizardProps) {
  const isMobile = useIsMobile()
  if (isMobile) {
    return <MobileInboundWizard {...props} />
  }
  return <DesktopInboundWizard {...props} />
}

function DesktopInboundWizard({
  servers,
  selectedServerIds,
  onCancel,
  onSubmit,
  skipServerSelection = false,
  usedPorts = [],
}: InboundWizardProps) {
  const { t } = useTranslation('xray')
  const { t: tc } = useTranslation('common')
  const [wizardMode, setWizardMode] = useState<WizardMode>('simple')
  const isSimpleMode = wizardMode === 'simple'

  // Show server selection step when no server is pre-selected
  const needsServerSelection =
    !skipServerSelection && selectedServerIds.length === 0 && servers.length > 0

  // Internal selected server (single selection when no external pre-selection)
  const [internalSelectedServerId, setInternalSelectedServerId] = useState<
    number | null
  >(null)

  // Effective server ID (single selection)
  const effectiveServerId =
    selectedServerIds.length > 0
      ? selectedServerIds[0]
      : internalSelectedServerId
  const effectiveServerIds = effectiveServerId ? [effectiveServerId] : []

  const { data: inboundInfo } = useQuery({
    queryKey: ['inbound-ports', effectiveServerId],
    queryFn: async () => {
      if (!effectiveServerId) return { ports: [] as number[], tunnelInPort: 0 }
      const res = await api.get(`/api/admin/remote/inbounds?server_id=${effectiveServerId}`)
      const inbounds = res.data.inbounds || []
      const ports = inbounds.map((item: any) => Number(item.port)).filter(Boolean)
      const tunnelIn = inbounds.find((item: any) => item.tag === 'tunnel-in')
      const tunnelInPort = tunnelIn?.settings?.port ? Number(tunnelIn.settings.port) : 0
      return { ports, tunnelInPort }
    },
    enabled: !!effectiveServerId && usedPorts.length === 0,
  })
  const resolvedUsedPorts = usedPorts.length > 0 ? usedPorts : (inboundInfo?.ports || [])
  const tunnelInPort = inboundInfo?.tunnelInPort || 0

  // 远程服务器列表(主要为了拿当前 server.domain 用于 AnyTLS+TLS 证书自动匹配)。
  // 没有 single detail endpoint,只能 list 后客户端找。
  const { data: allRemoteServers } = useQuery({
    queryKey: ['remote-servers-wizard'],
    queryFn: async () => {
      const res = await api.get('/api/admin/remote-servers')
      return (res.data?.servers ?? []) as Array<{ id: number; domain?: string; ip_address?: string }>
    },
    enabled: !!effectiveServerId,
    staleTime: 60_000,
  })
  const currentServerDetail = effectiveServerId
    ? allRemoteServers?.find((s) => s.id === effectiveServerId)
    : null

  // 已签发的有效证书列表,用于 AnyTLS+TLS 域名自动匹配(支持泛域名)。
  const { data: validCertificates } = useQuery({
    queryKey: ['certificates-valid-wizard'],
    queryFn: async () => {
      const res = await api.get('/api/admin/certificates/valid')
      return (res.data?.certificates ?? []) as Array<{
        id: number
        domain: string
        cert_path: string
        key_path: string
      }>
    },
    staleTime: 60_000,
  })

  const [selectedProtocol, setSelectedProtocol] = useState<string>('VLESS')
  const [selectedTransport, setSelectedTransport] = useState<string>('TCP')
  const [selectedSecurity, setSelectedSecurity] = useState<string>(
    'XTLS-Vision-REALITY'
  )
  const [formData, setFormData] = useState<any>({
    port: 443,
    listen: '0.0.0.0',
    sniffing: true,
    clients: [],
    accounts: [],
    decryption: 'none',
    encryption: 'none',
  })

  // Mobile JSON preview dialog state
  const [showMobileJsonPreview, setShowMobileJsonPreview] = useState(false)
  const [realityDomainsLoading, setRealityDomainsLoading] = useState(false)
  const [realityDomainOptions, setRealityDomainOptions] = useState<
    RealityDomainOption[]
  >([])
  const [selectedRealityDomain, setSelectedRealityDomain] = useState<string>('')
  const [showSSLSetupDialog, setShowSSLSetupDialog] = useState(false)
  const [domainServers, setDomainServers] = useState<
    Record<string, DomainServerInfo>
  >({})
  const [sslSetupStatus, setSSLSetupStatus] = useState<
    Record<number, SSLSetupState>
  >({})
  const [manualRealityDomain, setManualRealityDomain] = useState('')
  const [customDomainInput, setCustomDomainInput] = useState('')
  const [customDomainProbing, setCustomDomainProbing] = useState(false)
  const simpleRealityAutoLoaded = useRef(false)

  // Tunnel「转发已有节点」:拉取节点表,解析 clash_config 得到 server:port,供 dokodemo 自动配置
  const { data: forwardNodes = [] } = useQuery({
    queryKey: ['forward-nodes'],
    queryFn: async () => {
      const res = await api.get('/api/admin/nodes')
      const nodes = res.data.nodes || []
      return nodes
        .map((n: any) => {
          let server = ''
          let port = 0
          try {
            const c = JSON.parse(n.clash_config || '{}')
            server = c.server || ''
            port = Number(c.port) || 0
          } catch {
            /* 忽略解析失败的节点 */
          }
          return { id: n.id, name: n.node_name, server, port }
        })
        .filter((n: any) => n.server && n.port)
    },
    enabled: selectedProtocol === 'Tunnel',
  })
  const [forwardNodeId, setForwardNodeId] = useState<number | null>(null)

  // Node name + flag picker
  const [nodeName, setNodeName] = useState('')
  const [selectedFlag, setSelectedFlag] = useState('')
  const [showFlagPicker, setShowFlagPicker] = useState(false)

  // Frequent users quick-add (锁死自身模式下不再使用,保留变量避免大改)
  const [frequentUsers] = useState<any[]>([])
  // 当前登录用户名 —— 添加节点时用户卡片锁死为"自己"
  const [currentUsername, setCurrentUsername] = useState<string>('')
  const selfFilledRef = useRef(false)

  useEffect(() => {
    if (tunnelInPort <= 0 || resolvedUsedPorts.includes(tunnelInPort)) return
    const isRealitySecurity =
      selectedSecurity === 'REALITY' || selectedSecurity === 'XTLS-Vision-REALITY'
    if (isRealitySecurity && selectedRealityDomain && isSelfDomain(selectedRealityDomain)) {
      setFormData((prev: any) => prev.port === 443 ? { ...prev, port: tunnelInPort } : prev)
    }
  }, [tunnelInPort])

  // Toggle server selection (single)
  const toggleServerSelection = (serverId: number) => {
    setInternalSelectedServerId((prev) => (prev === serverId ? null : serverId))
  }

  // Get available protocols
  const protocols = getAllProtocols()

  // Get available transports for selected protocol
  const [transports, setTransports] = useState<string[]>([])
  const [securityOptions, setSecurityOptions] = useState<string[]>([])

  useEffect(() => {
    if (selectedProtocol) {
      const transportOpts = getTransportOptions(selectedProtocol)
      const transportNames: string[] = []

      transportOpts.forEach((item) => {
        if (typeof item === 'string') {
          transportNames.push(item)
        } else {
          transportNames.push(...Object.keys(item))
        }
      })

      setTransports(transportNames)

      if (isSimpleMode) {
        setSelectedTransport(
          pickSimpleTransport(selectedProtocol, transportNames)
        )
      } else if (transportNames.length === 1) {
        // Auto-select if only one transport option
        setSelectedTransport(transportNames[0])
      } else if (!transportNames.includes(selectedTransport)) {
        // Or if current selection is invalid
        setSelectedTransport(transportNames[0] || '')
      }
    }
  }, [isSimpleMode, selectedProtocol])

  useEffect(() => {
    if (selectedProtocol && selectedTransport) {
      const securities = getSecurityOptions(selectedProtocol, selectedTransport)
      setSecurityOptions(securities)

      // Auto-select security
      if (securities.length > 0 && !securities.includes(selectedSecurity)) {
        setSelectedSecurity(
          isSimpleMode ? pickSimpleSecurity(securities, selectedProtocol) : securities[0]
        )
      } else if (securities.length === 0) {
        setSelectedSecurity('')
      }
    }
  }, [isSimpleMode, selectedProtocol, selectedTransport])

  useEffect(() => {
    if (
      selectedSecurity !== 'REALITY' &&
      selectedSecurity !== 'XTLS-Vision-REALITY'
    ) {
      setRealityDomainOptions([])
      setSelectedRealityDomain('')
      setManualRealityDomain('')
      simpleRealityAutoLoaded.current = false
    }
  }, [selectedSecurity])

  // Auto-trigger "steal self" in simple mode with REALITY security
  useEffect(() => {
    const isRealitySecurity =
      selectedSecurity === 'REALITY' ||
      selectedSecurity === 'XTLS-Vision-REALITY'
    if (
      isSimpleMode &&
      isRealitySecurity &&
      effectiveServerId &&
      !simpleRealityAutoLoaded.current &&
      !realityDomainsLoading &&
      realityDomainOptions.length === 0
    ) {
      simpleRealityAutoLoaded.current = true
      handleLoadRealityDomains()
    }
  }, [isSimpleMode, selectedSecurity, effectiveServerId])

  useEffect(() => {
    const isRealitySecurity =
      selectedSecurity === 'REALITY' ||
      selectedSecurity === 'XTLS-Vision-REALITY'
    if (!isRealitySecurity) return

    setFormData((prev: any) => {
      let changed = false
      const next = { ...prev }

      if (!next.dest) {
        next.dest = 'www.microsoft.com:443'
        changed = true
      }
      if (!next.serverNames) {
        next.serverNames = 'www.microsoft.com'
        changed = true
      }
      if (next.shortIds === undefined) {
        next.shortIds = ''
        changed = true
      }

      return changed ? next : prev
    })

    if (formData.privateKey && formData.publicKey) return

    let cancelled = false
    const autoGenerateRealityKeyPair = async () => {
      try {
        const response = await api.post('/api/admin/xray/generate-x25519')
        if (cancelled) return

        setFormData((prev: any) => {
          if (prev.privateKey && prev.publicKey) return prev
          return {
            ...prev,
            privateKey: prev.privateKey || response.data.privateKey,
            publicKey: prev.publicKey || response.data.publicKey,
          }
        })
      } catch {
        if (!cancelled) {
          toast.error(t('wizard.autoGenRealityFailed'))
        }
      }
    }

    autoGenerateRealityKeyPair()
    return () => {
      cancelled = true
    }
  }, [selectedSecurity, formData.privateKey, formData.publicKey])

  useEffect(() => {
    // In simple mode, default Socks5/HTTP to password auth for user selection
    if (!isSimpleMode) return
    if (selectedProtocol !== 'Socks5' && selectedProtocol !== 'HTTP') return

    setFormData((prev: any) => ({
      ...prev,
      auth: prev.auth === 'noauth' ? 'password' : prev.auth || 'password',
    }))
  }, [isSimpleMode, selectedProtocol])

  // 协议切换时把 protocolFields[selectedProtocol] 里声明的 defaultValue 注入 formData,
  // 这样未交互的字段(如 AnyTLS 的 paddingScheme)在简易/专家模式都已预填默认值,提交时直接生效。
  useEffect(() => {
    const fields = protocolFields[selectedProtocol] || []
    setFormData((prev: any) => {
      let changed = false
      const next = { ...prev }
      for (const field of fields) {
        if (field.defaultValue !== undefined && next[field.name] === undefined) {
          next[field.name] = field.defaultValue
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [selectedProtocol])

  // AnyTLS + TLS 简易模式:用服务器 domain 匹配现有证书(支持泛域名),命中则自动选中证书 +
  // 简易模式 + 必 TLS 的协议(AnyTLS / Hysteria2 / VLESS / VMess):自动按服务器域名匹配已有证书并塞
  // cert_id + serverName + cert/key 路径。命中省 3 步,不命中 toast 提示用户去签发或切专家模式。
  // security 判定与 submit 时 hasCert(L1062-1071)一致:TLS-含变体(TLS / TLS-WS / XTLS-Vision)放行,
  // REALITY / XTLS-Vision-REALITY 走自己的域名+key 路径,不需证书。
  useEffect(() => {
    if (!isSimpleMode) return
    const tlsAutoCertProtocols = ['Anytls', 'Hysteria2', 'VLESS', 'VMess', 'Trojan']
    if (!tlsAutoCertProtocols.includes(selectedProtocol)) return
    if (!selectedSecurity.includes('TLS') || selectedSecurity.includes('REALITY')) return
    const serverDomain = (currentServerDetail?.domain || '').trim()
    if (!serverDomain) {
      toast.warning(t('wizard.tlsServerHasNoDomain', { protocol: selectedProtocol }), {
        id: `tls-no-domain-${selectedProtocol}`,
      })
      return
    }
    if (!validCertificates) return
    if (validCertificates.length === 0) {
      toast.warning(t('wizard.tlsNoCertsExpert'), { id: `tls-no-certs-${selectedProtocol}` })
      return
    }
    const matched = validCertificates.find((c) => certDomainMatches(serverDomain, c.domain))
    if (matched) {
      setFormData((prev: any) => {
        if (prev.cert_id === matched.id && prev.serverName === serverDomain) return prev
        return {
          ...prev,
          cert_id: matched.id,
          certificateFile: matched.cert_path,
          keyFile: matched.key_path,
          serverName: prev.serverName || serverDomain,
        }
      })
    } else {
      toast.warning(
        t('wizard.tlsNoMatchingCert', { domain: serverDomain }),
        { id: `tls-no-matching-cert-${selectedProtocol}`, duration: 8000 }
      )
    }
  }, [
    isSimpleMode,
    selectedProtocol,
    selectedSecurity,
    currentServerDetail?.domain,
    validCertificates,
    t,
  ])

  // AnyTLS + REALITY:toast 警告 Clash/Mihomo 不支持此组合,附文档链接(新标签打开)。
  // id 防止反复触发,duration 留长一点,description 内嵌可点击的 a 标签。
  useEffect(() => {
    if (selectedProtocol !== 'Anytls') return
    if (selectedSecurity !== 'REALITY') return
    toast.warning(t('wizard.anytlsRealityTitle'), {
      id: 'anytls-reality-warn',
      duration: 12000,
      description: (
        <span>
          {t('wizard.anytlsRealityDesc')}{' '}
          <a
            href='https://wiki.metacubex.one/config/proxies/anytls/'
            target='_blank'
            rel='noopener noreferrer'
            className='underline text-primary'
          >
            {t('wizard.viewDocs')}
          </a>
        </span>
      ),
    })
  }, [selectedProtocol, selectedSecurity, t])

  // GeoIP auto-detect flag
  useEffect(() => {
    if (!effectiveServerId) return
    const server = servers.find((s) => s.id === effectiveServerId)
    if (!server?.host) return
    getGeoIPInfo(server.host)
      .then((info) => setSelectedFlag(info.country_code))
      .catch(() => {})
  }, [effectiveServerId, servers])

  // 加载当前登录用户名(添加节点时用户卡片锁死成"自己")
  useEffect(() => {
    api.get('/api/user/profile').then((res) => {
      const uname = res.data?.username || ''
      if (uname) setCurrentUsername(uname)
    }).catch(() => {})
  }, [])

  // Auto-generate server/user passwords when entering SS2022 or switching method
  const prevSS2022MethodRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (selectedProtocol !== 'Shadowsocks2022') {
      prevSS2022MethodRef.current = undefined
      return
    }
    const method = formData.method || '2022-blake3-aes-128-gcm'
    if (prevSS2022MethodRef.current === method) return
    prevSS2022MethodRef.current = method

    const byteLength = method.includes('128') ? 16 : 32
    setFormData((prev: any) => ({
      ...prev,
      method,
      serverPassword: generateBase64Key(byteLength),
      clients: (prev.clients || []).map((client: any) => ({
        ...client,
        password: generateBase64Key(byteLength),
      })),
    }))
  }, [selectedProtocol, formData.method])

  // Auto-update default tag
  const buildDefaultTag = (port: number | string | undefined) => {
    const parts = [selectedProtocol.toLowerCase()]

    // Shadowsocks2022 uses protocol-port format (no transport/security)
    if (selectedProtocol !== 'Shadowsocks2022') {
      // Only add transport when not None
      if (selectedTransport && selectedTransport !== 'None') {
        parts.push(selectedTransport.toLowerCase())
      }

      // Only add security when present and not None
      if (selectedSecurity && selectedSecurity !== 'None') {
        parts.push(selectedSecurity.toLowerCase())
      }
    }

    // Append port
    parts.push(String(port || 443))

    return parts.join('-')
  }

  useEffect(() => {
    // tunnel 转发已有节点时 tag 用节点名生成,不让默认 tag 覆盖
    if (selectedProtocol === 'Tunnel' && forwardNodeId) return
    const defaultTag = buildDefaultTag(formData.port)

    // Only update when user hasn't manually modified the tag
    setFormData((prev: any) => ({
      ...prev,
      tag: defaultTag,
    }))
  }, [selectedProtocol, selectedTransport, selectedSecurity, formData.port])

  const handleProtocolSelect = (protocol: string) => {
    setSelectedProtocol(protocol)
  }

  const handleTransportSelect = (transport: string) => {
    setSelectedTransport(transport)
  }

  const handleSecuritySelect = (security: string) => {
    setSelectedSecurity(security)
  }

  const generateUUID = () => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }

  const generateRandomPassword = (length = 16) => {
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*'
    let password = ''
    for (let i = 0; i < length; i++) {
      password += charset.charAt(Math.floor(Math.random() * charset.length))
    }
    return password
  }

  const buildClientFromUser = (user: any) => {
    const fields = clientFieldsWithFlow
    const userObj: any = {}
    const hasUserOrIdField = fields.some((f) => f.name === 'user' || f.name === 'id')
    fields.forEach((field) => {
      if (field.name === 'id') {
        userObj[field.name] = generateUUID()
      } else if (field.name === 'user') {
        userObj[field.name] = user.username || user.email
      } else if (field.name === 'email') {
        userObj[field.name] = hasUserOrIdField
          ? (user.email || user.username)
          : user.username
      } else if (field.name === 'password' || field.name === 'pass' || field.name === 'auth') {
        // auth = Hysteria2 客户端密码,和 Trojan password 一样当场生成随机值。
        const isSS2022PskField = field.label?.includes('psk')
        if (isSS2022PskField) {
          const method = formData.method || '2022-blake3-aes-128-gcm'
          const byteLength = method.includes('128') ? 16 : 32
          userObj[field.name] = generateBase64Key(byteLength)
        } else {
          userObj[field.name] = generateRandomPassword()
        }
      } else {
        userObj[field.name] = field.defaultValue ?? ''
      }
    })
    return userObj
  }

  const handleQuickAddUser = (user: any) => {
    const fieldName = (selectedProtocol === 'Socks5' || selectedProtocol === 'HTTP') ? 'accounts' : 'clients'
    const existing = formData[fieldName] || []
    if (existing.some((c: any) => c.email === user.username || c.user === user.username)) {
      toast.info(t('wizard.userAlreadyAdded'))
      return
    }
    const newClient = buildClientFromUser(user)
    handleFieldChange(fieldName, [...existing, newClient])
  }

  // 添加节点:用户卡片锁死为"当前登录账号自己"。
  // currentUsername 拿到后(及切换协议时)把 clients/accounts 重置为唯一一条 = 自己,凭证当场生成。
  useEffect(() => {
    if (!currentUsername) return
    const fieldName = (selectedProtocol === 'Socks5' || selectedProtocol === 'HTTP') ? 'accounts' : 'clients'
    const selfClient = buildClientFromUser({ username: currentUsername })
    setFormData((prev: any) => ({
      ...prev,
      clients: fieldName === 'clients' ? [selfClient] : [],
      accounts: fieldName === 'accounts' ? [selfClient] : [],
    }))
    selfFilledRef.current = true
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUsername, selectedProtocol])

  const handleFieldChange = (fieldName: string, value: any) => {
    setFormData((prev: any) => {
      const next = { ...prev, [fieldName]: value }

      // When dest field (host:port) changes, sync the host part to serverNames
      if (fieldName === 'dest' && value) {
        const host = value.split(':')[0]
        if (host) {
          next.serverNames = host
        }
      }

      return next
    })
  }

  const getLocalDest = (domain: string, domainOpts?: RealityDomainOption[]) => {
    const opts = domainOpts || realityDomainOptions
    const opt = opts.find((o) => o.domain === domain)
    const port = opt?.nginx_ssl_port || 8001
    return `127.0.0.1:${port}`
  }

  const generateRandomPort = (usedPorts: number[]) => {
    const min = 10000
    const max = 65535
    const used = new Set(usedPorts)
    let port: number
    do {
      port = Math.floor(Math.random() * (max - min + 1)) + min
    } while (used.has(port))
    return port
  }

  // tunnel tag 清洗:节点名可能含 emoji/空格/中文,转成 xray 安全的 tag(tunnel-<slug>-<port>)
  const sanitizeTunnelTag = (name: string, port: number) => {
    const slug = (name || 'node')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40)
    return `tunnel-${slug || 'node'}-${port}`
  }

  // 选「转发已有节点」时自动配置 dokodemo:监听 0.0.0.0、监听端口=节点端口、转发到节点 server:port、tcp+udp、跟随重定向、嗅探
  const applyForwardNode = (nodeIdStr: string) => {
    const nid = Number(nodeIdStr)
    setForwardNodeId(nid)
    const node = forwardNodes.find((n: any) => n.id === nid)
    if (!node) return
    setFormData((prev: any) => ({
      ...prev,
      listen: '0.0.0.0',
      port: node.port,
      sniffing: true,
      address: node.server,
      forwardPort: node.port,
      network: 'tcp,udp',
      followRedirect: true,
      tag: sanitizeTunnelTag(node.name, node.port),
    }))
    if (isSimpleMode) setNodeName(node.name)
  }

  // tunnel 转发节点时,监听端口 = 节点端口;若该端口已被本服务器其它入站占用则冲突
  const forwardPortConflict =
    selectedProtocol === 'Tunnel' &&
    forwardNodeId != null &&
    resolvedUsedPorts.includes(Number(formData.port))

  const renderForwardNodeSelect = () => (
    <div className='space-y-2'>
      <Label>{t('wizard.forwardExistingNode')}</Label>
      <Select
        value={forwardNodeId ? String(forwardNodeId) : ''}
        onValueChange={applyForwardNode}
      >
        <SelectTrigger>
          <SelectValue placeholder={t('wizard.forwardNodePlaceholder')} />
        </SelectTrigger>
        <SelectContent>
          {forwardNodes.map((n: any) => (
            <SelectItem key={n.id} value={String(n.id)}>
              {n.name} ({n.server}:{n.port})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className='text-muted-foreground text-xs'>{t('wizard.forwardNodeDesc')}</p>
      {forwardPortConflict && (
        <p className='text-destructive text-xs'>
          {t('wizard.forwardPortConflict', { port: formData.port })}
        </p>
      )}
    </div>
  )

  const isSelfDomain = (domain: string, serverMap?: Record<string, DomainServerInfo>) => {
    const servers = serverMap || domainServers
    return servers[domain]?.server_id === effectiveServerId
  }

  const applyRealityDomain = (
    domain: string,
    serverMap?: Record<string, DomainServerInfo>,
    domainOpts?: RealityDomainOption[]
  ) => {
    const servers = serverMap || domainServers
    const isLocal = servers[domain]?.server_id === effectiveServerId
    handleFieldChange(
      'dest',
      isLocal ? getLocalDest(domain, domainOpts) : `${domain}:443`
    )
    handleFieldChange('serverNames', domain)
    handleFieldChange('xver', isLocal ? 1 : 0)

    if (isLocal && tunnelInPort > 0 && !resolvedUsedPorts.includes(tunnelInPort)) {
      setFormData((prev: any) => ({ ...prev, port: tunnelInPort }))
    } else {
      setFormData((prev: any) => ({ ...prev, port: generateRandomPort(resolvedUsedPorts) }))
    }
  }

  const handleSelectRealityDomain = (domain: string) => {
    setSelectedRealityDomain(domain)
    setManualRealityDomain('')
    applyRealityDomain(domain)
  }

  const handleManualRealityDomain = (domain: string) => {
    setManualRealityDomain(domain)
    setSelectedRealityDomain('')
    if (domain) {
      applyRealityDomain(domain)
    }
  }

  const handleAddCustomDomain = async () => {
    const domain = customDomainInput.trim()
    if (!domain || !effectiveServerId) return
    setCustomDomainProbing(true)
    try {
      const res = await api.post('/api/admin/remote/reality-domains/custom', {
        domain,
        server_id: effectiveServerId,
      })
      const data = res.data
      const newOpt: RealityDomainOption = {
        domain: data.domain || domain,
        target: data.target || `${domain}:443`,
        success: data.success !== false && !data.error,
        latency_ms: data.latency_ms,
        error: data.error,
        nginx_ssl_port: data.nginx_ssl_port,
      }
      setRealityDomainOptions((prev) => {
        const filtered = prev.filter((d) => d.domain !== newOpt.domain)
        const updated = [...filtered, newOpt].sort(
          (a, b) => (a.latency_ms ?? 9999) - (b.latency_ms ?? 9999)
        )
        return updated
      })
      setCustomDomainInput('')
      if (newOpt.success) {
        toast.success(`${newOpt.domain} ${newOpt.latency_ms ?? '-'}ms`)
        handleSelectRealityDomain(newOpt.domain)
      } else {
        toast.error(`${newOpt.domain} ${t('wizard.probeFailed')}: ${newOpt.error || t('routing.unknown')}`)
      }
    } catch {
      toast.error(t('wizard.probeRequestFailed'))
    } finally {
      setCustomDomainProbing(false)
    }
  }

  const handleLoadRealityDomains = async () => {
    if (!effectiveServerId) {
      toast.error(t('wizard.selectServerFirst'))
      return
    }

    setRealityDomainsLoading(true)
    try {
      const response = await api.get(
        `/api/admin/remote/reality-domains?server_id=${effectiveServerId}`
      )
      const domains = Array.isArray(response.data?.domains)
        ? response.data.domains
        : []
      const serverMap = response.data?.domain_servers || {}
      setRealityDomainOptions(domains)
      setDomainServers(serverMap)

      if (domains.length === 0) {
        toast.error(response.data?.message || t('wizard.noDomainsFound'))
        return
      }

      const successCount = domains.filter(
        (item: RealityDomainOption) => item.success
      ).length

      if (successCount === 0) {
        // Check if any failed domains have server info (can setup SSL)
        const failedWithServer = domains.filter(
          (d: RealityDomainOption) => !d.success && serverMap[d.domain]
        )
        if (failedWithServer.length > 0) {
          setSSLSetupStatus({})
          setShowSSLSetupDialog(true)
        } else {
          const errors = [
            ...new Set(
              domains.map((d: RealityDomainOption) => d.error).filter(Boolean)
            ),
          ]
          const warning = response.data?.warning
          toast.error(
            warning ||
              t('wizard.allDomainsFailed', { count: domains.length, errors: errors.join('; ') })
          )
        }
        return
      }

      const firstAvailable =
        domains
          .filter(
            (item: RealityDomainOption) =>
              item.success && item.latency_ms != null
          )
          .sort(
            (a: RealityDomainOption, b: RealityDomainOption) =>
              (a.latency_ms ?? Infinity) - (b.latency_ms ?? Infinity)
          )[0] || domains.find((item: RealityDomainOption) => item.success)
      if (firstAvailable?.domain) {
        setSelectedRealityDomain(firstAvailable.domain)
        setManualRealityDomain('')
        applyRealityDomain(firstAvailable.domain, serverMap, domains)
      }

      toast.success(t('wizard.domainsLoaded', { total: domains.length, available: successCount }))
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('wizard.loadDomainsFailed'))
    } finally {
      setRealityDomainsLoading(false)
    }
  }

  const handleSetupSSL = async (serverId: number) => {
    setSSLSetupStatus((prev) => ({ ...prev, [serverId]: 'loading' }))
    try {
      await api.post(`/api/admin/remote/setup-ssl?server_id=${serverId}`)
      setSSLSetupStatus((prev) => ({ ...prev, [serverId]: 'success' }))
    } catch {
      setSSLSetupStatus((prev) => ({ ...prev, [serverId]: 'error' }))
    }
  }

  const handleSetupAllSSL = async () => {
    const failedDomains = realityDomainOptions.filter(
      (d) => !d.success && domainServers[d.domain]
    )
    const serverIds = [
      ...new Set(failedDomains.map((d) => domainServers[d.domain].server_id)),
    ]
    for (const sid of serverIds) {
      await handleSetupSSL(sid)
    }
  }

  const handleSSLSetupDone = () => {
    setShowSSLSetupDialog(false)
    // Re-probe after SSL setup
    handleLoadRealityDomains()
  }

  // Check if all SSL setups are finished (success or error)
  const allSSLSetupDone = (() => {
    const failedDomains = realityDomainOptions.filter(
      (d) => !d.success && domainServers[d.domain]
    )
    const serverIds = [
      ...new Set(failedDomains.map((d) => domainServers[d.domain].server_id)),
    ]
    return (
      serverIds.length > 0 &&
      serverIds.every(
        (sid) =>
          sslSetupStatus[sid] === 'success' || sslSetupStatus[sid] === 'error'
      )
    )
  })()

  const anySSLSetupLoading = Object.values(sslSetupStatus).some(
    (s) => s === 'loading'
  )

  const handleFormSubmit = async () => {
    let submitData = { ...formData }

    const port = Number(submitData.port)
    if (port && resolvedUsedPorts.includes(port)) {
      toast.error(t('wizard.portOccupied', { port }))
      return
    }

    if (isSimpleMode) {
      // TLS 协议简易模式必须已有证书才放行。AnyTLS / Hysteria2 走自动匹配证书路径会预填 cert_id +
      // certificateFile,这里看到已填就不拦;其他 TLS 协议(VLESS+TLS / VMess+TLS)目前没自动填路径,
      // 走老的"切专家模式"提示。判定:formData.cert_id 非空(托管证书)或 certificateFile+keyFile 都填了。
      const hasCert =
        !!formData.cert_id ||
        (!!(formData.certificateFile && String(formData.certificateFile).trim()) &&
          !!(formData.keyFile && String(formData.keyFile).trim()))
      const requiresCertFiles =
        selectedSecurity.includes('TLS') &&
        !selectedSecurity.includes('REALITY') &&
        !hasCert
      if (requiresCertFiles) {
        toast.error(t('wizard.needsCertSwitch'))
        return
      }

      if (!submitData.port) {
        const isRealitySecurity =
          selectedSecurity === 'REALITY' || selectedSecurity === 'XTLS-Vision-REALITY'
        const selfDomain = isRealitySecurity && selectedRealityDomain && isSelfDomain(selectedRealityDomain)
        if (selfDomain && tunnelInPort > 0 && !resolvedUsedPorts.includes(tunnelInPort)) {
          submitData.port = tunnelInPort
        } else {
          submitData.port = generateRandomPort(resolvedUsedPorts)
        }
      }
      if (resolvedUsedPorts.includes(Number(submitData.port))) {
        let nextPort = Number(submitData.port) + 1
        while (resolvedUsedPorts.includes(nextPort) && nextPort <= 65535) nextPort++
        submitData.port = nextPort
      }
      if (!submitData.listen) submitData.listen = '0.0.0.0'
      if (submitData.sniffing === undefined) submitData.sniffing = true

      // Protocol defaults
      if (selectedProtocol === 'Shadowsocks2022') {
        if (!submitData.method) submitData.method = '2022-blake3-aes-128-gcm'
        if (!submitData.network) submitData.network = 'tcp,udp'
        if (!submitData.serverPassword) {
          const byteLength = submitData.method.includes('128') ? 16 : 32
          submitData.serverPassword = generateBase64Key(byteLength)
        }
      }

      if (
        (selectedProtocol === 'Socks5' || selectedProtocol === 'HTTP') &&
        !submitData.auth
      ) {
        submitData.auth = 'password'
      }

      if (selectedProtocol === 'Dokodemo') {
        if (!submitData.address) submitData.address = '127.0.0.1'
        if (!submitData.forwardPort) submitData.forwardPort = 443
        if (!submitData.network) submitData.network = 'tcp'
      }

      // Transport defaults
      if (
        (selectedTransport === 'HTTP' || selectedTransport === 'HTTP2') &&
        !submitData.path
      ) {
        submitData.path = '/'
      }
      if (selectedTransport === 'Websocket' && !submitData.path)
        submitData.path = '/ws'
      if (selectedTransport === 'WSS' && !submitData.path)
        submitData.path = '/wss'
      if (selectedTransport === 'XHTTP' && !submitData.path)
        submitData.path = '/xhttp'
      if (selectedTransport === 'XHTTP' && !submitData.mode)
        submitData.mode = 'auto'
      if (selectedTransport === 'GRPC' && !submitData.serviceName)
        submitData.serviceName = 'grpc'

      // REALITY auto-fill
      if (selectedSecurity.includes('REALITY')) {
        if (!submitData.dest) submitData.dest = 'www.microsoft.com:443'
        if (!submitData.serverNames)
          submitData.serverNames = 'www.microsoft.com'
        if (submitData.shortIds === undefined) submitData.shortIds = ''

        if (!submitData.privateKey) {
          try {
            const response = await api.post('/api/admin/xray/generate-x25519')
            submitData.privateKey = response.data.privateKey
            submitData.publicKey = response.data.publicKey
          } catch {
            toast.error(t('wizard.autoGenRealityKeyFailed'))
            return
          }
        }
      }
    }

    const accountBasedProtocol =
      selectedProtocol === 'Socks5' || selectedProtocol === 'HTTP'
    const selectedUsers = accountBasedProtocol
      ? submitData.accounts || []
      : submitData.clients || []
    if (shouldShowUserManagement && selectedUsers.length === 0) {
      toast.error(t('wizard.selectAtLeastOneUser'))
      return
    }

    const inbound = generateInboundConfig(
      submitData,
      selectedProtocol,
      selectedTransport,
      selectedSecurity
    )

    // Generate default tag if user hasn't specified one
    let tag = submitData.tag
    if (!tag) {
      tag = buildDefaultTag(submitData.port)
    }

    // 节点名称:简易/专家模式都用同一个 nodeName state(共用),不再只在简易模式生效
    let customNodeName = ''
    if (nodeName) {
      const flag = selectedFlag ? countryCodeToFlag(selectedFlag) + ' ' : ''
      customNodeName = flag + nodeName
    }

    // 选了主控托管证书时,把 cert_id 塞进 inbound(带外字段);后端会同步下发证书到 agent 并改写成真实路径,
    // 避免证书缺失导致 xray 加载失败(502)。
    if (formData.cert_id) {
      inbound.cert_id = formData.cert_id
    }

    // tunnel「转发已有节点」时把源节点 ID 传给父级,用于创建配套节点
    const fwdId =
      selectedProtocol === 'Tunnel' && forwardNodeId ? forwardNodeId : undefined
    await onSubmit(effectiveServerIds, inbound, tag, customNodeName, fwdId)
  }

  // Get current field sets based on selections
  const currentTransportFields = transportFields[selectedTransport] || []
  const currentSecurityFields = securityFields[selectedSecurity] || []
  const currentProtocolFields = protocolFields[selectedProtocol] || []
  const currentClientFields = clientFields[selectedProtocol] || []

  // Add flow field for XTLS protocols
  const needsFlow = requiresFlow(selectedProtocol, selectedSecurity)
  const clientFieldsWithFlow = needsFlow
    ? [...currentClientFields, getFlowField()]
    : currentClientFields

  // Determine if user management should be shown
  // For HTTP/Socks5, only show when password auth is selected
  const effectiveAuth =
    (selectedProtocol === 'HTTP' || selectedProtocol === 'Socks5') &&
    isSimpleMode
      ? formData.auth || 'password'
      : formData.auth

  const shouldShowUserManagement =
    currentClientFields.length > 0 &&
    !(
      (selectedProtocol === 'HTTP' || selectedProtocol === 'Socks5') &&
      effectiveAuth === 'noauth'
    )

  return (
    <div className='space-y-6 md:space-y-8'>
      {/* Server Selection - Show when no server is pre-selected and there are multiple servers */}
      {needsServerSelection && (
        <div>
          <h3 className='mb-4 text-lg font-semibold'>{t('wizard.selectTargetServer')}</h3>
          <p className='text-muted-foreground mb-4 text-sm'>
            {t('wizard.selectTargetServerDesc')}
          </p>
          <div className='flex flex-wrap gap-2 md:gap-3'>
            {servers.map((server) => (
              <Button
                key={server.id}
                variant={
                  internalSelectedServerId === server.id ? 'default' : 'outline'
                }
                onClick={() => toggleServerSelection(server.id)}
                type='button'
              >
                {server.name}
              </Button>
            ))}
          </div>
          {internalSelectedServerId === null && (
            <p className='mt-3 text-sm text-amber-600 dark:text-amber-400'>
              {t('wizard.selectServer')}
            </p>
          )}
        </div>
      )}

      {/* Protocol Selection - Always visible */}
      <div>
        <h3 className='mb-4 text-lg font-semibold'>{t('wizard.selectProtocol')}</h3>
        <div className='flex flex-wrap gap-2 md:gap-3'>
          {protocols.map((protocol) => (
            <Button
              key={protocol}
              variant={selectedProtocol === protocol ? 'default' : 'secondary'}
              className={
                selectedProtocol === protocol
                  ? ''
                  : getXrayProtocolColor(protocol)
              }
              onClick={() => handleProtocolSelect(protocol)}
              type='button'
            >
              {protocol === 'Dokodemo'
                ? t('wizard.tunnelAnyDoor')
                : protocol.toUpperCase()}
            </Button>
          ))}
        </div>
      </div>

      {/* Transport Selection - Show only when protocol has multiple transport options */}
      {selectedProtocol && transports.length > 1 && (
        <div>
          <h3 className='mb-4 text-lg font-semibold'>{t('wizard.transportProtocol')}</h3>
          <div className='flex flex-wrap gap-2 md:gap-3'>
            {transports.map((transport) => (
              <Button
                key={transport}
                variant={
                  selectedTransport === transport ? 'default' : 'outline'
                }
                onClick={() => handleTransportSelect(transport)}
                type='button'
              >
                {transport.toUpperCase()}
              </Button>
            ))}
          </div>
        </div>
      )}

      {/* Security Selection - Show when transport is selected and has security options */}
      {selectedProtocol && selectedTransport && securityOptions.length > 0 && (
        <div>
          <h3 className='mb-4 text-lg font-semibold'>{t('wizard.securityProtocol')}</h3>
          <div className='flex flex-wrap gap-2 md:gap-3'>
            {securityOptions.map((security) => (
              <Button
                key={security}
                variant={selectedSecurity === security ? 'default' : 'outline'}
                onClick={() => handleSecuritySelect(security)}
                type='button'
                className='h-auto min-h-[2.5rem] py-2 whitespace-normal'
              >
                {getSecurityLabel(security, t)}
              </Button>
            ))}
          </div>
        </div>
      )}

      {/* Mode Selection - under security section */}
      {selectedProtocol &&
        selectedTransport &&
        (securityOptions.length === 0 || selectedSecurity) && (
          <div>
            <h3 className='mb-4 text-lg font-semibold'>{t('wizard.configMode')}</h3>
            <ButtonGroup mode='adaptive-full' className='w-full' gap='md'>
              <Button
                type='button'
                variant={isSimpleMode ? 'default' : 'outline'}
                className='w-full min-w-0'
                onClick={() => setWizardMode('simple')}
              >
                {t('wizard.simpleMode')}
              </Button>
              <Button
                type='button'
                variant={isSimpleMode ? 'outline' : 'default'}
                className='w-full min-w-0'
                onClick={() => setWizardMode('expert')}
              >
                {t('wizard.expertMode')}
              </Button>
            </ButtonGroup>
          </div>
        )}

      {/* Form - Show when ready */}
      {selectedProtocol &&
        selectedTransport &&
        (securityOptions.length === 0 || selectedSecurity) && (
          <>
            {isSimpleMode ? (
              (() => {
                const isRealitySecurity =
                  selectedSecurity === 'REALITY' ||
                  selectedSecurity === 'XTLS-Vision-REALITY'
                const hasAvailableDomains = realityDomainOptions.some(
                  (d) => d.success
                )
                return (
                  <>
                    {/* Simple mode: left form, right JSON preview */}
                    <div className='flex gap-6'>
                      <div className='min-w-0 flex-1 space-y-6'>
                        {/* Node Name — tunnel 转发节点时隐藏(节点名自动取自所选节点) */}
                        {selectedProtocol !== 'Tunnel' && (
                        <Card>
                          <CardHeader>
                            <CardTitle>{t('wizard.nodeName')}</CardTitle>
                            <CardDescription>
                              {t('wizard.nodeNameDesc')}
                            </CardDescription>
                          </CardHeader>
                          <CardContent>
                            <div className='flex items-center gap-2'>
                              <Popover open={showFlagPicker} onOpenChange={setShowFlagPicker}>
                                <PopoverTrigger asChild>
                                  <Button variant='outline' size='sm' className='text-lg px-2' type='button'>
                                    <Twemoji>{selectedFlag ? countryCodeToFlag(selectedFlag) : '\u{1F3F3}\u{FE0F}'}</Twemoji>
                                  </Button>
                                </PopoverTrigger>
                                <PopoverContent className='w-72 p-2' align='start'>
                                  <div className='grid grid-cols-7 gap-1'>
                                    {FLAG_OPTIONS.map((opt) => (
                                      <Button
                                        key={opt.code}
                                        variant='ghost'
                                        size='sm'
                                        className='text-lg px-1'
                                        type='button'
                                        onClick={() => { setSelectedFlag(opt.code); setShowFlagPicker(false) }}
                                        title={opt.label}
                                      >
                                        <Twemoji>{countryCodeToFlag(opt.code)}</Twemoji>
                                      </Button>
                                    ))}
                                  </div>
                                </PopoverContent>
                              </Popover>
                              <Input
                                placeholder={t('wizard.nodeNamePlaceholder')}
                                value={nodeName}
                                onChange={(e) => setNodeName(e.target.value)}
                                className='flex-1'
                              />
                            </div>
                          </CardContent>
                        </Card>
                        )}

                        {/* Tunnel 转发已有节点(简易模式)*/}
                        {selectedProtocol === 'Tunnel' && (
                          <Card>
                            <CardHeader>
                              <CardTitle>{t('wizard.forwardNodeTitle')}</CardTitle>
                              <CardDescription>
                                {t('wizard.forwardNodeCardDesc')}
                              </CardDescription>
                            </CardHeader>
                            <CardContent>{renderForwardNodeSelect()}</CardContent>
                          </Card>
                        )}

                        {/* REALITY Domain Selection */}
                        {isRealitySecurity && (
                          <Card>
                            <CardHeader>
                              <CardTitle>{t('wizard.realityDomain')}</CardTitle>
                              <CardDescription>
                                {realityDomainsLoading
                                  ? t('wizard.realityDomainProbing')
                                  : hasAvailableDomains
                                    ? t('wizard.realityDomainAutoSelected')
                                    : realityDomainOptions.length > 0
                                      ? t('wizard.realityDomainAllFailed')
                                      : effectiveServerId
                                        ? t('wizard.realityDomainFetching')
                                        : t('wizard.realityDomainSelectFirst')}
                              </CardDescription>
                            </CardHeader>
                            <CardContent className='space-y-3'>
                              {realityDomainsLoading && (
                                <div className='text-muted-foreground flex items-center gap-2 text-sm'>
                                  <Loader2 className='h-4 w-4 animate-spin' />
                                  {t('wizard.probing')}
                                </div>
                              )}

                              {/* Available domains dropdown */}
                              {hasAvailableDomains && (
                                <div className='space-y-2'>
                                  <Select
                                    value={selectedRealityDomain}
                                    onValueChange={handleSelectRealityDomain}
                                  >
                                    <SelectTrigger>
                                      <SelectValue placeholder={t('wizard.selectDomainSorted')} />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {realityDomainOptions.map((item) => (
                                        <SelectItem
                                          key={item.domain}
                                          value={item.domain}
                                          disabled={!item.success}
                                        >
                                          {item.success
                                            ? `${item.domain} (${item.latency_ms ?? '-'}ms)`
                                            : `${item.domain} (${t('wizard.probeFailed')})`}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                  <Button
                                    type='button'
                                    variant='ghost'
                                    size='sm'
                                    onClick={handleLoadRealityDomains}
                                    disabled={realityDomainsLoading}
                                  >
                                    {realityDomainsLoading && (
                                      <Loader2 className='mr-2 h-3 w-3 animate-spin' />
                                    )}
                                    {t('wizard.reprobeBtn')}
                                  </Button>
                                </div>
                              )}

                              {/* Manual input when no domains available */}
                              {!realityDomainsLoading &&
                                !hasAvailableDomains && (
                                  <div className='space-y-2'>
                                    <Label>{t('wizard.targetDomain')}</Label>
                                    <Input
                                      placeholder='www.microsoft.com'
                                      value={manualRealityDomain}
                                      onChange={(e) =>
                                        handleManualRealityDomain(
                                          e.target.value
                                        )
                                      }
                                    />
                                    {effectiveServerId && (
                                      <Button
                                        type='button'
                                        variant='outline'
                                        size='sm'
                                        onClick={() => {
                                          simpleRealityAutoLoaded.current = false
                                          handleLoadRealityDomains()
                                        }}
                                        disabled={realityDomainsLoading}
                                      >
                                        {realityDomainsLoading && (
                                          <Loader2 className='mr-2 h-3 w-3 animate-spin' />
                                        )}
                                        {t('wizard.reprobeDomain')}
                                      </Button>
                                    )}
                                  </div>
                                )}

                              <div className='space-y-2'>
                                <Label>{t('wizard.customDomain')}</Label>
                                <div className='flex gap-2'>
                                  <Input
                                    placeholder={t('wizard.customDomainPlaceholder')}
                                    value={customDomainInput}
                                    onChange={(e) =>
                                      setCustomDomainInput(e.target.value)
                                    }
                                    onKeyDown={(e) =>
                                      e.key === 'Enter' &&
                                      handleAddCustomDomain()
                                    }
                                  />
                                  <Button
                                    type='button'
                                    variant='outline'
                                    size='sm'
                                    onClick={handleAddCustomDomain}
                                    disabled={
                                      !customDomainInput.trim() ||
                                      customDomainProbing ||
                                      !effectiveServerId
                                    }
                                  >
                                    {customDomainProbing ? (
                                      <Loader2 className='h-4 w-4 animate-spin' />
                                    ) : (
                                      t('wizard.probe')
                                    )}
                                  </Button>
                                </div>
                              </div>
                            </CardContent>
                          </Card>
                        )}

                        {shouldShowUserManagement ? (
                          <Card>
                            <CardHeader>
                              <CardTitle>{t('wizard.userManagement')}</CardTitle>
                              <CardDescription>
                                {selectedProtocol === 'Socks5' ||
                                selectedProtocol === 'HTTP'
                                  ? t('wizard.accountConfig')
                                  : t('wizard.clientConfig')}
                              </CardDescription>
                            </CardHeader>
                            <CardContent>
                              {frequentUsers.length > 0 && (
                                <div className='mb-3 space-y-1'>
                                  <Label className='text-muted-foreground text-xs'>{t('wizard.frequentUsers')}</Label>
                                  <div className='flex flex-wrap gap-1'>
                                    {frequentUsers.map((user) => (
                                      <Button
                                        key={user.id}
                                        variant='outline'
                                        size='sm'
                                        type='button'
                                        onClick={() => handleQuickAddUser(user)}
                                      >
                                        {user.username}
                                      </Button>
                                    ))}
                                  </div>
                                </div>
                              )}
                              <ArrayField
                                label={
                                  selectedProtocol === 'Socks5' ||
                                  selectedProtocol === 'HTTP'
                                    ? t('inbounds.accounts')
                                    : t('inbounds.users')
                                }
                                fields={clientFieldsWithFlow}
                                values={
                                  selectedProtocol === 'Socks5' ||
                                  selectedProtocol === 'HTTP'
                                    ? formData.accounts || []
                                    : formData.clients || []
                                }
                                onChange={(values) =>
                                  handleFieldChange(
                                    selectedProtocol === 'Socks5' ||
                                      selectedProtocol === 'HTTP'
                                      ? 'accounts'
                                      : 'clients',
                                    values
                                  )
                                }
                                addButtonText={
                                  selectedProtocol === 'Socks5' ||
                                  selectedProtocol === 'HTTP'
                                    ? t('inbounds.addAccount')
                                    : t('inbounds.addUser')
                                }
                                showUserSelect={
                                  selectedProtocol === 'VLESS' ||
                                  selectedProtocol === 'VMess' ||
                                  selectedProtocol === 'Trojan' ||
                                  selectedProtocol === 'Shadowsocks2022' ||
                                  selectedProtocol === 'Socks5' ||
                                  selectedProtocol === 'HTTP'
                                }
                                required
                                locked
                                ss2022Method={
                                  selectedProtocol === 'Shadowsocks2022'
                                    ? formData.method
                                    : undefined
                                }
                              />
                            </CardContent>
                          </Card>
                        ) : selectedProtocol === 'Tunnel' ? null : (
                          <Card>
                            <CardHeader>
                              <CardTitle>{t('wizard.simpleModeTitle')}</CardTitle>
                              <CardDescription>
                                {t('wizard.simpleModeDesc')}
                              </CardDescription>
                            </CardHeader>
                          </Card>
                        )}
                      </div>

                      {/* Right-side JSON preview */}
                      <div className='sticky top-4 hidden w-[380px] flex-shrink-0 self-start md:block'>
                        <Card>
                          <CardHeader>
                            <CardTitle>{t('wizard.jsonPreview')}</CardTitle>
                            <CardDescription>
                              {t('wizard.realtimeInboundConfig')}
                            </CardDescription>
                          </CardHeader>
                          <CardContent>
                            <pre className='max-h-[60vh] overflow-auto rounded bg-gray-50 p-4 text-xs dark:bg-gray-900'>
                              {JSON.stringify(
                                generateInboundConfig(
                                  formData,
                                  selectedProtocol,
                                  selectedTransport,
                                  selectedSecurity
                                ),
                                null,
                                2
                              )}
                            </pre>
                          </CardContent>
                        </Card>
                      </div>
                    </div>

                    {/* Mobile JSON preview FAB */}
                    <Button
                      variant='outline'
                      size='icon'
                      className='bg-background border-primary fixed top-1/2 right-4 z-50 h-12 w-12 -translate-y-1/2 rounded-full shadow-lg md:hidden'
                      onClick={() => setShowMobileJsonPreview(true)}
                    >
                      <Eye className='h-5 w-5' />
                    </Button>

                    {/* Mobile JSON preview dialog */}
                    {showMobileJsonPreview && (
                      <div className='bg-background/80 fixed inset-0 z-50 backdrop-blur-sm md:hidden'>
                        <div className='bg-background fixed inset-4 flex flex-col rounded-lg border shadow-lg'>
                          <div className='flex items-center justify-between border-b p-4'>
                            <div>
                              <h3 className='font-semibold'>{t('wizard.jsonPreview')}</h3>
                              <p className='text-muted-foreground text-sm'>
                                {t('wizard.realtimeInboundConfig')}
                              </p>
                            </div>
                            <Button
                              variant='ghost'
                              size='icon'
                              onClick={() => setShowMobileJsonPreview(false)}
                            >
                              <X className='h-5 w-5' />
                            </Button>
                          </div>
                          <div className='flex-1 overflow-auto p-4'>
                            <pre className='rounded bg-gray-50 p-4 text-xs dark:bg-gray-900'>
                              {JSON.stringify(
                                generateInboundConfig(
                                  formData,
                                  selectedProtocol,
                                  selectedTransport,
                                  selectedSecurity
                                ),
                                null,
                                2
                              )}
                            </pre>
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                )
              })()
            ) : (
              <>
                {/* Two-column layout: left form, right JSON preview */}
                <div className='flex gap-6'>
                  {/* Left form area */}
                  <div className='min-w-0 flex-1'>
                    <div className='grid grid-cols-1 gap-6 xl:grid-cols-2'>
                      {/* Common Fields */}
                      <Card>
                        <CardHeader>
                          <CardTitle>{t('wizard.commonConfig')}</CardTitle>
                          <CardDescription>
                            {t('wizard.commonConfigDesc')}
                          </CardDescription>
                        </CardHeader>
                        <CardContent className='space-y-4'>
                          {/* 节点名称 — 跟简易模式共用 nodeName state,切换模式值保留;tunnel 转发已有节点时隐藏 */}
                          {selectedProtocol !== 'Tunnel' && (
                            <div className='space-y-1.5'>
                              <Label className='text-sm font-medium'>{t('wizard.nodeName')}</Label>
                              <div className='flex items-center gap-2 w-full'>
                                <Popover open={showFlagPicker} onOpenChange={setShowFlagPicker}>
                                  <PopoverTrigger asChild>
                                    <Button variant='outline' size='sm' className='text-lg px-2 shrink-0' type='button'>
                                      <Twemoji>{selectedFlag ? countryCodeToFlag(selectedFlag) : '\u{1F3F3}\u{FE0F}'}</Twemoji>
                                    </Button>
                                  </PopoverTrigger>
                                  <PopoverContent className='w-72 p-2' align='start'>
                                    <div className='grid grid-cols-7 gap-1'>
                                      {FLAG_OPTIONS.map((opt) => (
                                        <Button
                                          key={opt.code}
                                          variant='ghost'
                                          size='sm'
                                          className='text-lg px-1'
                                          type='button'
                                          onClick={() => { setSelectedFlag(opt.code); setShowFlagPicker(false) }}
                                          title={opt.label}
                                        >
                                          <Twemoji>{countryCodeToFlag(opt.code)}</Twemoji>
                                        </Button>
                                      ))}
                                    </div>
                                  </PopoverContent>
                                </Popover>
                                <Input
                                  placeholder={t('wizard.nodeNamePlaceholder')}
                                  value={nodeName}
                                  onChange={(e) => setNodeName(e.target.value)}
                                  className='flex-1 min-w-0'
                                />
                              </div>
                              <p className='text-xs text-muted-foreground'>{t('wizard.nodeNameDesc')}</p>
                            </div>
                          )}
                          {commonFields.map((field) => (
                            <FormField
                              key={field.name}
                              field={field}
                              value={formData[field.name]}
                              onChange={(value) =>
                                handleFieldChange(field.name, value)
                              }
                            />
                          ))}
                        </CardContent>
                      </Card>

                      {/* Client/User Management */}
                      {shouldShowUserManagement && (
                        <Card>
                          <CardHeader>
                            <CardTitle>{t('wizard.userManagement')}</CardTitle>
                            <CardDescription>
                              {selectedProtocol === 'Socks5' ||
                              selectedProtocol === 'HTTP'
                                ? t('wizard.accountConfig')
                                : t('wizard.clientConfig')}
                            </CardDescription>
                          </CardHeader>
                          <CardContent>
                            <ArrayField
                              label={
                                selectedProtocol === 'Socks5' ||
                                selectedProtocol === 'HTTP'
                                  ? t('inbounds.accounts')
                                  : t('inbounds.users')
                              }
                              fields={clientFieldsWithFlow}
                              values={
                                selectedProtocol === 'Socks5' ||
                                selectedProtocol === 'HTTP'
                                  ? formData.accounts || []
                                  : formData.clients || []
                              }
                              onChange={(values) =>
                                handleFieldChange(
                                  selectedProtocol === 'Socks5' ||
                                    selectedProtocol === 'HTTP'
                                    ? 'accounts'
                                    : 'clients',
                                  values
                                )
                              }
                              addButtonText={
                                selectedProtocol === 'Socks5' ||
                                selectedProtocol === 'HTTP'
                                  ? t('inbounds.addAccount')
                                  : t('inbounds.addUser')
                              }
                              showUserSelect={
                                selectedProtocol === 'VLESS' ||
                                selectedProtocol === 'VMess' ||
                                selectedProtocol === 'Trojan' ||
                                selectedProtocol === 'Shadowsocks2022' ||
                                selectedProtocol === 'Socks5' ||
                                selectedProtocol === 'HTTP'
                              }
                              required
                              locked
                              ss2022Method={
                                selectedProtocol === 'Shadowsocks2022'
                                  ? formData.method
                                  : undefined
                              }
                            />
                          </CardContent>
                        </Card>
                      )}

                      {/* Security Fields */}
                      {currentSecurityFields.length > 0 && (
                        <Card>
                          <CardHeader>
                            <CardTitle>{t('wizard.securityConfig')}</CardTitle>
                            <CardDescription>
                              {selectedSecurity} {t('wizard.securitySettings')}
                            </CardDescription>
                          </CardHeader>
                          <CardContent className='space-y-4'>
                            {(selectedSecurity === 'REALITY' ||
                              selectedSecurity === 'XTLS-Vision-REALITY') && (
                              <div className='space-y-3 rounded-lg border p-3'>
                                <div className='flex flex-col gap-2 sm:flex-row sm:items-center'>
                                  <Button
                                    type='button'
                                    variant='outline'
                                    onClick={handleLoadRealityDomains}
                                    disabled={
                                      realityDomainsLoading ||
                                      !effectiveServerId
                                    }
                                  >
                                    {realityDomainsLoading && (
                                      <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                                    )}
                                    {t('wizard.stealSelf')}
                                  </Button>
                                  <p className='text-muted-foreground text-xs'>
                                    {t('wizard.stealSelfDesc')}
                                  </p>
                                </div>

                                {realityDomainOptions.length > 0 && (
                                  <Select
                                    value={selectedRealityDomain}
                                    onValueChange={handleSelectRealityDomain}
                                  >
                                    <SelectTrigger>
                                      <SelectValue placeholder={t('wizard.selectLowLatencyDomain')} />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {realityDomainOptions.map((item) => (
                                        <SelectItem
                                          key={item.domain}
                                          value={item.domain}
                                          disabled={!item.success}
                                        >
                                          {item.success
                                            ? `${item.domain} (${item.latency_ms ?? '-'}ms)`
                                            : `${item.domain} (${t('wizard.probeFailed')})`}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                )}

                                <div className='space-y-1'>
                                  <Label className='text-xs'>{t('wizard.customDomain')}</Label>
                                  <div className='flex gap-2'>
                                    <Input
                                      placeholder={t('wizard.customDomainPlaceholder')}
                                      value={customDomainInput}
                                      onChange={(e) =>
                                        setCustomDomainInput(e.target.value)
                                      }
                                      onKeyDown={(e) =>
                                        e.key === 'Enter' &&
                                        handleAddCustomDomain()
                                      }
                                    />
                                    <Button
                                      type='button'
                                      variant='outline'
                                      size='sm'
                                      onClick={handleAddCustomDomain}
                                      disabled={
                                        !customDomainInput.trim() ||
                                        customDomainProbing ||
                                        !effectiveServerId
                                      }
                                    >
                                      {customDomainProbing ? (
                                        <Loader2 className='h-4 w-4 animate-spin' />
                                      ) : (
                                        t('wizard.probe')
                                      )}
                                    </Button>
                                  </div>
                                </div>
                              </div>
                            )}

                            {selectedSecurity.includes('TLS') &&
                              !selectedSecurity.includes('REALITY') && (
                                <CertSelectField
                                  value={formData.cert_id ?? null}
                                  remoteServerId={0}
                                  onChange={(certId, certPath, keyPath) =>
                                    setFormData((prev: any) => ({
                                      ...prev,
                                      cert_id: certId,
                                      ...(certId
                                        ? { certificateFile: certPath, keyFile: keyPath }
                                        : {}),
                                    }))
                                  }
                                />
                              )}

                            {currentSecurityFields.map((field) => (
                              <FormField
                                key={field.name}
                                field={field}
                                value={formData[field.name]}
                                onChange={(value) =>
                                  handleFieldChange(field.name, value)
                                }
                                onPublicKeyGenerated={
                                  field.name === 'privateKey'
                                    ? (publicKey) =>
                                        handleFieldChange(
                                          'publicKey',
                                          publicKey
                                        )
                                    : undefined
                                }
                              />
                            ))}
                          </CardContent>
                        </Card>
                      )}

                      {/* Protocol-Specific Fields */}
                      {(currentProtocolFields.length > 0 ||
                        selectedProtocol === 'VLESS') && (
                        <Card>
                          <CardHeader>
                            <CardTitle>{t('wizard.protocolSpecificConfig')}</CardTitle>
                            <CardDescription>
                              {selectedProtocol} {t('wizard.protocolSettings')}
                            </CardDescription>
                          </CardHeader>
                          <CardContent className='space-y-4'>
                            {/* Tunnel 转发已有节点(专家模式):自动填充下面字段,仍可手动修改 */}
                            {selectedProtocol === 'Tunnel' &&
                              renderForwardNodeSelect()}
                            {selectedProtocol === 'VLESS' ? (
                              <>
                                <VlessDecryptionField
                                  value={formData.decryption}
                                  onChange={(value) =>
                                    handleFieldChange('decryption', value)
                                  }
                                  onEncryptionGenerated={(encryption) =>
                                    handleFieldChange('encryption', encryption)
                                  }
                                />
                                {currentProtocolFields
                                  .filter(
                                    (field) =>
                                      field.name !== 'decryption' &&
                                      field.name !== 'encryption'
                                  )
                                  .map((field) => (
                                    <FormField
                                      key={field.name}
                                      field={field}
                                      value={formData[field.name]}
                                      onChange={(value) =>
                                        handleFieldChange(field.name, value)
                                      }
                                    />
                                  ))}
                              </>
                            ) : (
                              currentProtocolFields.map((field) => (
                                <FormField
                                  key={field.name}
                                  field={field}
                                  value={formData[field.name]}
                                  onChange={(value) =>
                                    handleFieldChange(field.name, value)
                                  }
                                  ss2022Method={
                                    selectedProtocol === 'Shadowsocks2022'
                                      ? formData.method
                                      : undefined
                                  }
                                />
                              ))
                            )}
                          </CardContent>
                        </Card>
                      )}

                      {/* Transport Fields */}
                      {currentTransportFields.length > 0 && (
                        <Card>
                          <CardHeader>
                            <CardTitle>{t('wizard.transportConfig')}</CardTitle>
                            <CardDescription>
                              {selectedTransport} {t('wizard.transportSettings')}
                            </CardDescription>
                          </CardHeader>
                          <CardContent className='space-y-4'>
                            {currentTransportFields.map((field) => (
                              <FormField
                                key={field.name}
                                field={field}
                                value={formData[field.name]}
                                onChange={(value) =>
                                  handleFieldChange(field.name, value)
                                }
                              />
                            ))}
                          </CardContent>
                        </Card>
                      )}
                    </div>
                  </div>

                  {/* Right-side JSON preview - sticky positioned */}
                  <div className='sticky top-4 hidden w-[380px] flex-shrink-0 self-start md:block'>
                    {/* 按钮放在专家模式右栏 JSON 卡片之前 — 用户改完字段后 sticky 跟随,
                        不用滚到 wizard 最底部。这里在专家模式 form 渲染分支内(条件已经满足
                        协议/传输/安全选满),按钮一定会随之渲染,不会消失。 */}
                    <div className='mb-3 flex justify-end gap-2'>
                      <Button variant='outline' onClick={onCancel} type='button' size='sm'>
                        {tc('actions.cancel')}
                      </Button>
                      <Button
                        onClick={handleFormSubmit}
                        type='button'
                        size='sm'
                        disabled={needsServerSelection && internalSelectedServerId === null}
                      >
                        {t('wizard.submitConfig')}
                      </Button>
                    </div>
                    <Card>
                      <CardHeader>
                        <CardTitle>{t('wizard.jsonPreview')}</CardTitle>
                        <CardDescription>{t('wizard.realtimeInboundConfig')}</CardDescription>
                      </CardHeader>
                      <CardContent>
                        <pre className='max-h-[60vh] overflow-auto rounded bg-gray-50 p-4 text-xs dark:bg-gray-900'>
                          {JSON.stringify(
                            generateInboundConfig(
                              formData,
                              selectedProtocol,
                              selectedTransport,
                              selectedSecurity
                            ),
                            null,
                            2
                          )}
                        </pre>
                      </CardContent>
                    </Card>
                  </div>
                </div>

                {/* Mobile JSON preview FAB */}
                <Button
                  variant='outline'
                  size='icon'
                  className='bg-background border-primary fixed top-1/2 right-4 z-50 h-12 w-12 -translate-y-1/2 rounded-full shadow-lg md:hidden'
                  onClick={() => setShowMobileJsonPreview(true)}
                >
                  <Eye className='h-5 w-5' />
                </Button>

                {/* Mobile JSON preview dialog */}
                {showMobileJsonPreview && (
                  <div className='bg-background/80 fixed inset-0 z-50 backdrop-blur-sm md:hidden'>
                    <div className='bg-background fixed inset-4 flex flex-col rounded-lg border shadow-lg'>
                      <div className='flex items-center justify-between border-b p-4'>
                        <div>
                          <h3 className='font-semibold'>{t('wizard.jsonPreview')}</h3>
                          <p className='text-muted-foreground text-sm'>
                            {t('wizard.realtimeInboundConfig')}
                          </p>
                        </div>
                        <Button
                          variant='ghost'
                          size='icon'
                          onClick={() => setShowMobileJsonPreview(false)}
                        >
                          <X className='h-5 w-5' />
                        </Button>
                      </div>
                      <div className='flex-1 overflow-auto p-4'>
                        <pre className='rounded bg-gray-50 p-4 text-xs dark:bg-gray-900'>
                          {JSON.stringify(
                            generateInboundConfig(
                              formData,
                              selectedProtocol,
                              selectedTransport,
                              selectedSecurity
                            ),
                            null,
                            2
                          )}
                        </pre>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}

      {/* Action Buttons — 底部兜底,桌面 + mobile 都显示。
          桌面端在顶部 sticky bar 也有一份(下面 actionButtonsBar),用户从下往上滚都看得到。 */}
      <div className='flex justify-end gap-3 border-t pt-4'>
        <Button variant='outline' onClick={onCancel} type='button'>
          {tc('actions.cancel')}
        </Button>
        {selectedProtocol &&
          selectedTransport &&
          (securityOptions.length === 0 || selectedSecurity) && (
            <Button
              onClick={handleFormSubmit}
              type='button'
              disabled={
                needsServerSelection && internalSelectedServerId === null
              }
            >
              {t('wizard.submitConfig')}
            </Button>
          )}
      </div>

      {/* SSL Setup Dialog */}
      <Dialog open={showSSLSetupDialog} onOpenChange={setShowSSLSetupDialog}>
        <DialogContent className='max-w-md'>
          <DialogHeader>
            <DialogTitle>{t('wizard.sslConfig')}</DialogTitle>
            <DialogDescription>
              {t('wizard.sslConfigDesc')}
            </DialogDescription>
          </DialogHeader>
          <div className='max-h-[40vh] space-y-3 overflow-auto'>
            {realityDomainOptions
              .filter((d) => !d.success && domainServers[d.domain])
              .reduce<DomainServerInfo[]>((acc, d) => {
                const info = domainServers[d.domain]
                if (!acc.some((i) => i.server_id === info.server_id))
                  acc.push(info)
                return acc
              }, [])
              .map((info) => {
                const status = sslSetupStatus[info.server_id] || 'idle'
                return (
                  <div
                    key={info.server_id}
                    className='flex items-center justify-between rounded-lg border p-3'
                  >
                    <div className='min-w-0'>
                      <p className='truncate font-medium'>{info.server_name}</p>
                      <p className='text-muted-foreground truncate text-xs'>
                        {info.domain}
                      </p>
                    </div>
                    <div className='ml-3 flex-shrink-0'>
                      {status === 'idle' && (
                        <Button
                          size='sm'
                          variant='outline'
                          onClick={() => handleSetupSSL(info.server_id)}
                          disabled={anySSLSetupLoading}
                        >
                          <ShieldCheck className='mr-1 h-3.5 w-3.5' />
                          {t('wizard.configure')}
                        </Button>
                      )}
                      {status === 'loading' && (
                        <Button size='sm' variant='outline' disabled>
                          <Loader2 className='mr-1 h-3.5 w-3.5 animate-spin' />
                          {t('wizard.configuring')}
                        </Button>
                      )}
                      {status === 'success' && (
                        <span className='inline-flex items-center text-sm text-green-600'>
                          <CheckCircle className='mr-1 h-3.5 w-3.5' />
                          {t('wizard.done')}
                        </span>
                      )}
                      {status === 'error' && (
                        <span className='inline-flex items-center text-sm text-red-600'>
                          <XCircle className='mr-1 h-3.5 w-3.5' />
                          {t('wizard.failed')}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
          </div>
          <DialogFooter className='gap-2'>
            {!allSSLSetupDone ? (
              <Button onClick={handleSetupAllSSL} disabled={anySSLSetupLoading}>
                {anySSLSetupLoading && (
                  <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                )}
                {t('wizard.oneClickSetup')}
              </Button>
            ) : (
              <Button onClick={handleSSLSetupDone}>{t('wizard.reprobeAfterSetup')}</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
