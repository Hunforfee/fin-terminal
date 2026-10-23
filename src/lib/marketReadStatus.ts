/** Request-local provenance. No Node imports: shared source modules also supply browser metadata. */
export interface SavedMarketInput { key: string; source: string; acquiredAt: string; reason: string }
export interface MarketReadStatus { snapshots: SavedMarketInput[]; persistenceFailed: string[] }
const runtime = globalThis as typeof globalThis & {
  finMarketReadStatus?: () => MarketReadStatus | undefined;
  finMarketSnapshots?: WeakMap<object, SavedMarketInput>;
};
const snapshots = runtime.finMarketSnapshots ??= new WeakMap<object, SavedMarketInput>();
export function installMarketReadStatus(resolve: () => MarketReadStatus | undefined) { runtime.finMarketReadStatus = resolve; }
export function observeMarketValue<T>(value: T): T {
  if(Array.isArray(value))for(const item of value)observeMarketValue(item);
  const saved = value && typeof value === 'object' ? snapshots.get(value) : undefined;
  const state = runtime.finMarketReadStatus?.();
  if (saved && state && !state.snapshots.some(s => s.key === saved.key)) state.snapshots.push(saved);
  const inherited = (value as { dataStatus?: MarketReadStatus } | null)?.dataStatus;
  if (inherited && state) {
    for (const item of inherited.snapshots) if (!state.snapshots.some(s => s.key === item.key)) state.snapshots.push(item);
    for (const key of inherited.persistenceFailed) if (!state.persistenceFailed.includes(key)) state.persistenceFailed.push(key);
  }
  return value;
}
export function annotateMarketValue<T>(value: T): T {
  observeMarketValue(value);
  const state=runtime.finMarketReadStatus?.();
  if (!state || !state.snapshots.length && !state.persistenceFailed.length || !value ||
    Object.prototype.toString.call(value)!=='[object Object]') return value;
  return {...value,...(state.snapshots.length?{stale:true}:{}),
    warnings:[...new Set([...((value as {warnings?:string[]}).warnings??[]),
      ...(state.snapshots.length?['部分输入未能安全更新，使用已保存的数据；请留意原始获取日期。']:[]),
      ...(state.persistenceFailed.length?['本次有效数据已取得，但部分数据未确认入库成功。']:[])])],
    dataStatus:{snapshots:[...state.snapshots],persistenceFailed:[...state.persistenceFailed]}};
}
export function savedMarketValue<T>(value: T, provenance: SavedMarketInput): T {
  if (value && typeof value === 'object') snapshots.set(value, provenance);
  return observeMarketValue(value);
}
export function marketPersistenceFailed(key: string) {
  const state = runtime.finMarketReadStatus?.();
  if (state && !state.persistenceFailed.includes(key)) state.persistenceFailed.push(key);
}
