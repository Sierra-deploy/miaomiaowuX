// @ts-nocheck
// 手机端专版「添加节点」向导 — 用 Sheet 从底部上拉,只走 4 个最常用快捷模板,
// 跳过桌面版 inbound-wizard.tsx(2257 行)的协议×传输×安全二维矩阵 + 简易/专家模式。
//
// 4 模板覆盖 95% 场景:
//   1) VLESS-REALITY-Vision    安全度最高,主流首选
//   2) VMess-WS-TLS            适合 nginx 反代的场景
//   3) Trojan-TCP-TLS          简单的 TLS 入站
//   4) Shadowsocks2022         超轻量,无 TLS
//
// 用户每次只填:端口 / 节点名 / 国旗(可选)/ 用户(从下拉选,或留空)。
// 复用桌面版的 generateInboundConfig + buildDefaultTag 提交;复杂参数走 mobile 默认值。
// 需要专家配置(REALITY 自定义域名 / XTLS / gRPC serviceName / dokodemo 等)时,提示用户切到桌面端。
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ArrowLeft, ArrowRight, Loader2, Monitor, Shield, Zap } from 'lucide-react'
import { generateInboundConfig } from '@/lib/xray-config-generator'
import {
  getAllProtocols,
  getTransportOptions,
  getSecurityOptions,
} from '@/lib/xray-config-structure'
import { FLAG_OPTIONS, countryCodeToFlag } from '@/lib/country-flag'
import { Twemoji } from '@/components/twemoji'
import { api } from '@/lib/api'

interface Server {
  id: number
  name: string
}

interface MobileInboundWizardProps {
  servers: Server[]
  selectedServerIds: number[]
  onCancel: () => void
  onSubmit: (
    serverIds: number[],
    inbound: any,
    tag: string,
    nodeName?: string,
    forwardNodeId?: number
  ) => Promise<void>
  skipServerSelection?: boolean
  usedPorts?: number[]
}

// 快捷模板配置 — vmess / trojan 已移除(下拉框已覆盖完整矩阵,无需冗余 chip)
type TemplateKey = 'vless-reality' | 'ss-2022'

const TEMPLATES: Record<
  TemplateKey,
  {
    label: string
    desc: string
    protocol: string
    transport: string
    security: string
    defaultPort: number
    icon: 'shield' | 'monitor' | 'zap'
  }
> = {
  'vless-reality': {
    label: 'VLESS + REALITY',
    desc: 'XTLS Vision · 抗审查最强,推荐首选',
    protocol: 'VLESS',
    transport: 'TCP',
    security: 'XTLS-Vision-REALITY',
    defaultPort: 443,
    icon: 'shield',
  },
  'ss-2022': {
    label: 'Shadowsocks 2022',
    desc: '超轻量,无 TLS,适合后端 inbound',
    protocol: 'Shadowsocks2022',
    transport: 'TCP',
    security: 'None',
    defaultPort: 8388,
    icon: 'zap',
  },
}

// base64 32 字节随机密钥(SS2022 + Trojan password / VMess client id 不用,但 SS2022 server password 用)
function generateBase64Key(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes))
}

