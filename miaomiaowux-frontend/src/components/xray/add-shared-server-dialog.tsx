// @ts-nocheck
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Link2 } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
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

// 消费方:用「拥有方地址 + 分享令牌」接入一台被分享的服务器(PRO)。
export function AddSharedServerDialog() {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [ownerURL, setOwnerURL] = useState('')
  const [shareToken, setShareToken] = useState('')
  const [name, setName] = useState('')
  const [prefix, setPrefix] = useState('')

  const reset = () => { setOwnerURL(''); setShareToken(''); setName(''); setPrefix('') }

  const addMutation = useMutation({
    mutationFn: async () => {
      const res = await api.post('/api/admin/remote-servers/add-shared', {
        owner_url: ownerURL.trim(),
        share_token: shareToken.trim(),
        name: name.trim(),
        prefix: prefix.trim(),
      })
      return res.data
    },
    onSuccess: () => {
      toast.success('接入成功')
      queryClient.invalidateQueries({ queryKey: ['remote-servers'] })
      setOpen(false)
      reset()
    },
    onError: (e: any) => {
      toast.error(e?.response?.data?.error || e?.response?.data?.message || '接入失败')
    },
  })

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset() }}>
      <DialogTrigger asChild>
        <Button variant="outline"><Link2 className="mr-2 h-4 w-4" />接入分享服务器</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>接入分享服务器</DialogTitle>
          <DialogDescription>
            填入拥有方提供的「拥有方地址」与「分享令牌」即可接入。接入后可像自己的服务器一样管理（添加节点时请加前缀以区分）。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="shared-owner-url">拥有方地址</Label>
            <Input id="shared-owner-url" value={ownerURL} onChange={(e) => setOwnerURL(e.target.value)} placeholder="https://owner.example.com" className="font-mono text-sm" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="shared-token">分享令牌</Label>
            <Input id="shared-token" value={shareToken} onChange={(e) => setShareToken(e.target.value)} placeholder="拥有方生成的令牌" className="font-mono text-sm" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="shared-name">服务器名称（可选）</Label>
            <Input id="shared-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="留空则使用拥有方的名称" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="shared-prefix">入站前缀</Label>
            <Input id="shared-prefix" value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="如 myx-" className="font-mono text-sm" />
            <p className="text-xs text-muted-foreground">在该分享服务器上新增入站时，标签会自动加上此前缀，避免与拥有方已有入站冲突。设置后固定复用。</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => { setOpen(false); reset() }}>取消</Button>
          <Button onClick={() => addMutation.mutate()} disabled={addMutation.isPending || !ownerURL.trim() || !shareToken.trim()}>
            {addMutation.isPending ? '接入中…' : '接入'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
