import { currentUpstreamBudget } from './upstreamBudget';
/** Database mode never changes implicitly during a page request. Collectors have an isolated budget context. */
export const databaseOnly = () => currentUpstreamBudget()?.readOnly === true || process.env.MARKET_READ_MODE === 'database' && !currentUpstreamBudget();
/** Collectors must fail visibly on missing inputs, not declare old snapshots newly collected. */
export const allowSavedMarketFallback = () => !databaseOnly() && !currentUpstreamBudget();
export const marketDataMissing = (label = '所需数据') => new Error(`${label}尚未入库，请在自选公司中补齐十二年数据`);
export function allowMarketNetwork(url: string): boolean {
  if (!databaseOnly()) return true;
  const u=new URL(url);
  // Current quotes only: no price history, financial endpoints or arbitrary paths.
  return (u.hostname==='qt.gtimg.cn' && u.pathname.startsWith('/q='))
    || (u.hostname==='hq.sinajs.cn' && u.pathname==='/' && u.searchParams.has('list'))
    || (u.hostname==='smartbox.gtimg.cn' && u.pathname==='/s3/')
    || (u.hostname==='searchapi.eastmoney.com' && u.pathname==='/api/suggest/get');
}
