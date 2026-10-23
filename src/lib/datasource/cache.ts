import { isShanghaiTradingTime, isHongKongTradingTime } from './tradingTime';
import { databaseOnly } from '../marketReadPolicy';
import { annotateMarketValue, observeMarketValue, savedMarketValue } from '../marketReadStatus';
/**
 * 进程内 TTL 缓存。
 * 行情类接口上游有频率限制，且同一页面多个组件会重复请求同一标的，
 * 因此统一在 Provider 之上加一层短 TTL 缓存。
 */

interface Entry<T> {
  value: T;
  expireAt: number;
  storedAt: number;
}

const store = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
const MAX_ENTRIES = 1024;
function remember<T>(key: string, value: T, ttlMs: number): void {
  store.delete(key);
  store.set(key, { value, expireAt: Date.now() + ttlMs, storedAt: Date.now() });
  while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value!);
}

/** 默认 TTL：交易时段 15s，非交易时段 10 分钟（收盘后数据不再变化） */
export function defaultTtl(market: 'A' | 'HK' = 'A', date?: Date): number {
  const trading = market === 'HK'
    ? isHongKongTradingTime(date)
    : isShanghaiTradingTime(date);
  return trading ? 15_000 : 600_000;
}

export async function cached<T>(key: string, ttlMs: number, producer: () => Promise<T>, options: { staleOnError?: boolean } = {}): Promise<T> {
  if(databaseOnly())key=`database:${key}`;
  if(options.staleOnError===false)key=`fresh:${key}`;
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expireAt > now) {
    store.delete(key); store.set(key, hit);
    return observeMarketValue(hit.value as T);
  }

  // 防止并发击穿：同一 key 的并发请求共享一个 Promise
  const pending = inflight.get(key);
  if (pending) return (pending as Promise<T>).then(observeMarketValue);

  let p: Promise<T>;
  p = Promise.resolve().then(async () => {
    try {
      const value = annotateMarketValue(await producer());
      const savedInput = (value as {dataStatus?:{snapshots?:unknown[]}} | null)?.dataStatus?.snapshots?.length;
      if (inflight.get(key) === p && (ttlMs > 0 || options.staleOnError !== false)) remember(key, value, savedInput ? Math.min(ttlMs,30000) : ttlMs);
      return value;
    } catch (e) {
      // 上游失败时，若有过期旧值则降级使用，避免整页报错
      const stale = options.staleOnError === false ? undefined : store.get(key);
      if (stale) {
        const mark = (value: unknown): unknown => {
          if (!value || typeof value !== 'object' || !('stale' in value)) throw e;
          const item = value as { stale: boolean; warnings?: string[] };
          return savedMarketValue({ ...item, stale: true,
            warnings: [...(item.warnings??[]), '更新失败，当前使用上次缓存的数据，请留意日期。'] },
            {key:`cache:${key}`,source:'memory-cache',acquiredAt:new Date(stale.storedAt).toISOString(),reason:String(e)});
        };
        return (Array.isArray(stale.value) ? stale.value.map(mark) : mark(stale.value)) as T;
      }
      throw e;
    } finally {
      if (inflight.get(key) === p) inflight.delete(key);
    }
  });

  inflight.set(key, p);
  return p;
}

/** 写入（用于预热 / 手动覆盖） */
export function putCache<T>(key: string, value: T, ttlMs: number): void {
  remember(key, value, ttlMs);
}

/** 清空（测试或强制刷新） */
export function clearCache(): void {
  store.clear();
  inflight.clear();
}

export function cacheStats(): { size: number; pending: number } {
  return { size: store.size, pending: inflight.size };
}


/** Also detach old in-flight requests so a late response cannot refill invalidated data. */
export function invalidateSecurityCache(symbol:string):void {
 const code=symbol.replace(/^(sh|sz|bj|hk)/,'');
 for(const key of store.keys())if(key.includes(symbol) || key.includes(code))store.delete(key);
 for(const key of inflight.keys())if(key.includes(symbol) || key.includes(code))inflight.delete(key);
}
