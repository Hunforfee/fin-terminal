import { marketRecord, marketDigest, type MarketStore } from './marketStore';
import { marketCutoff } from './marketRetention';

/**
 * 财务/分红的 QMT 导入写入器。记录写入与现有读取器完全相同的键位与 payload 结构：
 * - 财务：source-sina-page:v1:<code>:<statement>:<year>（payload {dates,rows,unit}）
 * - 分红预案：dividend-plans-v2:<code>；已实施：implemented-dividends-v4:<code>
 * source 标签沿用读取器期望值，保证 cachedMarketInput 直接消费；真实来源在导入日志中留痕。
 */
const isoDate = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

const STATEMENTS = ['profit', 'balance', 'cashflow'] as const;
export type StatementId = typeof STATEMENTS[number];

const valStr = (v: unknown): string => {
  if (v === null || v === undefined || v === '' || v === '--' || v === '—') return '--';
  const n = Number(v);
  if (!Number.isFinite(n)) throw Error(`科目值无效: ${JSON.stringify(v)}`);
  return String(n);
};

export interface FinanceImport {
  symbol: string; // 6 位 A 股代码
  statement: StatementId;
  reportDates: string[];
  announceDates?: (string | null)[];
  items: { name: string; vals: (number | string | null)[] }[];
}

export async function writeFinanceStatements(store: MarketStore, input: FinanceImport, now = Date.now()) {
  const code = String(input.symbol ?? '');
  if (!/^\d{6}$/.test(code)) throw Error('财务导入仅支持 6 位 A 股代码');
  if (!STATEMENTS.includes(input.statement)) throw Error('statement 必须是 profit/balance/cashflow');
  if (!Array.isArray(input.items) || !input.items.length) throw Error('财务科目为空');
  const dates = input.reportDates;
  if (!Array.isArray(dates) || !dates.length) throw Error('报告期为空');
  const seen = new Set<string>();
  for (const d of dates) {
    if (!isoDate(d)) throw Error(`报告期日期无效: ${d}`);
    if (seen.has(d)) throw Error(`报告期重复: ${d}`);
    seen.add(d);
    if (d.slice(5) !== '03-31' && d.slice(5) !== '06-30' && d.slice(5) !== '09-30' && d.slice(5) !== '12-31')
      throw Error(`报告期必须是季末: ${d}`);
    if (d < marketCutoff(now)) throw Error('财报范围超出十年保留期限');
  }
  const announce = input.announceDates;
  if (announce !== undefined) {
    if (!Array.isArray(announce) || announce.length !== dates.length) throw Error('披露日期数量与报告期不一致');
    for (const a of announce) if (a !== null && !isoDate(a)) throw Error(`披露日期无效: ${a}`);
  }
  for (const it of input.items) {
    if (!it?.name || typeof it.name !== 'string') throw Error('科目名无效');
    if (!Array.isArray(it.vals) || it.vals.length !== dates.length) throw Error(`科目 ${it.name} 的值数量与报告期不一致`);
  }
  // 按年拆分写入（读取器按年取页）
  const byYear = new Map<string, number[]>();
  dates.forEach((d, i) => {
    const y = d.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push(i);
  });
  const written: { key: string; dates: number }[] = [];
  let identical = 0;
  for (const [year, idx] of [...byYear.entries()].sort()) {
    const yearDates = idx.map(i => dates[i]);
    const rows = input.items.map(it => ({
      kind: 'field' as const, name: it.name,
      vals: idx.map(i => valStr(it.vals[i])),
    }));
    const payload: Record<string, unknown> = { dates: yearDates, rows, unit: 'wan' };
    if (announce) payload.announceDates = idx.map(i => announce![i]);
    const key = `source-sina-page:v1:${code}:${input.statement}:${year}`;
    const old = await store.read(key);
    // 相同内容幂等跳过（digest 对键序不敏感，规避 PG jsonb 重排）
    if (old && marketDigest(old.payload) === marketDigest(payload)) {
      identical++;
      written.push({ key, dates: yearDates.length }); continue;
    }
    if (!await store.write(marketRecord(key, 'source-sina-page', 'sina:reported:wan', payload, 7 * 864e5, now), old?.digest ?? null))
      throw Error(`写入版本冲突: ${key}`);
    written.push({ key, dates: yearDates.length });
  }
  return { code, statement: input.statement, written, totalDates: dates.length,
    ...(identical === byYear.size ? { skipped: true } : {}) };
}

/* ------------------------------------------------- 财务史（statements-v3） */

