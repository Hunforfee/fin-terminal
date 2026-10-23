/**
 * 新浪财经-三大报表 Provider（资产负债表 / 利润表 / 现金流量表，全字段）。
 *
 * 端点（HTML，GBK，单位：万元）：
 *   https://money.finance.sina.com.cn/corp/go.php/vFD_BalanceSheet/stockid/{code}/ctrl/{year}/displaytype/4.phtml
 *   https://money.finance.sina.com.cn/corp/go.php/vFD_ProfitStatement/...
 *   https://money.finance.sina.com.cn/corp/go.php/vFD_CashFlow/...
 *
 * 每页 = 该年 4 个报告期 × 全部披露科目（资产负债表约 88 项、利润表约 22 项、现金流量表约 40 项），
 * 页面自带分组标题（如「流动资产」「一、经营活动产生的现金流量」），据此生成字段目录。
 *
 * 字段 key 约定：`{表前缀}_{中文科目名}`，如 bs_货币资金 / pl_营业收入 / cf_销售商品、提供劳务收到的现金。
 * 中文 key 直接用于 JSON 与前端展示，URL 传输时 encodeURIComponent 即可。
 */

import { assertFinancialPage } from '../financialPageQuality';
import { fetchText } from './http';
import { cachedMarketInput } from '../marketInputs';
import { financialEarliestYear } from '../marketHistoryPlan';
import { fetchInterestExpenses, INTEREST_FIELDS, withInterestFields } from './interestExpenses';
import { fetchDebtRatios } from './debtRatios';
import { statementFieldUnit, type StatementFieldUnit } from '../financeFieldSemantics';
import { fetchEastmoneyStatement, financialPageSource, type StatementSourcePage } from './eastmoneyStatements';

export const PROVIDER_NAME = 'sina-statements';

export type StatementId = 'balance' | 'profit' | 'cashflow';

export const STATEMENT_META: Record<StatementId, { label: string; url: string; prefix: string }> = {
  balance: {
    label: '资产负债表',
    url: 'https://money.finance.sina.com.cn/corp/go.php/vFD_BalanceSheet/stockid/{code}/ctrl/{year}/displaytype/4.phtml',
    prefix: 'bs',
  },
  profit: {
    label: '利润表',
    url: 'https://money.finance.sina.com.cn/corp/go.php/vFD_ProfitStatement/stockid/{code}/ctrl/{year}/displaytype/4.phtml',
    prefix: 'pl',
  },
  cashflow: {
    label: '现金流量表',
    url: 'https://money.finance.sina.com.cn/corp/go.php/vFD_CashFlow/stockid/{code}/ctrl/{year}/displaytype/4.phtml',
    prefix: 'cf',
  },
};

/** 报表科目字段定义（与 sinaFinancial.IndicatorDef 保持兼容的最小形状） */
export interface StatementFieldDef {
  key: string;
  /** 报表页上的中文科目名 */
  sina: string;
  label: string;
  group: string;
  statement: StatementId;
  /** 三大报表数值单位均为「万元」（新浪披露口径） */
  unit: StatementFieldUnit;
}

export interface FieldGroup {
  label: string;
  fields: StatementFieldDef[];
}

export interface StatementCatalog {
  id: StatementId;
  label: string;
  /** 披露单位，如「万元」 */
  unit: string;
  groups: FieldGroup[];
  /** 字段总数 */
  total: number;
}

/* ------------------------------------------------------- 页面解析 */

interface ParsedRow {
  kind: 'date' | 'group' | 'field';
  name: string;
  /** 各报告期原始值（field 行） */
  vals: string[];
}

