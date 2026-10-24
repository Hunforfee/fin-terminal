# fin-terminal 全栈部署指南

Next.js 15（App Router）+ React 19 + TypeScript + Tailwind + ECharts，
后端为 **PostgreSQL 市场数据库** + **行情更新 worker**。

> 本文件按当前实际运行架构编写：Web 服务、PostgreSQL、采集 worker、反向代理四部分。
> 旧的「无需数据库、纯实时抓取」描述已不适用。
> **本文件中所有密码与密钥均为占位符**，真实值只放在未纳入版本库的 `deploy/.env.deploy`。

---

## 一、架构与端口

| 组件 | 说明 | 端口 | 备注 |
|---|---|---|---|
| **Web** | Next.js 生产服务（`npm run start`） | 3000（仅监听 127.0.0.1） | 对外一律经反向代理 |
| **PostgreSQL** | 公共市场数据持久化，库名 `fin_market` | 5432（仅容器网络内） | 表结构由应用自动创建，**无需手工迁移脚本** |
| **Worker** | `node scripts/market-update-worker.mjs` | 无（出站） | 纯 HTTP 客户端，轮询 Web 的 `/api/market-updates/worker` |
| **反向代理** | nginx，终止 TLS | 80 / 443 | 见 `deploy/nginx/` |

**Worker 的两个重要事实**（容易踩坑）：

1. 它**不连数据库、不依赖 `node_modules`**，只是每轮向 Web 发一个带 `Bearer` 的 POST，由 Web 侧完成采集、校验与入库。成功间隔 3 秒，空闲 15 秒，失败退避 60 秒。
2. 它启动时会校验 `MARKET_UPDATE_ORIGIN`：**必须是 `https://` 开头，或主机名为 `127.0.0.1` / `localhost`**。
   因此容器编排里**不能**填 `http://web:3000`（hostname 是 `web`，会被直接拒绝），必须填公网 HTTPS 地址；
   若只在本机调试，可填 `http://127.0.0.1:3000` 并与 Web 同机/同网络命名空间。

参考数据规模：全市场十二年 K 线约 **669 万行**，库体积约 **2.9 GB**（其中 K 线表约 2.4 GB）。规划磁盘时按 3–4 倍冗余预留。

---

## 二、两种部署模式

| 维度 | **独立部署（源服务器）** | **远程 API 模式（消费者）** |
|---|---|---|
| 编排文件 | `docker-compose.yml` | `deploy/docker-compose.remote.yml` |
| 组件 | PostgreSQL + Web + Worker | 仅 Web |
| 是否持有市场数据 | **是**，读写本地 `fin_market` | **否**，不读也不写本地市场库 |
| 数据来源 | 直接抓取上游（腾讯/新浪/东财） | 源站 `/api/market/data` |
| 关键变量 | `MARKET_DATABASE_URL`、`MARKET_READ_MODE=hybrid` | `MARKET_DATA_MODE=remote` + `MARKET_DATA_API_URL` + `MARKET_DATA_API_ACCESS_TOKEN` |
| Worker | **必须运行**，否则无后台更新 | **禁止运行**（上游文档明确要求） |
| 源站不可用时 | 走已有数据 + 按需重试 | **明确报错**，不静默回落 |
| 账号数据 | 本机（`DATABASE_URL`，可选） | 仍在本机（同上） |
| 适用场景 | 主力站点、需要自建采集 | 镜像站、只读分流、先跑前端 |

> 两种模式**不要混配**：源服务器一旦设了 `MARKET_DATA_MODE=remote` 就退化成消费者，
> 会停止本地采集与入库。`.env.example` 中对此已有警示。

---

## 三、前置要求

| 项目 | 要求 |
|---|---|
| 操作系统 | Linux（x86_64），建议 Ubuntu 22.04+ / Debian 12+ |
| Docker | ≥ 24（含 BuildKit），`docker compose` v2 插件 |
| 内存 | **≥ 4 GB**（2 GB 机器构建 Next.js 易 OOM，需加 swap） |
| 磁盘 | ≥ 40 GB（数据 2.9 GB + 镜像 + 备份滚动） |
| Node | 镜像内固定 22，宿主机无需安装 |
| 出网 | 必须能访问下列**国内**数据源 |

**上游数据源**（决定部署地域）：

| 源 | 地址 | 说明 |
|---|---|---|
| 腾讯行情 | `qt.gtimg.cn` | 主行情源 |
| 新浪行情 | `hq.sinajs.cn` | 需带 `Referer`，否则 403 |
| 新浪财务 | `money.finance.sina.com.cn` | 财务摘要/三表 |
| 东方财富 | `push2.eastmoney.com` | 当前部分接口返回 403，需关注 |
| 同花顺 iFinD | 自选（配置 `IFIND_BASE_URL` / `IFIND_TOKEN`） | 配了才走真实三表 |

> ⚠️ 数据源均为国内站点。部署到**境外**（Vercel 美区、AWS 海外等）抓取延迟会显著升高甚至超时，
> 建议用国内云主机（腾讯云/阿里云）或中国香港节点。

---

## 四、独立部署步骤

