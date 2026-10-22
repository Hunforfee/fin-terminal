/**
 * 东方财富 HKF10 Provider —— 港股财务数据源。
 *
 * 已实测可用端点（沙箱 2026-10，均免鉴权）：
 *   主要指标   RPT_HKF10_FN_MAININDICATOR            （宽表，每期一行）
 *   资产负债表 RPT_HKF10_FN_BALANCE                  （长表，科目逐行，账本币种）
 *   利润表     RPT_HKF10_FN_INCOME                   （长表，账本币种）
 *   现金流量表 RPT_CUSTOM_HKSK_APPFN_CASHFLOW        （按报告期分组，VALUE_LIST 逐证券行，账本币种）
 *
 * 口径说明：
 *   - 三大长表一律采用原币报表（CURRENCY=港元等账本币种）；_PC 后缀报表为人民币折算口径，
 *     与 reported-currency 键位声明不符且下游不做币种换算，禁止混用。
 *   - 主要指标金额/每股值已标准化为 CNY；CURRENCY 为行情柜台币种，不能套用于 BPS/EPS。
 *   - 指标（ROE / 增长率 / 每股等）直接取东财披露值或由披露值恒等式派生。
 *   - 报告类型取 REPORT_TYPE，原始报表期取 STD_REPORT_DATE，不按自然年猜测财年。
 */

import { fetchJson } from './http';
import { cachedMarketInput, validateDatedRows } from '../marketInputs';
import { retainedDate } from '../marketRetention';
import { getMarketStore, marketRecord } from '../marketStore';
import { completeHkStatement, mergeHkStatementRows, type HkStatementRow } from '../marketHkStatements';
import { withMarketRefresh } from '../marketRefresh';
import { databaseOnly, marketDataMissing } from '../marketReadPolicy';
import type { CompanyFinancials, Granularity } from './sinaFinancial';
import type { StatementCatalog, CustomFinancials } from './sinaStatements';
import type { Candle, Valuation, ValuationPoint, ValuationStats, SeriesStats } from './types';
import { hkStatementValue, statementFieldUnit } from '../financeFieldSemantics';
import { computeHkValuation, fetchHkFundamental, fetchHkDividends, parseHkFundamental, type HkValuation } from './hkFundamental';

export const PROVIDER_NAME = 'eastmoney-hkf10';

const DC_URL = 'https://datacenter.eastmoney.com/securities/api/data/v1/get';


interface DcRow {
  STD_REPORT_DATE?: string;
  REPORT_DATE?: string;
  START_DATE?: string;
  CURRENCY?: string;
  STD_ITEM_CODE?: string | number;
  STD_ITEM_NAME?: string;
  ITEM_NAME?: string;
  AMOUNT?: number | string;
  [k: string]: unknown;
}

async function dcQuery(reportName: string, filter: string, extra = ''): Promise<DcRow[]> {
  const rows: DcRow[] = [];
  for (let page=1; ; page++) {
    const url = `${DC_URL}?reportName=${reportName}&columns=ALL&filter=${encodeURIComponent(filter)}&pageNumber=${page}&pageSize=1000&sortTypes=-1,1&sortColumns=REPORT_DATE,STD_ITEM_CODE&source=F10&client=PC${extra}`;
    const j = await fetchJson<{success?:boolean;result?:{data?:DcRow[];pages?:number}|null}>(url,{timeoutMs:15000,headers:{Referer:'https://emweb.securities.eastmoney.com/'}});
    if (j.success === false || !Array.isArray(j.result?.data)) throw new Error('港股报表数据不可用');
    rows.push(...j.result.data);
    if (page >= (j.result.pages ?? 1)) break;
    if (page >= 30) throw new Error('港股报表分页不完整');
  }
  return rows;
}

