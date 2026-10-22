import { marketDigest, marketRecord, type MarketStore } from './marketStore';
import { marketCutoff } from './marketRetention';
import { normalizeStockCode } from './datasource/codes';
import { completeHkStatement, mergeHkStatementRows, type HkStatementRow } from './marketHkStatements';
import { dividendIdentity, mergeHkDividendEvents } from './hkDividendEvents';
import type { HkDividendKind, HkDividendRecord } from './datasource/hkDividends';

/**
 * 港股数据导入写入器（WorkBuddy 经 MCP 取数后写回）。
 *
 * 写入与现有读取器完全相同的键位与 payload 结构，source 标签注明导入 provenance：
 * - 三大报表：source-hk-statement:v1:<secucode>:<statement>:<date>（payload {date,itemCode,itemName,amount}[]，金额为账本币种元）
 * - 分红事件：hk-dividend-events-v4:<symbol>（payload HkDividendRecord[]，HKD 税前每股）
 *
 * 合并哲学与 A 股导入一致：缺失值不擦除已确认事实；已存在且不一致的数值冲突则拒绝写入、保留原记录。
 */

const STATEMENTS = ['profit', 'balance', 'cashflow'] as const;
export type HkStatementId = typeof STATEMENTS[number];
const isoDate = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  Number.isFinite(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const chinaDate = (now: number) => new Date(now + 8 * 3600e3).toISOString().slice(0, 10);

function hkSecurity(symbol: string) {
  const n = normalizeStockCode(symbol);
  if (!n || n.market !== 'HK' || n.kind !== 'stock' || !/^\d{5}$/.test(n.code)) throw Error('港股导入仅支持港股证券代码（如 hk00016 / 00016.HK）');
  return { symbol: n.symbol, secucode: `${n.code}.HK` };
}

export type { HkStatementRow } from './marketHkStatements';
export interface CompleteHkReport { date: string; itemCodes: string[] }

/** 按报告期逐日写入三大报表；同报告期按 itemCode 合并，null 金额不擦除旧值。
 *  options.overwrite：受控的全量快照覆盖（仅管理员导入路由可传）。用于修正历史口径缺陷
 *  （如旧抓取链路落入的人民币折算值 → 原币值），开启后冲突金额以上传快照为准并留 incident。 */
export async function writeHkStatements(store: MarketStore, input: { symbol: string; statement: string; rows: HkStatementRow[]; completeReports?: CompleteHkReport[] }, now = Date.now(), options: { overwrite?: boolean } = {}) {
  const { symbol, secucode } = hkSecurity(input.symbol);
  if (!STATEMENTS.includes(input.statement as HkStatementId)) throw Error('港股报表 statement 必须是 profit/balance/cashflow');
  if (!Array.isArray(input.rows) || !input.rows.length) throw Error('港股报表行为空');
  const cutoff = marketCutoff(now), today = chinaDate(now);
  const byDate = new Map<string, HkStatementRow[]>();
  for (const r of input.rows) {
    if (!isoDate(r.date) || r.date > today || r.date < cutoff) throw Error(`港股报表报告期无效或超出保留期: ${r.date}`);
    if (typeof r.itemCode !== 'string' || !r.itemCode.trim()) throw Error('港股报表科目代码无效');
    if (typeof r.itemName !== 'string' || !r.itemName.trim()) throw Error('港股报表科目名称无效');
    if (r.amount !== null && (typeof r.amount !== 'number' || !Number.isFinite(r.amount))) throw Error('港股报表金额无效');
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date)!.push({ date: r.date, itemCode: r.itemCode.trim(), itemName: r.itemName.trim(), amount: r.amount ?? null });
  }
  // Completeness is an explicit administrator declaration of the original source's
  // complete item inventory, never inferred from a nonempty partial patch.
  const declared = new Set<string>();
  if (input.completeReports !== undefined) {
    if (!Array.isArray(input.completeReports)) throw Error('完整报表声明格式无效');
    for (const report of input.completeReports) {
      const rows = byDate.get(report?.date);
      if (!rows || declared.has(report.date) || !Array.isArray(report.itemCodes) || !report.itemCodes.length ||
        report.itemCodes.some(c => typeof c !== 'string' || !c.trim()) ||
        new Set(report.itemCodes).size !== report.itemCodes.length ||
        new Set(rows.map(r => r.itemCode)).size !== rows.length ||
        report.itemCodes.length !== rows.length || rows.some(r => !report.itemCodes.includes(r.itemCode)) ||
        !rows.some(r => r.amount !== null && Number.isFinite(r.amount))) throw Error('完整报表项目清单不匹配或缺少有效金额');
      declared.add(report.date);
    }
  }
  const written: { key: string; items: number; complete: boolean }[] = [];
  let identical = 0;
  for (const [date, incoming] of [...byDate.entries()].sort()) {
    const key = `source-hk-statement:v1:${secucode}:${input.statement}:${date}`;
    const old = await store.read<HkStatementRow[]>(key), prior = old?.payload ?? [];
    const overwritten: { itemCode: string; from: number; to: number }[] = [];
    const payload = mergeHkStatementRows(prior, incoming, date, {
      overwrite: options.overwrite === true,
      onOverwrite: row => overwritten.push({ itemCode: row.itemCode, from: row.prevAmount, to: row.amount as number }),
    });
    for (const o of overwritten)
      try { await store.incident(key, 'import_overwrite', { itemCode: o.itemCode, from: o.from, to: o.to, statement: input.statement }); } catch {}
    const complete = declared.has(date) || completeHkStatement(old, date);
    const source = `import:hk-statement:${complete ? 'complete' : 'partial'}:reported-currency`;
    if (old && old.digest === marketDigest(payload) && (completeHkStatement(old,date) === complete)) { identical++; written.push({ key, items: payload.length, complete }); continue; }
    if (!await store.write(marketRecord(key, 'source-hk-statement', source, payload, 1800e3, now), old?.digest ?? null))
      throw Error(`写入版本冲突: ${key}`);
    written.push({ key, items: payload.length, complete });
  }
  return { symbol, secucode, statement: input.statement, written, totalDates: byDate.size, ...(identical === byDate.size ? { skipped: true } : {}) };
}

