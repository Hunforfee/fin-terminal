#!/usr/bin/env bash
# 每日数据库备份 + 双通道网盘同步（被平台自动化任务调用，也可手动执行）
#
# 流程：
#   1. deploy/backup.sh      —— pg_dump -Fc + 角色 + pg_restore 校验（坏档自动删）+ 本地保留 KEEP_LOCAL_DAYS 天
#   2. 打包为单个 tar.gz 并做 gzip -t 校验（通过后删除未打包目录，省本地空间）
#   3. 上传 tdrive「行情数据备份」——必做通道，脚本走本地网关直连 MCP，零登录态、零扫码
#   4. 上传夸克 workbuddy 文件夹——cookie 有效才做；失效不阻塞，仅记录（退出码 2）
#   5. 双通道滚动保留 KEEP_REMOTE 份（夸克旧档进回收站，可恢复）
#
# 退出码：0 = 全部成功；2 = tdrive 成功但夸克失败（多为 cookie 过期，需扫码刷新）；
#         1 = 备份或 tdrive 失败（硬失败）
#
# 可用环境变量：
#   TDRIVE_DIR_FID   平台网盘目标目录（默认：行情数据备份 YhHLFNdbXnCC）
#   QUARK_DIR_FID    夸克目标目录（默认：workbuddy 文件夹 47bb20b4…）
#   KEEP_REMOTE      网盘各通道保留份数（默认 7）
#   KEEP_LOCAL_DAYS  本地 tar 包保留天数（默认 7）
#   SKIP_QUARK=1     跳过夸克通道（调试用）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKUP_DIR="${1:-$ROOT/backups}"
TDRIVE_DIR_FID="${TDRIVE_DIR_FID:-YhHLFNdbXnCC}"
QUARK_DIR_FID="${QUARK_DIR_FID:-47bb20b4573b43d190ef9e64d0bcd7fc}"
KEEP_REMOTE="${KEEP_REMOTE:-7}"
KEEP_LOCAL_DAYS="${KEEP_LOCAL_DAYS:-7}"
PREFIX="fin-market-db-"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }

mkdir -p "$BACKUP_DIR"

# ---------- 1. 数据库备份 ----------
log "== 1/5 数据库备份（backup.sh）"
BEFORE="$(ls "$BACKUP_DIR" 2>/dev/null || true)"
"$SCRIPT_DIR/backup.sh" "$BACKUP_DIR"
NEW_DIR="$(comm -13 <(printf '%s\n' "$BEFORE") <(ls "$BACKUP_DIR") | grep '^fin-market-' | head -1 || true)"
if [ -z "$NEW_DIR" ]; then
  log "ERROR: backup.sh 执行成功但找不到新备份目录"
  exit 1
fi
STAMP="${NEW_DIR#fin-market-}"

# ---------- 2. 打包 ----------
log "== 2/5 打包 $NEW_DIR -> ${PREFIX}${STAMP}.tar.gz"
TARBALL="$BACKUP_DIR/${PREFIX}${STAMP}.tar.gz"
tar -czf "$TARBALL.tmp" -C "$BACKUP_DIR" "$NEW_DIR"
if ! gzip -t "$TARBALL.tmp"; then
  rm -f "$TARBALL.tmp"
  log "ERROR: 打包结果 gzip 校验失败"
  exit 1
fi
mv "$TARBALL.tmp" "$TARBALL"
rm -rf "$BACKUP_DIR/$NEW_DIR"   # 只留 tar 包
SIZE="$(du -b "$TARBALL" | cut -f1)"
log "打包完成: $TARBALL（$SIZE B）"

# ---------- 3. tdrive 上传（必做） ----------
log "== 3/5 上传 tdrive（目录 $TDRIVE_DIR_FID）"
node "$ROOT/scripts/tdrive-tool.mjs" upload "$TARBALL" "$TDRIVE_DIR_FID"
log "tdrive 上传完成"

# ---------- 4. 夸克上传（cookie 有效才做） ----------
QUARK_STATUS="skipped"
if [ "${SKIP_QUARK:-0}" = "1" ]; then
  log "== 4/5 SKIP_QUARK=1，跳过夸克通道"
elif python3 "$SCRIPT_DIR/quark_upload.py" --check; then
  log "== 4/5 上传夸克（目录 $QUARK_DIR_FID）"
  if python3 "$SCRIPT_DIR/quark_upload.py" upload "$TARBALL" "$QUARK_DIR_FID"; then
    QUARK_STATUS="ok"
  else
    QUARK_STATUS="failed"
    log "WARN: 夸克上传失败（tdrive 已成功，不影响主通道）"
  fi
else
  QUARK_STATUS="cookie_expired"
  log "WARN: 夸克 cookie 已失效，跳过夸克通道——需要扫码刷新（重跑 quark-drive skill 的 get_cookie.py）"
fi

# ---------- 5. 双通道滚动保留 ----------
log "== 5/5 滚动保留（各通道保留 $KEEP_REMOTE 份）"
node "$ROOT/scripts/tdrive-tool.mjs" prune "$TDRIVE_DIR_FID" "$KEEP_REMOTE" --prefix "$PREFIX"
if [ "$QUARK_STATUS" = "ok" ]; then
  python3 "$SCRIPT_DIR/quark_upload.py" prune "$QUARK_DIR_FID" "$KEEP_REMOTE" "$PREFIX"
fi
find "$BACKUP_DIR" -maxdepth 1 -name "${PREFIX}*.tar.gz" -mtime "+$KEEP_LOCAL_DAYS" -delete 2>/dev/null || true

log "RESULT: tdrive=ok quark=$QUARK_STATUS tarball=${PREFIX}${STAMP}.tar.gz size=$SIZE"

if [ "$QUARK_STATUS" = "ok" ] || [ "$QUARK_STATUS" = "skipped" ]; then
  exit 0
fi
exit 2
