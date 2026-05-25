import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Settings } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

interface UserPermConfig {
  pages: string[]
  quota_template: number
  quota_override: number
  quota_subscribe: number
}

const PAGE_OPTIONS: { key: string; label: string }[] = [
  { key: 'subscription', label: '订阅链接' },
  { key: 'generator', label: '生成订阅' },
  { key: 'templates', label: '模板管理' },
  { key: 'subscribe-files', label: '订阅管理' },
  { key: 'custom-rules', label: '覆写管理' },
  { key: 'nodes', label: '节点管理' },
]

const emptyConfig: UserPermConfig = {
  pages: [],
  quota_template: 0,
  quota_override: 0,
  quota_subscribe: 0,
}

export function UserPermissionsDialog() {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [config, setConfig] = useState<UserPermConfig>(emptyConfig)

  const { data } = useQuery({
    queryKey: ['user-permissions-config'],
    queryFn: async () => {
      const res = await api.get('/api/admin/system-settings/user-permissions')
      return res.data as { success: boolean; config: UserPermConfig }
    },
    enabled: open,
  })

  useEffect(() => {
    if (data?.config) {
      setConfig({
        pages: data.config.pages ?? [],
        quota_template: data.config.quota_template ?? 0,
        quota_override: data.config.quota_override ?? 0,
        quota_subscribe: data.config.quota_subscribe ?? 0,
      })
    }
  }, [data])

  const saveMutation = useMutation({
    mutationFn: async (cfg: UserPermConfig) => {
      // 路由出站的 enabled + quota 由"系统设置"页管理,这里 PUT 时要把当前值原样回传,
      // 否则会被默认的 false/0 覆盖。
      const base = data?.config ?? ({} as any)
      await api.put('/api/admin/system-settings/user-permissions', {
        ...cfg,
        routed_outbound_enabled: Boolean(base.routed_outbound_enabled),
        quota_routed_outbound: Number(base.quota_routed_outbound ?? 0),
      })
    },
    onSuccess: () => {
      toast.success('用户权限已保存')
      queryClient.invalidateQueries({ queryKey: ['user-permissions-config'] })
      queryClient.invalidateQueries({ queryKey: ['user-permissions'] })
      setOpen(false)
    },
    onError: () => {
      toast.error('保存失败')
    },
  })

  const togglePage = (key: string, checked: boolean) => {
    setConfig((prev) => ({
      ...prev,
      pages: checked ? [...prev.pages, key] : prev.pages.filter((p) => p !== key),
    }))
  }

  const setQuota = (field: keyof UserPermConfig, value: string) => {
    const n = Math.max(0, parseInt(value, 10) || 0)
    setConfig((prev) => ({ ...prev, [field]: n }))
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant='outline' size='icon' className='h-7 w-7' title='用户权限配置'>
          <Settings className='h-3.5 w-3.5' />
        </Button>
      </DialogTrigger>
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>普通用户权限配置</DialogTitle>
          <DialogDescription>
            统一配置普通用户可见的页面，以及可创建的资源数量上限（0 = 不限）。
          </DialogDescription>
        </DialogHeader>

        <div className='space-y-4 py-2'>
          <div className='space-y-2'>
            <Label className='text-sm font-semibold'>可见页面</Label>
            <div className='grid grid-cols-2 gap-2'>
              {PAGE_OPTIONS.map((opt) => (
                <label key={opt.key} className='flex items-center gap-2 rounded-md border p-2 cursor-pointer'>
                  <Checkbox
                    checked={config.pages.includes(opt.key)}
                    onCheckedChange={(c) => togglePage(opt.key, c === true)}
                  />
                  <span className='text-sm'>{opt.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div className='space-y-3'>
            <Label className='text-sm font-semibold'>数量限制（0 = 不限）</Label>
            <div className='flex items-center justify-between gap-3'>
              <span className='text-sm text-muted-foreground'>模板数量</span>
              <Input
                type='number'
                min={0}
                className='w-28'
                value={config.quota_template}
                onChange={(e) => setQuota('quota_template', e.target.value)}
              />
            </div>
            <div className='flex items-center justify-between gap-3'>
              <span className='text-sm text-muted-foreground'>覆写规则数量</span>
              <Input
                type='number'
                min={0}
                className='w-28'
                value={config.quota_override}
                onChange={(e) => setQuota('quota_override', e.target.value)}
              />
            </div>
            <div className='flex items-center justify-between gap-3'>
              <span className='text-sm text-muted-foreground'>订阅数量</span>
              <Input
                type='number'
                min={0}
                className='w-28'
                value={config.quota_subscribe}
                onChange={(e) => setQuota('quota_subscribe', e.target.value)}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant='outline' onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button onClick={() => saveMutation.mutate(config)} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