function parseStatementPage(html: string): { dates: string[]; rows: ParsedRow[]; unit: string } {
  const dates: string[] = [];
  const rows: ParsedRow[] = [];
  const unitMatch = html.match(/单位：([^<]+)/);
  const unit = unitMatch ? unitMatch[1].trim() : '万元';

  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(html)) !== null) {
    const tr = m[1];
    if (tr.includes('报表日期')) {
      for (const d of tr.matchAll(/<td[^>]*>(\d{4}-\d{2}-\d{2})<\/td>/g)) dates.push(d[1]);
      continue;
    }
    const colspan = tr.match(/<td colspan='\d+'><strong>([^<]+)<\/strong><\/td>/);
    if (colspan) {
      rows.push({ kind: 'group', name: colspan[1].trim(), vals: [] });
      continue;
    }
    if (tr.includes('padding-left:30px') || dates.length > 0 && /<a[^>]*>/.test(tr)) {
      const tds = Array.from(tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)).map((x) => stripTags(x[1]));
      if (tds.length >= 2 && (tr.includes('padding-left:30px') || tds.slice(1).every(v=>/^(?:[+\-]?[\d,.]+|--|—|-|)$/.test(v)))) {
        rows.push({ kind: 'field', name: tds[0], vals: tds.slice(1) });
      }
    }
  }
  return { dates, rows, unit };
}

