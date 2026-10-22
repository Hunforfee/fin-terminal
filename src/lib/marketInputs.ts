/** Persist source inputs, not derived PE/PB/yields. Expired inputs never silently become current. */
import { getMarketStore, marketRecord, type MarketStore, type MarketRecord } from './marketStore';
import { cached } from './datasource/cache';
import { withMarketRefresh } from './marketRefresh';
import { retainMarketPayload } from './marketRetention';
import { databaseOnly, marketDataMissing } from './marketReadPolicy';

export function cachedMarketInput<T>(key: string, kind: string, source: string, ttl: number,
  producer: () => Promise<T>, validate: (value: T) => void): Promise<T> {
  const store = getMarketStore();
  // The persistent record owns freshness. A second full TTL on a nearly expired
  // record would hide later writes and extend its effective lifetime.
  if (store || databaseOnly()) return storedMarketInput(key, kind, source, ttl, producer, validate, store);
  return cached(`market-input:${key}`, ttl, () => storedMarketInput(key, kind, source, ttl, producer, validate, null));
}

const withoutStore = {};
const pendingInputs = new WeakMap<object, Map<string, Promise<unknown>>>();

const wire = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_key, value) => {
  if (value instanceof Map) return { $marketMap: [...value.entries()] };
  if (typeof value === 'number' && !Number.isFinite(value)) throw Error('来源含非有限数值');
  return value;
}));
const decode = <T>(v: unknown): T => JSON.parse(JSON.stringify(v), (_key, value) =>
  value && typeof value === 'object' && Array.isArray(value.$marketMap) ? new Map(value.$marketMap) : value);

async function availableInput(store: MarketStore, key: string, kind: string, now: number): Promise<MarketRecord | null> {
  const primary = await store.read(key);
  if (primary) return primary;
  const match = /^(statements-v3|disclosures-v3):(\d{6}):(\d+)$/.exec(key);
  if (!match || kind !== (match[1] === 'statements-v3' ? 'financial-history' : 'disclosure-dates')) return null;
  const span = Number(match[3]);
  if (!Number.isInteger(span) || span < 2 || span >= 12) return null;
  const broader = Array.from({ length: 12 - span }, (_, i) => `${match[1]}:${match[2]}:${span + i + 1}`);
  const records = store.readInputs ? await store.readInputs(broader) : await Promise.all(broader.map(k => store.read(k)));
  // Reuse the actual record and its freshness; do not duplicate its payload or
  // manufacture a new acquisition time just because the display range changed.
  return records.filter((r): r is MarketRecord => !!r && broader.includes(r.key) && r.kind === kind
      && (databaseOnly() || Date.parse(r.refreshAfter) > now))
    .sort((a, b) => Number(b.key.split(':').at(-1)) - Number(a.key.split(':').at(-1)))[0] ?? null;
}

