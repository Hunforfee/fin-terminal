import { normalizeStockCode } from './datasource/codes';
export function financeStorageKey(base:string,code:string):string {
  return normalizeStockCode(code)?.market==='HK' ? `${base}.hk` : base;
}
