// @ts-nocheck
// Helper functions to generate Xray inbound configuration JSON

export function generateInboundConfig(formData: any, protocol: string, transport: string, security: string) {
  // Map protocol name to Xray protocol identifier
  const protocolMap: Record<string, string> = {
    'Dokodemo': 'tunnel',
    'Shadowsocks2022': 'shadowsocks',
    'Socks5': 'socks',
    'Hysteria2': 'hysteria',
  }

  const config: any = {
    port: formData.port,
    protocol: protocolMap[protocol] || protocol.toLowerCase(),
  }

  // Add listen if not default
  if (formData.listen && formData.listen !== '0.0.0.0') {
    config.listen = formData.listen
  }

  // Add tag if provided
  if (formData.tag) {
    config.tag = formData.tag
  }

  // Add sniffing if enabled
  if (formData.sniffing) {
    config.sniffing = {
      enabled: true,
      destOverride: ['http', 'tls'],
    }
    // Add quic for REALITY
    if (security && security.includes('REALITY')) {
      config.sniffing.destOverride.push('quic')
    }
  }

  // Generate settings based on protocol
  config.settings = generateSettings(formData, protocol, security)

  // Generate streamSettings
  if (protocol === 'Hysteria2') {
    // fork 的 xray-core HY2 schema(infra/conf/hysteria.go + transport_internet.go HysteriaConfig):
    // protocol=hysteria + settings{version:2, clients:[{auth,email}]} +
    // streamSettings{network:hysteria, security:tls, tlsSettings, hysteriaSettings:{version:2}}。
    // 注意:该 fork 的 HysteriaConfig 不支持 obfs/salamander(无此字段),故不下发。
    config.streamSettings = {
      network: 'hysteria',
      security: 'tls',
      tlsSettings: {
        certificates: [{
          certificateFile: formData.certificateFile,
          keyFile: formData.keyFile,
        }],
        alpn: ['h3'],
      },
      hysteriaSettings: { version: 2 },
    }
    if (formData.serverName) {
      config.streamSettings.tlsSettings.serverName = formData.serverName
    }
  } else if (protocol !== 'HTTP' && protocol !== 'Dokodemo' && transport !== 'None') {
    config.streamSettings = generateStreamSettings(formData, transport, security)
  }

  return config
}

