#!/usr/bin/env bash
# 独立部署：PostgreSQL 全量备份
#
# 用法：
#   ./deploy/backup.sh                 # 备份到 <项目根>/backups
#   ./deploy/backup.sh /data/db-backup # 指定目录
#   DIRECT=1 ./deploy/backup.sh        # 强制直连模式
#
# 连接方式（默认自动探测，两种都支持）：
#   - docker 模式：compose 栈正在运行（生产部署）——docker compose exec -T postgres pg_dump
#   - direct 模式：裸机部署 / 本沙箱——postgres 以系统进程跑在 127.0.0.1:5432，直接用本机 pg_dump
#     连接串来源：环境变量 PGURL > 项目根 .env.local 的 MARKET_DATABASE_URL
#   角色（globals）在直连模式下优先走 su postgres（本地 socket 超级用户），
#   失败则回退 pg_dumpall -d <连接串>；两者都失败只告警不中断（数据备份优先）。
#
# 说明：
#   - 采用 pg_dump -Fc（自定义格式）：支持压缩、pg_restore 选择性恢复、可跨版本。
#     另存 pg_dumpall --globals-only 保存角色（如只读角色 fin_market_ro），
#     这是纯 pg_dump 不会包含、但恢复后查看器依赖的关键对象。
#   - 容器内不落盘，直接经 stdout 写到宿主机，避免残留。
#   - 备份完成后用 pg_restore --list 做可读性校验，失败则删除，不留下坏备份。

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"   # docker compose 与默认相对路径都依赖项目根目录

# 传入相对路径时先解析为绝对路径（cd 之后相对基准不变）
_case="${1:-}"
BACKUP_DIR="${_case:-./backups}"
[[ "$BACKUP_DIR" = /* ]] || BACKUP_DIR="$ROOT_DIR/${BACKUP_DIR#./}"

KEEP_DAYS="${KEEP_DAYS:-7}"
STAMP="$(date '+%Y%m%d-%H%M%S')"
OUT_DIR="$BACKUP_DIR/fin-market-$STAMP"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
die() { printf '[%s] ERROR: %s\n' "$(date '+%F %T')" "$*" >&2; exit 1; }

mkdir -p "$OUT_DIR"

log "备份开始 -> $OUT_DIR"

# ---------- 0. 连接方式探测 ----------
COMPOSE="${COMPOSE:-docker compose}"
[ -f "$ROOT_DIR/deploy/.env.deploy" ] && COMPOSE="$COMPOSE --env-file deploy/.env.deploy"

DIRECT="${DIRECT:-}"
if [ -z "$DIRECT" ]; then
  if $COMPOSE exec -T postgres true >/dev/null 2>&1; then
    DIRECT=0
  else
    DIRECT=1
    log "compose 栈不可用，切换直连模式（127.0.0.1:5432）"
  fi
fi

if [ "$DIRECT" = "1" ]; then
  # 直连模式：解析连接串
  if [ -z "${PGURL:-}" ]; then
    PGURL="$(grep -E '^MARKET_DATABASE_URL=' "$ROOT_DIR/.env.local" 2>/dev/null | head -1 | cut -d= -f2-)"
  fi
  [ -n "${PGURL:-}" ] || die "直连模式需要 PGURL 环境变量或 $ROOT_DIR/.env.local 中的 MARKET_DATABASE_URL"
  DUMP_CMD=(pg_dump -Fc -Z9 "$PGURL")
else
  DUMP_CMD=($COMPOSE exec -T postgres pg_dump -Fc -Z9 -U "${POSTGRES_USER:-fin_market}" \
            "${POSTGRES_DB:-fin_market}")
fi

# ---------- 1. 全量数据 ----------
if ! "${DUMP_CMD[@]}" > "$OUT_DIR/fin_market.dump"; then
  rm -rf "$OUT_DIR"
  die "pg_dump 失败"
fi
log "数据导出完成：$(du -h "$OUT_DIR/fin_market.dump" | cut -f1)"

# ---------- 2. 全局对象（角色 / 权限）----------
GLOBALS_OK=1
if [ "$DIRECT" = "1" ]; then
  # 直连模式：优先 su postgres（超级用户，角色最全），回退连接串
  if su postgres -c "pg_dumpall --globals-only" > "$OUT_DIR/globals.sql" 2>/dev/null; then
    log "角色导出完成（su postgres）：$(du -h "$OUT_DIR/globals.sql" | cut -f1)"
  elif pg_dumpall --globals-only -d "$PGURL" > "$OUT_DIR/globals.sql" 2>/dev/null; then
    log "角色导出完成（连接串）：$(du -h "$OUT_DIR/globals.sql" | cut -f1)"
  else
    GLOBALS_OK=0
    log "WARN: 角色导出失败（两种方式均不可用），本次备份仅含数据——恢复后需手动补建 fin_market_ro 等角色"
  fi
else
  if ! $COMPOSE exec -T postgres pg_dumpall --globals-only > "$OUT_DIR/globals.sql"; then
    GLOBALS_OK=0
    log "WARN: 角色导出失败，本次备份仅含数据"
  else
    log "角色导出完成：$(du -h "$OUT_DIR/globals.sql" | cut -f1)"
  fi
fi

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
log "产物：$OUT_DIR/fin_market.dump$( [ "$GLOBALS_OK" = "1" ] && echo ' + globals.sql' || echo '（无 globals）' )"
