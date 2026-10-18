/**
 * 雪球代码映射。
 *
 * 雪球个股页地址形如 https://xueqiu.com/S/SH600519：
 * - 沪市 SH + 6 位，深市 SZ + 6 位，北交所 BJ + 6 位
 * - 港股 5 位代码，**不带市场前缀**：https://xueqiu.com/S/00700
 *
 * 本站 symbol 形如 sh600519 / sz000858 / hk00700 / bj430047，
 * 与雪球路径格式不同，必须显式映射，不能直接透传本站 symbol。
 */

type MarketKey = 'SH' | 'SZ' | 'BJ' | 'HK';

/** 本站行情支持的市场；指数/基金/ETF 等非个股标的雪球路径不同，暂不提供跳转。 */
const KNOWN_MARKETS: MarketKey[] = ['SH', 'SZ', 'BJ', 'HK'];

/**
 * 由本站标的代码推出雪球个股页地址。
 * @param symbol 本站 symbol（sh600519 / sz000858 / hk00700）
 * @param market 市场（SH/SZ/BJ/HK/US）
 * @param kind 资产类型，仅 stock 有雪球个股页
 * @returns 雪球地址；非个股返回 null
 */
export function xueqiuUrl(
  symbol: string,
  market: string,
  kind?: string,
): string | null {
  if (kind && kind !== 'stock') return null;
  const key = String(market ?? '').toUpperCase() as MarketKey;
  if (!KNOWN_MARKETS.includes(key)) return null;
  let code = String(symbol ?? '').toLowerCase();
  if (code.startsWith(key.toLowerCase())) code = code.slice(key.length);
  code = code.replace(/\D/g, '');
  if (!code) return null;
  // 港股路径是纯 5 位数字（不带 HK），A 股/北交所是市场前缀 + 6 位；位数超出不猜
  const width = key === 'HK' ? 5 : 6;
  if (code.length > width) return null;
  code = code.padStart(width, '0');
  return `https://xueqiu.com/S/${key === 'HK' ? '' : key}${code}`;
}

/** 雪球搜索页兜底：代码映射不出来时，让用户仍能一键到雪球找这只票。 */
export function xueqiuSearchUrl(keyword: string): string {
  return `https://xueqiu.com/k?q=${encodeURIComponent(keyword)}`;
}
