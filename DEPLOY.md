# fin-terminal 部署指南

A 股金融数据终端（Next.js 15 App Router + React 19 + TypeScript + Tailwind + ECharts）。
数据源全部为**实时抓取**（腾讯 / 新浪 / 东方财富），无需数据库，无需额外 API Key。

## 一、本地运行

```bash
npm install
cp .env.example .env.local   # 可选，默认不配置也能跑
npm run dev                  # http://localhost:3000
```

生产模式：

```bash
npm run build && npm start
```

## 二、环境要求

| 项目 | 要求 |
|---|---|
| Node.js | ≥ 20（推荐 22） |
| 出网 | 必须能访问 `qt.gtimg.cn`、`hq.sinajs.cn`、`money.finance.sina.com.cn`、`push2.eastmoney.com` |
| 端口 | 默认 3000，可用 `PORT` 覆盖 |

> **重要**：数据源都是国内站点。部署到**境外服务器**（Vercel 美区、AWS 海外等）时抓取延迟会明显升高甚至偶发失败，建议用国内云主机（阿里云/腾讯云）或国内节点。

## 三、部署方式

### 方式 1：Docker（推荐）

```bash
docker compose up -d --build
# 或
docker build -t fin-terminal .
docker run -d -p 3000:3000 --name fin-terminal fin-terminal
```

### 方式 2：PM2 常驻

```bash
npm ci
npm run build
npm i -g pm2
pm2 start npm --name fin-terminal -- start
pm2 save && pm2 startup
```

### 方式 3：Vercel / 其他 PaaS

直接导入本仓库即可，框架会被自动识别为 Next.js。注意选**国内或香港节点**以降低上游抓取超时。

## 四、环境变量

| 变量 | 说明 |
|---|---|
| `UPSTREAM_TIMEOUT_MS` | 单个上游请求超时，默认 8000ms。海外节点建议调到 15000 |
| `IFIND_BASE_URL` / `IFIND_TOKEN` | 可选。配置后财务摘要改走同花顺 iFinD 真实三表，不配则用行情估值派生 |
| `IFIND_MCP_URL` | 可选。走 MCP 网关时的 iFinD 地址 |
| `PORT` | 服务端口，默认 3000 |

## 五、估值口径

- 个股曲线引用前复权收盘价，同时按同一因子调整 EPS、每股净资产；PE/PB 比率与不复权计算一致。
- 总股数取真实股本变动史，不假定每股面值为 1 元；使用交易日实际股数。
- TTM = 今年累计 + 上年年报 − 上年同期累计；Q1 减上年 Q1。
- 默认真实公告次日起生效；未知公告日的报告不参与计算，并在法定截止后阻断旧数据沿用。
- 亏损 PE、缺失财报及无法取得匹配价格时明确显示缺失／报错，不自动回填估算。
- 行情 PE/PB 单独作为参考。历史财务数据可能包含重述，非严格时点回测数据库。

执行 npm test、npm run typecheck、npm run build 验证。详细说明见 VALUATION_FIXES.md。

## 六、目录结构

```
src/
  app/                 页面与 API 路由
    api/valuation/     历史估值
    api/finance-*/     财报对比 / 字段目录
    api/sw-industry/   申万行业分类
    stock/[code]/      个股页（估值 / 财务体检 / 合并报表）
  components/          UI 组件（EChart、FinanceTable、ValuationSection…）
  lib/
    valuation.ts       估值重建核心
    datasource/        数据源适配层
    analytics.ts       指标派生、股息率、后复权
```

## 七、常见问题

**Q：页面能打开但数据一直加载失败？**
A：服务器访问不了上游。先在服务器上 `curl -I https://money.finance.sina.com.cn/` 验证；企业内网需放行上述域名。

**Q：估值数字和别的平台不一致？**
A：先看页面底部「口径说明」里的**数据溯源**一行（报告期 / 归母净利润 TTM / 股本 / 每股净资产），再确认对方的统计频率（日频 vs 周频）与区间，这三项任一不同分位就会有差异。

**Q：`000001` 为什么是上证指数不是平安银行？**
A：代码重叠，本项目按指数优先。要查平安银行请用 `sz000001`。

