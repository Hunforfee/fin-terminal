# FinTerminal

类理杏仁（Lixinger）的金融数据查询与分析终端。支持**股票 / 指数 / 基金**的行情查询、历史走势、估值分析、财务派生、行业对比、条件选股与自选列表。

行情与 K 线来自公开接口；个股估值使用已披露财报、真实股本与前复权价格复算。首页财务指标使用所列报告期的披露数据；行业与选股页的 ROE 为 PB ÷ PE 推导的估算值，单独标注。行情接口失败时使用带快照标识的历史数据。

---

## 一、技术架构

```
┌─────────────────────────────────────────────────────────────┐
│  浏览器（React 19 Client Components）                        │
│  SearchBox · KLineChart · ValuationBandChart · MinuteChart   │
│  Screener · Watchlist（localStorage）                        │
└───────────────────────────┬─────────────────────────────────┘
                            │ fetch /api/*（同源，无 CORS 问题）
┌───────────────────────────▼─────────────────────────────────┐
│  Next.js 15 App Router（Server Components + Route Handlers） │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ 编排层  src/lib/datasource/index.ts                    │  │
│  │  · 优先级降级：腾讯 → 新浪 → 本地快照                  │  │
│  │  · TTL 缓存（盘中 15s / 盘后 10min）+ 并发去重         │  │
│  │  · 批量分块（50 个/批）                                │  │
│  └──────┬────────────────────────────────────────────────┘  │
│         │                                                    │
│  ┌──────▼───────────────────────────────────────────────┐   │
│  │ Provider 层（统一实现同一组数据契约）                  │   │
│  │  tencent.ts   行情 / K线 / 分时 / 联想   ← 主力        │   │
│  │  sina.ts      K线 / 行情               ← 备用         │   │
│  │  eastmoney.ts 搜索联想                 ← 可选增强     │   │
│  │  ifind.ts     真实三表财务             ← 预留插槽     │   │
│  │  snapshot.ts  本地兜底快照             ← 最后防线     │   │
│  └──────┬───────────────────────────────────────────────┘   │
│         │  http.ts（超时 / 重试 / GBK 解码 / UA 伪装）       │
└─────────┼──────────────────────────────────────────────────┘
          ▼
   腾讯财经 · 新浪财经 · 东方财富（公开 HTTP 接口）
```

**技术选型与理由**

| 层 | 选型 | 理由 |
|---|---|---|
| 框架 | Next.js 15 App Router | 行情接口有 CORS 限制且返回 GBK，必须有服务端代理；单进程同时承担 SSR 与 API，部署最省事 |
| 语言 | TypeScript strict | 多数据源字段错位是这类项目的头号 bug 来源，类型能挡住大半 |
| 样式 | Tailwind CSS 3 | 卡片/表格密集的金融界面，原子类迭代最快 |
| 图表 | ECharts 5（按需注册） | K 线 + 缩放 + markLine 组合能力强，按需引入控制体积 |
| 存储 | 无数据库 | 行情实时抓取不落库；自选放 localStorage，零运维 |
| 缓存 | 进程内 TTL Map | 单实例足够；换多实例时替换成 Redis 即可（接口不变） |

---

## 二、数据来源方案

### 实测可用性（沙箱环境，2026-10）

| 数据源 | 端点 | 状态 | 提供 |
|---|---|---|---|
| 腾讯财经 | `qt.gtimg.cn` | ✅ 36ms | 实时行情（含 PE/PB/市值/换手/量比/52周高低） |
| 腾讯财经 | `ifzq.gtimg.cn/.../fqkline` | ✅ | 日/周/月 K 线，支持前复权/后复权 |
| 腾讯财经 | `web.ifzq.gtimg.cn/.../minute` | ✅ | 当日分时 |
| 腾讯财经 | `smartbox.gtimg.cn` | ✅ | 搜索联想（代码/中文/拼音） |
| 新浪财经 | `money.finance.sina.com.cn` | ✅ | 备用 K 线 |
| 新浪财经 | `...vFD_FinancialGuideLine...` | ✅ | **真实财报指标**（85 项，含 ROE/净利率/资产负债率/流动比率/经营现金流/EPS 等），财务体检页数据源 |
| 新浪财经 | `hq.sinajs.cn` | ✅ | 备用实时行情 |
| 东方财富 | `searchapi.eastmoney.com` | ⚠️ 不稳定 | 搜索联想（响应格式会在 JSON / JSONP 间切换，已做容错） |
| 东方财富 | `push2*` / `clist` | ❌ 403 | 出口 IP 被拦截，未接入 |
| 同花顺 iFinD | MCP 网关 | ❌ 未注册 | 网关返回 `17008`，工具数为 0 |

### 个股估值口径