/* --------------------------------------------------------------- 主要指标 */

export interface HkIndicatorPoint {
  date: string;
  raw: Record<string, number | null>;
  currency: string;
  kind: string;
  label: string;
}

/**
 * 按报告期合并写入主要指标（与站点 source-hk-indicators:v1:<secucode> 同键位同构）。
 * raw 字段级合并：导入值覆盖同名字段，旧有新字段不擦除；报告期只增不减。
 */
export async function writeHkIndicators(store: MarketStore, input: { symbol: string; points: HkIndicatorPoint[] }, now = Date.now()) {
  const { symbol, secucode } = hkSecurity(input.symbol);
  if (!Array.isArray(input.points) || !input.points.length) throw Error('港股指标数据为空');
  const cutoff = marketCutoff(now), today = chinaDate(now);
  const incoming = new Map<string, HkIndicatorPoint>();
  for (const p of input.points) {
    if (!isoDate(p.date) || p.date > today || p.date < cutoff) throw Error(`港股指标报告期无效或超出保留期: ${p.date}`);
    if (!p.raw || typeof p.raw !== 'object' || Array.isArray(p.raw)) throw Error('港股指标数值无效');
    for (const [k, v] of Object.entries(p.raw))
      if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) throw Error(`港股指标数值无效: ${k}`);
    incoming.set(p.date, { date: p.date, raw: p.raw, currency: String(p.currency ?? ''), kind: String(p.kind ?? ''), label: String(p.label ?? '') });
  }
  const key = `source-hk-indicators:v1:${secucode}`;
  const old = await store.read<HkIndicatorPoint[]>(key);
  const merged = new Map<string, HkIndicatorPoint>((old?.payload ?? []).map(p => [p.date, p]));
  for (const [date, p] of incoming) {
    const prev = merged.get(date);
    const raw: Record<string, number | null> = { ...(prev?.raw ?? {}) };
    for (const [k, v] of Object.entries(p.raw)) raw[k] = v;
    merged.set(date, { date, raw, currency: p.currency || prev?.currency || '', kind: p.kind || prev?.kind || '', label: p.label || prev?.label || '' });
  }
  const payload = [...merged.values()].sort((a, b) => a.date.localeCompare(b.date));
  const record = marketRecord(key, 'source-hk-indicators', 'import:hkf10:main:reported', payload, 1800e3, now);
  if (old && old.digest === record.digest) return { symbol, secucode, dates: payload.length, skipped: true };
  if (!await store.write(record, old?.digest ?? null)) throw Error('港股指标写入版本冲突，请重试');
  return { symbol, secucode, dates: payload.length };
}

