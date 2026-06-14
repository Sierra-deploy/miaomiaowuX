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
echo "[1/6] 升级版本号..."
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
echo "[2/6] 更新 README changelog..."
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
echo "[3/6] 创建后端 commit 和 tag..."
git add -A
git commit -m "v${NEW_VERSION}" --no-verify
git tag "v${NEW_VERSION}"

echo "  -> tag: v${NEW_VERSION}"

# 4. 前端 repo 同步打 tag(GitHub Actions 拉前端时用 ref: ${{ github.ref_name }} 同 tag 严格对齐,
# 必须先在前端 repo 推 tag,后端 tag push 触发 CI 时才能拉到匹配的前端 source。
# 前端 repo 当前 HEAD 必须已经是 release 想要的版本 → 上游 push 过)
FRONTEND_DIR="$PROJECT_ROOT/miaomiaowux-frontend"
if [ ! -d "$FRONTEND_DIR/.git" ]; then
  echo "[ERROR] 前端 repo 不存在或非 git work tree: $FRONTEND_DIR"
  echo "       同 tag 策略要求前端 repo 在本地,请先 clone:"
  echo "         git clone git@github.com:iluobei/miaomiaowux-frontend.git $FRONTEND_DIR"
  exit 1
fi

echo "[4/6] 前端 repo 同步版本号 + 打同名 tag v${NEW_VERSION}..."
pushd "$FRONTEND_DIR" >/dev/null

# 前端 working tree 必须干净 — 否则脏状态的改动会跟下面 sed 的改动混在同一个 commit,语义混乱
if ! git diff-index --quiet HEAD --; then
  echo "[ERROR] 前端 repo working tree 有未 commit 改动,请先 commit + push 再 release:"
  git status --short
  popd >/dev/null
  exit 1
fi

# 检查本地 HEAD 跟 origin 是否同步,避免 tag 指向只有本地有的 commit
git fetch origin --quiet
LOCAL_HEAD=$(git rev-parse HEAD)
REMOTE_BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || echo "main")
REMOTE_HEAD=$(git rev-parse "origin/$REMOTE_BRANCH" 2>/dev/null || echo "")
if [ -n "$REMOTE_HEAD" ] && [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]; then
  echo "[ERROR] 前端 repo HEAD 跟 origin/$REMOTE_BRANCH 不一致:"
  echo "          local:  $LOCAL_HEAD"
  echo "          remote: $REMOTE_HEAD"
  echo "        请先 push 本地 commit: cd $FRONTEND_DIR && git push origin $REMOTE_BRANCH"
  popd >/dev/null
  exit 1
fi

# 已存在同名 tag → 跳过整个 bump + commit 流程(支持 release.sh 重试)
if git rev-parse "v${NEW_VERSION}" >/dev/null 2>&1; then
  echo "  -> 前端 tag v${NEW_VERSION} 已存在,跳过 bump + commit + tag"
else
  # 同步前端 2 处硬编码版本号 — 否则前端展示版本号 + 检查更新机制对比都用旧值,
  # 用户更新后 UI 仍显示老版本(0.2.4)且持续提示"有新版本"。
  echo "  -> 更新 package.json + src/hooks/use-version-check.ts 到 ${NEW_VERSION}..."
  # package.json: 顶部 "version": "x.y.z" — 用 sed 改首个匹配,避免改到 dependencies 里的 ^x.y.z
  sed -i "0,/\"version\":/s/\"version\": \"[^\"]*\"/\"version\": \"${NEW_VERSION}\"/" package.json
  # use-version-check.ts: const CURRENT_VERSION = '...'
  sed -i "s/const CURRENT_VERSION = '[^']*'/const CURRENT_VERSION = '${NEW_VERSION}'/" src/hooks/use-version-check.ts

  # commit + push 到 main(必须先到 origin,后面 tag 才能指向 push 出去的 commit)
  git add package.json src/hooks/use-version-check.ts
  git commit -m "v${NEW_VERSION}" --no-verify
  git push origin "$REMOTE_BRANCH"
  echo "  -> 前端 bump commit 已 push 到 origin/$REMOTE_BRANCH"

  # 打 tag(指向刚 push 的 commit)+ push tag
  git tag "v${NEW_VERSION}"
  echo "  -> 前端打 tag: v${NEW_VERSION}"
fi
git push origin "v${NEW_VERSION}"
echo "  -> 前端 tag v${NEW_VERSION} 已推送到 origin"
popd >/dev/null

# 5. push 后端
echo "[5/6] 推送后端到远程..."
git push origin main
git push origin "v${NEW_VERSION}"

# 6. 创建 GitHub Release
echo "[6/6] 创建 GitHub Release..."
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
