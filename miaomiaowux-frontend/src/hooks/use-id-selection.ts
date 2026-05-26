import { useCallback, useEffect, useState } from 'react'

interface Options {
  // 持久化到 localStorage(JSON.stringify 数组),hook 启动时自动恢复。
  // 例如 nodes 页面的 selectedNodeIds 用 'mmwx-selected-node-ids' 跨页面记忆。
  persistKey?: string
}

// 通用的 ID 多选 hook。
//
// 之前项目里散落着 8 处 `useState<Set<...>>(new Set())` + 各自的 toggle / toggleAll / clear,
// 行为不完全一致(有的 toggleAll 用"全选/全清",有的传入 allIds 数组,有的没有持久化)。
// 用这个 hook 后:
//   - 全部走 immutable update(new Set(prev) 然后增删)
//   - 全选语义统一为"如果当前选中数 = 候选总数 → 清空,否则选中所有候选"
//   - 持久化按需(传 persistKey 即可)
//
// 不强制迁移所有 8 处 — 复杂的(如 generator 三个 Set 相互依赖)留到 B 阶段拆分时再做。
export function useIdSelection<T extends string | number = number>(opts?: Options) {
  const persistKey = opts?.persistKey

  const [selected, setSelected] = useState<Set<T>>(() => {
    if (typeof window === 'undefined' || !persistKey) return new Set<T>()
    try {
      const raw = localStorage.getItem(persistKey)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) return new Set<T>(parsed)
      }
    } catch {
      // 解析失败保留空集,不阻塞
    }
    return new Set<T>()
  })

  useEffect(() => {
    if (typeof window === 'undefined' || !persistKey) return
    try {
      localStorage.setItem(persistKey, JSON.stringify([...selected]))
    } catch {
      // 写入失败(配额满 / 隐私模式)忽略
    }
  }, [selected, persistKey])

  const toggle = useCallback((id: T) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // toggleAll 接收当前候选 id 数组(因为 hook 不知道总候选);
  // 行为:已全选 → 清空,否则把候选全选(覆盖之前的选择)
  const toggleAll = useCallback((allIds: T[]) => {
    setSelected((prev) => (prev.size === allIds.length && allIds.length > 0 ? new Set<T>() : new Set(allIds)))
  }, [])

  const clear = useCallback(() => setSelected(new Set<T>()), [])

  const isSelected = useCallback((id: T) => selected.has(id), [selected])

  return {
    selected,
    setSelected,
    toggle,
    toggleAll,
    clear,
    isSelected,
    count: selected.size,
  }
}
