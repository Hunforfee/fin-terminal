import { HISTORY_YEARS } from './marketHistoryPlan';
import { marketDigest, marketRecord, type MarketRecord, type MarketStore } from './marketStore';
import { normalizeStockCode } from './datasource/codes';
import { INDICATORS, type IndicatorDef } from './datasource/financeIndicators';
import { marketCutoff } from './marketRetention';

/**
 * A 股维护端导入写入器（披露日期 / 年度财务指标）。
 *
 * 写入与现有读取器完全相同的键位与 payload 结构：
 * - 披露日期：disclosures-v3:<代码>:<范围>（payload Map<报告期, 实际披露日>）
 * - 年度指标：source-sina-indicators:v1:<代码>:<年份>（payload {dates, rows:Map<新浪指标名, (string|null)[]>}）
 *
 * 合并哲学与港股导入一致：空值不覆盖有效值；已存在且不一致的值按项记冲突返回明细、
 * 不直接覆盖；版本冲突检查走 digest CAS；幂等（相同值重复导入 skipped）。
 */

const isoDate = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  Number.isFinite(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const chinaDate = (now: number) => new Date(now + 8 * 3600e3).toISOString().slice(0, 10);

interface Item { [k: string]: unknown }

/** 读出已入库 payload 并把（可选嵌套字段下的）$marketMap 还原为 Map；无记录返回 null。 */
async function readStored(store: MarketStore, key: string, field?: string): Promise<{ row: MarketRecord<Record<string, unknown>> | null; map: Map<string, unknown> } | null> {
  const row = await store.read<Record<string, unknown>>(key).catch(() => null);
  if (!row) return null;
  const container = (field ? row.payload?.[field] : row.payload) as { $marketMap?: [string, unknown][] } | undefined;
  const map = container instanceof Map ? container : container?.$marketMap ? new Map(container.$marketMap) : new Map();
  return { row, map };
}

/** 公共收尾：对合并所依据的版本进行 CAS 写入，冲突交由调用方重新读取合并。 */
async function casWrite(store: MarketStore, key: string, kind: string, source: string, payload: Record<string, unknown>, ttl: number, now: number, expected: string | null): Promise<string> {
  // CAS must compare the version used to build payload. Re-reading only the digest
  // would authorize a stale payload to erase another importer/worker's new cells.
  const record = marketRecord(key, kind, source, payload, ttl, now);
  if (await store.write(record, expected)) return record.digest;
  throw Error('版本冲突：写入期间记录被并发修改，请重试');
}

/** 保留窗口过滤（与 retainMarketPayload 的 buffered 口径一致），超窗项进 missing。 */
function retentionCutoff(now: number): string {
  const boundary = new Date(marketCutoff(now) + 'T00:00:00Z');
  boundary.setUTCFullYear(boundary.getUTCFullYear() - 2);
  return boundary.toISOString().slice(0, 10);
}

/* ------------------------------------------------ 披露日期 disclosures-v3 */

export interface DisclosureImportResult {
  key: string; saved: number; skipped: boolean; savedPeriods: string[];
  conflicts: { report: string; stored: string; incoming: string; basis?: string }[];
  missing: { report: string; reason: string }[];
  digest: string;
}

/** 导入实际披露日期：排除预约日期（披露日必须晚于报告期）与未来日期；冲突返回明细不覆盖。 */
export async function importDisclosureDates(store: MarketStore, input: { symbol?: unknown; code?: unknown; years?: unknown; items?: unknown; basis?: unknown }, now = Date.now()): Promise<DisclosureImportResult> {
  const n = normalizeStockCode(String(input.symbol ?? input.code ?? ''));
  if (!n || n.market === 'HK') throw Error('披露日期导入仅支持 A 股代码（如 sh600519 / 600519）');
  const spanRaw = Number(input.years ?? HISTORY_YEARS+2);
  if (!Number.isInteger(spanRaw) || spanRaw < 2 || spanRaw > 20) throw Error('years 必须是 2–20 的整数（键中的报告期范围，缺省 14，与十二年估值公告读取器一致）');
  const key = `disclosures-v3:${n.code}:${spanRaw}`;
  const items = Array.isArray(input.items) ? input.items as Item[] : [];
  if (!items.length) throw Error('items 为空：每项 {date: 报告期, published: 实际披露日}，可附 basis 来源依据');
  const today = chinaDate(now), cutoff = retentionCutoff(now);
  const basis = typeof input.basis === 'string' ? input.basis : undefined;

  const stored = await readStored(store, key);
  const merged = stored?.map ?? new Map<string, string>();
  const conflicts: DisclosureImportResult['conflicts'] = [];
  const missing: DisclosureImportResult['missing'] = [];
  const savedPeriods: string[] = [];
  let changed = false;

  for (const it of items) {
    const report = it?.date, published = it?.published;
    if (!isoDate(report)) { missing.push({ report: String(report ?? ''), reason: '报告期日期无效' }); continue; }
    if (!isoDate(published)) { missing.push({ report, reason: '披露日期无效' }); continue; }
    if (published > today) { missing.push({ report, reason: `披露日期晚于今天（${published}），排除未来日期` }); continue; }
    if (published <= report) { missing.push({ report, reason: `披露日期 ${published} 未晚于报告期 ${report}，疑似预约披露日期，已排除` }); continue; }
    if (published < cutoff) { missing.push({ report, reason: `超出保留窗口（早于 ${cutoff}）` }); continue; }
    const itemBasis = typeof it.basis === 'string' && it.basis.trim() ? it.basis.trim() : basis;
    const prev = merged.get(report);
    if (typeof prev === 'string' && prev !== published) {
      conflicts.push({ report, stored: prev, incoming: published, ...(itemBasis ? { basis: itemBasis } : {}) });
      continue;
    }
    if (prev === published) { savedPeriods.push(report); continue; }
    merged.set(report, published);
    savedPeriods.push(report);
    changed = true;
  }
  if (!changed) {
    return { key, saved: 0, skipped: true, savedPeriods: [...new Set(savedPeriods)].sort(), conflicts, missing,
      digest: stored?.row?.digest ?? marketDigest(Object.fromEntries(merged)) };
  }
  const digest = await casWrite(store, key, 'disclosure-dates', `import:actual-disclosure${basis ? ':' + basis.slice(0, 60) : ''}`,
    { $marketMap: [...merged.entries()].sort(([a], [b]) => b.localeCompare(a)) }, 1800e3, now, stored?.row?.digest ?? null);
  return { key, saved: savedPeriods.length, skipped: false, savedPeriods: [...new Set(savedPeriods)].sort(), conflicts, missing, digest };
}

/* --------------------------------------- 年度财务指标 source-sina-indicators */

const indicatorByName = new Map<string, IndicatorDef>(INDICATORS.map((d) => [d.sina, d]));
const numEq = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(a) * 1e-9);

