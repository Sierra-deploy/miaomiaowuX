import axios, { AxiosError, AxiosHeaders } from 'axios'
import { useAuthStore } from '@/stores/auth-store'
import { secureChannel, SECURE_CHANNEL_CONSTANTS } from '@/lib/securechan'

export const AUTH_HEADER = 'MM-Authorization'

// 哪些路径走 E2E 加密(黑名单制 — 默认所有 /api/* 加密)。
//
// **不加密**仅限会被外部客户端(mihomo / clash-verge 等)直接访问的 endpoint:
//   - /api/securechan/handshake       (握手本身不能加密)
//   - /api/clash/subscribe            (clash/mihomo 客户端直拉,通过 ?token=xxx)
//   - /api/user/package-subscribe     (前端构造的"给 clash 用的 URL",见 subscription.index.tsx:138-143)
//   - /x/{code}, /t/{id}              (短链 / 临时订阅,客户端 GET)
//
// 其余所有 endpoint(/api/admin/*、/api/user/*、/api/traffic/*、/api/subscriptions、
// /api/subscribe-files、/api/login* 等)都是**前端 axios 调用**,加密。
function shouldEncrypt(url: string | undefined): boolean {
  if (!url) return false
  // 不加密的黑名单
  if (url.includes('/api/securechan/handshake')) return false
  if (url.includes('/api/clash/subscribe')) return false
  if (url.includes('/api/user/package-subscribe')) return false
  if (url.startsWith('/x/') || url.startsWith('/t/')) return false
  // 其他所有 /api/* 加密
  return url.includes('/api/')
}

// 触发一次握手(由 axios 拦截器在 secureChannel 未就绪时调用)
async function triggerHandshake(): Promise<void> {
  await secureChannel.handshake(async (clientPubB64) => {
    const resp = await axios.post(
      (baseURL ?? '') + '/api/securechan/handshake',
      { client_pub_b64: clientPubB64 },
      { headers: { 'Content-Type': 'application/json' } }
    )
    return resp.data
  })
}

// 暴露给 auth-store / 入口在登录后主动调用
export const ensureSecureChannel = async (): Promise<void> => {
  if (secureChannel.isReady()) return
  await triggerHandshake()
}
const rawConfiguredBaseURL = (import.meta.env.VITE_API_BASE_URL ?? '').trim()

// Determine baseURL based on environment
let baseURL: string | undefined = undefined

if (rawConfiguredBaseURL) {
  // Use configured baseURL, but clear it in production if it's localhost:12889
  baseURL = import.meta.env.PROD && rawConfiguredBaseURL === 'http://localhost:12889'
    ? undefined
    : rawConfiguredBaseURL
} else if (typeof window !== 'undefined' && window.location) {
  // Auto-detect based on current location
  const { protocol, hostname } = window.location
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    // Development: use port 12889
    baseURL = `${protocol}//${hostname}:12889`
  }
  // Production: leave undefined to use relative paths (same origin)
}

export const api = axios.create({
  baseURL,
  withCredentials: false,
})

api.interceptors.request.use(async (config) => {
  const token = useAuthStore.getState().auth.accessToken
  if (token) {
    config.headers = config.headers ?? new AxiosHeaders()
    config.headers[AUTH_HEADER] = token
  }

  // E2E 加密:命中白名单 → 确保 session 就绪
  //
  // **关键约束**:GET/HEAD/DELETE/OPTIONS 等无 body 方法,浏览器 XHR/fetch 会按规范
  // **丢弃 request body** — 即使我们塞 envelope,也会被浏览器静默丢掉,后端收到空 body
  // → "envelope too short" → 400。所以这些方法**不加密 request body**(本来就没 body 可加密),
  // 但仍带 X-Secure-Channel header,告诉后端"加密响应"。
  // POST/PUT/PATCH 有 body → 正常加密 request + response。
  if (shouldEncrypt(config.url)) {
    try {
      if (!secureChannel.isReady()) {
        await triggerHandshake()
      }
      const method = (config.method ?? 'get').toUpperCase()
      const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH'

      config.headers = config.headers ?? new AxiosHeaders()
      config.headers[SECURE_CHANNEL_CONSTANTS.HEADER] = SECURE_CHANNEL_CONSTANTS.VERSION
      const sid = secureChannel.getSessionId()
      if (sid) config.headers[SECURE_CHANNEL_CONSTANTS.SESSION_ID_HEADER] = sid
      // 响应统一当 text 拿,后端响应永远是 base64 envelope
      config.responseType = 'text'

      if (hasBody) {
        const bodyStr = config.data == null ? '' : typeof config.data === 'string' ? config.data : JSON.stringify(config.data)
        const bodyBytes = new TextEncoder().encode(bodyStr)
        const envelopeB64 = await secureChannel.encryptBodyB64(bodyBytes)
        config.data = envelopeB64
        config.headers['Content-Type'] = 'text/plain; charset=utf-8'
        // 让 axios 不再 JSON.stringify
        config.transformRequest = [(data) => data]
      }
      // GET/HEAD/DELETE/OPTIONS:不动 body(本来就没),只走加密响应通道
    } catch (e) {
      // 握手 / 加密失败:降级走明文(浏览器仍有 HTTPS 保护),保证可用性
      console.warn('[securechan] encrypt request failed, falling back to plaintext:', e)
    }
  }
  return config
})

