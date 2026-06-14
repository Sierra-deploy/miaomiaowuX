#!/bin/bash
# 一次性 release 脚本 — 修补「v0.2.5 / v0.2.6 内容版本号仍是 0.2.4」的历史问题。
#
# 跟正常 release.sh 区别:
#   - PREV_TAG 写死成 v0.2.4(不用 git describe 找上一个 tag,因为上一个是损坏的 v0.2.6)
#   - NEW_VERSION 写死成 0.2.7(直接指定,不 bump)
#   - 收集 v0.2.4..HEAD 全部 commits 作为 changelog → 让 v0.2.5 / v0.2.6 已经发但内容错的改动并到 v0.2.7
#
# 用完丢掉:rm scripts/release-once.sh
#
# 使用:bash scripts/release-once.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

# 写死 — 一次性脚本不需要灵活
PREV_TAG="v0.2.4"
NEW_VERSION="0.2.7"

if ! git rev-parse "$PREV_TAG" >/dev/null 2>&1; then
  echo "[ERROR] 上游 tag $PREV_TAG 不存在,无法生成 changelog"
  exit 1
fi

# 收集自 v0.2.4 以来所有 commit messages
# 排除版本号 commit (v0.x.y) 和 merge commit;sort -u 去重(同名修复多次也只留一条)
COMMITS=$(git log "${PREV_TAG}..HEAD" --pretty=format:"- %s" --no-merges | grep -v "^- v[0-9]" | sort -u || true)
if [ -z "$COMMITS" ]; then
  echo "[ERROR] $PREV_TAG..HEAD 之间没有 commit"
  exit 1
fi

echo "=== 变更内容(${PREV_TAG}..HEAD) ==="
echo "$COMMITS"
echo ""

# 1. 写入新版本号到 version.go + install.sh + quick-install.sh
echo "[1/6] 同步后端版本号到 ${NEW_VERSION}..."
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

# 3. 后端 commit + tag
echo "[3/6] 创建后端 commit 和 tag..."
git add -A
git commit -m "v${NEW_VERSION}" --no-verify
git tag "v${NEW_VERSION}"
echo "  -> tag: v${NEW_VERSION}"

# 4. 前端 repo 同步版本号 + 打 tag
FRONTEND_DIR="$PROJECT_ROOT/miaomiaowux-frontend"
if [ ! -d "$FRONTEND_DIR/.git" ]; then
  echo "[ERROR] 前端 repo 不存在或非 git work tree: $FRONTEND_DIR"
  echo "       请先 clone:"
  echo "         git clone git@github.com:iluobei/miaomiaowux-frontend.git $FRONTEND_DIR"
  exit 1
fi

echo "[4/6] 前端 repo 同步版本号 + 打同名 tag v${NEW_VERSION}..."
pushd "$FRONTEND_DIR" >/dev/null

if ! git diff-index --quiet HEAD --; then
  echo "[ERROR] 前端 repo working tree 有未 commit 改动,请先处理:"
  git status --short
  popd >/dev/null
  exit 1
fi

git fetch origin --quiet
LOCAL_HEAD=$(git rev-parse HEAD)
REMOTE_BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || echo "main")
REMOTE_HEAD=$(git rev-parse "origin/$REMOTE_BRANCH" 2>/dev/null || echo "")
if [ -n "$REMOTE_HEAD" ] && [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]; then
  echo "[ERROR] 前端 repo HEAD 跟 origin/$REMOTE_BRANCH 不一致:"
  echo "          local:  $LOCAL_HEAD"
  echo "          remote: $REMOTE_HEAD"
  echo "        请先 push: cd $FRONTEND_DIR && git push origin $REMOTE_BRANCH"
  popd >/dev/null
  exit 1
fi

if git rev-parse "v${NEW_VERSION}" >/dev/null 2>&1; then
  echo "  -> 前端 tag v${NEW_VERSION} 已存在,跳过 bump + commit + tag"
else
  echo "  -> sed bump package.json + src/hooks/use-version-check.ts → ${NEW_VERSION}..."
  sed -i "0,/\"version\":/s/\"version\": \"[^\"]*\"/\"version\": \"${NEW_VERSION}\"/" package.json
  sed -i "s/const CURRENT_VERSION = '[^']*'/const CURRENT_VERSION = '${NEW_VERSION}'/" src/hooks/use-version-check.ts

  git add package.json src/hooks/use-version-check.ts
  git commit -m "v${NEW_VERSION}" --no-verify
  git push origin "$REMOTE_BRANCH"
  echo "  -> 前端 bump commit 已 push 到 origin/$REMOTE_BRANCH"

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

> 本版本汇总了 v0.2.5 / v0.2.6 发布后才发现的版本号同步问题修复,从 ${PREV_TAG} 至今所有改动重新打包。

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
echo ""
echo "  用完可以删:rm scripts/release-once.sh"
