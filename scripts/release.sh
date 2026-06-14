#!/bin/bash
# 自动发布脚本
# 触发方式：commit message 包含 [release] 时由 post-commit hook 调用
# 流程：bump version -> 更新 README changelog -> commit -> tag -> push -> 创建 GitHub Release
#
# 用法:
#   bash scripts/release.sh           # bump patch (0.2.4 -> 0.2.5)
#   bash scripts/release.sh minor     # bump minor (0.2.4 -> 0.3.0)
#   bash scripts/release.sh major     # bump major (0.2.4 -> 1.0.0)
#   bash scripts/release.sh 0.5.0     # 直接指定版本号
#
# 历史背景:之前从 miaomiaowux-frontend/package.json 用 npm version bump,前端迁私有 repo 后
# 改成后端 internal/version/version.go 作唯一来源,bump 用纯 bash awk 解析 X.Y.Z 自增。
# 前端版本号同 tag 由私有 repo 自管,不再 cross-update。

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

# 获取上一个 tag
PREV_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
if [ -z "$PREV_TAG" ]; then
  echo "[ERROR] 没有找到上一个 tag，无法生成 changelog"
  exit 1
fi

# 收集自上个 tag 以来的 commit messages（排除版本号 commit 和 merge commit）
COMMITS=$(git log "${PREV_TAG}..HEAD" --pretty=format:"- %s" --no-merges | grep -v "^- v[0-9]" | sort -u || true)
if [ -z "$COMMITS" ]; then
  echo "[SKIP] 没有新的 commit，跳过发布"
  exit 0
fi

echo "=== 变更内容 ==="
echo "$COMMITS"
echo ""

# 1. bump version
echo "[1/5] 升级版本号..."
CURRENT_VERSION=$(grep 'const Version' "${PROJECT_ROOT}/internal/version/version.go" | sed -n 's/.*"\(.*\)".*/\1/p')
if [ -z "$CURRENT_VERSION" ]; then
  echo "[ERROR] 无法从 internal/version/version.go 读取现有版本号"
  exit 1
fi

BUMP_ARG="${1:-patch}"
case "$BUMP_ARG" in
  major)
    NEW_VERSION=$(echo "$CURRENT_VERSION" | awk -F. '{printf "%d.0.0", $1+1}')
    ;;
  minor)
    NEW_VERSION=$(echo "$CURRENT_VERSION" | awk -F. '{printf "%d.%d.0", $1, $2+1}')
    ;;
  patch)
    NEW_VERSION=$(echo "$CURRENT_VERSION" | awk -F. '{printf "%d.%d.%d", $1, $2, $3+1}')
    ;;
  [0-9]*.[0-9]*.[0-9]*)
    # 直接指定 X.Y.Z
    NEW_VERSION="$BUMP_ARG"
    ;;
  *)
    echo "[ERROR] 无效的 bump 参数: $BUMP_ARG (应为 major / minor / patch 或 X.Y.Z)"
    exit 1
    ;;
esac

# 写新版本到 version.go + install.sh + quick-install.sh
bash scripts/sync-version.sh "$NEW_VERSION"

echo "  -> 新版本: v${NEW_VERSION}"

# 2. 更新 README changelog
echo "[2/5] 更新 README changelog..."
TODAY=$(date +%Y-%m-%d)

TMPFILE=$(mktemp)
echo "### v${NEW_VERSION} (${TODAY})" > "$TMPFILE"
echo "$COMMITS" >> "$TMPFILE"

INSERT_LINE=$(grep -n '<summary>更新日志</summary>' "$PROJECT_ROOT/README.md" | head -1 | cut -d: -f1)
INSERT_LINE=$((INSERT_LINE + 1))

{
  head -n "$INSERT_LINE" "$PROJECT_ROOT/README.md"
  cat "$TMPFILE"
  tail -n +"$((INSERT_LINE + 1))" "$PROJECT_ROOT/README.md"
} > "$PROJECT_ROOT/README.md.tmp"
mv "$PROJECT_ROOT/README.md.tmp" "$PROJECT_ROOT/README.md"
rm -f "$TMPFILE"

echo "  -> README 已更新"

# 3. commit + tag
echo "[3/5] 创建 commit 和 tag..."
git add -A
git commit -m "v${NEW_VERSION}" --no-verify
git tag "v${NEW_VERSION}"

echo "  -> tag: v${NEW_VERSION}"

# 4. push
echo "[4/5] 推送到远程..."
git push origin main
git push origin "v${NEW_VERSION}"

# 5. 创建 GitHub Release
echo "[5/5] 创建 GitHub Release..."
RELEASE_BODY="## 更新日志
## [妙妙屋 & 妙妙屋 X 交流群](https://t.me/miaomiaowux)

### v${NEW_VERSION} (${TODAY})
${COMMITS}

## 更新版本
可以在网页端直接检查并更新应用。

## 操作方法：
进入 「个人设置」 菜单 → 点击 「检查更新」 按钮 → 确认更新

## 其他版本安装及更新方式查看文档 [妙妙屋文档](https://miaomiaowu.net/docs/update)"

gh release create "v${NEW_VERSION}" \
  --title "v${NEW_VERSION}" \
  --notes "$RELEASE_BODY" \
  --generate-notes \
  --latest

echo ""
echo "=== 发布完成! v${NEW_VERSION} ==="
echo "  Release: https://github.com/iluobei/miaomiaowuX/releases/tag/v${NEW_VERSION}"
echo "  GitHub Action 将自动打包二进制文件"
