import { normalizeStockCode } from './datasource/codes';
import { fetchCustomFinancials, type CustomFinancials } from './datasource/sinaStatements';
import { fetchHkCustomFinancials } from './datasource/hkFinance';
import { getMarketReadStore, getMarketStore } from './marketStore';
import { remoteMarketDataEnabled, readRemoteMarketData } from './marketDataClient';
import { databaseOnly } from './marketReadPolicy';
import { withMarketReadStatus } from './marketReadContext';
import { withUpstreamBudget } from './marketUpdateContext';
import { UpstreamBudget } from './upstreamBudget';
import { savedMarketValue } from './marketReadStatus';
import { getWatchlistFinancialInputs, validateWatchlistFinancials, watchlistFinancialKey, WATCHLIST_FINANCIAL_FIELDS } from './watchlistFinancialInputs';
import { scheduleFinancialRefresh, type DeferRefresh, type FinancialRefresh } from './financialDisplayRefresh';

type DisplayCompany = CustomFinancials & { refresh?: FinancialRefresh; missing?: string };
export interface WatchlistFinancialDisplay { companies: DisplayCompany[]; errors: { code: string; error: string }[] }
/** Read-only on the response path. Collectors continue to use the synchronous, verified writer. */
export async function getWatchlistFinancialDisplay(codes: string[], defer: DeferRefresh): Promise<WatchlistFinancialDisplay> {
  if (remoteMarketDataEnabled()) return readRemoteMarketData<WatchlistFinancialDisplay>('finance-compare', {}, {
    codes, fields: WATCHLIST_FINANCIAL_FIELDS, years: 2, granularity: 'quarter',
  });
  const normalized = codes.map(code => normalizeStockCode(code));
  if (normalized.some(n => !n)) throw Error('无效股票代码');
  const store = getMarketReadStore(), readOnly = databaseOnly();
  const companies: DisplayCompany[] = [];
  // Sequential DB reads prevent the entire watchlist from filling the connection pool.
  for (const n of normalized) {
    if (!n) continue;
    const key = watchlistFinancialKey(n.symbol);
    let value: CustomFinancials | undefined, acquiredAt: string | undefined, source: string | undefined;
    let fresh = false, readError: string | undefined, conflict = false;
    try {
      const record = await store?.read<CustomFinancials>(key);
      if (record) {
        validateWatchlistFinancials(record.payload, n.code);
        value = record.payload; acquiredAt = record.acquiredAt; source = record.source;
        fresh = Date.parse(record.refreshAfter) > Date.now();
        const origin = (record.payload as CustomFinancials & {retainedSourceConflicts?:{source:string;acquiredAt:string}}).retainedSourceConflicts;
        if(origin) { conflict=true; acquiredAt=origin.acquiredAt; source=origin.source; }
      }
    } catch (error) { readError = error instanceof Error ? error.message : '数据库读取失败'; }
    if (!value && !readError) {
      // Imports may contain source pages before the derived watchlist record exists.
      // Reuse those pages without allowing quotes, HTTP, or background writes here.
      try {
        value = await withUpstreamBudget(new UpstreamBudget(new AbortController().signal, 0, 0, true), () =>
          withMarketReadStatus(async () => {
            const result = n.market === 'HK'
              ? await fetchHkCustomFinancials(`${n.code}.HK`, n.code, WATCHLIST_FINANCIAL_FIELDS, 2)
              : await fetchCustomFinancials(n.code, WATCHLIST_FINANCIAL_FIELDS, 2);
            validateWatchlistFinancials(result, n.code);
            return result;
          }));
      } catch { /* Missing data remains explicitly pending, never a fabricated zero. */ }
    }
    let refresh: FinancialRefresh | undefined;
    if (!fresh && !readOnly) {
      if (!getMarketStore()) refresh = { state:'unavailable', retryAfterMs:60_000, error:'未配置可写市场存储，无法后台补齐' };
      else refresh = scheduleFinancialRefresh(key, defer, async signal => {
        await withUpstreamBudget(new UpstreamBudget(signal, 0, 80), async () => {
          await getWatchlistFinancialInputs(n.symbol);
          signal.throwIfAborted();
          const written = await getMarketReadStore()?.read<CustomFinancials>(key);
          if (!written || Date.parse(written.refreshAfter) <= Date.now()) throw Error('列表财务尚未确认更新入库');
          validateWatchlistFinancials(written.payload, n.code);
        });
      });
    }
    if (value) {
      const display = { ...value, ...(refresh ? { refresh } : {}) };
      companies.push((!fresh || conflict) && acquiredAt && source ? await withMarketReadStatus(async () =>
        savedMarketValue(display, { key, acquiredAt:acquiredAt!, source:source!, reason:conflict?'新旧披露数值冲突，保留原值待复核':refresh?.error??(readOnly?'已保存财报过期；只读模式未联网更新':'已保存财报过期，后台更新中；保留原始日期') })) : display);
    } else companies.push({ code:n.code, name:n.code, periods:[], periodLabels:[],
      series:Object.fromEntries(WATCHLIST_FINANCIAL_FIELDS.map(field => [field,[]])), source:'unavailable',
      missingFields:WATCHLIST_FINANCIAL_FIELDS, missing:readError ?? refresh?.error ?? (refresh ? '财报正在后台获取，请稍后重试' : '库内财报暂缺'),
      ...(refresh ? { refresh } : {}) });
  }
  return { companies, errors:companies.filter(c => (c.missing || c.refresh?.error) && !['pending','busy'].includes(c.refresh?.state ?? ''))
    .map(c => ({ code:c.code, error:c.refresh?.error ?? c.missing! })) };
}
