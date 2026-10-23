import { AsyncLocalStorage } from 'node:async_hooks';
import { installMarketReadStatus, observeMarketValue, type MarketReadStatus } from './marketReadStatus';
const runtime = globalThis as typeof globalThis & { finMarketReadStorage?: AsyncLocalStorage<MarketReadStatus> };
const storage = runtime.finMarketReadStorage ??= new AsyncLocalStorage<MarketReadStatus>();
installMarketReadStatus(() => storage.getStore());

/** Preserve acquisition dates and mark derived results too; stale inputs never become a fresh valuation. */
export async function withMarketReadStatus<T>(read: () => Promise<T>): Promise<T> {
  const parent = storage.getStore();
  const state: MarketReadStatus = { snapshots: [], persistenceFailed: [] };
  return storage.run(state, async () => {
    const value = observeMarketValue(await read());
    if (parent) {
      for (const item of state.snapshots) if (!parent.snapshots.some(s => s.key === item.key)) parent.snapshots.push(item);
      for (const key of state.persistenceFailed) if (!parent.persistenceFailed.includes(key)) parent.persistenceFailed.push(key);
    }
    if (!state.snapshots.length && !state.persistenceFailed.length || !value || typeof value !== 'object') return value;
    const warnings = [
      ...((value as { warnings?: string[] }).warnings ?? []),
      ...(state.snapshots.length ? ['部分输入未能安全更新，使用已保存的数据；请留意各项数据的原始获取日期。'] : []),
      ...(state.persistenceFailed.length ? ['本次有效数据已取得，但部分数据未确认入库成功。'] : []),
    ];
    const decorate=(item:unknown)=>item && Object.prototype.toString.call(item)==='[object Object]'
      ? {...item,...(state.snapshots.length ? {stale:true}:{}),warnings:[...new Set(warnings)],dataStatus:state}:item;
    return (Array.isArray(value)?value.map(decorate):decorate(value)) as T;
  });
}