export interface IndicatorImportResult {
  key: string; saved: number; skipped: boolean; savedPeriods: string[];
  indicators: string[];
  conflicts: { date: string; indicator: string; stored: string | null; incoming: number }[];
  missing: { date: string; indicator?: string; reason: string }[];
  digest: string;
}

/**
 * 导入 A 股年度财务指标：指标名必须来自现有指标定义（新浪口径名，含单位，
 * 防止混用不同 ROE 口径——不同口径在目录中是不同指标名）；按指标 × 报告期合并，
 * 空值不覆盖有效值，冲突返回明细不覆盖。
 */
export async function importAIndicators(store: MarketStore, input: { symbol?: unknown; code?: unknown; year?: unknown; items?: unknown; basis?: unknown }, now = Date.now()): Promise<IndicatorImportResult> {
  const n = normalizeStockCode(String(input.symbol ?? input.code ?? ''));
  if (!n || n.market === 'HK') throw Error('年度指标导入仅支持 A 股代码（如 sh600519 / 600519）');
  const year = Number(input.year);
  const thisYear = new Date(now).getUTCFullYear();
  if (!Number.isInteger(year) || year < 1998 || year > thisYear) throw Error(`year 必须是 1998–${thisYear} 的整数`);
  const key = `source-sina-indicators:v1:${n.code}:${year}`;
  const items = Array.isArray(input.items) ? input.items as Item[] : [];
  if (!items.length) throw Error('items 为空：每项 {date: 报告期, indicator: 指标名(新浪口径), value: 数值}，可附 basis');
  const today = chinaDate(now), cutoff = retentionCutoff(now);
  const basis = typeof input.basis === 'string' ? input.basis : undefined;

  const stored = await readStored(store, key, 'rows');
  // 归一化为 name → date → 原始值，避免依赖已有 dates 与行 vals 的顺序耦合
  const storedDates: string[] = Array.isArray((stored?.row?.payload as { dates?: unknown })?.dates)
    ? ((stored!.row!.payload as { dates: string[] }).dates.filter(isoDate)) : [];
  const cells = new Map<string, Map<string, string | null>>();
  for (const [name, vals] of stored?.map ?? []) {
    if (!Array.isArray(vals)) continue;
    const byDate = new Map<string, string | null>();
    storedDates.forEach((d, i) => byDate.set(d, vals[i] ?? null));
    cells.set(String(name), byDate);
  }
  const dateSet = new Set<string>(storedDates);

  const conflicts: IndicatorImportResult['conflicts'] = [];
  const missing: IndicatorImportResult['missing'] = [];
  const savedIndicators = new Set<string>();
  const savedPeriods = new Set<string>();
  let changed = false;

  for (const it of items) {
    const date = it?.date, name = typeof it?.indicator === 'string' ? it.indicator.trim() : '', value = it?.value;
    const def = indicatorByName.get(name);
    if (!def) {
      missing.push({ date: String(date ?? ''), indicator: name, reason: `未知指标名（必须使用现有定义的新浪口径名，如「净资产收益率(%)」；可用指标 ${INDICATORS.length} 个）` });
      continue;
    }
    if (!isoDate(date)) { missing.push({ date: String(date ?? ''), indicator: name, reason: '报告期日期无效' }); continue; }
    if (date.slice(0, 4) !== String(year)) { missing.push({ date, indicator: name, reason: `报告期不属于 ${year} 年` }); continue; }
    if (date > today) { missing.push({ date, indicator: name, reason: '报告期晚于今天，排除未来日期' }); continue; }
    if (date < cutoff) { missing.push({ date, indicator: name, reason: `超出保留窗口（早于 ${cutoff}）` }); continue; }
    if (typeof value !== 'number' || !Number.isFinite(value)) { missing.push({ date, indicator: name, reason: 'value 必须是有限数值（空值请勿上报，导入不会用空值覆盖有效值）' }); continue; }
    let byDate = cells.get(name);
    if (!byDate) { byDate = new Map(); cells.set(name, byDate); changed = true; }
    const raw = byDate.has(date) ? byDate.get(date)! : null;
    const prevNum = raw != null && raw !== '--' && raw !== '' ? Number(String(raw).replace(/,/g, '')) : null;
    if (prevNum != null && Number.isFinite(prevNum)) {
      if (numEq(prevNum, value)) { savedIndicators.add(name); savedPeriods.add(date); continue; }
      conflicts.push({ date, indicator: name, stored: String(raw), incoming: value });
      continue;
    }
    if (!dateSet.has(date)) { dateSet.add(date); changed = true; }
    byDate.set(date, String(value));
    savedIndicators.add(name); savedPeriods.add(date);
    changed = true;
  }
  const payloadDates = [...dateSet].sort((a, b) => b.localeCompare(a));
  if (!changed) {
    return { key, saved: 0, skipped: true, savedPeriods: [...savedPeriods].sort(), indicators: [...savedIndicators].sort(),
      conflicts, missing, digest: stored?.row?.digest ?? marketDigest({}) };
  }
  const digest = await casWrite(store, key, 'source-sina-indicators', `import:maintain-indicators${basis ? ':' + basis.slice(0, 60) : ''}`,
    { dates: payloadDates, rows: { $marketMap: [...cells.entries()].map(([name, byDate]) => [name, payloadDates.map((d) => byDate.get(d) ?? null)]) } }, 1800e3, now, stored?.row?.digest ?? null);
  return { key, saved: savedIndicators.size, skipped: false, savedPeriods: [...savedPeriods].sort(), indicators: [...savedIndicators].sort(),
    conflicts, missing, digest };
}
