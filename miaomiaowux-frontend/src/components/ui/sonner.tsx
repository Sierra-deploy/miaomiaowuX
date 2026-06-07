import { Toaster as Sonner, ToasterProps } from 'sonner'
import { useTheme } from '@/context/theme-provider'
import { useIsMobile } from '@/hooks/use-mobile'

export function Toaster({ ...props }: ToasterProps) {
  const { theme = 'system' } = useTheme()
  // 桌面端:bottom-right 展开堆叠;
  // 移动端:**top-center 折叠 + 可见数 1**,避开底部主操作区 + 防止 toast 项 pointer-events:auto 吞点击。
  // 之前默认 `expand={true} + bottom-right` 在 mobile 上会把多条 toast 全宽展开盖住底部,即使 toaster
  // 容器 pointer-events:none,**每条 toast 自身仍 pointer-events:auto**,叠在按钮上时整条 toast 会拦截点击。
  const isMobile = useIsMobile()
  return (
    <Sonner
      theme={theme as ToasterProps['theme']}
      className='toaster group [&_div[data-content]]:w-full'
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
        } as React.CSSProperties
      }
      position={isMobile ? 'top-center' : 'bottom-right'}
      expand={!isMobile}
      visibleToasts={isMobile ? 1 : 3}
      closeButton={isMobile}
      richColors
      {...props}
    />
  )
}
