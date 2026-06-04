import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

export interface LicensePlan {
  name: string
  display_name: string
  description: string
  max_servers: number
  max_nodes: number
  max_users: number
  features: string[]
}

export interface LicenseStatus {
  success: boolean
  valid: boolean
  expires_at?: string
  plan?: LicensePlan
}

export interface LicenseUsage {
  success: boolean
  usage: {
    servers: { current: number; max: number }
    nodes: { current: number; max: number }
    users: { current: number; max: number }
  }
}

export function useLicenseStatus() {
  const { auth } = useAuthStore()
  return useQuery({
    queryKey: ['user-license-status'],
    queryFn: async () => {
      const response = await api.get('/api/user/license/status')
      return response.data as LicenseStatus
    },
    enabled: Boolean(auth.accessToken),
    staleTime: 5 * 60 * 1000,
  })
}

export function useLicenseUsage() {
  const { auth } = useAuthStore()
  return useQuery({
    queryKey: ['admin-license-usage'],
    queryFn: async () => {
      const response = await api.get('/api/admin/license/usage')
      return response.data as LicenseUsage
    },
    enabled: Boolean(auth.accessToken),
    staleTime: 30 * 1000,
  })
}

export function useLicenseFeature(featureName: string) {
  const { data } = useLicenseStatus()
  const hasFeature = data?.plan?.features?.includes(featureName) ?? false
  return { hasFeature, plan: data?.plan }
}