function reportDate(row: DcRow): string | null {
  const raw = row.REPORT_DATE;
  if (!raw) return null;
  const m = String(raw).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function num(v: unknown): number | null {
  if ((typeof v !== 'string' && typeof v !== 'number') || (typeof v === 'string' && !v.trim())) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------------------------------- 主要指标 */

export interface IndicatorPoint {
  date: string;
  raw: Record<string, number | null>;
  /** Raw CURRENCY is the trading counter, not the main indicators' value unit. */
  currency: string;
  kind: string;
  label: string;
}

const MAIN_URL = `${DC_URL}?reportName=RPT_HKF10_FN_MAININDICATOR&columns=ALL&filter=`;

/** 拉取主要指标（近 N 年，年报 + 中报 + 季报全部披露期） */
async function fetchAllHkIndicatorPoints(secucode: string): Promise<IndicatorPoint[]> {
  const url =
    `${MAIN_URL}${encodeURIComponent(`(SECUCODE="${secucode}")`)}` +
    `&pageNumber=1&pageSize=200&sortTypes=-1&sortColumns=REPORT_DATE&source=F10&client=PC`;
  const j = await fetchJson<{ result?: { data?: DcRow[] } | null }>(url, {
    timeoutMs: 15000,
    headers: { Referer: 'https://emweb.securities.eastmoney.com/' },
  });
  const rows = j.result?.data ?? [];
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const cutoff = new Date();
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 10);
  const points = rows
    .map((r) => {
      const d = reportDate(r);
      if (!d || d > today) return null;
      const raw: Record<string, number | null> = {};
      for (const [k, v] of Object.entries(r)) {
        if (typeof v === 'number' || (typeof v === 'string' && v !== '' && Number.isFinite(Number(v)))) {
          raw[k] = Number(v);
        }
      }
      const type = String(r.REPORT_TYPE ?? '');
      const kind = /年报/.test(type) ? 'annual' : /中报/.test(type) ? 'semi' : /一季/.test(type) ? 'q1' : /三季/.test(type) ? 'q3' : 'other';
      const label = type.replace('年年报','年报').replace('年中报','中报').replace('年一季报','Q1').replace('年三季报','Q3') || d;
      return { date: d, raw, currency: String(r.CURRENCY ?? ''), kind, label };
    })
    .filter((p): p is IndicatorPoint => p !== null && new Date(`${p.date}T00:00:00Z`) >= cutoff)
    .sort((a, b) => a.date.localeCompare(b.date));
  return points;
}

export async function fetchHkIndicatorPoints(secucode: string, years = 10): Promise<IndicatorPoint[]> {
  const points = await cachedMarketInput(`source-hk-indicators:v1:${secucode}`,'source-hk-indicators','hkf10:main:reported',1800e3,
    ()=>fetchAllHkIndicatorPoints(secucode),rows=>validateDatedRows(rows as unknown as Record<string,unknown>[],'date'));
  const cutoff = new Date(); cutoff.setUTCFullYear(cutoff.getUTCFullYear()-Math.min(10,Math.max(1,years)));
  return points.filter(p=>p.date>=cutoff.toISOString().slice(0,10));
}

/* ------------------------------------------- CompanyFinancials（指标趋势） */

type Fn = (p: IndicatorPoint, i: number, all: IndicatorPoint[]) => number | null;

/** 指标 key（与 sinaFinancial.INDICATORS 对齐）→ 计算函数 */
const METRIC_FNS: Record<string, Fn> = {
  roe: (p) => num(p.raw.ROE_AVG),
  netMargin: (p) => num(p.raw.NET_PROFIT_RATIO),
  operatingMargin: (p) => {
    const op = num(p.raw.OPERATE_PROFIT);
    const inc = num(p.raw.OPERATE_INCOME);
    return op !== null && inc !== null && inc !== 0 ? (op / inc) * 100 : null;
  },
  // Gross margin is not operating/main-business profit margin.
  mainMargin: () => null,
  roa: (p) => num(p.raw.ROA),
  revenueGrowth: (p) => num(p.raw.OPERATE_INCOME_YOY),
  profitGrowth: (p) => num(p.raw.HOLDER_PROFIT_YOY),
  equityGrowth: (p, _i, all) => yoyOf(p, all, 'TOTAL_PARENT_EQUITY'),
  assetGrowth: (p, _i, all) => yoyOf(p, all, 'TOTAL_ASSETS'),
  debtRatio: (p) => num(p.raw.DEBT_ASSET_RATIO),
  currentRatio: (p) => num(p.raw.CURRENT_RATIO),
  quickRatio: () => null,
  cashRatio: () => null,
  equityRatio: (p) => {
    const eq = num(p.raw.TOTAL_PARENT_EQUITY);
    const ta = num(p.raw.TOTAL_ASSETS);
    return eq !== null && ta !== null && ta !== 0 ? (eq / ta) * 100 : null;
  },
  ocfPerShare: (p) => num(p.raw.PER_NETCASH_OPERATE),
  ocfToRevenue: (p) => {
    const ocf = num(p.raw.NETCASH_OPERATE);
    const inc = num(p.raw.OPERATE_INCOME);
    return ocf !== null && inc !== null && inc !== 0 ? (ocf / inc) * 100 : null;
  },
  ocfToProfit: (p) => {
    const ocf = num(p.raw.NETCASH_OPERATE);
    // Match the consolidated-profit denominator used by the A-share metric.
    // HOLDER_PROFIT excludes minority interests and must not replace it.
    const np = num(p.raw.NET_PROFIT);
    return ocf !== null && np !== null && np > 0 ? (ocf / np) * 100 : null;
  },
  cashFlowRatio: () => null,
  eps: (p) => num(p.raw.BASIC_EPS),
  bps: (p) => num(p.raw.BPS),
  undistPerShare: () => null,
};

/** 同比：与上年同期（同月日）比较 */
function yoyOf(p: IndicatorPoint, all: IndicatorPoint[], key: string): number | null {
  const cur = num(p.raw[key]);
  const md = p.date.slice(5);
  const prevYear = Number(p.date.slice(0, 4)) - 1;
  const prev = all.find((x) => x.date === `${prevYear}-${md}`);
  const pv = prev ? num(prev.raw[key]) : null;
  if (cur === null || pv === null || pv === 0) return null;
  return ((cur - pv) / Math.abs(pv)) * 100;
}

/** 港股指标序列 → 与 A 股 CompanyFinancials 同形 */
export async function fetchHkFinancials(
  secucode: string,
  code: string,
  years = 6,
  name?: string,
): Promise<CompanyFinancials> {
  const points = await fetchHkIndicatorPoints(secucode, years + 2);
  if (points.length === 0) throw new Error(`港股财务指标：${code} 未取得任何报告期数据`);
  const crop = new Date();
  crop.setUTCFullYear(crop.getUTCFullYear() - years);
  const kept = points.filter((p) => new Date(`${p.date}T00:00:00Z`) >= crop);
  const periods = kept.map((p) => p.date);
  const series: Record<string, (number | null)[]> = {};
  for (const [key, fn] of Object.entries(METRIC_FNS)) {
    series[key] = kept.map((p, i) => fn(p, i, kept));
  }
  return {
    code,
    name: name ?? code,
    periods,
    periodLabels: kept.map(p => p.label),
    periodKinds: Object.fromEntries(kept.map(p => [p.date,p.kind])),
    currency: 'CNY',
    series,
    source: PROVIDER_NAME,
  };
}

/** 报告期 → 展示标签（与 A 股口径一致） */
export function periodLabel(date: string): string {
  const md = date.slice(5);
  const y = date.slice(2, 4);
  if (md === '12-31') return `${y}H2`;
  if (md === '06-30') return `${y}H1`;
  if (md === '03-31') return `${y}Q1`;
  if (md === '09-30') return `${y}Q3`;
  return date.slice(2);
}

/* ------------------------------------------------- 三大报表（长表） */

const STATEMENT_REPORTS: Record<'balance' | 'profit' | 'cashflow', string> = {
  // 原币报表（CURRENCY=账本币种，如港元）。_PC 后缀报表为人民币折算口径，
  // 与键位声明的 reported-currency 不符，且下游不做币种换算，故不采用。
  balance: 'RPT_HKF10_FN_BALANCE',
  profit: 'RPT_HKF10_FN_INCOME',
  cashflow: 'RPT_CUSTOM_HKSK_APPFN_CASHFLOW',
};

/** 现金流量表原币报表按报告期分组、VALUE_LIST 逐证券行；展平为逐行长表（只保留本证券行）。 */
function flattenCashflowGroups(rows: DcRow[], secucode: string): DcRow[] {
  const flat: DcRow[] = [];
  for (const group of rows) {
    const list = group?.VALUE_LIST;
    if (!Array.isArray(list)) { flat.push(group); continue; }
    for (const row of list) {
      if (String(row.SECUCODE ?? '') !== secucode) continue;
      flat.push({ ...row, REPORT_DATE: row.REPORT_DATE ?? group.REPORT_DATE });
    }
  }
  return flat;
}

export type StatementId = 'balance' | 'profit' | 'cashflow';

export type { HkStatementRow } from '../marketHkStatements';

/** 按报告期集合拉取一张表的全部科目行 */
export async function fetchHkStatement(
  secucode: string,
  id: StatementId,
  dates: string[],
): Promise<HkStatementRow[]> {
  const selected = [...new Set(dates)].filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d) && retainedDate(d)).sort();
  if (!selected.length) return [];
  const fetchRows = async (missing: string[]) => {
    const query = `(SECUCODE="${secucode}")(REPORT_DATE in (${missing.map(d=>`'${d}'`).join(',')}))`;
    return parseHkStatementRows(id === 'cashflow'
      ? flattenCashflowGroups(await dcQuery(STATEMENT_REPORTS[id], query), secucode)
      : await dcQuery(STATEMENT_REPORTS[id], query));
  };
  const store = getMarketStore(); if (!store) {if(databaseOnly())throw marketDataMissing('港股原始报表');return fetchRows(selected);}
  const read=async()=>{
    const values = new Map<string,HkStatementRow[]>(), prior = new Map<string,string>(), priorRows = new Map<string,HkStatementRow[]>();
    const key = (date: string)=>`source-hk-statement:v1:${secucode}:${id}:${date}`;
    for (const date of selected) {
      const row = await store.read<HkStatementRow[]>(key(date));
      if (row) { prior.set(date,row.digest); priorRows.set(date,row.payload); }
      if (row && (Date.parse(row.refreshAfter)>Date.now() || databaseOnly()) && completeHkStatement(row,date)) values.set(date,row.payload);
    }
    const missing = selected.filter(d=>!values.has(d));
    if(databaseOnly() && missing.length)throw marketDataMissing('港股原始报表');
    if (missing.length) {
      const rows = await fetchRows(missing);
      for (const date of missing) {
        const sourceRows = rows.filter(r=>r.date===date); if (!sourceRows.length) continue;
        if (!completeHkStatement({source:'hkf10:statement:reported-currency',payload:sourceRows},date)) throw Error('港股报表缺少有效金额或项目无效');
        const part = mergeHkStatementRows(priorRows.get(date)??[],sourceRows,date);
        values.set(date,part);
        await store.write(marketRecord(key(date),'source-hk-statement','hkf10:statement:reported-currency',part,1800e3),prior.get(date)??null);
      }
    }
    return selected.flatMap(date=>values.get(date)??[]);
  };
  return databaseOnly()?read():withMarketRefresh(store,`hk-statement:${secucode}:${id}`,read);
}