function generateSettings(formData: any, protocol: string, security: string) {
  const settings: any = {}

  switch (protocol) {
    case 'Shadowsocks2022':
      settings.method = formData.method || '2022-blake3-aes-128-gcm'
      // Password is already Base64-encoded from the key generator
      settings.password = formData.serverPassword
      settings.network = formData.network || 'tcp,udp'
      // Client passwords are also already Base64-encoded
      settings.clients = formData.clients || []
      break

    case 'Socks5':
      settings.auth = formData.auth || 'password'
      if (settings.auth === 'password') {
        settings.accounts = (formData.accounts || []).map((acc: any) => ({
          user: acc.user,
          pass: acc.pass,
        }))
      }
      settings.udp = formData.udp ?? true
      if (formData.ip) {
        settings.ip = formData.ip
      }
      break

    case 'Trojan':
      settings.clients = (formData.clients || []).map((client: any) => {
        const c: any = {
          password: client.password,
        }
        if (client.email) c.email = client.email
        // Add flow for XTLS
        if (security && (security.includes('XTLS') || security.includes('Vision'))) {
          c.flow = client.flow || 'xtls-rprx-vision'
        }
        return c
      })
      if (formData.fallbacks && formData.fallbacks.length > 0) {
        settings.fallbacks = formData.fallbacks
      }
      break

    case 'VLESS':
      settings.decryption = formData.decryption || 'none'
      // Add encryption field at settings level for mlkem768x25519plus
      if (formData.encryption) {
        settings.encryption = formData.encryption
      }
      settings.clients = (formData.clients || []).map((client: any) => {
        const c: any = {
          id: client.id,
          level: client.level ?? 0,
        }
        if (client.email) c.email = client.email
        // Add flow for XTLS
        if (security && (security.includes('XTLS') || security.includes('Vision'))) {
          c.flow = client.flow || 'xtls-rprx-vision'
        }
        return c
      })
      if (formData.fallbacks && formData.fallbacks.length > 0) {
        settings.fallbacks = formData.fallbacks
      }
      break

    case 'VMess':
      settings.clients = (formData.clients || []).map((client: any) => {
        const c: any = {
          id: client.id,
        }
        if (client.email) c.email = client.email
        if (client.level !== undefined) c.level = client.level
        return c
      })
      break

    case 'Hysteria2':
      settings.version = 2
      settings.clients = (formData.clients || []).map((client: any) => {
        const c: any = { auth: client.auth }
        if (client.email) c.email = client.email
        if (client.level !== undefined) c.level = client.level
        return c
      })
      break

    case 'Anytls':
      // AnyTLS schema:settings.users[](非 clients),字段 {password, level, email}。
      settings.users = (formData.clients || []).map((client: any) => {
        const c: any = { password: client.password }
        if (client.email) c.email = client.email
        if (client.level !== undefined) c.level = client.level
        return c
      })
      // paddingScheme 为可选的 inbound 级流量整形规则数组,每行一条;留空则 server 用默认。
      if (formData.paddingScheme && typeof formData.paddingScheme === 'string') {
        const lines = formData.paddingScheme
          .split('\n')
          .map((l: string) => l.trim())
          .filter(Boolean)
        if (lines.length > 0) {
          settings.paddingScheme = lines
        }
      }
      break

    case 'HTTP':
      settings.auth = formData.auth || 'noauth'
      if (formData.auth === 'password' && formData.accounts && formData.accounts.length > 0) {
        settings.accounts = formData.accounts
      }
      if (formData.udp !== undefined) {
        settings.udp = formData.udp
      }
      if (formData.allowTransparent !== undefined) {
        settings.allowTransparent = formData.allowTransparent
      }
      break

    case 'Dokodemo':
      settings.address = formData.address
      settings.port = formData.forwardPort
      settings.network = formData.network || 'tcp'
      if (formData.followRedirect !== undefined) {
        settings.followRedirect = formData.followRedirect
      }
      if (formData.userLevel !== undefined) {
        settings.userLevel = formData.userLevel
      }
      break

    default:
      break
  }

  return settings
}