function uuidv4(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return (crypto as any).randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

type Step = 'configure' | 'submitting'

// Radix Select 禁止 <SelectItem value="">(空串保留给清空 selection),
// 用 sentinel 占位,onValueChange 时映射回空串存到 state。
const SENTINEL_NONE = '__none__'

// 从 getTransportOptions 返回值里抽出 transport 名(它可能是 string 或 { transport: securities[] })
function extractTransportNames(opts: ReturnType<typeof getTransportOptions>): string[] {
  return opts.map((t) => (typeof t === 'string' ? t : Object.keys(t)[0]))
}

export function MobileInboundWizard({
  servers,
  selectedServerIds,
  onCancel,
  onSubmit,
  skipServerSelection = false,
  usedPorts = [],
}: MobileInboundWizardProps) {
  const { t: tc } = useTranslation('common')
  const [step, setStep] = useState<Step>('configure')

  // 完整协议矩阵下拉:协议 → 传输 → 安全
  const allProtocols = useMemo(() => getAllProtocols(), [])
  const [selectedProtocol, setSelectedProtocol] = useState<string>('VLESS')
  const transportOptions = useMemo(
    () => extractTransportNames(getTransportOptions(selectedProtocol)),
    [selectedProtocol]
  )
  const [selectedTransport, setSelectedTransport] = useState<string>('TCP')
  const securityOptions = useMemo(
    () => getSecurityOptions(selectedProtocol, selectedTransport),
    [selectedProtocol, selectedTransport]
  )
  const [selectedSecurity, setSelectedSecurity] = useState<string>('XTLS-Vision-REALITY')

  // 协议变化时,如果当前 transport 不在新协议合法集合里,自动切到第一项
  useEffect(() => {
    if (transportOptions.length > 0 && !transportOptions.includes(selectedTransport)) {
      setSelectedTransport(transportOptions[0])
    }
  }, [selectedProtocol, transportOptions])

  // 传输变化时,同样校正 security
  useEffect(() => {
    if (securityOptions.length > 0 && !securityOptions.includes(selectedSecurity)) {
      setSelectedSecurity(securityOptions[0])
    }
  }, [selectedProtocol, selectedTransport, securityOptions])

  const [port, setPort] = useState<string>('443')
  const [nodeName, setNodeName] = useState('')
  const [selectedFlag, setSelectedFlag] = useState('')
  const [internalServerId, setInternalServerId] = useState<number | null>(
    selectedServerIds[0] ?? null
  )
  const [users, setUsers] = useState<Array<{ username: string }>>([])
  const [pickedUsername, setPickedUsername] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)

  const showServerSelection = !skipServerSelection && servers.length > 1

  // 加载用户列表(限速 / 子账号需要)
  useEffect(() => {
    if (step !== 'configure') return
    api.get('/api/admin/users').then((r) => {
      setUsers(r.data?.users || [])
    }).catch(() => {
      // 失败不影响主流程,用户可留空让后端自动开
    })
  }, [step])

  // 端口被占用提示
  const portIsUsed = useMemo(() => {
    const p = parseInt(port, 10)
    return Number.isFinite(p) && usedPorts.includes(p)
  }, [port, usedPorts])

  // 「快速模板」点一下 → 一键填三个 select + 端口
  const applyTemplate = (k: TemplateKey) => {
    const tpl = TEMPLATES[k]
    setSelectedProtocol(tpl.protocol)
    setSelectedTransport(tpl.transport)
    setSelectedSecurity(tpl.security === 'None' ? '' : tpl.security)
    setPort(String(tpl.defaultPort))
    toast.success(`已套用模板:${tpl.label}`)
  }

  const handleSubmit = async () => {
    const portNum = parseInt(port, 10)
    if (!Number.isFinite(portNum) || portNum < 1 || portNum > 65535) {
      toast.error('端口无效(1-65535)')
      return
    }
    if (showServerSelection && !internalServerId) {
      toast.error('请选择服务器')
      return
    }
    if (!nodeName.trim()) {
      toast.error('请填节点名称')
      return
    }
    if (!selectedProtocol || !selectedTransport) {
      toast.error('请选择协议 + 传输协议')
      return
    }

    const effectiveServerIds = skipServerSelection
      ? selectedServerIds
      : (internalServerId ? [internalServerId] : selectedServerIds)
    if (effectiveServerIds.length === 0) {
      toast.error('请选择服务器')
      return
    }

    setSubmitting(true)
    setStep('submitting')
    try {
      const formData: any = {
        port: portNum,
        listen: '0.0.0.0',
        sniffing: true,
        decryption: 'none',
        encryption: 'none',
      }

      const username = pickedUsername || `user-${Date.now().toString(36)}`
      const protoLower = selectedProtocol.toLowerCase()
      const secLower = (selectedSecurity || '').toLowerCase()
      const usesReality = secLower.includes('reality')
      const usesXTLS = secLower.includes('xtls')

      // 简易模式默认值填充 — 跟桌面版 inbound-wizard.tsx L1100-1175 同源
      switch (protoLower) {
        case 'vless':
        case 'vmess':
        case 'trojan': {
          const client: any = { id: uuidv4(), email: username }
          if (protoLower === 'trojan') {
            client.password = generateBase64Key(16)
            delete client.id
          }
          if (protoLower === 'vmess') {
            client.alterId = 0
          }
          if (usesXTLS) {
            client.flow = 'xtls-rprx-vision'
            formData.flow = 'xtls-rprx-vision'
          }
          formData.clients = [client]
          break
        }
        case 'shadowsocks2022': {
          formData.method = '2022-blake3-aes-128-gcm'
          formData.serverPassword = generateBase64Key(16)
          formData.network = 'tcp,udp'
          formData.accounts = [{ password: generateBase64Key(16), email: username }]
          break
        }
        case 'shadowsocks': {
          formData.method = 'aes-256-gcm'
          formData.password = generateBase64Key(32)
          formData.network = 'tcp,udp'
          formData.accounts = [{ password: generateBase64Key(16), email: username }]
          break
        }
        case 'hysteria2':
        case 'anytls': {
          formData.clients = [{ password: generateBase64Key(16), email: username }]
          break
        }
        case 'socks5':
        case 'http': {
          formData.auth = 'password'
          formData.accounts = [{ user: username, pass: generateBase64Key(12) }]
          break
        }
        case 'dokodemo':
        case 'tunnel': {
          // mobile 上 dokodemo 不深做,用最小默认
          formData.address = '127.0.0.1'
          formData.forwardPort = 443
          formData.network = 'tcp'
          break
        }
      }

      // 传输默认值
      const transLower = selectedTransport.toLowerCase()
      if (transLower === 'http' || transLower === 'http2') formData.path = formData.path || '/'
      if (transLower === 'websocket') formData.path = formData.path || '/ws'
      if (transLower === 'wss') formData.path = formData.path || '/wss'
      if (transLower === 'xhttp') {
        formData.path = formData.path || '/xhttp'
        formData.mode = formData.mode || 'auto'
      }
      if (transLower === 'grpc') formData.serviceName = formData.serviceName || 'grpc'

      // REALITY 自动 X25519 + 默认 dest
      if (usesReality) {
        try {
          const r = await api.post('/api/admin/xray/generate-x25519')
          formData.privateKey = r.data.privateKey
          formData.publicKey = r.data.publicKey
        } catch {
          toast.error('生成 REALITY x25519 失败,请用桌面端')
          setSubmitting(false)
          setStep('configure')
          return
        }
        formData.dest = formData.dest || 'www.microsoft.com:443'
        formData.serverNames = formData.serverNames || 'www.microsoft.com'
        formData.shortIds = formData.shortIds ?? ''
      }

      const inbound = generateInboundConfig(
        formData,
        selectedProtocol,
        selectedTransport,
        selectedSecurity || 'None'
      )

      const tag = `${protoLower}-${transLower}-${secLower || 'none'}-${portNum}`

      const flag = selectedFlag ? countryCodeToFlag(selectedFlag) + ' ' : ''
      const customNodeName = flag + nodeName.trim()

      await onSubmit(effectiveServerIds, inbound, tag, customNodeName, undefined)
      toast.success('节点已添加')
    } catch (e: any) {
      toast.error(e?.response?.data?.message || e?.message || '添加失败')
      setStep('configure')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Sheet open onOpenChange={(o) => !o && onCancel()}>
      <SheetContent side='bottom' className='h-[94vh] flex flex-col p-0 gap-0'>
        <SheetHeader className='p-4 border-b shrink-0'>
          <SheetTitle>添加节点</SheetTitle>
          <SheetDescription className='text-xs'>
            协议 / 传输 / 安全 完整矩阵下拉可选;复杂参数(REALITY 自定义域名、cert_id、Dokodemo 完整字段)走桌面端。
          </SheetDescription>
        </SheetHeader>

        <div className='flex-1 overflow-y-auto'>
          {step === 'configure' && (
            <div className='p-4 space-y-4'>
              {/* 快速模板 — 横向滚动 chip,一键填三 select + 端口 */}
              <div>
                <Label className='text-xs text-muted-foreground mb-1.5 block'>快速模板</Label>
                <div className='overflow-x-auto -mx-4 px-4'>
                  <div className='flex gap-2 w-max pb-1'>
                    {(Object.keys(TEMPLATES) as TemplateKey[]).map((k) => {
                      const tpl = TEMPLATES[k]
                      const Icon = tpl.icon === 'shield' ? Shield : tpl.icon === 'monitor' ? Monitor : Zap
                      return (
                        <button
                          key={k}
                          onClick={() => applyTemplate(k)}
                          className='shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-md border bg-card hover:bg-muted active:bg-muted text-xs'
                        >
                          <Icon className='size-3.5 text-primary' />
                          {tpl.label}
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>

              {/* 协议三级 select */}
              <div className='space-y-3 rounded-md border bg-muted/20 p-3'>
                <div className='space-y-1.5'>
                  <Label className='text-xs'>协议 *</Label>
                  <Select value={selectedProtocol} onValueChange={setSelectedProtocol}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {allProtocols.map((p) => (
                        <SelectItem key={p} value={p}>{p}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className='grid grid-cols-2 gap-3'>
                  <div className='space-y-1.5'>
                    <Label className='text-xs'>传输 *</Label>
                    <Select value={selectedTransport} onValueChange={setSelectedTransport}>
                      <SelectTrigger><SelectValue placeholder='选传输' /></SelectTrigger>
                      <SelectContent>
                        {transportOptions.map((tr) => (
                          <SelectItem key={tr} value={tr}>{tr}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className='space-y-1.5'>
                    <Label className='text-xs'>安全</Label>
                    <Select
                      value={selectedSecurity || SENTINEL_NONE}
                      onValueChange={(v) => setSelectedSecurity(v === SENTINEL_NONE ? '' : v)}
                    >
                      <SelectTrigger><SelectValue placeholder='—' /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value={SENTINEL_NONE}>None</SelectItem>
                        {securityOptions.map((s) => (
                          <SelectItem key={s} value={s}>{s}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className='flex flex-wrap gap-1 pt-1'>
                  <Badge variant='outline' className='text-[10px]'>{selectedProtocol}</Badge>
                  <Badge variant='outline' className='text-[10px]'>{selectedTransport}</Badge>
                  {selectedSecurity && (
                    <Badge variant='outline' className='text-[10px]'>{selectedSecurity}</Badge>
                  )}
                </div>
              </div>

              {showServerSelection && (
                <div className='space-y-1.5'>
                  <Label>服务器 *</Label>
                  <Select
                    value={internalServerId ? String(internalServerId) : ''}
                    onValueChange={(v) => setInternalServerId(parseInt(v, 10))}
                  >
                    <SelectTrigger><SelectValue placeholder='选择服务器' /></SelectTrigger>
                    <SelectContent>
                      {servers.map((s) => (
                        <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className='space-y-1.5'>
                <Label htmlFor='m-port'>端口 *</Label>
                <Input
                  id='m-port'
                  type='number'
                  inputMode='numeric'
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  placeholder='443'
                />
                {portIsUsed && (
                  <p className='text-[11px] text-amber-600 dark:text-amber-400'>
                    ⚠ 该端口已被其他入站占用,可能冲突
                  </p>
                )}
              </div>

              <div className='space-y-1.5'>
                <Label htmlFor='m-name'>节点名 *</Label>
                <div className='flex gap-2'>
                  <Select
                    value={selectedFlag || SENTINEL_NONE}
                    onValueChange={(v) => setSelectedFlag(v === SENTINEL_NONE ? '' : v)}
                  >
                    <SelectTrigger className='w-[100px] shrink-0'>
                      <SelectValue placeholder='国旗'>
                        {selectedFlag ? (
                          <span className='flex items-center gap-1.5'>
                            <Twemoji emoji={countryCodeToFlag(selectedFlag)} className='size-4' />
                            {selectedFlag}
                          </span>
                        ) : '国旗'}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent className='max-h-[40vh]'>
                      <SelectItem value={SENTINEL_NONE}>无</SelectItem>
                      {FLAG_OPTIONS.map((opt: any) => (
                        <SelectItem key={opt.code} value={opt.code}>
                          <span className='flex items-center gap-1.5'>
                            <Twemoji emoji={countryCodeToFlag(opt.code)} className='size-4' />
                            {opt.code} {opt.name}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    id='m-name'
                    value={nodeName}
                    onChange={(e) => setNodeName(e.target.value)}
                    placeholder='如:香港 GoMami'
                    className='flex-1'
                  />
                </div>
              </div>

              <div className='space-y-1.5'>
                <Label htmlFor='m-user'>用户(可选)</Label>
                <Select
                  value={pickedUsername || SENTINEL_NONE}
                  onValueChange={(v) => setPickedUsername(v === SENTINEL_NONE ? '' : v)}
                >
                  <SelectTrigger><SelectValue placeholder='留空自动生成 email' /></SelectTrigger>
                  <SelectContent className='max-h-[40vh]'>
                    <SelectItem value={SENTINEL_NONE}>留空自动生成</SelectItem>
                    {users.map((u) => (
                      <SelectItem key={u.username} value={u.username}>{u.username}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className='text-[11px] text-muted-foreground'>
                  选用户后用 username 作为 client email(限速 / 路由出站统计依赖此)。
                </p>
              </div>

              <div className='rounded-md border border-dashed bg-muted/30 p-3 text-[11px] text-muted-foreground'>
                <div className='font-medium text-foreground flex items-center gap-1 mb-1'>
                  <Monitor className='size-3.5' />
                  专家级配置请用桌面端
                </div>
                <p>自定义 REALITY 域名 / cert_id 主控托管证书选择 / Dokodemo 完整字段 / 多 client 编辑 等场景,mobile 仅走最小默认值。</p>
              </div>
            </div>
          )}

          {step === 'submitting' && (
            <div className='p-8 flex flex-col items-center justify-center gap-3'>
              <Loader2 className='size-8 animate-spin text-primary' />
              <div className='text-sm text-muted-foreground'>正在创建入站…</div>
            </div>
          )}
        </div>

        <SheetFooter className='p-4 border-t shrink-0 flex-col-reverse sm:flex-row gap-2'>
          <Button
            variant='outline'
            onClick={onCancel}
            disabled={submitting}
            className='w-full sm:w-auto'
          >
            {tc('actions.cancel')}
          </Button>
          {step === 'configure' && (
            <Button onClick={handleSubmit} disabled={submitting} className='w-full sm:w-auto'>
              {submitting ? <Loader2 className='size-4 mr-1 animate-spin' /> : null}
              添加入站
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
