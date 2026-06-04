// 节点选择器:按 original_server 分组 + 顶部 tag chip 工具栏批量选中。
// 复用于:
//   - edit-metadata-dialog(嵌在表单里)
//   - files-list-section(订阅行的"选择节点" Popover 快捷入口)
import { useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'

export interface NodePickerItem {
  id: number
  node_name: string
  protocol: string
  original_server: string
  tag?: string
}

export interface NodePickerProps {
  allNodes: NodePickerItem[]
  selectedNodeIds: number[]
  onChange: (next: number[]) => void
  // 列表容器高度类(默认 max-h-64 适合 dialog;Popover 可调大些)
  listHeightClass?: string
  // 顶部 hint 文案,默认无
  hintText?: string
}

export function NodePicker({
  allNodes,
  selectedNodeIds,
  onChange,
  listHeightClass = 'max-h-64',
  hintText,
}: NodePickerProps) {
  const selected = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds])
  // 按 original_server 分组
  const groups = useMemo(() => {
    const map = new Map<string, NodePickerItem[]>()
    for (const n of allNodes) {
      const key = (n.original_server || '').trim() || '(未关联服务器)'
      const arr = map.get(key) || []
      arr.push(n)
      map.set(key, arr)
    }
    return map
  }, [allNodes])
  const allTags = useMemo(
    () => Array.from(new Set(allNodes.map((n) => (n.tag || '').trim()).filter(Boolean))).sort(),
    [allNodes],
  )

  const setIds = (next: number[]) => onChange(next)
  const toggleNode = (id: number) => {
    const s = new Set(selected)
    if (s.has(id)) s.delete(id)
    else s.add(id)
    setIds(Array.from(s))
  }
  const toggleGroupAll = (members: NodePickerItem[]) => {
    const s = new Set(selected)
    const allIn = members.every((n) => s.has(n.id))
    if (allIn) members.forEach((n) => s.delete(n.id))
    else members.forEach((n) => s.add(n.id))
    setIds(Array.from(s))
  }
  const toggleTagAll = (tag: string) => {
    const s = new Set(selected)
    const members = allNodes.filter((n) => (n.tag || '').trim() === tag)
    const allIn = members.every((n) => s.has(n.id))
    if (allIn) members.forEach((n) => s.delete(n.id))
    else members.forEach((n) => s.add(n.id))
    setIds(Array.from(s))
  }

  return (
    <div className='space-y-2'>
      <div className='flex items-center justify-between gap-2'>
        <div className='text-xs text-muted-foreground'>
          已选 <span className='tabular-nums font-medium text-foreground'>{selected.size}</span> / {allNodes.length}
        </div>
        <div className='flex gap-1'>
          <Button type='button' variant='ghost' size='sm' className='h-6 text-xs' onClick={() => setIds(allNodes.map((n) => n.id))}>
            全选
          </Button>
          <Button type='button' variant='ghost' size='sm' className='h-6 text-xs' onClick={() => setIds([])}>
            清空
          </Button>
        </div>
      </div>
      {allTags.length > 0 && (
        <div className='flex flex-wrap gap-1'>
          <span className='self-center text-xs text-muted-foreground'>按标签:</span>
          {allTags.map((tag) => (
            <Button
              key={tag}
              type='button'
              variant='outline'
              size='sm'
              className='h-6 text-xs'
              onClick={() => toggleTagAll(tag)}
              title={`切换标签 "${tag}" 下所有节点`}
            >
              {tag}
            </Button>
          ))}
        </div>
      )}
      <div className={`border rounded-md overflow-y-auto divide-y ${listHeightClass}`}>
        {Array.from(groups.entries()).map(([server, members]) => {
          const allIn = members.every((n) => selected.has(n.id))
          return (
            <div key={server} className='p-2 space-y-1'>
              <div className='flex items-center justify-between gap-2'>
                <button
                  type='button'
                  className='flex items-center gap-1.5 text-sm font-medium hover:text-primary text-left'
                  onClick={() => toggleGroupAll(members)}
                  title='点击切换该服务器下所有节点'
                >
                  <Checkbox checked={allIn} />
                  <span className='truncate'>{server}</span>
                </button>
                <span className='text-[10px] text-muted-foreground tabular-nums shrink-0'>
                  {members.filter((n) => selected.has(n.id)).length}/{members.length}
                </span>
              </div>
              <div className='pl-5 grid grid-cols-1 sm:grid-cols-2 gap-y-1'>
                {members.map((n) => (
                  <label key={n.id} className='flex items-center gap-1.5 text-xs cursor-pointer'>
                    <Checkbox checked={selected.has(n.id)} onCheckedChange={() => toggleNode(n.id)} />
                    <span className='truncate' title={n.node_name}>{n.node_name}</span>
                    <span className='text-[9px] uppercase text-muted-foreground shrink-0'>{n.protocol}</span>
                  </label>
                ))}
              </div>
            </div>
          )
        })}
      </div>
      {hintText && <p className='text-xs text-muted-foreground'>{hintText}</p>}
    </div>
  )
}
