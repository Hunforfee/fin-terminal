/** Bounded post-response refreshes. No market network work runs on the display request. */
export interface FinancialRefresh {
  state: 'pending' | 'busy' | 'failed' | 'unavailable';
  retryAfterMs: number;
  error?: string;
}
export type DeferRefresh = (work: () => Promise<void>) => void;
export function createFinancialRefreshes(concurrency = 2, capacity = 8, timeoutMs = 90_000, clock = Date.now) {
  const pending = new Set<string>(), failures = new Map<string, { until: number; error: string }>();
  let running = 0;
  const waiting: (() => void)[] = [];
  return (key: string, defer: DeferRefresh, work: (signal: AbortSignal) => Promise<void>): FinancialRefresh => {
    const now = clock();
    for (const [id, failure] of failures) if (failure.until <= now) failures.delete(id);
    if (pending.has(key)) return { state: 'pending', retryAfterMs: 5000 };
    const failure = failures.get(key);
    if (failure) return { state: 'failed', retryAfterMs: failure.until-now, error: failure.error };
    if (pending.size >= capacity) return { state: 'busy', retryAfterMs: 5000 };
    pending.add(key);
    try {
      defer(async () => {
        if (running >= concurrency) await new Promise<void>(resolve => waiting.push(resolve));
        else running++;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(Error('财报后台更新超时')), timeoutMs);
        try { await work(controller.signal); }
        catch (error) {
          failures.set(key, { until: clock()+60_000, error: error instanceof Error ? error.message : '财报后台更新失败' });
          // Bound diagnostics even if all queries target different companies.
          while (failures.size > 256) failures.delete(failures.keys().next().value!);
        } finally {
          clearTimeout(timer); pending.delete(key);
          const next = waiting.shift(); if (next) next(); else running--;
        }
      });
    } catch {
      pending.delete(key);
      return { state: 'unavailable', retryAfterMs: 60_000, error: '后台更新未能启动，请稍后重试' };
    }
    return { state: 'pending', retryAfterMs: 5000 };
  };
}
export const scheduleFinancialRefresh = createFinancialRefreshes();