function generateStreamSettings(formData: any, transport: string, security: string) {
  const streamSettings: any = {
    network: getNetworkType(transport),
  }

  // Add transport-specific settings
  switch (transport) {
    case 'HTTP':
    case 'HTTP2':
      streamSettings.httpSettings = {
        path: formData.path || '/',
      }
      if (formData.host) {
        streamSettings.httpSettings.host = formData.host.split(',').map((h: string) => h.trim())
      }
      break

    case 'Websocket':
    case 'WSS':
      streamSettings.wsSettings = {
        path: formData.path || '/ws',
      }
      break

    case 'GRPC':
      streamSettings.grpcSettings = {
        serviceName: formData.serviceName || '',
      }
      break

    case 'XHTTP':
      streamSettings.xhttpSettings = {
        path: formData.path || '/xhttp',
        mode: formData.mode || 'auto',
      }
      if (formData.host) {
        streamSettings.xhttpSettings.host = formData.host
      }
      break
  }

  // Add security settings
  if (security && security !== 'None') {
    streamSettings.security = getSecurityType(security)

    if (security === 'TLS' || security.includes('XTLS-Vision') && !security.includes('REALITY')) {
      streamSettings.tlsSettings = {}

      // certificates 仅在用户真填了 cert/key 时才包含。出站(client-side)绝大多数情况不需要本地证书,
      // 留空数组只会让 xray 报 "both file and bytes are empty"。
      if (formData.certificateFile || formData.keyFile) {
        streamSettings.tlsSettings.certificates = [
          {
            certificateFile: formData.certificateFile || '',
            keyFile: formData.keyFile || '',
          },
        ]
      }

      // serverNames(复数,Reality 字段)与 serverName(单数,普通 TLS)在 clashConfigToOutbound 里都可能被填,
      // 这里两者兼容,取到非空就当 SNI 用,不然 Trojan/VLESS-TLS 落地后 SNI 为空会直接握手失败
      const sni = formData.serverName || formData.serverNames || ''
      if (sni) {
        streamSettings.tlsSettings.serverName = String(sni).split(',')[0].trim()
      }

      if (formData.alpn) {
        streamSettings.tlsSettings.alpn = formData.alpn.split(',').map((a: string) => a.trim())
      }
      // xray 已废弃 allowInsecure,改用 pinnedPeerCertSha256(hex,逗号分隔多值)精确锁证书
      // 用户没填 → 留空字段,后端 hook 会在 POST 时 TLS dial 自动获取
      if (formData.pinnedPeerCertSha256 && String(formData.pinnedPeerCertSha256).trim()) {
        streamSettings.tlsSettings.pinnedPeerCertSha256 = String(formData.pinnedPeerCertSha256).trim()
      }
      if (formData.fingerprint) {
        streamSettings.tlsSettings.fingerprint = formData.fingerprint
      }

      if (formData.minVersion) {
        streamSettings.tlsSettings.minVersion = formData.minVersion
      }

      if (formData.rejectUnknownSni) {
        streamSettings.tlsSettings.rejectUnknownSni = true
      }
    } else if (security.includes('REALITY')) {
      streamSettings.realitySettings = {
        dest: formData.dest,
        serverNames: formData.serverNames
          ? formData.serverNames.split(',').map((s: string) => s.trim()).filter(Boolean)
          : [],
        privateKey: formData.privateKey,
        shortIds: formData.shortIds
          ? formData.shortIds.split(',').map((s: string) => s.trim()).filter(Boolean)
          : [''],
      }

      // Add publicKey if available
      if (formData.publicKey) {
        streamSettings.realitySettings.publicKey = formData.publicKey
      }

      if (formData.show) {
        streamSettings.realitySettings.show = true
      }

      if (formData.xver && formData.xver > 0) {
        streamSettings.realitySettings.xver = formData.xver
      }
    }
  }

  return streamSettings
}

function getNetworkType(transport: string): string {
  const mapping: Record<string, string> = {
    TCP: 'tcp',
    HTTP: 'http',
    HTTP2: 'http',
    Websocket: 'ws',
    WSS: 'ws',
    GRPC: 'grpc',
    XHTTP: 'xhttp',
  }
  return mapping[transport] || 'tcp'
}

function getSecurityType(security: string): string {
  if (security.includes('REALITY')) {
    return 'reality'
  }
  if (security.includes('TLS')) {
    return 'tls'
  }
  return 'none'
}

// Generate outbound configuration
export function generateOutboundConfig(formData: any, protocol: string, transport: string, security: string) {
  // Map protocol name to Xray protocol identifier
  const protocolMap: Record<string, string> = {
    'Shadowsocks2022': 'shadowsocks',
    'Socks5': 'socks',
    'Freedom': 'freedom',
    'Blackhole': 'blackhole',
  }

  const config: any = {
    protocol: protocolMap[protocol] || protocol.toLowerCase(),
  }

  // Add tag if provided
  if (formData.tag) {
    config.tag = formData.tag
  } else {
    // Default tags for special protocols
    if (protocol === 'Freedom') {
      config.tag = 'direct'
    } else if (protocol === 'Blackhole') {
      config.tag = 'block'
    } else {
      config.tag = 'proxy'
    }
  }

  // Generate settings based on protocol (vnext or servers structure)
  config.settings = generateOutboundSettings(formData, protocol, security)

  // Generate streamSettings if transport is not None and not simple outbound
  if (transport !== 'None' && protocol !== 'Freedom' && protocol !== 'Blackhole') {
    config.streamSettings = generateStreamSettings(formData, transport, security)
  }

  return config
}

