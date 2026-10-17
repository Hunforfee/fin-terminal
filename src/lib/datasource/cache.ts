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
export function defaultTtl(): number {
  const d = new Date();
  const day = d.getDay();
  if (day === 0 || day === 6) return 10 * 60 * 1000;
  const t = d.getHours() * 60 + d.getMinutes();
  const trading = (t >= 9 * 60 + 15 && t <= 11 * 60 + 30) || (t >= 13 * 60 && t <= 15 * 60 + 5);
  return trading ? 15 * 1000 : 10 * 60 * 1000;
}

export async function cached<T>(key: string, ttlMs: number, producer: () => Promise<T>): Promise<T> {
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
      if (stale) return stale.value as T;
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
