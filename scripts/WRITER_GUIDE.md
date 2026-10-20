# 个股 AI 分析撰写规范（福耀玻璃范式）

## 输入数据

对每只股票 code，读取两个文件：

1. `/workspace/fin-terminal/src/data/analyses/_raw/{code}.json` —— 东财 F10
   - `profile` 公司简介、`scope` 经营范围、`review` 最新经营评述（含大量财务与业务数据）
   - `groups` 三维主营构成（分行业/分产品/分地区，含收入、占比、毛利率）
   - `finance` 财务摘要（可能为 null）
   - `industry` 行业分类
2. `/workspace/fin-terminal/src/data/analyses/_raw/{code}.mcp.json` —— 通达信 MCP
   - `overview`：`d['overview']['response']['transformed']['tables']`，数组，每项 `{name, rows}`，
     name ∈ metadata / basic_overview / business_overview / related_themes / financial_highlights /
     valuation_metrics / pledge_overview / tags / extra_info。**财务亮点与估值指标主要看这里**
   - `reports`：`d['reports']['data']`，元素为 `[标题, 时间, 链接, 来源, 摘要]`，**第一行是表头需跳过**。
     注意：查询结果可能混入**其他公司**的研报，只保留标题中研究对象是本股的条目。

## 研报过滤规则（严格）

- 只统计**研究对象为本股**的研报（标题里带本股名称/代码）。
- 行业周报、晨会纪要、策略汇总、早知道、其他公司报告一律不计。
- 评级映射：买入 / 跑赢行业 / 强推 / 优于大市 / 推荐 / 强烈推荐 → **buy**；
  增持 / 谨慎增持 → **hold**；卖出 / 减持 → **sell**。
- 若确实无直接覆盖的券商研报：`ratingSummary` 全填 0（`{buy:0,hold:0,sell:0}`），
  **省略 `targetPriceRange` 字段**，`source` 里注明「无直接券商研报覆盖，评级统计如实记零」。

## 输出

写到 `/workspace/fin-terminal/src/data/analyses/{code}.json`，严格 schema：

```jsonc
{
  "code": "600660",                    // 必填，与文件名一致
  "fullName": "福耀玻璃工业集团股份有限公司",  // 必填，工商全称
  "industry": "汽车-汽车零部件（车身附件及饰件）", // 必填，细分到子行业
  "position": "全球汽车玻璃市占率第一（约34%）……", // 必填，一句话行业地位+关键依据
  "summary": "……",   // 必填：5 个段落，用 \n\n 分隔，总长 1300~2200 字
  "moat": [ {"point": "≤14字", "detail": "2-3句，必须带具体数据"} ],        // ≥3 条
  "competitors": [ {"name": "", "code": "", "note": ""} ],                 // ≥3 条，尽量带代码
  "bullCase": [ {"point": "≤14字", "detail": "2-3句带数据"} ],             // ≥3 条
  "bearCase": [ {"point": "≤14字", "detail": "2-3句带数据"} ],             // ≥3 条
  "ratingSummary": { "buy": 5, "hold": 0, "sell": 0 },   // 可选；无覆盖时全 0
  "targetPriceRange": { "min": 10.9, "max": 12.5 },      // 可选；无覆盖时省略
  "source": "数据来源：东财F10……；财务数据截至2026-06-30",  // 必填
  "generatedAt": "2026-10-19T00:00:00.000Z"              // 必填，ISO 字符串
}
```

## summary 五段结构（对标 600660 福耀玻璃）

1. **公司沿革与当期经营**：成立时间/上市地/股东背景 + 最新报告期营收、净利、同比、行业背景对照。
2. **业务与产品矩阵**：分产品/分板块收入、占比、毛利率；主业 / 第二曲线 / 其他各是什么。
3. **商业模式与盈利模式**：怎么赚钱、客户是谁、收入确认方式、上下游关系、周期或季节特征。
4. **利润结构与分地区/分板块拆解**：毛利率差异及原因、国内 vs 海外、成本构成、近期边际变化。
5. **产能/资本开支/现金流/分红**：在建与投产项目、资本开支计划、经营现金流、分红比例。

写作要求：
- **必须用具体数字说话**（亿元、%、pct、市占率、产能单位），禁止空泛形容词堆砌。
- 数据来自 F10 经营评述、主营构成、通达信财务亮点；注明报告期（如 2026H1 / 2025 年报）。
- 语言为中文，专业、克制、不吹票，风险与亮点都要写。

## 参考样例

完整范式见 `/workspace/fin-terminal/src/data/analyses/600660.json`（福耀玻璃）与
`/workspace/fin-terminal/src/data/analyses/000425.json`（徐工机械）。

## 完成标准

写完后运行 `cd /workspace/fin-terminal && node scripts/validate-analyses.mjs` 确认无 ERROR，
并自检每份文件：summary 段落数=5、字数 1300~2200、moat/competitors/bullCase/bearCase 各 ≥3 条、
competitors 尽量带股票代码、ratingSummary 与研报条数逻辑自洽。