/** Shared source page: field catalogs, custom reports and valuation read the same rows. */
export function fetchStatementSourcePage(code: string, id: StatementId, year: number, options: { forceRefresh?: boolean; requiredDates?: string[] } = {}) {
  if (!/^\d{6}$/.test(code) || !STATEMENT_META[id] || !Number.isInteger(year) || year < financialEarliestYear())
    throw Error('财报范围超出十年保留期限');
  const validate=(value:StatementSourcePage)=>{
    if(!value.dates.length || !value.rows.some(r=>r.kind==='field' && r.vals.some(v=>v!=null && v.trim()!=='' && Number.isFinite(Number(v.replaceAll(',','')))))
      || value.dates.some(d=>!/^\d{4}-\d{2}-\d{2}$/.test(d))
      || options.requiredDates?.some(d=>!value.dates.includes(d)))throw Error('财报来源页缺少有效数据或应有报告期');
    assertFinancialPage(value,id,options.requiredDates??value.dates);
  };
  return cachedMarketInput<StatementSourcePage>(`source-sina-page:v1:${code}:${id}:${year}`,'source-sina-page','sina:reported:wan',new Date().getUTCFullYear()-year<=1?1800e3:7*864e5,
    async()=>{
      try {
        const value=parseStatementPage(await fetchText(STATEMENT_META[id].url.replace('{code}',code).replace('{year}',String(year)),{encoding:'gbk',timeoutMs:10000,retries:0}));
        validate(value);return value;
      }catch(primary){
        try{const value=await fetchEastmoneyStatement(code,id,year);validate(value);return value;}
        catch(backup){throw Error(`公网财报均未取得有效数据（新浪：${primary instanceof Error?primary.message:'不可用'}；东方财富：${backup instanceof Error?backup.message:'不可用'}）`);}
      }
    },validate,financialPageSource,options);
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function toNum(s: string | null | undefined): number | null {
  if (!s || s === '--' || s === '') return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * 报告期 → 展示标签。
 * mode='report'（默认，财报表格用）：12-31 → 年报，06-30 → 中报；
 * mode='half'（趋势/图表用）：12-31 → H2，06-30 → H1。
 */
export function periodLabel(date: string, mode: 'report' | 'half' = 'report'): string {
  const m = date.match(/^(\d{2})(\d{2})-(\d{2})-(\d{2})$/);
  if (!m) return date;
  const y = m[1] + m[2];
  const md = `${m[3]}-${m[4]}`;
  if (md === '12-31') return mode === 'report' ? `${y}年报` : `${y}H2`;
  if (md === '06-30') return mode === 'report' ? `${y}中报` : `${y}H1`;
  if (md === '03-31') return `${y}Q1`;
  if (md === '09-30') return `${y}Q3`;
  return date.slice(2);
}

/* ------------------------------------------------------- 字段目录 */

const catalogCache = new Map<string, { at: number; catalog: StatementCatalog[] }>();
const CATALOG_TTL = 24 * 60 * 60 * 1000;

/** 解析单年页面 → 目录（失败返回 null） */
export function catalogFromPage(id: StatementId, parsed: { rows: ParsedRow[]; unit: string } | null): StatementCatalog | null {
  if (!parsed || parsed.rows.length === 0) return null;
  const meta = STATEMENT_META[id];
  const groups: FieldGroup[] = [];
  let cur: FieldGroup = { label: meta.label, fields: [] };
  const flush = () => {
    if (cur.fields.length > 0) groups.push(cur);
  };
  for (const row of parsed.rows) {
    if (row.kind === 'group') {
      flush();
      cur = { label: row.name, fields: [] };
    } else if (row.kind === 'field' && row.name) {
      cur.fields.push({
        key: `${meta.prefix}_${row.name}`,
        sina: row.name,
        label: row.name,
        group: cur.label,
        statement: id,
        unit: statementFieldUnit(row.name),
      });
    }
  }
  flush();
  if (groups.length === 0) return null;
  return {
    id,
    label: meta.label,
    unit: parsed.unit,
    groups,
    total: groups.reduce((a, g) => a + g.fields.length, 0),
  };
}

/**
 * 抓取字段目录。目录跨公司基本一致（新浪统一模板），按 code 缓存 24h。
 * 单表当年页面不可用时逐年回退（目录模板跨年一致，任一年页面即可生成目录）；
 * 数据库已有部分报表时返回可用表而非整体失败，缺失表由调用方标注。
 */
export async function fetchStatementCatalog(code: string): Promise<StatementCatalog[]> {
  const hit = catalogCache.get(code);
  if (hit && Date.now() - hit.at < CATALOG_TTL) return hit.catalog;

  const thisYear = new Date().getFullYear();
  const earliest = Math.max(financialEarliestYear(), thisYear - 3);
  const ids = Object.keys(STATEMENT_META) as StatementId[];
  const pages = await Promise.all(
    ids.map(async (id) => {
      for (let y = thisYear; y >= earliest; y--) {
        try {
          return { id, parsed: await fetchStatementSourcePage(code, id, y) };
        } catch { /* 逐年回退：数据库已有任一年页面即可生成目录 */ }
      }
      return { id, parsed: null };
    }),
  );
  const catalog = pages
    .map((p) => catalogFromPage(p.id, p.parsed))
    .filter((c): c is StatementCatalog => c !== null);
  if (catalog.length === 0) {
    throw new Error(`新浪三大报表：${code} 字段目录获取失败（三大报表均无可用数据）`);
  }
  const enriched = withInterestFields(catalog);
  // 仅三表齐全才长缓存；部分缺失时不缓存，待维护端补齐后下次即可取到完整目录
  if (catalog.length === ids.length) catalogCache.set(code, { at: Date.now(), catalog: enriched });
  return enriched;
}

/* ------------------------------------------------------- 序列抓取 */

/**
 * 需要抓取的日历年份：「近 N 年」= 含当前年的 N 个自然年，
 * 再多取 1 年，避免年报视图里最早一年缺失（例：10 年 → 10 个年报）。
 * 最终裁剪由 cropRecentYears 按报告期长度完成。
 */
function yearListFor(years: number): number[] {
  const thisYear = new Date().getFullYear();
  const list: number[] = [];
  const need = Math.min(10,Math.max(1,years)) + 1;
  for (let y = thisYear; list.length < need && y >= 1998; y--) list.push(y);
  return list;
}

/** 保留最近 N 个自然年内的报告期（以当前年 - N 的 1 月 1 日为界） */
function cropRecentYears<T extends CustomFinancials>(f: T, years: number): T {
  const now = new Date();
  const from = `${now.getFullYear() - years + 1}-01-01`;
  /** 当前年尚未出年报时，边界再往前推 1 年，保证年报视图仍是完整的 N 个年度 */
  const annualLast = f.periods.at(-1) ?? '';
  const fromAnnual = annualLast.endsWith('-12-31') && annualLast.slice(0, 4) === String(now.getFullYear())
    ? from
    : `${now.getFullYear() - years}-01-01`;
  const candidates = f.periods
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p >= (p.endsWith('-12-31') ? fromAnnual : from));
  // 若最新一期仍早于边界（数据源滞后），保留全部，避免出现空表
  const keep = candidates.length > 0 ? candidates : f.periods.map((p, i) => ({ p, i }));
  if (keep.length === f.periods.length) return f;
  return {
    ...f,
    periods: keep.map((k) => k.p),
    periodLabels: keep.map((k) => f.periodLabels[k.i]),
    series: Object.fromEntries(Object.entries(f.series).map(([k, arr]) => [k, keep.map((x) => arr[x.i])])),
  };
}

/** 单表多年数据：科目名 → 各期值（按 byDate 合并） */
async function fetchOneStatement(
  code: string,
  id: StatementId,
  years: number,
  byDate: Map<string, Map<string, number | null>>,
  sources: Set<string>,
): Promise<void> {
  const meta = STATEMENT_META[id];
  const pages = await Promise.all(
    yearListFor(years).map(async (y) => {
      const url = meta.url.replace('{code}', code).replace('{year}', String(y));
      try {
        return await fetchStatementSourcePage(code,id,y);
      } catch {
        return null;
      }
    }),
  );
  for (const p of pages) {
    if (!p || p.dates.length === 0) continue;
    sources.add(financialPageSource(p));
    for (let i = 0; i < p.dates.length; i++) {
      const date = p.dates[i];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      let rec = byDate.get(date);
      if (!rec) {
        rec = new Map();
        byDate.set(date, rec);
      }
      for (const row of p.rows) {
        if (row.kind === 'field' && row.name && row.vals[i] !== undefined && !INTEREST_FIELDS.some(key => key === `${meta.prefix}_${row.name}`)) {
          rec.set(`${meta.prefix}_${row.name}`, toNum(row.vals[i]));
        }
      }
    }
  }
}

export interface CustomFinancials {
  fieldCurrencies?: Record<string, string>;
  periodKinds?: Record<string, string>;
  currency?: string;
  code: string;
  name: string;
  periods: string[];
  periodLabels: string[];
  /** 字段 key（bs_x / pl_x / cf_x 或指标 key）→ 各期数值 */
  series: Record<string, (number | null)[]>;
  source: string;
  /** 请求字段中在所有报告期均无数据的 key（数据库缺对应源页），供调用方明确标注缺失项 */
  missingFields?: string[];
}

/**
 * 抓取自定义字段的多年序列。
 * fields 为 `bs_货币资金,pl_营业收入` 这类 key 列表（中文 key 需由调用方 encodeURIComponent 后再逗号分隔）。
 * 同时合并指标页数据：fields 中的非 bs/pl/cf 前缀 key 视为财务指标 key（roe 等）。
 */
export async function fetchCustomFinancials(
  code: string,
  fields: string[],
  years: number,
  name?: string,
): Promise<CustomFinancials> {
  if (fields.length === 0) throw new Error('未指定任何字段');

  const byDate = new Map<string, Map<string, number | null>>();
  const sources = new Set<string>();

  const statementFields = fields.filter((k) => /^(bs|pl|cf)_/.test(k) && !INTEREST_FIELDS.some(f => f === k));
  const indicatorKeys = fields.filter((k) => !/^(bs|pl|cf)_/.test(k) && k !== 'interestDebtRatio');

  const tasks: Promise<void>[] = [];
  if (fields.includes('interestDebtRatio')) {
    tasks.push((async () => {
      const rows = await fetchDebtRatios(code, years).catch(() => new Map<string, number | null>());
      if(rows.size)sources.add('eastmoney:explicit-interest-debt-ratio');
      for (const [date, value] of rows) {
        const rec = byDate.get(date) ?? new Map<string, number | null>();
        rec.set('interestDebtRatio', value);
        byDate.set(date, rec);
      }
    })());
  }
  const statementIds = new Set(statementFields.map(key =>
    (key.startsWith('bs_') ? 'balance' : key.startsWith('pl_') ? 'profit' : 'cashflow') as StatementId));
  for (const id of statementIds) {
    tasks.push(fetchOneStatement(code, id, years, byDate, sources));
  }
  if (fields.some(k => INTEREST_FIELDS.some(f => f === k))) {
    tasks.push((async () => {
      // 分红/财报附注明细缺失时保留空值，不回退到净财务费用或现金流附注。
      const rows = await fetchInterestExpenses(code, years).catch(() => new Map<string, Map<string,number|null>>());
      if(rows.size)sources.add('eastmoney:explicit-interest-expense');
      for (const [date, values] of rows) {
        const rec = byDate.get(date) ?? new Map<string,number|null>();
        for (const [key,value] of values) if (fields.includes(key)) rec.set(key,value);
        byDate.set(date,rec);
      }
    })());
  }

  // 指标页数据（复用 sinaFinancial 的解析）：需要时才抓
  if (indicatorKeys.length > 0) {
    tasks.push(
      (async () => {
        const { fetchSinaFinancial } = await import('./sinaFinancial');
        const f = await fetchSinaFinancial(code, years, name).catch(() => null);
        if (!f) return;
        if(f.source)sources.add(f.source);
        for (let i = 0; i < f.periods.length; i++) {
          let rec = byDate.get(f.periods[i]);
          if (!rec) {
            rec = new Map();
            byDate.set(f.periods[i], rec);
          }
          for (const k of indicatorKeys) {
            const v = f.series[k]?.[i];
            if (v !== undefined) rec.set(k, v);
          }
        }
      })(),
    );
  }

  await Promise.all(tasks);

  const periods = Array.from(byDate.keys()).sort();
  if (periods.length === 0) {
    const missing = fields.join(', ');
    throw new Error(`${code} 未取得任何报告期数据（缺失字段：${missing}；对应财报源页未入库，请先通过维护端补齐）`);
  }
  // 数据库已有部分报表时正常返回：全字段皆空的 key 视为缺失项，明确标注而非整体报错
  const missingFields = fields.filter((key) => periods.every((d) => byDate.get(d)?.get(key) == null));

  const series: Record<string, (number | null)[]> = {};
  for (const key of fields) {
    series[key] = periods.map((d) => byDate.get(d)?.get(key) ?? null);
  }

  return cropRecentYears(
    {
      code,
      name: name ?? code,
      periods,
      periodLabels: periods.map((d) => periodLabel(d, 'half')),
      series,
      source: [...sources].sort().join(' + ') || 'public-financials',
      ...(missingFields.length ? { missingFields } : {}),
    },
    years,
  );
}

/** 按报告期粒度筛选（年报 / 中报 / 季报） */
export function filterByGranularityCustom(
  f: CustomFinancials,
  g: 'annual' | 'semi' | 'quarter' = 'semi',
): CustomFinancials {
  if (g === 'quarter') return f;
  const keep = f.periods
    .map((p, i) => ({ p, i }))
    .filter(({ p }) =>
      g === 'annual' ? p.endsWith('-12-31') : p.endsWith('-12-31') || p.endsWith('-06-30'),
    );
  return {
    ...f,
    periods: keep.map((k) => k.p),
    // 按明细粒度重算标签：年报/中报/季报的展示口径不同（12-31 在年报视图叫「年报」）
    periodLabels: keep.map((k) => periodLabel(k.p, 'half')),
    series: Object.fromEntries(
      Object.entries(f.series).map(([k, arr]) => [k, keep.map((x) => arr[x.i])]),
    ),
  };
}

