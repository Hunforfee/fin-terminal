/** Persist source inputs, not derived PE/PB/yields. Expired inputs never silently become current. */
import { getMarketStore, marketRecord, type MarketStore } from './marketStore';
import { cached } from './datasource/cache';
import { withMarketRefresh } from './marketRefresh';
import { retainMarketPayload } from './marketRetention';

export function cachedMarketInput<T>(key: string, kind: string, source: string, ttl: number,
  producer: () => Promise<T>, validate: (value: T) => void): Promise<T> {
  const store = getMarketStore();
  // The persistent record owns freshness. A second full TTL on a nearly expired
  // record would hide later writes and extend its effective lifetime.
  if (store) return storedMarketInput(key, kind, source, ttl, producer, validate, store);
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
export async function storedMarketInput<T>(key: string, kind: string, source: string, ttl: number,
  producer: () => Promise<T>, validate: (value: T) => void,
  store: MarketStore | null = getMarketStore(), now = Date.now()): Promise<T> {
  const owner = store ?? withoutStore;
  let pending = pendingInputs.get(owner);
  if (!pending) { pending = new Map(); pendingInputs.set(owner, pending); }
  const identity = JSON.stringify([key, kind, source, ttl]);
  const existing = pending.get(identity);
  if (existing) { const value = await existing as T; validate(value); return value; }
  const work = (async()=>{
    if (store) {
      const row = await store.read(key).catch(()=>null);
      if (row && Date.parse(row.refreshAfter)>now) {
        try { const value=retainMarketPayload(kind,decode<T>(row.payload),now);validate(value);return value; } catch {}
      }
    }
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
      if (old && Date.parse(old.refreshAfter) > now) {
        const value = retainMarketPayload(kind, decode<T>(old.payload),now); validate(value); return value;
      }
    } catch { /* Store outage must not prevent source access. */ }
  }
  let value: T;
  try {
    value = retainMarketPayload(kind, await producer(),now); validate(value);
    if (old) {
      const prior = retainMarketPayload(kind,decode<any>(old.payload),now), next = value as any;
      if (Array.isArray(prior) && Array.isArray(next) && prior.length && prior.every(r => r && typeof r.date === 'string')) {
        const dates = new Set(next.map(r => r.date));
        if (prior.some(r => !dates.has(r.date))) throw Error('历史来源记录减少，未确认完整性，暂不替换');
        if (kind === 'financial-history') {
          const byDate = new Map(next.map(r => [r.date, r]));
          for (const row of prior) for (const field of ['npParent', 'equityParent', 'sharesYi'])
            if (typeof row[field] === 'number' && (byDate.get(row.date) as any)?.[field] == null)
              throw Error('已有财报金额变为缺失，暂不替换');
        }
      }
      if (prior instanceof Map && next instanceof Map && [...prior.keys()].some(k => !next.has(k)))
        throw Error('原始公告日期覆盖减少，暂不替换');
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