个股估值采用真实披露的归母净利润、归母普通股净资产与股本变动史。利润 TTM 按“今年累计 + 上年全年 − 上年同期累计”拼接。每个交易日使用真实公告次日起可得的最新报告；利润亏损、数据缺失与无法识别公告日时保留缺失状态，不继续套用旧盈利，也不自动生成估算曲线。

价格曲线采用腾讯**前复权日线**。EPS、每股净资产同时乘以前复权价／不复权价因子，再计算 PE、PB，因此复权处理不会改变估值比率。长历史按最多 640 条分页抓取，价格口径必须显式匹配。真实股数按交易日变动，避免把每股面值默认为 1 元。行情接口 PE/PB 作为参考单独显示，不覆盖财报复算值。

分位基于所选区间有效交易日；股息率使用已除息的十二个月现金分红，无分红为 0、无法取数为缺失。真实报告日期由新浪历史公告列表获取；财务金额仍可能是数据源后续重述版本，不能当作严格的历史时点回测数据。显示实际样本数及起止日期。

---

## 三、主要页面与模块

| 路由 | 类型 | 内容 |
|---|---|---|
| `/` | Client | **研究工作台**：关注公司的 PE/PB、累计 ROE、净利率、每股经营现金流及报告期；支持名称/代码筛选、排序；研究笔记和财报索引。PE/PB 行情口径与财报指标分别标注，最新报告期缺值时不沿用旧值。 |
| `/stock/[code]` | Server + Client | PE-TTM / PB / 股息率指标卡切换，共用大图；前复权收盘价、5/10 年分位、区间统计、点选参考线、可选口径对比；计算说明默认折叠。保留 AI 深入分析、提示词编辑、接口设置及历史版本；提示词默认收起，生成内容按需展示。 |
| `/stock/[code]/finance` | Server + Client | **指标趋势**：模块内全部图表纵向排列，左侧吸附指标导航，点击定位、拖动排序；每图展示当前值与区间统计。支持双公司对比、年报/中报/季报、5/10 年切换，保留模块配置与自定义公式。移动端导航横向滚动。 |
| `/stock/[code]/finance` | Client | **合并报表**：单公司自选指标及完整三表；默认最近 8 期、每科目一行，分组可折叠，关键科目加粗、最新列高亮，悬停定位行列。支持关键科目筛选、搜索、逐行或全局展开同比、4/8/全部报告期、2/3/5/10 年及报告类型切换。金额亿元、每股数据元/股、比率单位单列；单季同比仅用于三表中的利润/现金流金额，不用于资产负债或比率。CSV 导出当前筛选科目的全部请求期间原始数据，金额单位万元；首行首列吸附，表高自适应窗口。 |
| `/watchlist` | Client | **关注公司**：基本面比较表，可逐项移除；原有指数/基金关注项保留在折叠的「其他关注标的」中。 |
| `/industry` | Client | **行业研究**：申万 2021 三级分类，名称/代码筛选、PE/PB 中位数、估算 ROE、市值及排序；保留亏损股。短期涨跌和换手率移出主表，分类口径默认折叠。 |
| `/screener` | Client | 行业、PE/PB、估算 ROE 下限和市值筛选；预设、排序、自选操作和 CSV 导出。 |
| `/index/[code]` | Server + Client | 指数点位、历史走势、区间表现与估值。 |
| `/fund`、`/fund/[code]` | Server + Client | 基金/ETF 列表与历史走势。 |
| `/health` | Server | 数据源可用性、延迟与降级状态。 |

自选、研究笔记和指标配置存储在当前浏览器的 localStorage，沿用原有自选存储键；没有云端同步。全站采用紧凑导航与小边距的全宽布局，宽屏上导航、标志和搜索同排；财务页标题与视图切换同排，报表高度根据实际剩余窗口空间调整。保留灰白底色、蓝色操作按钮，并适配电脑和手机。

**API**（`src/app/api/`）：`quote` `kline` `minute` `search` `valuation` `financial` `finance-fields` `finance-compare` `peers` `screen` `market` `industry` `sw-industry` `health` `ai-analyze`

---

## 四、项目结构