/* --------------------------------------------------------------- 分红事件 */

export interface HkDividendEventRow {
  exDate: string;
  /** 数据源公告/更新日期；未知时为空字符串，不以除息日伪造公告批次 */
  noticeDate?: string;
  /** 港元/股，税前；无法取得已披露折算额时为空 */
  dps: number | null;
  period: string;
  special: boolean;
  fiscalYear?: string;
  kind?: string;
  eventId?: string;
}

const DIVIDEND_KINDS = new Set(['interim', 'final', 'q1', 'q2', 'q3', 'q4', 'special', 'unknown']);

/** 合并写入 hk-dividend-events-v4:<symbol>；按 eventId ?? exDate 去重，金额冲突拒绝写入。 */
export async function writeHkDividendEvents(store: MarketStore, input: { symbol: string; rows: HkDividendEventRow[] }, now = Date.now()) {
  const { symbol } = hkSecurity(input.symbol);
  if (!Array.isArray(input.rows) || !input.rows.length) throw Error('港股分红事件为空');
  const cutoff = marketCutoff(now), today = chinaDate(now);
  const seen = new Set<string>();
  const incoming: HkDividendRecord[] = input.rows.map(r => {
    if (!isoDate(r.exDate) || r.exDate > today || r.exDate < cutoff) throw Error(`港股分红除息日无效或超出保留期: ${r.exDate}`);
    if (r.noticeDate !== undefined && r.noticeDate !== '' && !isoDate(r.noticeDate)) throw Error('港股分红公告日期无效');
    if (r.dps !== null && (typeof r.dps !== 'number' || !Number.isFinite(r.dps) || r.dps < 0)) throw Error('港股每股分红无效');
    if (typeof r.period !== 'string') throw Error('港股分红报告期无效');
    if (typeof r.special !== 'boolean') throw Error('港股分红特别息标记必须为布尔');
    if (r.kind !== undefined && !DIVIDEND_KINDS.has(r.kind)) throw Error('港股分红类型无效');
    const id = dividendIdentity({ ...r, noticeDate: r.noticeDate ?? '', kind: r.kind as HkDividendKind | undefined });
    if (seen.has(id)) throw Error(`港股分红事件重复: ${id}`);
    seen.add(id);
    return {
      exDate: r.exDate, noticeDate: r.noticeDate ?? '', dps: r.dps ?? null, period: r.period, special: r.special,
      ...(r.fiscalYear !== undefined ? { fiscalYear: r.fiscalYear } : {}),
      ...(r.kind !== undefined ? { kind: r.kind as HkDividendKind } : {}),
      ...(r.eventId !== undefined ? { eventId: String(r.eventId) } : {}),
    };
  });
  const key = `hk-dividend-events-v4:${symbol}`;
  const old = await store.read<HkDividendRecord[]>(key);
  const payload = mergeHkDividendEvents(old?.payload ?? [], incoming, true);
  const record = marketRecord(key, 'hk-recent-dividend-events', 'import:HKD-confirmed-DPS:tax-before:recent-100-events', payload, 1800e3, now);
  if (old && old.digest === record.digest) return { symbol, count: payload.length, skipped: true };
  if (!await store.write(record, old?.digest ?? null)) throw Error('港股分红写入版本冲突，请重试');
  return { symbol, count: payload.length };
}
