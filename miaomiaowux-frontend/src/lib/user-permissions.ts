import { api } from '@/lib/api'

export type UserPageKey = 'subscription' | 'generator' | 'templates' | 'subscribe-files' | 'custom-rules'

export interface QuotaItem {
  used: number
  max: number // 0 = 不限
}

export interface UserPermissions {
  success: boolean
  is_admin: boolean
  pages: UserPageKey[]
  quota: {
    template: QuotaItem
    override: QuotaItem
    subscribe: QuotaItem
  }
}

export const userPermissionsQueryFn = async (): Promise<UserPermissions> => {
  const response = await api.get('/api/user/permissions')
  return response.data as UserPermissions
}