function generateOutboundSettings(formData: any, protocol: string, security: string) {
  const settings: any = {}

  // Freedom outbound
  if (protocol === 'Freedom') {
    if (formData.domainStrategy && formData.domainStrategy !== 'AsIs') {
      settings.domainStrategy = formData.domainStrategy
    }
    return settings
  }

  // Blackhole outbound
  if (protocol === 'Blackhole') {
    // Blackhole has optional response type, but typically empty settings
    return settings
  }

  // VLESS/VMess 用 vnext.users[] 嵌套结构;Trojan 用扁平 servers[](xray 要求 servers 数组有且仅一个成员)
  if (protocol === 'VLESS' || protocol === 'VMess') {
    const vnext: any = {
      address: formData.address,
      port: formData.port,
      users: []
    }

    if (protocol === 'VLESS') {
      vnext.users = (formData.users || []).map((user: any) => {
        const u: any = {
          id: user.id,
          encryption: user.encryption || 'none',
        }
        if (user.level !== undefined) u.level = user.level
        if (security && (security.includes('XTLS') || security.includes('Vision'))) {
          u.flow = user.flow || 'xtls-rprx-vision'
        }
        return u
      })
    } else if (protocol === 'VMess') {
      vnext.users = (formData.users || []).map((user: any) => {
        const u: any = {
          id: user.id,
        }
        if (user.level !== undefined) u.level = user.level
        if (user.alterId !== undefined) u.alterId = user.alterId
        if (user.security) u.security = user.security
        return u
      })
    }

    settings.vnext = [vnext]
  } else if (protocol === 'Trojan') {
    // xray Trojan outbound 协议结构与 VLESS/VMess 不同:settings.servers[{address, port, password, level, flow?}]
    // 且 servers 必须有且仅有 1 个元素,以前误用 vnext 会导致 "Multiple endpoints" / 字段缺失等错误
    const firstUser: any = (formData.users || [])[0] || {}
    const server: any = {
      address: formData.address,
      port: formData.port,
      password: firstUser.password || formData.password || '',
    }
    if (firstUser.level !== undefined) server.level = firstUser.level
    if (security && (security.includes('XTLS') || security.includes('Vision'))) {
      server.flow = firstUser.flow || 'xtls-rprx-vision'
    }
    settings.servers = [server]
  }
  // Protocols that use servers structure (Shadowsocks, Socks)
  else if (protocol === 'Shadowsocks2022') {
    const server: any = {
      address: formData.address,
      port: formData.port,
      method: formData.method || '2022-blake3-aes-128-gcm',
      password: formData.password,
    }
    if (formData.level !== undefined) server.level = formData.level
    settings.servers = [server]
  } else if (protocol === 'Socks5') {
    const server: any = {
      address: formData.address,
      port: formData.port,
    }
    if (formData.users && formData.users.length > 0) {
      server.users = formData.users.map((user: any) => ({
        user: user.user,
        pass: user.pass,
        level: user.level ?? 0,
      }))
    }
    settings.servers = [server]
  }

  return settings
}

