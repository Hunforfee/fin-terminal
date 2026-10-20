# 公司深度解析接续说明

本文件供 WorkBuddy、Codex 及其他维护工具接续工作。路径均相对仓库根目录，可在 Windows、Linux 或部署环境使用。

## 本轮范围与成果

管理范围为仓库保存的自选清单快照、`src/lib/universe.ts` 中的 **STOCKS 公司池**以及已有解析。指数和基金不算公司；不包含全市场数千家标的。自选快照不是浏览器当前个人账户的实时数据，新增自选后需要导入更新。

2026-10-20 初次审计：671 份原有解析全部已登记；自选快照中另有 170 家港股缺稿。本轮为 170 家建立了**有来源的研究初稿**，按实际业务使用不同研究框架，保留原有 671 份内容。另修复了带 `sh/sz/bj/hk` 前缀或市场后缀的代码查不到既有解析的问题，并让每日公司支持已收录港股解析。

**170 份新稿均未完成逐页原文、财务币种与券商观点复核。它们是接续工作起点，不是 170 份已核验的投资报告。** 解析页面标注“研究稿·待复核”；看好栏显示“研究假设”。部分公告请求被原站以403拒绝，没有绕过访问限制；已取得原文地址也不等于读过全文。新稿只使用有明确来源的业务资料和聚合比率，不引用尚未确认换算基础的绝对金额，也不虚构评级、目标价、客户、排名或市场份额。

## 优先读取

1. `docs/analysis-coverage.json`：完整管理清单、文件、状态、内容哈希及缺口。
2. `docs/analysis-work-queue.json`：下一步任务，包含每份研究稿的核验事项。
3. `docs/analysis-coverage.md`：便于人工浏览的摘要。
4. `scripts/analysis-targets.json`：管理范围及来源、分组。

状态含义：

|状态|含义|下一步|
|---|---|---|
|missing|目标公司没有正文文件|收集资料，撰写并登记|
|invalid|文件身份、结构、来源或状态不合规则|先修复，不能计为完成|
|unregistered|有稿但索引未接入|登记后检查页面|
|draft|可阅读研究稿，仍有核验任务|阅读原文，补充分部及经营量证据|
|legacy|本轮之前已有的解析|保留；不代表本轮重新核验过|
|reviewed|有明确复核人、日期与原文阅读记录|按新披露持续更新|

**missing=0 不等于 draft=0，更不等于所有公司都已核验。**

## 如何继续一家公司

1. 从队列选择代码；读取对应 `src/data/analyses/{code}.json` 的 `sources`、`verificationTasks`、`evidence`。
2. 实际打开发行人官网或交易所年报、中报、业绩公告，确认公司身份、合并范围、报告期、审计或审阅意见、**原始币种与单位**。港元交易不代表港元记账；A/H价格和每股口径不能混用。
3. 拆解主营、量价成本、分部利润、客户与供应商、资本开支及现金来源。金融、保险、租赁和工业企业不能共用同一种自由现金流框架。原资料分类可能错误，例如机器人、汽车融资及本地平台，应按实际主营研究。
4. 核实直接竞争关系与可比口径。目前 `competitors` 中新稿条目是业务或价值链对照，不保证全部是直接竞争对手。证据不足时允许少于三家，不为凑数加入不相关公司或基金。
5. 实际阅读研究对象明确为本公司的券商报告，记录日期、机构、链接与观点；没有取得不等于没有覆盖，评级未知时省略统计，不能填零冒充无覆盖。目标价必须有币种、日期及出处，不能跨市场拼接。
6. 更新正文与证据。若仍有缺口，保持 `researchStatus: "draft"` 和待核对项。只有完成原文复核才可改为 `reviewed`，并填写 `reviewedAt`、`reviewedBy`、`evidence.originalReportRead: true`，另在 `docs/analysis-review-log/` 保存逐条核对依据、来源页码及差异处理；不得仅切状态。
7. 本地检查并刷新清单。用户未明确要求时不要推送 Git。

## 可复用命令

```sh
npm run analyses:coverage
npm run analyses:check
npm run analyses:index
node scripts/sync-analysis-index.mjs --check
node scripts/validate-analyses.mjs
npm run typecheck
```

`analyses:coverage` 更新范围、覆盖状态、人工摘要和工作队列；`analyses:check` 只读检查缺稿、错误和未登记。研究稿仍会单独统计，不会被变成已复核状态。需要严格验证无待复核稿时运行：

```sh
node scripts/analysis-coverage.mjs --check --require-no-drafts
```

本轮该严格命令**预期失败**，因为 170 份仍需原文复核；不是程序故障。

新增个人自选后，可导出纯JSON代码数组、对象数组或 `items` 格式的清单，再运行：

```sh
node scripts/analysis-coverage.mjs --watchlist path/to/watchlist.json
```

代码如 `sh600519`、`600519.SH`、`hk700`、`00700.HK` 会标准化。需先排除指数/ETF；新自选股票会加入管理范围并出现在缺稿队列，不会自动生成内容。

补采现有未覆盖港股的公共资料：

```sh
node scripts/collect-analysis-evidence.mjs 01836 02460
```

中间材料保存在已忽略的 `src/data/analyses/_raw/coverage/`，不含登录信息。若运行环境没有中间材料，可用每份正文的来源URL重新获取。`scripts/prepare-hk-research-drafts.mjs` 只从已有证据生成缺失稿，**不会覆盖已存在的正文**；生成结果必须保留研究稿状态，不能自动升格为复核完成。`scripts/hk-research-guides.mjs` 是分析框架，不是已证实的公司优势。

原 `scripts/uncovered-watchlist.json` 是历史输入快照，名称不表示今天仍未覆盖；后续请以新清单与实时检查结果为准。原通达信MCP脚本依赖特定环境的网关，不保证在所有工具中可用；无法访问时记录缺口并使用公开发行人资料，不猜测来源结果。
