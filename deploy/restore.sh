#!/usr/bin/env bash
# 独立部署：PostgreSQL 全量恢复
#
# ⚠️ 不可恢复操作：会覆盖目标库数据。执行前会二次确认。
#
# 用法：
#   ./deploy/restore.sh backups/fin-market-20261024-120000
#
# 建议顺序（见 DEPLOY.md「回滚步骤」）：
#   1. 停 web 与 worker（避免写入冲突）
#   2. 执行本脚本
#   3. 启回服务并验收

set -euo pipefail

SRC="${1:?用法: $0 <备份目录>，例如 $0 backups/fin-market-20261024-120000}"
DUMP="$SRC/fin_market.dump"
GLOBALS="$SRC/globals.sql"
COMPOSE="${COMPOSE:-docker compose}"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
die() { printf '[%s] ERROR: %s\n' "$(date '+%F %T')" "$*" >&2; exit 1; }

[ -f "$DUMP" ] || die "找不到备份文件：$DUMP"

log "即将把 $DUMP 恢复到 ${POSTGRES_DB:-fin_market}"
log "目标容器：postgres（${COMPOSE}）"
read -r -p "确认覆盖？请输入 yes 继续：" CONFIRM
[ "$CONFIRM" = "yes" ] || die "已取消"

# ---------- 1. 可选：恢复角色 ----------
if [ -f "$GLOBALS" ]; then
  log "恢复全局对象（角色/权限，已存在则忽略报错）"
  $COMPOSE exec -T postgres psql -U "${POSTGRES_USER:-fin_market}" -d postgres \
    -v ON_ERROR_STOP=0 -f - < "$GLOBALS" > /dev/null 2>&1 || log "角色恢复有告警（常见：已存在），继续"
fi

# ---------- 2. 恢复数据 ----------
# --clean：先删除已存在对象；--if-exists 避免对象不存在时报错
log "开始恢复数据"
if $COMPOSE exec -T postgres pg_restore -U "${POSTGRES_USER:-fin_market}" \
      -d "${POSTGRES_DB:-fin_market}" --clean --if-exists --no-owner < "$DUMP"; then
  log "恢复完成"
else
  die "pg_restore 返回非 0（部分对象可能已恢复，请检查日志）"
fi

log "下一步：启动 web 与 worker，并做验收（见 DEPLOY.md）"