```bash
# 1. 准备环境变量（真实密钥只写在这里，不进版本库）
cp deploy/.env.deploy.example deploy/.env.deploy
vi deploy/.env.deploy          # 填密码、PUBLIC_ORIGIN、两个 32 字符以上令牌

# 2. 构建并启动
docker compose --env-file deploy/.env.deploy up -d --build

# 3. 观察启动（postgres 先 healthy，再 web，最后 worker）
docker compose --env-file deploy/.env.deploy ps
docker compose --env-file deploy/.env.deploy logs -f web
```

首次启动会自动建表（`fin_market_bars`、`fin_market_records`、`fin_market_revisions` 等），
随后由 worker 按需采集填充，无需手工执行迁移。

---

## 五、远程 API 模式步骤

```bash
cp deploy/.env.remote.example deploy/.env.remote
vi deploy/.env.remote          # 填源站地址与访问令牌（与源站 MARKET_DATA_API_TOKEN 相同）

docker compose -f deploy/docker-compose.remote.yml \
  --env-file deploy/.env.remote up -d --build
```

**源站侧**需已设置 `MARKET_DATA_API_TOKEN`。消费者连不上源站时会明确报错，
不会拿空数据糊弄页面。

---

## 六、环境变量参考

| 变量 | 模式 | 说明 |
|---|---|---|
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | 独立 | 数据库库名与凭据（占位符） |
| `MARKET_DATABASE_URL` | 独立 | 应用连接串，优先于旧的 `DATABASE_URL` |
| `MARKET_READ_MODE` | 独立 | `hybrid`=缓存复用+按需联网（推荐）；`database`=纯离线只读库 |
| `MARKET_RETENTION_YEARS` | 独立 | 历史保留年数，默认 12 |
| `MARKET_CLOSE_UPDATE_ENABLED` | 独立 | 收盘后自动更新调度（16:30 调度 / 06:30 补偿 / 周日复核） |
| `MARKET_UPDATE_WORKER_ENABLED` | 独立 | 后台更新开关 |
| `MARKET_UPDATE_WORKER_TOKEN` | 独立 | ≥32 字符，Web 与 Worker **必须一致** |
| `MARKET_UPDATE_ORIGIN` | 独立 | Worker 回连地址，**必须 https 或 localhost** |
| `MARKET_DATA_API_TOKEN` | 独立 | 对外数据 API 密钥，供远程消费者接入 |
| `MARKET_DATA_MODE=remote` | 远程 | 切换为消费者模式 |
| `MARKET_DATA_API_URL` | 远程 | 源站数据端点 |
| `MARKET_DATA_API_ACCESS_TOKEN` | 远程 | 与源站 `MARKET_DATA_API_TOKEN` 相同 |
| `DATABASE_URL` | 均可 | 账号数据独立库；不设则回落文件存储（容器重启丢失） |
| `AUTH_SESSION_SECRET` | 均可 | 手机号登录会话密钥 |
| `APP_ORIGIN` / `PUBLIC_ORIGIN` | 均可 | 公网访问地址 |
| `UPSTREAM_TIMEOUT_MS` | 均可 | 上游单请求超时，默认 8000，弱网可加大 |
| `IFIND_BASE_URL` / `IFIND_TOKEN` | 可选 | 接入后财务摘要切换为真实三表 |

生成随机密钥：`openssl rand -base64 32`

---

## 七、启动顺序与依赖

```
PostgreSQL（healthcheck: pg_isready）
   └── Web（depends_on: service_healthy）
         └── Worker（depends_on: service_healthy，出站调用 Web）
```

**顺序不能颠倒**：Worker 依赖 Web 提供的 `/api/market-updates/worker`，
Web 依赖数据库可写。手工启停也请遵循：

```bash
docker compose --env-file deploy/.env.deploy stop worker web   # 先停上层
docker compose --env-file deploy/.env.deploy stop postgres     # 再停数据库
# 启动反过来：postgres → web → worker
```

---

## 八、数据迁移（从既有服务器搬到新服务器）

应用表结构自动创建，所以**迁移只需搬数据**，无需执行建表脚本：

```bash
# ---- 源服务器：导出 ----
docker compose exec -T postgres pg_dump -Fc -Z9 -U fin_market fin_market \
  > fin_market.dump
docker compose exec -T postgres pg_dumpall --globals-only > globals.sql
# globals.sql 含只读角色 fin_market_ro 等，纯 pg_dump 不含，务必一起带走

# ---- 新服务器：导入 ----
docker compose --env-file deploy/.env.deploy up -d postgres
docker compose exec -T postgres psql -U fin_market -d postgres -f - < globals.sql
docker compose exec -T postgres pg_restore -U fin_market -d fin_market \
  --clean --if-exists --no-owner < fin_market.dump
```

大库（数 GB）传输建议先压缩，实测 2.9 GB 库压缩后约 330 MB。

---

## 九、备份与恢复

```bash
./deploy/backup.sh                    # 备份到 ./backups，默认滚动 7 天
./deploy/backup.sh /data/db-backup    # 指定目录
KEEP_DAYS=30 ./deploy/backup.sh       # 自定义保留天数

./deploy/restore.sh backups/fin-market-20261024-120000   # 需输入 yes 确认
```

