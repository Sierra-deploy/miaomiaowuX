// @ts-nocheck
import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
import { profileQueryFn } from '@/lib/profile'

// 仅 admin 可访问 — 迁移操作只能由管理员执行
export const Route = createFileRoute('/migrate-from-mmw')({
  beforeLoad: async ({ context }) => {
    try {
      const profile = await (context as any).queryClient.fetchQuery({
        queryKey: ['profile'],
        queryFn: profileQueryFn,
        staleTime: 5 * 60 * 1000,
      })
      if (!profile?.is_admin) {
        throw redirect({ to: '/' })
      }
    } catch (e) {
      throw redirect({ to: '/login' })
    }
  },
  component: MigrateLayout,
})

function MigrateLayout() {
  return <Outlet />
}