// Source pages are a date x field matrix. A shorter reply must not erase fields
// supplied by an import, and a missing cell is not evidence that its value is zero.
function mergeSourcePage(prior: any, next: any): any {
  const unit = (v: unknown) => ['wan', '万元', '人民币万元'].includes(String(v)) ? 'wan' : v;
  if (prior.unit && next.unit && unit(prior.unit) !== unit(next.unit)) throw Error('财报来源单位发生变化，未混合历史金额');
  const dates = [...new Set<string>([...prior.dates, ...next.dates])].sort().reverse();
  const oldIndex = new Map<string, number>(prior.dates.map((d: string, i: number) => [d, i]));
  const newIndex = new Map<string, number>(next.dates.map((d: string, i: number) => [d, i]));
  const incoming = new Map<string, any>(next.rows.filter((r: any) => r.kind === 'field').map((r: any) => [r.name, r]));
  const template = [...prior.rows];
  for (const row of next.rows) if (!template.some(r => r.kind === row.kind && r.name === row.name)) template.push(row);
  const populated = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== ''
    && Number.isFinite(Number(String(v).replaceAll(',', '')));
  const rows = template.map(row => row.kind !== 'field' ? row : { ...row, vals: dates.map(d => {
    const oi = oldIndex.get(d), ni = newIndex.get(d);
    const value = ni === undefined ? null : incoming.get(row.name)?.vals[ni];
    return populated(value) ? value : oi === undefined ? '--' : row.vals[oi] ?? '--';
  }) });
  return { ...prior, ...next, dates, rows, ...(prior.announceDates || next.announceDates ? {
    announceDates: dates.map(d => {
      const oi = oldIndex.get(d), ni = newIndex.get(d);
      return (ni === undefined ? null : next.announceDates?.[ni]) ?? (oi === undefined ? null : prior.announceDates?.[oi]) ?? null;
    }),
  } : {}) };
}
export async function storedMarketInput<T>(key: string, kind: string, source: string, ttl: number,
  producer: () => Promise<T>, validate: (value: T) => void,
  store: MarketStore | null = getMarketStore(), now = Date.now()): Promise<T> {
  const owner = store ?? withoutStore;
  let pending = pendingInputs.get(owner);
  if (!pending) { pending = new Map(); pendingInputs.set(owner, pending); }
  const identity = JSON.stringify([key, kind, source, ttl, databaseOnly()]);
  const existing = pending.get(identity);
  if (existing) { const value = await existing as T; validate(value); return value; }
  const work = (async()=>{
    if (store) {
      const row = await availableInput(store, key, kind, now).catch(error => {
        if (databaseOnly()) throw Error(`数据库读取或校验失败：${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      if (row && (Date.parse(row.refreshAfter)>now || databaseOnly())) {
        try { const value=retainMarketPayload(kind,decode<T>(row.payload),now);validate(value);return value; }
        catch (error) { if (databaseOnly()) throw Error(`数据库输入未通过校验：${error instanceof Error ? error.message : String(error)}`); }
      }
    }
    if (databaseOnly()) throw marketDataMissing('财务或分红输入');
    return withMarketRefresh(store, key, () => readOrFetchInput(key, kind, source, ttl, producer, validate, store, now));
  })()
    .finally(() => pending!.delete(identity));
  pending.set(identity, work);
  return work;
}
async function readOrFetchInput<T>(key: string, kind: string, source: string, ttl: number,
  producer: () => Promise<T>, validate: (value: T) => void,
  store: MarketStore | null, now: number): Promise<T> {
  let old;
  if (store) {
    try {
      old = await store.read(key);
      if (old && (Date.parse(old.refreshAfter) > now || databaseOnly())) {
        const value = retainMarketPayload(kind, decode<T>(old.payload),now); validate(value); return value;
      }
    } catch { /* Store outage must not prevent source access. */ }
  }
  if (databaseOnly()) throw marketDataMissing('财务或分红输入');
  let value: T;
  try {
    value = retainMarketPayload(kind, await producer(),now); validate(value);
    if (old) {
      const prior = retainMarketPayload(kind,decode<any>(old.payload),now), next = value as any;
      if (Array.isArray(prior) && Array.isArray(next) && prior.length && prior.every(r => r && typeof r.date === 'string')) {
        const byDate = new Map<any, any>(next.map(r => [r.date, r]));
        // An upstream response may legitimately cover fewer report dates than the
        // database (imported histories are often more complete, and providers
        // paginate or rate-limit). Dropping verified local history would destroy
        // data, so keep every known date and only let upstream add or refresh.
        const shrunk = prior.filter(r => !byDate.has(r.date));
        if (shrunk.length) {
          try { await store?.incident(key, 'source_history_shrank', { missingDates: shrunk.map(r => r.date), kept: shrunk.length }); } catch {}
          for (const row of prior) if (!byDate.has(row.date)) byDate.set(row.date, row);
          value = [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date))) as T;
        }
        if (kind === 'financial-history') {
          let repaired = false;
          for (const row of prior) {
            const target = byDate.get(row.date);
            if (!target) continue;
            for (const field of ['npParent', 'npTotal', 'equityParent', 'equityTotal', 'equityCommon', 'sharesYi'])
              if (typeof row[field] === 'number' && (target as any)[field] == null) { (target as any)[field] = row[field]; repaired = true; }
          }
          if (repaired) try { await store?.incident(key, 'source_amounts_partial', { key, keptFrom: 'local' }); } catch {}
        }
      }
      // Same rule for disclosure maps: a thinner upstream reply must not erase
      // publication dates that are already verified and stored.
      if (kind === 'source-sina-page') value = mergeSourcePage(prior, next);
      if (prior instanceof Map && next instanceof Map) {
        const missing = [...prior.keys()].filter(k => !next.has(k));
        for (const k of missing) next.set(k, prior.get(k));
        if (missing.length) try { await store?.incident(key, 'disclosure_coverage_shrank', { kept: missing.length }); } catch {}
      }
      // 港股分红按 eventId ?? exDate 合并：上游「已确认无派息」或更薄的回复
      // 不得擦除已入库的派息历史（该 kind 用 exDate 而非 date，不适用上面的按日期合并）。
      if (kind === 'hk-recent-dividend-events' && Array.isArray(prior) && Array.isArray(next) && prior.length) {
        const id = (r: any) => String(r.eventId ?? r.exDate);
        const kept = new Map<any, any>(prior.map((r: any) => [id(r), r]));
        for (const r of next) kept.set(id(r), r);
        value = [...kept.values()].sort((a: any, b: any) => String(a.exDate).localeCompare(String(b.exDate))) as T;
        const missing = prior.filter((r: any) => !next.some((n: any) => id(n) === id(r)));
        if (missing.length) try { await store?.incident(key, 'source_history_shrank', { missingEvents: missing.map(id), kept: prior.length }); } catch {}
      }
      validate(value);
    }
  }
  catch (e) {
    try { await store?.incident(key, 'source_input_failed', { message: e instanceof Error ? e.message : String(e) }); } catch {}
    // Intentionally no stale fallback: callers must not combine expired inputs
    // with current prices and publish an apparently current valuation.
    if (kind === 'financial-history') throw Error(`财报数据不可用：${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
  if (store) {
    try { await store.write(marketRecord(key, kind, source, wire(value), ttl, now), old?.digest ?? null); }
    catch { /* Valid current source values remain usable if writing fails. */ }
  }
  return value;
}

export function validateDatedRows(rows: readonly Record<string, unknown>[], dateKey: string,
  required: string[] = [], allowFuture = false): void {
  if (!Array.isArray(rows) || !rows.length) throw Error('缺少有效来源记录');
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const seen = new Set<string>();
  let populated = false;
  for (const row of rows) {
    const d = row[dateKey];
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d) ||
        new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) !== d || (!allowFuture && d > today) || seen.has(d))
      throw Error('来源日期无效、重复或晚于当前日期');
    seen.add(d);
    populated ||= required.length === 0 || required.some(k => typeof row[k] === 'number' && Number.isFinite(row[k]));
  }
  if (!populated) throw Error('来源关键字段全部缺失');
}