export interface FinancialHistoryImport {
  symbol: string;
  reportDates: string[];
  /** 金额字段单位万元（累计），totalShares 单位股 */
  items: { code: string; vals: (number | null)[] }[];
}

const WAN_TO_YUAN = 1e4;

/** 写入 statements-v3:<code>:<span>（financial-history，供估值/收盘/净利史读取）。 */
export async function writeFinancialHistory(store: MarketStore, input: FinancialHistoryImport, now = Date.now()) {
  const code = String(input.symbol ?? '').replace(/^(sh|sz|hk)/i, '');
  if (!/^\d{6}$/.test(code)) throw Error('财务史导入仅支持 6 位 A 股代码');
  const dates = input.reportDates;
  if (!Array.isArray(dates) || dates.length < 2) throw Error('财务史报告期不足');
  const seen = new Set<string>();
  for (const d of dates) {
    if (!isoDate(d)) throw Error(`报告期日期无效: ${d}`);
    if (seen.has(d)) throw Error(`报告期重复: ${d}`);
    seen.add(d);
    if (d < marketCutoff(now)) throw Error('财报范围超出十年保留期限');
  }
  const WAN_CODES = new Set(['npParent', 'npTotal', 'equityParent', 'equityTotal', 'equityCommon']);
  const byCode = new Map(input.items.map(it => [String(it.code), it.vals]));
  for (const req of ['npParent', 'equityParent']) {
    const vals = byCode.get(req);
    if (!vals) throw Error(`缺少必需科目 ${req}`);
  }
  const idx = dates.map((d, i) => ({ d, i })).sort((a, b) => a.d.localeCompare(b.d));
  const incoming = idx.map(({ d, i }) => {
    const row: Record<string, unknown> = { date: d };
    for (const [code2, vals] of byCode) {
      const v = vals[i];
      if (v === null || v === undefined) { row[code2] = null; continue; }
      if (!Number.isFinite(Number(v))) throw Error(`科目 ${code2} 值无效: ${v}`);
      row[code2] = code2 === 'totalShares' ? Number(v) / 1e8
        : WAN_CODES.has(code2) ? Number(v) * WAN_TO_YUAN : Number(v);
    }
    return row;
  });
  // 按日期合并（本次覆盖同日），绝不能缩减已有历史
  let rows: Record<string, unknown>[] = incoming;
  const probe = await store.read(`statements-v3:${code}:12`).catch(() => null);
  const probeRows = (probe?.payload as Record<string, unknown>[] | undefined) ?? null;
  if (probeRows?.length) {
    const union = new Map(probeRows.map(r => [String(r.date), r]));
    for (const r of incoming) union.set(String(r.date), r);
    rows = [...union.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (union.size === probeRows.length && marketDigest(probeRows) === marketDigest(rows))
      return { code, rows: rows.length, spans: 0, skipped: true };
  }
  // 每个消费方按 span 取数，写入覆盖 2~12 年的全部 span 键
  const written: string[] = [];
  for (let span = 2; span <= 12; span++) {
    const key = `statements-v3:${code}:${span}`;
    const old = await store.read(key);
    if (old && marketDigest(old.payload) === marketDigest(rows)) { written.push(key); continue; }
    if (!await store.write(marketRecord(key, 'financial-history', 'sina-statements:CNY:yuan:current-revisions', rows, 1800e3, now), old?.digest ?? null))
      throw Error(`写入版本冲突: ${key}`);
    written.push(key);
  }
  return { code, rows: rows.length, spans: written.length };
}

/* ------------------------------------------------------------ 分红 */

export interface DividendPlanItem {
  reportDate: string; announceDate: string | null; scheduleKnownDate?: string | null;
  exDate: string | null; perShare: number; perShareStock?: number;
  implemented: boolean; cancelled?: boolean; special?: boolean;
}

function checkPlan(p: DividendPlanItem) {
  if (!isoDate(p.reportDate)) throw Error(`分红报告期无效: ${p.reportDate}`);
  for (const k of ['announceDate', 'scheduleKnownDate', 'exDate'] as const)
    if (p[k] !== null && p[k] !== undefined && !isoDate(p[k])) throw Error(`分红 ${k} 无效: ${p[k]}`);
  if (!Number.isFinite(p.perShare) || p.perShare < 0) throw Error('每股分红金额无效');
  if (p.perShareStock !== undefined && p.perShareStock !== null &&
      (!Number.isFinite(p.perShareStock) || p.perShareStock < 0)) throw Error('送转比例无效');
  if (typeof p.implemented !== 'boolean') throw Error('implemented 必须为布尔');
}

const planCurrency = (symbol: string) => symbol.startsWith('hk') ? 'HKD' : 'CNY';

export async function writeDividendPlans(store: MarketStore, symbol: string, plans: DividendPlanItem[], now = Date.now()) {
  const code = String(symbol ?? '').replace(/^(sh|sz|hk)/i, '');
  if (!/^\d{4,6}$/.test(code)) throw Error('分红导入证券代码无效');
  if (!Array.isArray(plans) || !plans.length) throw Error('分红预案为空');
  const sorted = [...plans].sort((a, b) => a.reportDate.localeCompare(b.reportDate));
  for (const p of sorted) checkPlan(p);
  const key = `dividend-plans-v2:${code}`;
  const payload = sorted.map(p => ({
    exDate: p.exDate ?? null, special: !!p.special, perShare: p.perShare,
    cancelled: !!p.cancelled, reportDate: p.reportDate, implemented: !!p.implemented,
    announceDate: p.announceDate ?? null, ...(p.scheduleKnownDate ? { scheduleKnownDate: p.scheduleKnownDate } : {}),
    ...(p.perShareStock != null ? { perShareStock: p.perShareStock } : {}),
  }));
  const old = await store.read(key);
  if (old && marketDigest(old.payload) === marketDigest(payload)) return { code, count: payload.length, skipped: true };
  if (!await store.write(marketRecord(key, 'announced-dividend-plans', `eastmoney:${planCurrency(symbol)}:tax-before:per-share:announced-not-implemented`, payload, 1800e3, now), old?.digest ?? null))
    throw Error('分红预案写入版本冲突，请重试');
  return { code, count: payload.length };
}

export interface DividendImplRow { exDate: string; perShare: number; perShareStock?: number; precisionPerShare?: number }

export async function writeDividendImplemented(store: MarketStore, symbol: string, rows: DividendImplRow[], now = Date.now()) {
  const code = String(symbol ?? '').replace(/^(sh|sz|hk)/i, '');
  if (!/^\d{4,6}$/.test(code)) throw Error('分红导入证券代码无效');
  if (!Array.isArray(rows) || !rows.length) throw Error('已实施分红为空');
  const sorted = [...rows].sort((a, b) => a.exDate.localeCompare(b.exDate));
  let prev = '';
  for (const r of sorted) {
    if (!isoDate(r.exDate)) throw Error(`除息日无效: ${r.exDate}`);
    if (r.exDate <= prev) throw Error(`除息日重复或未升序: ${r.exDate}`);
    prev = r.exDate;
    if (!Number.isFinite(r.perShare) || r.perShare < 0) throw Error('每股分红金额无效');
    if (r.perShareStock !== undefined && (!Number.isFinite(r.perShareStock) || r.perShareStock < 0)) throw Error('送转比例无效');
  }
  const key = `implemented-dividends-v4:${code}`;
  const payload = sorted.map(r => ({
    exDate: r.exDate, perShare: r.perShare, cashSource: 'qmt',
    perShareStock: r.perShareStock ?? 0,
    precisionPerShare: r.precisionPerShare ?? 0.01,
  }));
  const old = await store.read(key);
  if (old && marketDigest(old.payload) === marketDigest(payload)) return { code, count: payload.length, skipped: true };
  if (!await store.write(marketRecord(key, 'implemented-dividends', `qmt:${planCurrency(symbol)}:tax-before:per-share:ex-date`, payload, 1800e3, now), old?.digest ?? null))
    throw Error('已实施分红写入版本冲突，请重试');
  return { code, count: payload.length };
}

/* ---------------------------------------------------- K线跨源冲突检查 */

interface SimpleSeries { candles?: { date: string; close: number }[] }

/** 与库内 tencent/sina 重叠日收盘偏差 >1% 记为冲突（不写入）。 */
export async function klineCrossConflicts(store: MarketStore, symbol: string, candles: { date: string; close: number }[]) {
  const conflicts: { date: string; incoming: number; existing: number; source: string }[] = [];
  const incoming = new Map(candles.map(c => [c.date, c.close]));
  for (const src of ['tencent', 'sina']) {
    const row = await store.read<SimpleSeries>(`kline:v2:${symbol}:day:none:${src}:prices-only`).catch(() => null);
    for (const c of row?.payload?.candles ?? []) {
      const v = incoming.get(c.date);
      if (v === undefined || !Number.isFinite(c.close) || c.close === 0) continue;
      if (Math.abs(v - c.close) > Math.abs(c.close) * 0.01)
        conflicts.push({ date: c.date, incoming: v, existing: c.close, source: src });
    }
  }
  return conflicts.slice(0, 20);
}