// Convert Clash proxy config to Xray outbound config
export function clashConfigToOutbound(clashConfig: any, tag: string): any {
  const protocolMap: Record<string, string> = {
    vless: 'VLESS', vmess: 'VMess', trojan: 'Trojan',
    ss: 'Shadowsocks2022', socks5: 'Socks5', http: 'HTTP',
  }
  const transportMap: Record<string, string> = {
    ws: 'WebSocket', grpc: 'gRPC', h2: 'HTTP/2', tcp: 'TCP',
    quic: 'QUIC', httpupgrade: 'HTTPUpgrade', splithttp: 'SplitHTTP',
  }

  const clashType = clashConfig.type?.toLowerCase() || ''
  const protocol = protocolMap[clashType] || 'VLESS'
  const network = clashConfig.network?.toLowerCase() || 'tcp'
  const transport = transportMap[network] || 'TCP'

  let security = 'None'
  if (clashConfig.tls === true || clashConfig.tls === 'true') security = 'TLS'
  else if (clashConfig.reality === true || clashConfig['reality-opts']) security = 'Reality'

  const formData: any = {
    address: clashConfig.server || '',
    port: clashConfig.port || 443,
    tag,
    decryption: 'none',
    encryption: 'none',
    domainStrategy: 'AsIs',
    users: [],
  }

  const user: any = {}
  if (protocol === 'VLESS') {
    user.id = clashConfig.uuid || ''
    if (clashConfig.flow) user.flow = clashConfig.flow
    formData.users = [user]
  } else if (protocol === 'VMess') {
    user.id = clashConfig.uuid || ''
    user.alterId = clashConfig.alterId || 0
    user.security = clashConfig.cipher || 'auto'
    formData.users = [user]
  } else if (protocol === 'Trojan') {
    user.password = clashConfig.password || ''
    formData.users = [user]
  } else if (protocol === 'Shadowsocks2022') {
    formData.method = clashConfig.cipher || '2022-blake3-aes-128-gcm'
    formData.password = clashConfig.password || ''
  } else if (protocol === 'Socks5' || protocol === 'HTTP') {
    if (clashConfig.username || clashConfig.password) {
      formData.accounts = [{ user: clashConfig.username || '', pass: clashConfig.password || '' }]
    }
  }

  if (transport === 'WebSocket') {
    const wsOpts = clashConfig['ws-opts'] || {}
    formData.path = wsOpts.path || '/'
    if (wsOpts.headers?.Host) formData.host = wsOpts.headers.Host
  } else if (transport === 'gRPC') {
    formData.serviceName = (clashConfig['grpc-opts'] || {})['grpc-service-name'] || ''
  } else if (transport === 'HTTP/2') {
    const h2Opts = clashConfig['h2-opts'] || {}
    formData.path = h2Opts.path || '/'
    if (h2Opts.host?.length > 0) formData.host = h2Opts.host[0]
  } else if (transport === 'HTTPUpgrade') {
    formData.path = clashConfig.path || '/'
    formData.host = clashConfig.host || ''
  }

  if (security === 'TLS') {
    formData.serverNames = clashConfig.sni || clashConfig.servername || clashConfig.server || ''
    formData.alpn = clashConfig.alpn?.join(',') || ''
    // xray 已废弃 allowInsecure。skip-cert-verify=true 的 clash 节点不再写入"放弃验证"标记到 xray outbound;
    // 后端 hook 会在保存时 TLS dial 目标节点拿 peer cert sha256 自动填入 pinnedPeerCertSha256
    if (clashConfig.fingerprint) formData.fingerprint = clashConfig.fingerprint
  } else if (security === 'Reality') {
    const realityOpts = clashConfig['reality-opts'] || {}
    formData.serverNames = realityOpts['server-name'] || clashConfig.sni || ''
    formData.publicKey = realityOpts['public-key'] || ''
    formData.shortId = realityOpts['short-id'] || ''
    if (clashConfig.fingerprint) formData.fingerprint = clashConfig.fingerprint
  }

  return generateOutboundConfig(formData, protocol, transport, security)
}

/**
 * 在 outbounds 列表里找一条"等价于这个节点"的出站(协议+server+port+凭据 全匹配),命中返回其 tag。
 * 用于"选了节点做出站时,若服务器已有等价出站则复用,不重复创建"。
 */
export function matchNodeToExistingOutbound(clash: any, outbounds: any[]): string | null {
  if (!clash || !Array.isArray(outbounds)) return null
  const type = String(clash.type || '').toLowerCase()
  const proto = type === 'ss' ? 'shadowsocks' : type === 'hy2' ? 'hysteria2' : type
  const server = String(clash.server || '')
  const port = Number(clash.port)

  for (const ob of outbounds) {
    if (!ob || ob.protocol !== proto) continue
    const ep = (ob.settings?.vnext || ob.settings?.servers || [])[0]
    if (!ep || String(ep.address || '') !== server || Number(ep.port) !== port) continue

    if (type === 'vless' || type === 'vmess') {
      const id = ep.users?.[0]?.id
      if (id && clash.uuid && id === clash.uuid) return ob.tag
    } else if (type === 'trojan') {
      if (ep.password && clash.password && ep.password === clash.password) return ob.tag
    } else if (type === 'ss' || type === 'shadowsocks') {
      const cm = clash.cipher || clash.method
      if (ep.method && cm && ep.method === cm && ep.password === clash.password) return ob.tag
    } else if (type === 'hysteria2' || type === 'hy2') {
      const pw = ep.password || ep.auth
      const cpw = clash.password || clash.auth
      if (pw && cpw && pw === cpw) return ob.tag
    }
  }
  return null
}
