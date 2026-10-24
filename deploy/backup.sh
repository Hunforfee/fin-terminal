#!/usr/bin/env bash
# 独立部署：PostgreSQL 全量备份
#
# 用法：
#   ./deploy/backup.sh                 # 备份到 ./backups
#   ./deploy/backup.sh /data/db-backup # 指定目录
#
# 说明：
#   - 采用 pg_dump -Fc（自定义格式）：支持压缩、pg_restore 选择性恢复、可跨版本。
#     另存 pg_dumpall --globals-only 保存角色（如只读角色 fin_market_ro），
#     这是纯 pg_dump 不会包含、但恢复后查看器依赖的关键对象。
#   - 容器内不落盘，直接经 stdout 写到宿主机，避免残留。
#   - 备份完成后用 pg_restore --list 做可读性校验，失败则删除，不留下坏备份。

set -euo pipefail

BACKUP_DIR="${1:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-7}"
COMPOSE="${COMPOSE:-docker compose}"
STAMP="$(date '+%Y%m%d-%H%M%S')"
OUT_DIR="$BACKUP_DIR/fin-market-$STAMP"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
die() { printf '[%s] ERROR: %s\n' "$(date '+%F %T')" "$*" >&2; exit 1; }

mkdir -p "$OUT_DIR"

log "备份开始 -> $OUT_DIR"

# ---------- 1. 全量数据 ----------
if ! $COMPOSE exec -T postgres pg_dump -Fc -Z9 -U "${POSTGRES_USER:-fin_market}" \
      "${POSTGRES_DB:-fin_market}" > "$OUT_DIR/fin_market.dump"; then
  die "pg_dump 失败"
fi
log "数据导出完成：$(du -h "$OUT_DIR/fin_market.dump" | cut -f1)"

# ---------- 2. 全局对象（角色 / 权限）----------
if ! $COMPOSE exec -T postgres pg_dumpall --globals-only > "$OUT_DIR/globals.sql"; then
  die "pg_dumpall 失败"
fi
log "角色导出完成：$(du -h "$OUT_DIR/globals.sql" | cut -f1)"

# ---------- 3. 完整性校验 ----------
if pg_restore --list "$OUT_DIR/fin_market.dump" > /dev/null 2>&1; then
  log "pg_restore --list 校验通过"
elif docker run --rm -v "$OUT_DIR:/b" -w /b postgres:16-alpine \
      pg_restore --list /b/fin_market.dump > /dev/null 2>&1; then
  log "pg_restore --list 校验通过（容器内校验）"
else
  rm -rf "$OUT_DIR"
  die "备份文件校验失败，已删除：$OUT_DIR"
fi

# ---------- 4. 滚动保留 ----------
find "$BACKUP_DIR" -maxdepth 1 -type d -name 'fin-market-*' -mtime "+$KEEP_DAYS" -exec rm -rf {} + 2>/dev/null || true

log "备份完成，保留 $KEEP_DAYS 天"
log "产物：$OUT_DIR/fin_market.dump + globals.sql"