export function parseHkStatementRows(rows: DcRow[]): HkStatementRow[] {
  // 数据源有时把上一期原始报表挂在新报告期上；必须按真实报表期归位。
  // 但少数证券（实测 00016.HK 等 11 只）STD_REPORT_DATE 系统性滞后一期：无任何
  // STD==REPORT 行，且 REPORT_DATE 集合含 STD 集合没有的报告期（如最新中报）。
  // 这类证券按 STD 归位会整条链错位一期并丢掉最新报告期，应以 REPORT_DATE 为准；
  // 同证券主要指标宽表（按 REPORT_DATE）同期数字可交叉印证二者一致。
  const stdDate = (r: DcRow) => {
    const m = r.STD_REPORT_DATE ? String(r.STD_REPORT_DATE).match(/^(\d{4}-\d{2}-\d{2})/) : null;
    return m ? m[1] : null;
  };
  const bySecurity = new Map<string, DcRow[]>();
  for (const r of rows) {
    const sc = String(r.SECUCODE ?? '');
    if (!bySecurity.has(sc)) bySecurity.set(sc, []);
    bySecurity.get(sc)!.push(r);
  }
  const byItem = new Map<string, HkStatementRow>();
  for (const group of bySecurity.values()) {
    const anyExact = group.some(r => stdDate(r) !== null && stdDate(r) === reportDate(r));
    const stdDates = new Set(group.map(stdDate).filter((d): d is string => d !== null));
    const reportDates = new Set(group.map(reportDate).filter((d): d is string => d !== null));
    const stdLagsWholeSecurity = !anyExact && [...reportDates].some(d => !stdDates.has(d));
    const sorted = [...group].sort((a, b) => stdLagsWholeSecurity ? 0
      : Number(a.STD_REPORT_DATE === a.REPORT_DATE) - Number(b.STD_REPORT_DATE === b.REPORT_DATE));
    for (const r of sorted) {
      const date = reportDate(stdLagsWholeSecurity ? r : { ...r, REPORT_DATE: r.STD_REPORT_DATE ?? r.REPORT_DATE });
      const itemCode = String(r.STD_ITEM_CODE ?? '');
      const itemName = String(r.STD_ITEM_NAME ?? r.ITEM_NAME ?? '').trim();
      if (date && itemCode && itemName) byItem.set(`${r.SECUCODE ?? ''}:${date}:${itemCode}`, { date, itemCode, itemName, amount: num(r.AMOUNT) });
    }
  }
  return [...byItem.values()];
}

