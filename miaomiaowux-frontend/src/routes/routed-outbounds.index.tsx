// @ts-nocheck
import { createFileRoute } from '@tanstack/react-router'
import { RoutedOutboundsPanel } from '@/components/routed-outbounds-panel'

export const Route = createFileRoute('/routed-outbounds/')({
  component: RoutedOutboundsPage,
})

function RoutedOutboundsPage() {
  return (
    <div className='container mx-auto py-8 px-4 pt-24'>
      <RoutedOutboundsPanel showHeader />
    </div>
  )
}
