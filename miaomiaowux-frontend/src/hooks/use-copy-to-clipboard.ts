import { useCallback } from 'react'
import { toast } from 'sonner'

// 复制到剪贴板的统一封装:
//   - SSR / 不支持 clipboard 的环境 → 安全返回 false,可选失败 toast
//   - 成功后可选成功 toast
//   - 始终是 async,await 后可拿到 boolean 决定后续(比如 setCopied(true))
//
// 旧代码到处都在写 `if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) { await ... }`
// 或者 `navigator.clipboard.writeText(x).then(success, failure)`。换用本 hook 后,所有兜底统一。
//
// 不强行抽出每一处调用 — 复杂的(带 dialog 开关 / setTimeout / 多步骤)保持原状即可,
// 这个 hook 只是把后来的新代码统一起来。
export function useCopyToClipboard() {
  return useCallback(
    async (
      text: string,
      opts?: { success?: string; failure?: string },
    ): Promise<boolean> => {
      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
        if (opts?.failure) toast.error(opts.failure)
        return false
      }
      try {
        await navigator.clipboard.writeText(text)
        if (opts?.success) toast.success(opts.success)
        return true
      } catch {
        if (opts?.failure) toast.error(opts.failure)
        return false
      }
    },
    [],
  )
}