/** 数据源标准化口径的币种。 */
export async function fetchHkCurrency(secucode: string): Promise<string | null> {
  return (await fetchHkIndicatorPoints(secucode, 2)).at(-1)?.currency ?? null;
}

/** 字段 key：bs_i1234 形式（i + 东财科目代码），label 用披露科目名 */
export const itemKey = (prefix: 'bs' | 'pl' | 'cf', itemCode: string) => `${prefix}_i${itemCode}`;

/** 三大报表字段目录（供自定义指标选择器） */
export async function fetchHkCatalog(secucode: string): Promise<StatementCatalog[]> {
  const ids: StatementId[] = ['balance', 'profit', 'cashflow'];
  const labels: Record<StatementId, string> = {
    balance: '资产负债表',
    profit: '利润表',
    cashflow: '现金流量表',
  };
  const prefixes: Record<StatementId, 'bs' | 'pl' | 'cf'> = { balance: 'bs', profit: 'pl', cashflow: 'cf' };

  const allDates = (await fetchHkIndicatorPoints(secucode, 12)).map((p) => p.date);
  const sampleDates = allDates.slice(-8);
  const catalogs = await Promise.all(
    ids.map(async (id) => {
      const rows = await fetchHkStatement(secucode, id, sampleDates);
      const seen = new Map<string, string>(); // itemCode → itemName
      for (const r of rows) if (!seen.has(r.itemCode)) seen.set(r.itemCode, r.itemName);
      const items = Array.from(seen.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([ic, nm]) => ({
          key: itemKey(prefixes[id], ic),
          sina: nm,
          label: nm,
          group: '全部科目',
          statement: id,
          unit: statementFieldUnit(nm),
        }));
      return {
        id,
        label: labels[id],
        unit: '万元',
        groups: [{ label: '全部科目', fields: items }],
        total: items.length,
      } satisfies StatementCatalog;
    }),
  );
  return catalogs;
}

