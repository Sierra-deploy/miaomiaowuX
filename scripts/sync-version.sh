#!/bin/bash
# 同步版本号到所有引用文件
#
# 用法:
#   bash scripts/sync-version.sh             # 从 internal/version/version.go 读现有版本,同步到 install 脚本
#   bash scripts/sync-version.sh 0.3.0       # 写入指定版本到 version.go + install 脚本
#
# 历史背景:之前唯一版本来源是 miaomiaowux-frontend/package.json,前端迁私有 repo 后改用
# internal/version/version.go 作唯一来源(后端总要 build,这个文件总在)。前端版本号
# (private repo 的 package.json / use-version-check.ts)由前端自己同 tag 维护,不再 cross-update。

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

VERSION="${1:-}"

if [ -z "$VERSION" ]; then
    # 没传参 → 从 version.go 读现有版本(用于 build.sh 启动时的幂等同步)
    VERSION=$(grep 'const Version' "${PROJECT_ROOT}/internal/version/version.go" | sed -n 's/.*"\(.*\)".*/\1/p')
    if [ -z "$VERSION" ]; then
        echo "❌ 无法从 internal/version/version.go 读取版本号"
        exit 1
    fi
fi

echo "同步版本号: $VERSION"

# 更新 internal/version/version.go(传参时是写入新版本,无参时是无操作覆盖)
sed -i "s/const Version = \".*\"/const Version = \"$VERSION\"/" "${PROJECT_ROOT}/internal/version/version.go"
echo "✓ internal/version/version.go"

# 更新 install.sh
sed -i "s/VERSION=\"v.*\"/VERSION=\"v$VERSION\"/" "${PROJECT_ROOT}/install.sh"
echo "✓ install.sh"

# 更新 quick-install.sh
sed -i "s/VERSION=\"v.*\"/VERSION=\"v$VERSION\"/" "${PROJECT_ROOT}/quick-install.sh"
echo "✓ quick-install.sh"

echo ""
echo "版本号同步完成: $VERSION"
