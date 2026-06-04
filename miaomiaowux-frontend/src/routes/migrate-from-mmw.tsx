// @ts-nocheck
import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
import { profileQueryFn } from '@/lib/profile'

// 仅 admin 可访问 — 迁移操作只能由管理员执行
export const Route = createFileRoute('/migrate-from-mmw')({
  beforeLoad: async ({ context }) => {
    let profile: any
    try {
      profile = await (context as any).queryClient.fetchQuery({
        queryKey: ['profile'],
        queryFn: profileQueryFn,
        staleTime: 5 * 60 * 1000,
      })
    } catch {
      // 未登录 / token 过期 → 走登录页
      throw redirect({ to: '/login' })
    }
    // 已登录但非管理员 → 回主页(不能误抛 /login,否则会循环踢出 admin 体感)
    if (!profile?.is_admin) {
      throw redirect({ to: '/' })
    }
  },
  component: MigrateLayout,
})

function MigrateLayout() {
  return <Outlet />
}