/** 自定义字段多年序列（与 sinaStatements.fetchCustomFinancials 同形） */
export async function fetchHkCustomFinancials(
  secucode: string,
  code: string,
  fields: string[],
  years = 6,
  name?: string,
): Promise<CustomFinancials> {
  const points = await fetchHkIndicatorPoints(secucode, years + 2);
  if (points.length === 0) throw new Error(`港股财报：${code} 未取得任何报告期数据`);
  const allDates = points.map((p) => p.date);

  const statementFields = fields.filter((k) => /^(bs|pl|cf)_/i.test(k));
  const indicatorKeys = fields.filter((k) => !/^(bs|pl|cf)_/i.test(k));

  const byDate = new Map<string, Map<string, number | null>>();
  for (const d of allDates) byDate.set(d, new Map());

  const tasks: Promise<void>[] = [];

  // 三表科目
  const need = new Map<StatementId, Set<string>>();
  for (const f of statementFields) {
    const m = /^(bs|pl|cf)_i(.+)$/i.exec(f);
    if (!m) continue;
    const id = (m[1].toLowerCase() === 'bs' ? 'balance' : m[1].toLowerCase() === 'pl' ? 'profit' : 'cashflow') as StatementId;
    if (!need.has(id)) need.set(id, new Set());
    need.get(id)!.add(m[2]);
  }
  for (const [id, codes] of need) {
    tasks.push(
      (async () => {
        const rows = await fetchHkStatement(secucode, id, allDates).catch(() => []);
        for (const r of rows) {
          if (!codes.has(r.itemCode)) continue;
          const rec = byDate.get(r.date);
          if (rec) rec.set(itemKey(id === 'balance' ? 'bs' : id === 'profit' ? 'pl' : 'cf', r.itemCode), hkStatementValue(r.amount, r.itemName));
        }
      })(),
    );
  }

  // 指标
  if (indicatorKeys.length > 0) {
    tasks.push(
      (async () => {
        for (const p of points) {
          const rec = byDate.get(p.date);
          if (!rec) continue;
          for (const k of indicatorKeys) {
            const fn = METRIC_FNS[k];
            if (fn) rec.set(k, fn(p, allDates.indexOf(p.date), points));
          }
        }
      })(),
    );
  }

  await Promise.all(tasks);

  const cutoff = new Date();
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
  const periods = allDates.filter((d) => new Date(`${d}T00:00:00Z`) >= cutoff);
  const series: Record<string, (number | null)[]> = {};
  for (const key of fields) {
    series[key] = periods.map((d) => byDate.get(d)?.get(key) ?? null);
  }
  if (periods.length === 0) throw new Error(`港股财报：${code} 未取得任何报告期数据`);

  return {
    code,
    name: name ?? code,
    periods,
    periodLabels: periods.map(d => points.find(p => p.date === d)?.label ?? d),
    periodKinds: Object.fromEntries(points.map(p => [p.date,p.kind])),
    // Main-indicator CURRENCY is the trading counter, not the long statements'
    // accounting currency. Never label CNY Tencent statements as HKD.
    currency: statementFields.length ? '原币未核实' : 'CNY',
    fieldCurrencies: Object.fromEntries(fields.map(key => [key, /^(bs|pl|cf)_/i.test(key) ? '原币未核实' : 'CNY'])),
    series,
    source: PROVIDER_NAME,
  };
}

