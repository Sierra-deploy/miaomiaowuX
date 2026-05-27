import { useTranslation } from 'react-i18next'
import { EditNodesDialog } from '@/components/edit-nodes-dialog'
import { MobileEditNodesDialog } from '@/components/mobile-edit-nodes-dialog'

// 这些类型沿用 EditNodesDialog 的内部类型,这里给一个最宽松的运行时模型,
// 避免把内部 ProxyGroup / Node 接口外露(B 阶段后续会迁移到共享 types)。
type ProxyGroup = { name: string; type: string; proxies: string[]; use?: string[]; [k: string]: any }
type Node = { node_name: string; tag?: string; [k: string]: any }
type ProxyProviderConfigRef = { id: number; name: string; process_mode?: string }

interface EditNodesHostDialogProps {
  // 端到端展示控制
  open: boolean
  onOpenChange: (open: boolean) => void
  isMobile: boolean
  // 文件元信息(用于桌面端标题)
  fileName: string | undefined
  // 数据
  proxyGroups: ProxyGroup[]
  availableNodes: string[]
  allNodes: Node[]
  // 写回 / 保存
  onProxyGroupsChange: (groups: ProxyGroup[]) => void
  onSave: () => void
  saving: boolean
  // 仅桌面端:显隐"已添加节点"
  showAllNodes: boolean
  onShowAllNodesChange: (show: boolean) => void
  // 节点 / 代理组 mutation 回调
  onRemoveNodeFromGroup: (groupName: string, nodeIndex: number) => void
  onRemoveGroup: (groupName: string) => void
  onRenameGroup: (oldName: string, newName: string) => void
  // 代理集合配置(仅在用户启用了代理集合特性时才传非空)
  proxyProviderConfigs: ProxyProviderConfigRef[]
}

// 适配桌面 / 移动两套节点编辑器的薄包装。
// 从 routes/subscribe-files.index.tsx L4843 提取,根据 isMobile 选择 EditNodesDialog 或 MobileEditNodesDialog,
// 两者 prop 子集略有不同(桌面端额外有 title / showAllNodes / saveButtonText / allNodes),已在内部分别处理。
export function EditNodesHostDialog({
  open,
  onOpenChange,
  isMobile,
  fileName,
  proxyGroups,
  availableNodes,
  allNodes,
  onProxyGroupsChange,
  onSave,
  saving,
  showAllNodes,
  onShowAllNodesChange,
  onRemoveNodeFromGroup,
  onRemoveGroup,
  onRenameGroup,
  proxyProviderConfigs,
}: EditNodesHostDialogProps) {
  const { t } = useTranslation('subscribe')

  if (isMobile) {
    return (
      <MobileEditNodesDialog
        open={open}
        onOpenChange={onOpenChange}
        proxyGroups={proxyGroups}
        availableNodes={availableNodes}
        allNodes={allNodes}
        onProxyGroupsChange={onProxyGroupsChange}
        onSave={onSave}
        onRemoveNodeFromGroup={onRemoveNodeFromGroup}
        onRemoveGroup={onRemoveGroup}
        onRenameGroup={onRenameGroup}
        showSpecialNodesAtBottom={true}
        proxyProviderConfigs={proxyProviderConfigs}
      />
    )
  }

  return (
    <EditNodesDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('editConfig.editNodesTitle', { name: fileName })}
      proxyGroups={proxyGroups}
      availableNodes={availableNodes}
      allNodes={allNodes}
      onProxyGroupsChange={onProxyGroupsChange}
      onSave={onSave}
      isSaving={saving}
      showAllNodes={showAllNodes}
      onShowAllNodesChange={onShowAllNodesChange}
      onRemoveNodeFromGroup={onRemoveNodeFromGroup}
      onRemoveGroup={onRemoveGroup}
      onRenameGroup={onRenameGroup}
      saveButtonText={t('editConfig.applyAndSave')}
      showSpecialNodesAtBottom={true}
      proxyProviderConfigs={proxyProviderConfigs}
    />
  )
}
