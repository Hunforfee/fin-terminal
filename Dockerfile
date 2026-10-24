# syntax=docker/dockerfile:1
#
# fin-terminal 全栈镜像
# 同一镜像承载两个进程入口：
#   web    : npm run start                          （Next.js 服务，默认入口）
#   worker : node scripts/market-update-worker.mjs  （行情更新执行器，compose 覆盖 command）
#
# worker 是纯 HTTP 客户端（仅 fetch /api/market-updates/worker），不依赖 node_modules，
# 因此与 web 共用镜像不会带来额外依赖负担。

ARG NODE_IMAGE=node:22-slim

# ---------- 1. 依赖安装（含 devDependencies，供构建使用）----------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# 国内服务器可加速：--registry=https://registry.npmmirror.com
RUN npm ci --no-audit --no-fund

# ---------- 2. 构建 ----------
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# build-market-importer.mjs 生成 .market-importer，next build 产出 .next
RUN npm run build

# ---------- 3. 生产依赖（剔除 devDependencies）----------
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---------- 4. 运行 ----------
FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    TZ=Asia/Shanghai

RUN useradd -r -u 1001 -m -s /usr/sbin/nologin appuser

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/.market-importer ./.market-importer
# 兜底快照（运行时 fs 读取，必须随镜像分发）
COPY --from=builder /app/src/data ./src/data
COPY --from=builder /app/public ./public
# worker 入口脚本
COPY --from=builder /app/scripts ./scripts

RUN mkdir -p /app/.next/cache && chown -R appuser:appuser /app

USER appuser
EXPOSE 3000

HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start"]
