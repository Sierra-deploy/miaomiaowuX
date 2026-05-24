import { createFileRoute, Outlet } from '@tanstack/react-router'
import { Topbar } from '@/components/layout/topbar'

export const Route = createFileRoute('/routed-outbounds')({
  component: RoutedOutboundsLayout,
})

function RoutedOutboundsLayout() {
  return (
    <div className='min-h-svh bg-background'>
      <Topbar />
      <Outlet />
    </div>
  )
}
