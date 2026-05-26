import { createContext } from 'react'

// 拖拽状态 Context — 避免 isActiveDragging 作为 prop 透传引起所有子组件全量重渲染。
// 只有真正用到 isActiveDragging 的 SortableCard / DraggableAvailableNode / SortableProxy / SortableUseItem
// 通过 useContext 订阅,Context 值变化时也只重渲染这些消费者。
export const DragStateContext = createContext<{ isActiveDragging: boolean }>({
  isActiveDragging: false,
})
