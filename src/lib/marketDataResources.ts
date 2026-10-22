/** Public, structured market data only. Never add account/admin/AI/write routes here. */
export const MARKET_DATA_RESOURCES = {
  quote: ['GET'], kline: ['GET'], minute: ['GET'], valuation: ['GET'],
  financial: ['GET'], 'finance-fields': ['GET'], 'finance-compare': ['GET', 'POST'],
  'dividend-yield': ['GET'], 'deducted-pe': ['GET'], 'company-profile': ['GET'],
  analysis: ['GET'], 'company-window': ['GET'], 'announcement-content': ['GET'],
  'financial-reports': ['GET'], 'company-learning': ['GET', 'POST'],
  search: ['GET'], peers: ['GET'], market: ['GET'], industry: ['GET'],
  'sw-industry': ['GET'], 'hk-industry': ['GET'], screen: ['GET', 'POST'], health: ['GET'],
  records: ['GET'], 'hk-valuation': ['GET'], catalog: ['GET'],
} as const;
export type MarketDataResource = keyof typeof MARKET_DATA_RESOURCES;
export function isMarketDataResource(value: string): value is MarketDataResource {
  return Object.hasOwn(MARKET_DATA_RESOURCES, value);
}
export function marketDataMethodAllowed(resource: MarketDataResource, method: string): boolean {
  return (MARKET_DATA_RESOURCES[resource] as readonly string[]).includes(method);
}

/** Enumerate each family with a cursor to read all available public records. */
export const PUBLIC_MARKET_FAMILIES = [
  'latest-quote:v1:', 'kline:v2:', 'source-sina-page:v1:', 'source-sina-indicators:v1:',
  'statements-v3:', 'shares-v3:', 'disclosures-v3:', 'implemented-dividends-v4:',
  'dividend-plans-v2:', 'deducted-periods:v1:', 'source-debt-ratios:v1:',
  'source-interest-expenses:v1:', 'screen-company-input:v1:', 'watchlist-financial-inputs:v1:',
  'market-coverage:v1:', 'security-basics:v1:', 'source-hk-indicators:v1:',
  'source-hk-statement:v1:', 'source-hk-valuation:v1:', 'hk-main-currency-v4:',
  'hk-dividend-events-v4:', 'valuation-result:v1:', 'valuation-input-version:v1:',
  'display-metric:v1:', 'company-profile:v1:', 'company-business:v1:',
  'company-announcements:v1:', 'announcement-content:v1:', 'company-reports:v1:',
  'financial-report-announcements:v1:',
] as const;
export const allowedPublicMarketKey = (key: string, prefix = false) => key.length <= 300
  && /^[a-zA-Z0-9:._-]+$/.test(key)
  && PUBLIC_MARKET_FAMILIES.some(family => key.startsWith(family) && (prefix || key.length > family.length));
