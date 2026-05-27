// 订阅流量统计范围 - 管理员可在此选择该订阅只统计哪些服务器的流量。
// 数据落点是 subscribe_files.stats_server_ids(空字符串/未设置 = 统计全部服务器)。
//
// UI: 气泡(Popover),锚定到流量列的进度条按钮 — 比抽屉更轻,不遮主表格。
import { useState, type ReactNode } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'

interface ServerOption {
  id: number
  name: string
}

interface SubscribeFileRef {
  id: number
  name: string
  stats_server_ids?: string
}

interface TrafficScopePopoverProps {
  file: SubscribeFileRef
  servers: ServerOption[]
  onSave: (id: number, statsServerIds: string) => void
  saving: boolean
  // 触发元素 — 流量列里的可点击按钮(进度条 / 占位横线)
  children: ReactNode
}

function parseInitial(file: SubscribeFileRef): Set<number> {
  const raw = (file.stats_server_ids || '').trim()
  if (raw === '') return new Set()
  const ids = raw
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0)
  return new Set(ids)
}

export function TrafficScopePopover({ file, servers, onSave, saving, children }: TrafficScopePopoverProps) {
  const [open, setOpen] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => parseInitial(file))

  const handleOpenChange = (next: boolean) => {
    if (next) {
      // 打开时按当前 file.stats_server_ids 重置勾选,保证显示与保存的状态一致
      setSelectedIds(parseInitial(file))
    }
    setOpen(next)
  }

  const toggle = (id: number, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const handleSave = () => {
    // 空集合 = 统计全部服务器(语义与未设置一致)
    const payload = selectedIds.size === 0 ? '' : Array.from(selectedIds).sort((a, b) => a - b).join(',')
    onSave(file.id, payload)
  }

  const handleSelectAll = () => setSelectedIds(new Set(servers.map((s) => s.id)))
  const handleClear = () => setSelectedIds(new Set())

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align='start' side='bottom' sideOffset={6} className='w-[min(360px,92vw)] p-3'>
        <div className='space-y-2'>
          <div>
            <div className='text-sm font-medium'>统计流量范围</div>
            <div className='text-muted-foreground mt-0.5 text-[11px]'>
              不勾选任何项 = 统计全部服务器。当前订阅: {file.name || '—'}
            </div>
          </div>

          <div className='flex items-center gap-2 text-xs'>
            <Button variant='outline' size='sm' className='h-7' onClick={handleSelectAll} disabled={servers.length === 0}>
              全选
            </Button>
            <Button variant='outline' size='sm' className='h-7' onClick={handleClear} disabled={selectedIds.size === 0}>
              清空(=全部)
            </Button>
            <span className='text-muted-foreground ml-auto'>
              已选 {selectedIds.size} / {servers.length}
            </span>
          </div>

          <div className='max-h-64 space-y-1.5 overflow-y-auto rounded border p-2'>
            {servers.length === 0 ? (
              <div className='text-muted-foreground text-xs'>暂无服务器</div>
            ) : (
              servers.map((s) => (
                <label key={s.id} className='hover:bg-muted/60 flex cursor-pointer items-center gap-2 rounded px-1.5 py-1'>
                  <Checkbox
                    checked={selectedIds.has(s.id)}
                    onCheckedChange={(c) => toggle(s.id, c === true)}
                  />
                  <span className='text-xs'>{s.name}</span>
                </label>
              ))
            )}
          </div>

          <div className='flex items-center justify-end gap-2 pt-1'>
            <Button variant='outline' size='sm' onClick={() => setOpen(false)} disabled={saving}>
              取消
            </Button>
            <Button size='sm' onClick={handleSave} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
