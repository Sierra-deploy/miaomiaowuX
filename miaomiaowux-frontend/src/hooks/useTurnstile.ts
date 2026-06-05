import { useState, useEffect, useRef, useCallback } from 'react'

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: string | HTMLElement,
        options: { sitekey: string; callback: (token: string) => void; 'expired-callback'?: () => void }
      ) => string
      reset: (widgetId: string) => void
      remove: (widgetId: string) => void
    }
  }
}

// useTurnstile 通用 Cloudflare Turnstile hook。siteKey 空(captcha 未启用)时 token 永远为空,
// 调用方应同时跳过渲染 containerRef 容器、不阻塞提交。
// 移植自 mmwx-license 同名 hook(原生 script,无第三方依赖)。
export function useTurnstile(siteKey: string | undefined) {
  const containerRef = useRef<HTMLDivElement>(null)
  const widgetIdRef = useRef<string | null>(null)
  const [token, setToken] = useState('')

  useEffect(() => {
    if (!siteKey || !containerRef.current) return

    const renderWidget = () => {
      if (!window.turnstile || !containerRef.current) return
      if (widgetIdRef.current) window.turnstile.remove(widgetIdRef.current)
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        callback: (t: string) => setToken(t),
        'expired-callback': () => setToken(''),
      })
    }

    if (window.turnstile) {
      renderWidget()
    } else {
      const script = document.createElement('script')
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
      script.async = true
      script.onload = renderWidget
      document.head.appendChild(script)
    }

    return () => {
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current)
        widgetIdRef.current = null
      }
    }
  }, [siteKey])

  const reset = useCallback(() => {
    setToken('')
    if (widgetIdRef.current && window.turnstile) {
      window.turnstile.reset(widgetIdRef.current)
    }
  }, [])

  return { containerRef, token, reset }
}
