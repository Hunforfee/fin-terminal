#!/usr/bin/env bash
# 从 GitHub 拉取最新代码，按需重装依赖并重新构建
#
# 用法：
#   bash scripts/sync.sh                 # 拉 origin/main 并构建
#   bash scripts/sync.sh dev             # 拉指定分支
#   FORCE=1 bash scripts/sync.sh         # 有本地未提交改动时丢弃改动强行拉取
#   SKIP_BUILD=1 bash scripts/sync.sh    # 只拉代码不构建
#   GITHUB_TOKEN=ghp_xxx bash scripts/sync.sh   # 仓库为私有时的写法
#
# 设计要点：
# - 仓库已公开，默认走匿名 https，不需要 token
# - 传入 token 时只在本次 fetch 的 URL 里出现，不写入 .git/config，不落盘
# - 有本地未提交改动时默认中止，避免覆盖沙箱里的改动
# - 只在 package-lock.json 变化或 node_modules 缺失时才重装依赖，省时间
set -euo pipefail

BRANCH="${1:-main}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

REMOTE_URL="$(git remote get-url origin)"
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  # 私有库场景：把 token 拼进本次使用的 URL，用完即弃
  FETCH_URL="$(printf '%s' "$REMOTE_URL" | sed -E "s#https://github.com/#https://x-access-token:${GITHUB_TOKEN}@github.com/#")"
  echo "==> 使用 token 访问（不落盘）"
else
  FETCH_URL="$REMOTE_URL"
fi

if [[ -n "$(git status --porcelain)" ]]; then
  if [[ "${FORCE:-0}" == "1" ]]; then
    echo "==> 检测到本地未提交改动，FORCE=1，将丢弃改动"
    git checkout -- .
  else
    echo "!! 本地有未提交的改动，已中止。确认可以丢弃后加 FORCE=1 重跑：" >&2
    git status --short >&2
    exit 2
  fi
fi

LOCK_BEFORE="$(md5sum package-lock.json 2>/dev/null | awk '{print $1}')"

echo "==> 拉取 $BRANCH"
# 网络偶发 TLS 中断（GnuTLS -110），重试 3 次
n=0
until git -c credential.helper= -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 \
      fetch "$FETCH_URL" "$BRANCH"; do
  n=$((n + 1))
  if (( n >= 3 )); then
    echo "!! 拉取失败（已重试 $n 次），请检查网络后重跑" >&2
    exit 3
  fi
  echo "==> 第 $n 次失败，2 秒后重试"
  sleep 2
done
git reset --hard FETCH_HEAD

LOCK_AFTER="$(md5sum package-lock.json 2>/dev/null | awk '{print $1}')"
if [[ "$LOCK_BEFORE" != "$LOCK_AFTER" || ! -d node_modules ]]; then
  echo "==> 依赖有变化，安装中"
  npm ci --no-audit --no-fund || npm install --no-audit --no-fund
else
  echo "==> 依赖未变化，跳过安装"
fi

if [[ "${SKIP_BUILD:-0}" == "1" ]]; then
  echo "==> SKIP_BUILD=1，跳过构建"
else
  echo "==> 构建"
  npm run build
fi

echo "==> 完成：$(git log --oneline -1)"