要点：

- 采用 `pg_dump -Fc`：可压缩、`pg_restore` 可选择性恢复单表、可跨版本。
  另存 `pg_dumpall --globals-only`，否则**角色不会被备份**，恢复后只读查看器会连不上。
- 备份完成后自动执行 `pg_restore --list` 校验，失败即删除，不留下坏备份。
- 脚本经 `docker compose exec` 走 stdout 落盘，容器内不留残留。
- 建议再配一层异地（对象存储或另一台主机）。**只放在应用同机等于没备份**——
  主机故障时会和应用一起丢失。
- 「校验通过」不等于「能恢复成功」，上线前请至少做一次真实恢复演练。

---

## 十、反向代理

参考 `deploy/nginx/fin-terminal.conf` + `deploy/nginx/fin-proxy.inc`：

```bash
cp deploy/nginx/fin-terminal.conf /etc/nginx/conf.d/
cp deploy/nginx/fin-proxy.inc     /etc/nginx/conf.d/
# 替换 server_name 与证书路径后
nginx -t && systemctl reload nginx
```

**要点**：

1. `proxy_read_timeout` 已设为 **180s**。财务对比等接口冷启动时会同步等待上游抓取，
   实测 6–25 秒，用默认 60s 在弱网下仍会 504。
2. `/api/market-updates/` 默认只放行 `127.0.0.1`；若 Worker 走公网 HTTPS 回源，
   需把 Worker 出口 IP 加入 `allow`。
3. Web 只监听 `127.0.0.1:3000`，公网不直接暴露容器端口。

---

## 十一、回滚步骤

### 代码回滚（发布后功能异常）

```bash
git log --oneline -5                 # 确认要回到的提交
git checkout <上一个可用提交>
docker compose --env-file deploy/.env.deploy up -d --build web
docker compose --env-file deploy/.env.deploy logs -f web
```

数据未变动时，回滚代码即可，**不要动数据库**。

### 数据回滚（误删 / 脏数据）

> ⚠️ 不可恢复操作，执行前确认已停写入。

```bash
docker compose --env-file deploy/.env.deploy stop worker web   # 先停上层写入
./deploy/restore.sh backups/fin-market-<时间戳>
docker compose --env-file deploy/.env.deploy start postgres web worker   # 注意顺序
```

### 完整回滚

代码回滚 + 数据回滚按顺序执行：停上层 → 恢复数据 → 启回服务 → 验收。

---

## 十二、验收清单

```bash
# 1. 服务状态
docker compose --env-file deploy/.env.deploy ps

# 2. 基础可用性
curl -I https://your-domain/                       # 期望 200
curl -s 'https://your-domain/api/quote?code=600519' | head -c 200

# 3. 冷启动行为（上游文档明确要求验证四类）
#    已入库 / 过期 / 完全缺失 / A股与港股 —— 缺失请求应先返回合法 JSON，
#    不应出现原始 JSON 解析错误，也不应长时间空转
curl -s 'https://your-domain/api/finance-compare?codes=600519&years=2&granularity=quarter&fields=roe,netMargin,ocfPerShare,debtRatio'

# 4. Worker 是否在工作
docker compose --env-file deploy/.env.deploy logs -f worker
#   正常会周期性输出 {"symbol":...,"ok":...} 或 maintenance 统计

# 5. 数据库连通
docker compose exec -T postgres psql -U fin_market -d fin_market -c 'SELECT count(*) FROM fin_market_bars;'
```

> 本地隔离测试**不能证明**公网链路已恢复。十年财务对比冷启动、健康检查、
> worker 自身卡顿需单独在源服务器验证。

---

## 十三、常见问题

**Q：页面能打开但数据一直加载失败？**
服务器访问不了上游。在服务器上逐个验证：`curl -I https://money.finance.sina.com.cn/`、
`curl -H 'Referer: https://finance.sina.com.cn' https://hq.sinajs.cn/list=sh600519`。
企业内网需放行上述域名。

**Q：Worker 启动就退出，提示 origin 不合法？**
`MARKET_UPDATE_ORIGIN` 必须是 `https://` 开头或 `127.0.0.1` / `localhost`。
填了 `http://web:3000` 这类容器名会被拒绝。

**Q：Worker 一直报 401/403？**
`MARKET_UPDATE_WORKER_TOKEN` 在 Web 与 Worker 两侧不一致，或长度不足 32 字符。

**Q：请求偶发空响应 / JSON 截断？**
多为冷启动同步抓取耗时超过链路等待上限，连接被客户端断开。
确保反向代理 `proxy_read_timeout` 足够（见第十节），并优先用 worker 预填充数据。

**Q：`000001` 为什么是上证指数不是平安银行？**
代码重叠，本项目按指数优先。查平安银行请用 `sz000001`。

**Q：估值数字和别的平台不一致？**
先看页面底部「口径说明」里的数据溯源（报告期 / 归母净利润 TTM / 股本 / 每股净资产），
再确认对方统计频率（日频 vs 周频）与区间。三者任一不同，分位就会有差异。
