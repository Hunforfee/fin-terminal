import { normalizeCode, normalizeStockCode } from './datasource/codes';

/** 搜索结果与旧搜索历史共用；修复旧版保存的 bj002714 / sz00700 等错误市场。 */
export function searchResultPath(hit: {kind: string; code: string; market?: string; symbol?: string}): string {
  if (hit.kind === 'index') {
    const n = normalizeCode(hit.code);
    return `/index/${n?.symbol ?? encodeURIComponent(hit.code)}`;
  }
  if (hit.kind === 'fund' || hit.kind === 'etf') return `/fund/${encodeURIComponent(hit.code)}`;
  const n = normalizeStockCode(hit.code);
  return `/stock/${n?.symbol ?? encodeURIComponent(hit.code)}`;
}
