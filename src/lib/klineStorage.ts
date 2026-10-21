import type { Candle, KLineSeries, Period, Adjust } from './datasource/types';
import { getMarketStore, marketDigest, marketRecord, type MarketStore, type MarketRecord } from './marketStore';
import { marketCutoff, retainMarketPayload } from './marketRetention';
import { withMarketRefresh } from './marketRefresh';

export interface KLineRequest { symbol: string; period: Period; adjust: Adjust; count: number; start?: string; recentOnly?: boolean }
export type KLineFetcher = (request: KLineRequest & { end?: string }) => Promise<KLineSeries>;
interface Query { start?: string; count: number; at: number; complete: boolean }
interface StoredSeries extends KLineSeries { queries: Query[]; lastFullAt?: number }
const day = (now: number) => new Date(now + 8 * 3600e3).toISOString().slice(0, 10);
const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const keyOf = (r: KLineRequest, source: string) => `kline:v2:${r.symbol}:${r.period}:${r.adjust}:${source}:prices-only`;
const same = (a: Candle, b: Candle) => ['open', 'close', 'high', 'low'].every(k => a[k as keyof Candle] === b[k as keyof Candle]);
export function validateKLine(series: KLineSeries, request: KLineRequest, now = Date.now()): void {
  if (series.symbol !== request.symbol || series.code !== request.symbol.slice(2) || series.period !== request.period || series.adjust !== request.adjust)
    throw Error('K线证券身份、周期或复权方式不匹配');
  if (!series.candles.length || !series.source) throw Error('K线为空或缺少来源');
  let previous = '';
  for (const c of series.candles) {
    if (!validDate(c.date) || c.date > day(now) || c.date <= previous ||
        ![c.open, c.close, c.high, c.low].every(Number.isFinite) ||
        c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close) || c.high < c.low ||
        (request.adjust === 'none' && c.low <= 0)) throw Error('K线日期、价格或成交量校验失败');
    previous = c.date;
  }
}
function take(series: KLineSeries, request: KLineRequest): KLineSeries {
  const { queries: _queries, ...result } = series as StoredSeries;
  return { ...result, candles: series.candles.filter(c => !request.start || c.date >= request.start).slice(-request.count) };
}
function ttl(request: KLineRequest) { return request.adjust === 'none' ? 60_000 : 60_000; }
const active = new Map<string, Promise<KLineSeries>>();

