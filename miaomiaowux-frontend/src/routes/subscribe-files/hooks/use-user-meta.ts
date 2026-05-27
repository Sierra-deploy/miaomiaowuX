// 当前登录用户的「元信息」聚合:
//   - userToken(/api/user/token)+ user/custom short code
//   - 更新 custom_user_short_code 的 mutation
//   - userConfig(/api/user/config)— 用 enable_proxy_provider 决定要不要拉代理集合配置
//
// 这些 query 都是页面初始化必须的轻量数据,合到一个 hook 减少主文件顶部噪音。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'

interface UserTokenData {
  token: string
  user_short_code?: string
  custom_user_short_code?: string
}

interface UserConfigData {
  enable_proxy_provider: boolean
}

export function useUserMeta(opts: { enabled: boolean }) {
  const queryClient = useQueryClient()

  const { data: userTokenData } = useQuery({
    queryKey: ['user-token'],
    queryFn: async () => {
      const response = await api.get('/api/user/token')
      return response.data as UserTokenData
    },
    enabled: opts.enabled,
  })

  const updateShortCodeMutation = useMutation({
    mutationFn: async (custom: string) => {
      const res = await api.put('/api/user/token', { custom_user_short_code: custom })
      return res.data as Pick<UserTokenData, 'user_short_code' | 'custom_user_short_code'>
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-token'] })
      toast.success('短码已更新')
    },
    onError: (e: any) => {
      toast.error(e?.response?.data?.error || e?.message || '更新短码失败')
    },
  })

  const { data: userConfigData } = useQuery({
    queryKey: ['user-config'],
    queryFn: async () => {
      const response = await api.get('/api/user/config')
      return response.data as UserConfigData
    },
    enabled: opts.enabled,
  })

  return {
    userToken: userTokenData?.token ?? '',
    myUserShortCode: userTokenData?.user_short_code ?? '',
    myCustomUserShortCode: userTokenData?.custom_user_short_code ?? '',
    updateShortCodeMutation,
    enableProxyProvider: userConfigData?.enable_proxy_provider ?? false,
  }
}
