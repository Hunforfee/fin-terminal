import { normalizeStockCode } from './datasource/codes';
import { fetchCustomFinancials, type CustomFinancials } from './datasource/sinaStatements';
import { fetchHkCustomFinancials } from './datasource/hkFinance';
import { storedMarketInput, validateDatedRows } from './marketInputs';
export const WATCHLIST_FINANCIAL_FIELDS = ['roe', 'netMargin', 'ocfPerShare', 'debtRatio'];
export function validateWatchlistFinancials(value: CustomFinancials, code: string): void {
  if (value.code !== code) throw Error('列表财务证券不匹配');
  validateDatedRows(value.periods.map(date => ({ date })), 'date');
  if (WATCHLIST_FINANCIAL_FIELDS.some(key => !Array.isArray(value.series[key]) || value.series[key].length !== value.periods.length ||
    value.series[key].some(v => v !== null && !Number.isFinite(v)))) throw Error('列表财务序列未对齐');
  if (WATCHLIST_FINANCIAL_FIELDS.every(key => value.series[key].at(-1) === null)) throw Error('最新列表财务指标暂缺');
}
export const watchlistFinancialKey = (symbol: string) => `watchlist-financial-inputs:v1:${symbol}`;
/** The watchlist and updater read the SAME record, without a second hour-long page cache. */
export function getWatchlistFinancialInputs(input: string): Promise<CustomFinancials> {
  const n = normalizeStockCode(input); if (!n) throw Error('无效股票代码');
  return storedMarketInput(watchlistFinancialKey(n.symbol), 'watchlist-financial-inputs',
    n.market === 'HK' ? 'hkf10:reported-indicators' : 'public-financials:reported-indicators', 1800e3,
    () => n.market === 'HK' ? fetchHkCustomFinancials(`${n.code}.HK`, n.code, WATCHLIST_FINANCIAL_FIELDS, 2)
      : fetchCustomFinancials(n.code, WATCHLIST_FINANCIAL_FIELDS, 2),
    value => validateWatchlistFinancials(value, n.code));
}