```
fin-terminal/
├── src/
│   ├── app/
│   │   ├── layout.tsx              全局壳（导航 + 搜索）
│   │   ├── page.tsx                首页
│   │   ├── stock/[code]/page.tsx   个股详情
│   │   ├── index/[code]/page.tsx   指数详情
│   │   ├── fund/page.tsx + [code]/page.tsx
│   │   ├── screener/page.tsx       条件选股
│   │   ├── watchlist/page.tsx      自选
│   │   ├── health/page.tsx         数据源体检
│   │   └── api/{quote,kline,minute,search,valuation,financial,peers,screen,market,health}/route.ts
│   ├── components/
│   │   ├── EChart.tsx              图表容器（按需注册 + 自适应 + 销毁）
│   │   ├── KLineChart.tsx          蜡烛 + MA5/20/60 + 成交量 + 缩放
│   │   ├── KLineSection.tsx        周期/复权/区间切换与分时切换
│   │   ├── ValuationBandChart.tsx  PE/PB 估值带 + 均值/20%/80% 分位线
│   │   ├── MinuteChart.tsx         分时 + 均价 + 分钟量
│   │   ├── SearchBox.tsx           联想搜索（防抖 + 键盘导航 + 本地搜索历史：聚焦空输入框直接下拉展示最近 8 条，点选填入跳转，单条 ✕ 删除 / 一键清空，localStorage 持久化）
│   │   └── lib/searchHistory.ts    搜索历史存取（去重上移，最多 8 条）
│   │   ├── QuoteHeader.tsx / QuoteTable.tsx / MetricGrid.tsx / IndexBar.tsx
│   │   └── WatchlistProvider.tsx   自选上下文（localStorage + 多标签同步）
│   ├── lib/
│   │   ├── datasource/
│   │   │   ├── types.ts            统一数据契约（所有 Provider 对齐于此）
│   │   │   ├── index.ts            编排层：降级 / 缓存 / 分块 / 体检
│   │   │   ├── tencent.ts sina.ts eastmoney.ts ifind.ts snapshot.ts
│   │   │   ├── http.ts             超时 / 重试 / GBK 解码
│   │   │   ├── cache.ts            TTL 缓存 + 并发去重
│   │   │   └── codes.ts            代码标准化（含指数白名单消歧）
│   │   ├── analytics.ts            估值分位 / 恒等式派生 / 波动率 / 回撤
│   │   ├── universe.ts             指数池 · 行业龙头池 · ETF 池 · 行业分类
│   │   ├── format.ts               涨跌色 · 金额/百分比格式化
│   │   └── api.ts                  统一响应封装
│   └── data/snapshots/market.json  兜底快照（由 npm run seed 生成）
├── scripts/fetch-snapshots.mjs     快照抓取脚本
├── Dockerfile / docker-compose.yml / .env.example
└── package.json / tsconfig.json / tailwind.config.ts / next.config.mjs
```

---

## 五、快速开始

```bash
cd fin-terminal
npm install                 # 已配置依赖，国内可用 --registry=https://registry.npmmirror.com
npm run seed                # 可选：抓一轮真实数据生成兜底快照（约 1-2 分钟）
npm run dev                 # http://localhost:3000
```

生产：

```bash
npm run build && npm run start
```

Docker：

```bash
docker compose up -d --build      # http://localhost:3000
```

常用脚本：`dev` / `build` / `start` / `typecheck` / `seed`

---

## 六、验证结果（实测）

| 项目 | 结果 |
|---|---|
| 类型检查 | `tsc --noEmit` 零错误 |
| 生产构建 | 通过，18 条路由 |
| 行情 | 贵州茅台 1329.00，PE 20.40，PB 6.61，市值 16613.58 亿 |
| 派生财务 | 净利润 814.4 亿，ROE 32.40%，净利增速 8.15% |
| 估值分位 | PE 13.0% / PB 14.7% 分位（401 个历史点） |
| K 线 | 640 根日线（前复权），周/月线可切 |
| 搜索 | 中文（茅台）、代码（600519）、拼音（gzmt）、指数（沪深300）均命中 |
| 选股 | PE 0–20 且 ROE≥15% → 命中 19 只 |
| 行业对比 | 食品饮料 8 家，茅台 ROE 32.4% vs 五粮液 11.0% |
| 大盘 | 9 个指数（上证/沪深300/创业板/北证50 等）全部取到 |

---

## 七、已知边界

- **个股历史估值**：采用上文真实财报与前复权一致口径；完整修复说明及验证见 `VALUATION_FIXES.md`。
- **财务报表为新浪披露口径**：`/stock/[code]/finance` 的 21 项指标取自新浪财务指引页（原始披露值，非三表原始数据），适合看趋势与横向对比；若需审计级三表，可接入 iFinD（`ifind.ts` 已预留插槽）。
- **个股历史估值**：采用上文真实财报与前复权一致口径；完整修复说明及验证见 `VALUATION_FIXES.md`。
- **选股池为行业龙头样本**（约 125 只），非全市场 5000+ 只——扩展需接入全量股票列表接口（东财 `clist` 在本环境被封，换成自有列表即可）。
- **东财搜索响应格式不稳定**：已在 `eastmoney.ts` 做容错，失败时由腾讯联想 + 本地池兜底。
- **自选存 localStorage**：未做账号体系；需要跨设备同步时把 `WatchlistProvider` 的读写换成 `/api/watchlist` 即可。

---

## 八、免责声明

数据来自公开行情接口，可能存在延迟或误差，仅供参考，不构成任何投资建议。

