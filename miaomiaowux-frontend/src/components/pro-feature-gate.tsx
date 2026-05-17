import { useLicenseFeature } from '@/hooks/use-license'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslation } from 'react-i18next'
import { Lock } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ProFeatureGateProps {
  feature: string
  children: React.ReactNode
  className?: string
}

export function ProFeatureGate({ feature, children, className }: ProFeatureGateProps) {
  const { hasFeature } = useLicenseFeature(feature)
  const { t } = useTranslation('common')

  if (hasFeature) {
    return <>{children}</>
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={cn('relative', className)}>
          <div className="pointer-events-none opacity-50">
            {children}
          </div>
          <div className="absolute inset-0 cursor-not-allowed" />
          <Badge
            variant="secondary"
            className="absolute -top-2 -right-2 text-[10px] px-1.5 py-0 gap-0.5"
          >
            <Lock className="h-2.5 w-2.5" />
            Pro
          </Badge>
        </div>
      </TooltipTrigger>
      <TooltipContent>
        {t('license.proFeatureTooltip')}
      </TooltipContent>
    </Tooltip>
  )
}
