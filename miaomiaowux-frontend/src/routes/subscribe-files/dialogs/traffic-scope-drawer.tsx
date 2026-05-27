// 订阅流量统计范围 - 管理员可在此选择该订阅只统计哪些服务器的流量。
// 数据落点是 subscribe_files.stats_server_ids(空字符串/未设置 = 统计全部服务器)。
import { useEffect, useState } from 'react'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'

interface ServerOption {
  id: number
  name: string
}

interface SubscribeFileRef {
  id: number
  name: string
  stats_server_ids?: string
}

interface TrafficScopeDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  file: SubscribeFileRef | null
  servers: ServerOption[]
  // 父端 mutation 入口 — 直接复用 inlineUpdate({ id, data: { stats_server_ids } })
  onSave: (id: number, statsServerIds: string) => void
  saving: boolean
}

export function TrafficScopeDrawer({ open, onOpenChange, file, servers, onSave, saving }: TrafficScopeDrawerProps) {
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())

  // 每次打开抽屉根据当前 file.stats_server_ids 解析勾选状态
  useEffect(() => {
    if (!open || !file) return
    const raw = (file.stats_server_ids || '').trim()
    if (raw === '') {
      setSelectedIds(new Set())
      return
    }
    const ids = raw
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0)
    setSelectedIds(new Set(ids))
  }, [open, file])

  const toggle = (id: number, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const handleSave = () => {
    if (!file) return
    // 空集合 = 统计全部服务器(语义与未设置一致)
    const payload = selectedIds.size === 0 ? '' : Array.from(selectedIds).sort((a, b) => a - b).join(',')
    onSave(file.id, payload)
  }

  const handleSelectAll = () => setSelectedIds(new Set(servers.map((s) => s.id)))
  const handleClear = () => setSelectedIds(new Set())

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side='right' className='w-full sm:max-w-md p-0 flex flex-col'>
        <SheetHeader className='px-6 pt-6'>
          <SheetTitle>统计流量范围</SheetTitle>
          <SheetDescription>
            选择此订阅只统计哪些服务器的流量。不勾选任何项 = 统计全部服务器。
            <span className='mt-1 block text-xs'>当前订阅: {file?.name || '—'}</span>
          </SheetDescription>
        </SheetHeader>

        <div className='flex items-center gap-2 px-6 pt-3 text-xs'>
          <Button variant='outline' size='sm' onClick={handleSelectAll} disabled={servers.length === 0}>
            全选
          </Button>
          <Button variant='outline' size='sm' onClick={handleClear} disabled={selectedIds.size === 0}>
            清空(=全部)
          </Button>
          <span className='ml-auto text-muted-foreground'>
            已选 {selectedIds.size} / {servers.length}
          </span>
        </div>

        <ScrollArea className='flex-1 px-6 py-4'>
          <div className='space-y-2'>
            {servers.length === 0 ? (
              <div className='text-sm text-muted-foreground'>暂无服务器</div>
            ) : (
              servers.map((s) => (
                <label key={s.id} className='flex items-center gap-2 rounded border p-2 cursor-pointer hover:bg-muted/50'>
                  <Checkbox
                    checked={selectedIds.has(s.id)}
                    onCheckedChange={(c) => toggle(s.id, c === true)}
                  />
                  <span className='text-sm'>{s.name}</span>
                </label>
              ))
            )}
          </div>
        </ScrollArea>

        <SheetFooter className='px-6 pb-6'>
          <Button variant='outline' onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
