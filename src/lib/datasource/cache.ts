import { isShanghaiTradingTime, isHongKongTradingTime } from './tradingTime';
import { databaseOnly } from '../marketReadPolicy';
/**
 * 进程内 TTL 缓存。
 * 行情类接口上游有频率限制，且同一页面多个组件会重复请求同一标的，
 * 因此统一在 Provider 之上加一层短 TTL 缓存。
 */

interface Entry<T> {
  value: T;
  expireAt: number;
}

const store = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

/** 默认 TTL：交易时段 15s，非交易时段 10 分钟（收盘后数据不再变化） */
export function defaultTtl(market: 'A' | 'HK' = 'A', date?: Date): number {
  const trading = market === 'HK'
    ? isHongKongTradingTime(date)
    : isShanghaiTradingTime(date);
  return trading ? 15_000 : 600_000;
}

export async function cached<T>(key: string, ttlMs: number, producer: () => Promise<T>): Promise<T> {
  if(databaseOnly())key=`database:${key}`;
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expireAt > now) return hit.value as T;

  // 防止并发击穿：同一 key 的并发请求共享一个 Promise
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const p = (async () => {
    try {
      const value = await producer();
      store.set(key, { value, expireAt: Date.now() + ttlMs });
      return value;
    } catch (e) {
      // 上游失败时，若有过期旧值则降级使用，避免整页报错
      const stale = store.get(key);
      if (stale) {
        const mark = (value: unknown): unknown => {
          if (!value || typeof value !== 'object' || !('stale' in value)) throw e;
          const item = value as { stale: boolean; warnings?: string[] };
          return { ...item, stale: true,
            ...(Array.isArray(item.warnings) ? { warnings: [...item.warnings, '更新失败，当前使用上次缓存的数据，请留意日期。'] } : {}) };
        };
        return (Array.isArray(stale.value) ? stale.value.map(mark) : mark(stale.value)) as T;
      }
      throw e;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, p);
  return p;
}

/** 写入（用于预热 / 手动覆盖） */
export function putCache<T>(key: string, value: T, ttlMs: number): void {
  store.set(key, { value, expireAt: Date.now() + ttlMs });
}

/** 清空（测试或强制刷新） */
export function clearCache(): void {
  store.clear();
  inflight.clear();
}

export function cacheStats(): { size: number; pending: number } {
  return { size: store.size, pending: inflight.size };
}