/** Canonical source-specific series, independent of page count/range and user identity. */
export async function storedKLine(request: KLineRequest, fetcher: KLineFetcher,
  store: MarketStore | null = getMarketStore(), now = Date.now()): Promise<KLineSeries> {
  if (request.start && request.start < marketCutoff(now)) request = { ...request,start:marketCutoff(now) };
  if (!store) {
    const value = retainMarketPayload('kline',await fetcher(request),now); validateKLine(value, request, now); return value;
  }
  const lock = `${request.symbol}:${request.period}:${request.adjust}:${request.start}:${request.count}:${!!request.recentOnly}`;
  const pending = active.get(lock); if (pending) return pending;
  const work: Promise<KLineSeries> = withMarketRefresh(store,`kline:${request.symbol}:${request.period}:${request.adjust}`,async (): Promise<KLineSeries> => {
    const old: MarketRecord<StoredSeries>[] = [];
    let storageFailed = false;
    for (const source of ['tencent', 'sina']) {
      try {
        const row = await store.read<StoredSeries>(keyOf(request, source));
        if (row) { row.payload=retainMarketPayload('kline',row.payload,now); if(row.payload.candles.length){validateKLine(row.payload, request, now); old.push(row);} }
      } catch { storageFailed = true; }
    }
    const saved = old[0];
    const reusable = old.find(row => {
      if (!request.recentOnly && now - (row.payload.lastFullAt ?? 0) >= 7 * 864e5) return false;
      const matches = take(row.payload, request).candles;
      const rangeCovered = matches.length >= request.count || !!request.start && row.payload.candles[0].date <= request.start;
      const lastQuery = row.payload.queries.find(q => q.start === request.start && q.count >= request.count);
      return Date.parse(row.refreshAfter) > now && (rangeCovered || !!lastQuery && now - lastQuery.at < 60_000);
    });
    if (reusable) return { ...take(reusable.payload, request), storage: { backend: 'persistent', acquiredAt: reusable.acquiredAt, validation: 'structural' } };
    const incident = async (reason: string, details?: unknown) => {
      try { await store.incident(keyOf(request, saved?.source ?? 'tencent'), reason, details); } catch { storageFailed = true; }
    };
    try {
      // Adjusted series refresh coherently: never patch only their last few bars.
      let query: KLineRequest & { end?: string } = { ...request };
      const historicalReviewDue = !!saved && !request.recentOnly && now - (saved.payload.lastFullAt ?? 0) >= 7 * 864e5;
      if (saved && request.adjust === 'none' && !request.recentOnly) {
        const bars = saved.payload.candles;
        const needOlder = !!request.start && request.start < bars[0].date || !request.start && request.count > bars.length;
        if (historicalReviewDue) {
          const elapsed = Math.max(0, Math.ceil((now - Date.parse(bars.at(-1)!.date)) / 864e5));
          const extra = request.period === 'week' ? Math.ceil(elapsed / 7) : request.period === 'month' ? Math.ceil(elapsed / 28) : elapsed;
          query = { ...request, start: request.start && request.start < bars[0].date ? request.start : bars[0].date,
            count: Math.min(3200, Math.max(request.count, bars.length + extra + 16)) };
        } else if (needOlder) {
          query = { ...request, end: new Date(Date.parse(bars[0].date) - 864e5).toISOString().slice(0, 10), count: Math.max(16, request.count - bars.length) };
          // Also refresh the recent tail; both segments must succeed before committing.
        } else {
          const overlap = bars[Math.max(0, bars.length - 8)].date;
          const gap = Math.max(0, Math.ceil((now - Date.parse(bars[bars.length - 1].date)) / 864e5));
          query = { ...request, start: overlap, count: request.period === 'day' ? Math.max(16, gap + 10) : 16 };
        }
      } else if (saved && request.adjust !== 'none') {
        query = { ...request, start: request.start && request.start < saved.payload.candles[0].date ? request.start : saved.payload.candles[0].date,
          count: Math.max(request.count, saved.payload.candles.length + 16) };
      }
      let fetched = await fetcher(query); validateKLine(fetched, request, now);
      if (query.end && fetched.candles.some(c => c.date > query.end!)) throw Error('来源未遵守历史补抓截止日期');
      if (saved && query.end) {
        const gapDays = Math.max(0, Math.ceil((now - Date.parse(saved.payload.candles.at(-1)!.date)) / 864e5));
        const tail = await fetcher({ ...request, start: saved.payload.candles[Math.max(0, saved.payload.candles.length - 8)].date, count: Math.max(16, gapDays + 10) });
        validateKLine(tail, request, now);
        if (tail.source !== fetched.source) throw Error('补抓区间来源不一致，未合并');
        fetched = { ...fetched, complete: fetched.complete !== false && tail.complete !== false,
          candles: [...new Map([...fetched.candles, ...tail.candles].map(c => [c.date, c])).values()].sort((a, b) => a.date.localeCompare(b.date)) };
      }
      if (fetched.stale) return { ...fetched, warnings: [...(fetched.warnings ?? []), '来源为历史快照，未作为最新数据入库。'] };
      const key = keyOf(request, fetched.source);
      const matching = old.find(r => r.source === fetched.source);
      let candles = fetched.candles;
      let revision = false;
      if (matching) {
        const prior = matching.payload.candles;
        const byDate = new Map(prior.map(c => [c.date, c]));
        const changed = candles.filter(c => byDate.has(c.date) && !same(c, byDate.get(c.date)!));
        const protectedBefore = prior[Math.max(0, prior.length - 8)].date;
        if (request.adjust === 'none' && changed.some(c => c.date < protectedBefore)) {
          await incident('historical_unadjusted_conflict', { dates: changed.map(c => c.date), candidateDigest: marketDigest(fetched) });
          throw Error('历史不复权价格存在差异，保留原数据，等待复核');
        }
        if (request.adjust === 'none') candles = [...new Map([...prior, ...candles].map(c => [c.date, c])).values()].sort((a, b) => a.date.localeCompare(b.date));
        else {
          if (candles[0].date > prior[0].date || candles.at(-1)!.date < prior.at(-1)!.date || fetched.complete === false)
            throw Error('复权历史刷新不完整，未混接新旧版本');
          revision = changed.length > 0;
        }
      }
      const cutoff = new Date(now + 8 * 3600e3); cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 10);
      candles = candles.filter(c => c.date >= cutoff.toISOString().slice(0, 10));
      const series: StoredSeries = { ...fetched, candles: candles.filter(c=>c.date>=marketCutoff(now)).map(({date, open, high, low, close}) => ({date, open, high, low, close})),
        lastFullAt: !matching || historicalReviewDue && fetched.complete !== false && fetched.candles[0].date <= matching.payload.candles[0].date
          ? now : matching.payload.lastFullAt,
        queries: [...(matching?.payload.queries ?? []).slice(-15), { start: request.start, count: request.count, at: now, complete: fetched.complete !== false }] };
      validateKLine(series, request, now);
      let written = false;
      try { written = await store.write(marketRecord(key, 'kline', fetched.source, series, ttl(request), now), matching?.digest ?? null); }
      catch { storageFailed = true; }
      const result = take(series, request);
      return { ...result, warnings: [...(result.warnings ?? []), ...(revision ? ['复权序列已整体更新，旧版本保留供追溯。'] : []),
        ...(storageFailed || !written ? ['本次数据已取得，但未确认持久化成功。'] : [])],
        storage: { backend: written ? 'persistent' : 'upstream', acquiredAt: new Date(now).toISOString(), validation: 'structural' } };
    } catch (e) {
      await incident('refresh_failed', { message: e instanceof Error ? e.message : String(e) });
      if (saved) return { ...take(saved.payload, request), stale: true, warnings: ['更新或校验失败，当前使用上次存储的数据；请留意实际覆盖日期。'],
        storage: { backend: 'persistent', acquiredAt: saved.acquiredAt, validation: 'structural' } };
      throw e;
    }
  });
  active.set(lock, work);
  try { return await work; } finally { if (active.get(lock) === work) active.delete(lock); }
}