/** 按公司自身财年筛选，不把所有港股的 12 月末都当成年报。 */
export function filterHkPeriods<T extends {periods:string[];periodLabels:string[];series:Record<string,(number|null)[]>;periodKinds?:Record<string,string>}>(f:T,g:'annual'|'semi'|'quarter'):T {
  if(g==='quarter') return f;
  const keep=f.periods.map((p,i)=>({p,i})).filter(({p})=>g==='annual'?f.periodKinds?.[p]==='annual':['annual','semi'].includes(f.periodKinds?.[p]??''));
  return {...f,periods:keep.map(k=>k.p),periodLabels:keep.map(k=>f.periodLabels[k.i]),series:Object.fromEntries(Object.entries(f.series).map(([k,v])=>[k,keep.map(x=>v[x.i])]))};
}

/** Current metrics share the list calculation; no unverified historical curves. */
export function summarizeHkSnapshot(
  points: IndicatorPoint[], code: string,
  quote: { price: number | null; pe: number | null; marketPe?: number | null; pb?: number | null; ts?: string | null },
  date: string, years: number, current?: HkValuation,
): Valuation {
  const latest = points.filter(p => p.date <= date).at(-1);
  if (!latest) throw new Error('港股财报指标不可用');
  const fundamental = parseHkFundamental([{
    ...latest.raw, REPORT_DATE: latest.date, REPORT_TYPE: latest.label, CURRENCY: latest.currency,
  }]);
  // Without actual event records, DPS_HKD alone is not a verified fiscal year.
  const metrics = current ?? computeHkValuation(fundamental, null, quote.price, date);
  const pe = metrics.pe, pb = metrics.pb, dy = metrics.dividendYield;
  const empty = (value: number | null): SeriesStats => ({
    current: value, percentile: null, p80: null, p50: null, p20: null,
    max: value, avg: value, min: value, count: 0,
  });
  return {
    code, pe, pb, pePercentile: null, pbPercentile: null,
    dividendYield: dy, dyPercentile: null,
    dividendYieldMethod: 'hk-static',
    dividendFiscalYear: metrics.fiscalYear,
    dividendPerShare: { ordinary: metrics.ordinaryDps, special: metrics.specialDps, total: metrics.ttmDps },
    roe: num(latest.raw.ROE_YEARLY), netProfit: null, netAssets: null,
    history: [], basis: 'real', years,
    stats: { pe: empty(pe), pb: empty(pb), dy: empty(dy), from: date, to: date },
    method: 'disclosure', source: PROVIDER_NAME, stale: false,
    historyUnavailableReason: '港股财报接口未提供可核验的历史公告日及历史分红快照，暂不计算历史估值曲线和分位。',
    marketComparison: { pe: quote.marketPe === undefined ? quote.pe : quote.marketPe, pb: quote.pb ?? null, ts: quote.ts ?? null },
    warnings: [
      '港股当前 PB 使用同一快照的港元市值、普通股数与 PB 恢复港元每股净资产，再按当前价计算。PE 保留上游 TTM 口径并按当前价更新，不将人民币 EPS_TTM 直接除以港元股价。',
      '港股股息率为最新完整财年已实施现金分红（含特别现金股息）除以当前港元股价；未验证的历史公告日期、分红时点不回填历史曲线。',
    ],
    fin: {
      report: metrics.reportDate ?? latest.date, npTTM: null, shares: null,
      bps: metrics.bookValuePerShareHkd, points: points.length, realDates: false, adjustGaps: 0,
    },
  };
}

export async function buildHkValuation(
  secucode: string, code: string, candles: Candle[],
  quote: { price: number | null; pe: number | null; pb?: number | null; ts?: string | null },
  years = 10, current?: HkValuation,
): Promise<Valuation> {
  const points = await fetchHkIndicatorPoints(secucode, years + 3);
  const date = quote.ts?.slice(0, 10) ?? candles.at(-1)?.date ??
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  let shared = current;
  if (!shared) {
    const [fundamental, dividends] = await Promise.all([
      fetchHkFundamental(code).catch(() => null),
      fetchHkDividends(code, date).catch(() => null),
    ]);
    shared = computeHkValuation(fundamental, dividends, quote.price, date);
  }
  return summarizeHkSnapshot(points, code, quote, date, years, shared);
}