api.interceptors.response.use(
  async (response) => {
    // 检查是否是加密响应
    const headerVal = (response.headers as Record<string, string>)?.[SECURE_CHANNEL_CONSTANTS.HEADER.toLowerCase()]
      ?? (response.headers as Record<string, string>)?.[SECURE_CHANNEL_CONSTANTS.HEADER]
    if (headerVal === SECURE_CHANNEL_CONSTANTS.VERSION && typeof response.data === 'string') {
      try {
        const plain = await secureChannel.decryptBodyB64(response.data)
        const text = new TextDecoder().decode(plain)
        // 尝试 JSON parse;失败则保留为 string
        try {
          response.data = JSON.parse(text)
        } catch {
          response.data = text
        }
      } catch (e) {
        console.error('[securechan] decrypt response failed:', e)
        return Promise.reject(e)
      }
    }
    return response
  },
  async (error) => {
    if (error instanceof AxiosError) {
      // **关键**:错误响应也可能是加密的(下游 handler 返回 4xx/5xx + 加密 body),
      // 在分发到上层 UI 之前先解密,否则 toast 会显示密文 base64。
      const errHeaderVal = (error.response?.headers as Record<string, string> | undefined)?.[SECURE_CHANNEL_CONSTANTS.HEADER.toLowerCase()]
        ?? (error.response?.headers as Record<string, string> | undefined)?.[SECURE_CHANNEL_CONSTANTS.HEADER]
      if (errHeaderVal === SECURE_CHANNEL_CONSTANTS.VERSION && error.response && typeof error.response.data === 'string') {
        try {
          const plain = await secureChannel.decryptBodyB64(error.response.data)
          const text = new TextDecoder().decode(plain)
          try {
            error.response.data = JSON.parse(text)
          } catch {
            error.response.data = text
          }
          // 同步更新 error.message,有些代码直接读 error.message 而非 response.data.error
          const dataAny = error.response.data as { error?: string; message?: string; msg?: string } | string
          if (typeof dataAny === 'string') {
            error.message = dataAny
          } else if (dataAny && (dataAny.error || dataAny.message || dataAny.msg)) {
            error.message = dataAny.error ?? dataAny.message ?? dataAny.msg ?? error.message
          }
        } catch (decErr) {
          console.error('[securechan] decrypt error response failed:', decErr)
        }
      }

      // 412 + X-Secure-Channel-Expired:session 过期,重做握手 + 重试一次
      const expired = error.response?.headers?.[SECURE_CHANNEL_CONSTANTS.EXPIRED_HEADER.toLowerCase()]
        ?? error.response?.headers?.[SECURE_CHANNEL_CONSTANTS.EXPIRED_HEADER]
      if (error.response?.status === 412 && expired === '1' && error.config && !(error.config as { _scRetried?: boolean })._scRetried) {
        secureChannel.reset()
        try {
          await triggerHandshake()
          ;(error.config as { _scRetried?: boolean })._scRetried = true
          return api.request(error.config)
        } catch (e) {
          console.error('[securechan] re-handshake failed:', e)
        }
      }
      if (error.response?.status === 404 && error.response?.headers?.['x-silent-mode'] === 'true') {
        if (typeof window !== 'undefined' && window.location.pathname !== '/404') {
          window.location.href = '/404'
        }
        return Promise.reject(error)
      }
      if (error.response?.status === 401) {
        useAuthStore.getState().auth.reset()
        secureChannel.reset()
        if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
          window.location.href = '/login'
        }
      }
    }
    return Promise.reject(error)
  }
)
