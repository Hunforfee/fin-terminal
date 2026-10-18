import { isShanghaiTradingTime } from './tradingTime';
import type { AssetKind, Market } from './types';

/**
 * A 股 / 指数 / 基金代码标准化工具。
 * 上证与深证存在代码重叠（如 000001 既是上证指数又是平安银行），
 * 因此指数用白名单显式判定，其余按板块规则落到股票。
 */

export const INDEX_WHITELIST: Record<string, { symbol: string; name: string; market: Market }> = {
  '000001': { symbol: 'sh000001', name: '上证指数', market: 'SH' },
  '000300': { symbol: 'sh000300', name: '沪深300', market: 'SH' },
  '000016': { symbol: 'sh000016', name: '上证50', market: 'SH' },
  '000010': { symbol: 'sh000010', name: '上证180', market: 'SH' },
  '000009': { symbol: 'sh000009', name: '上证380', market: 'SH' },
  '000905': { symbol: 'sh000905', name: '中证500', market: 'SH' },
  '000852': { symbol: 'sh000852', name: '中证1000', market: 'SH' },
  '000688': { symbol: 'sh000688', name: '科创50', market: 'SH' },
  '000015': { symbol: 'sh000015', name: '红利指数', market: 'SH' },
  '399001': { symbol: 'sz399001', name: '深证成指', market: 'SZ' },
  '399006': { symbol: 'sz399006', name: '创业板指', market: 'SZ' },
  '399005': { symbol: 'sz399005', name: '中小板指', market: 'SZ' },
  '399300': { symbol: 'sz399300', name: '沪深300', market: 'SZ' },
  '399905': { symbol: 'sz399905', name: '中证500', market: 'SZ' },
  '899050': { symbol: 'bj899050', name: '北证50', market: 'BJ' },
};

const ETF_PREFIX_SH = ['50', '51', '52', '56', '58'];
const ETF_PREFIX_SZ = ['15', '16', '18'];
/** 场外基金（按代码段粗略识别） */
const FUND_PREFIX_SH = ['50', '51', '52'];

export interface NormalizedCode {
  code: string;
  symbol: string;
  market: Market;
  kind: AssetKind;
  /** 板块名 */
  board: string;
  /** 东方财富 secid（1=沪, 0=深/北） */
  secid: string;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '' || v === '-') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export { numOrNull };

/**
 * 把任意用户输入（600519 / sh600519 / 600519.SH / 沪深300）标准化。
 * 无法判定时返回 null，由调用方交给搜索接口去问上游。
 */
export function normalizeCode(input: string): NormalizedCode | null {
  if (!input) return null;
  let raw = String(input).trim().toLowerCase();
  // 港股：hk00700 / 00700.hk / 700.hk / 裸 4-5 位数字（A 股固定 6 位，无冲突）
  const hkSuffixed = raw.match(/^(?:hk)?(\d{1,5})\.hk$/);
  if (hkSuffixed) return buildHk(hkSuffixed[1]);
  const hkPrefixed = raw.match(/^hk(\d{1,5})$/);
  if (hkPrefixed) return buildHk(hkPrefixed[1]);
  // 去掉 .SH / .SZ 之类的后缀
  const suffix = raw.match(/^(\d{6})\.(sh|sz|bj|ss)$/);
  if (suffix) return build(suffix[1], (suffix[2] === 'ss' ? 'SH' : suffix[2].toUpperCase()) as Market);
  // 去掉已有的市场前缀
  const prefixed = raw.match(/^(sh|sz|bj)(\d{6})$/);
  if (prefixed) {
    return build(prefixed[2], prefixed[1].toUpperCase() as Market);
  }
  const digits = raw.match(/^(\d{6})$/);
  if (!digits) {
    // 裸 4-5 位数字视为港股代码（如 700 / 0700 / 00700）
    const hk = raw.match(/^(\d{4,5})$/);
    if (hk) return buildHk(hk[1]);
    return null;
  }
  const code = digits[1];

  // 指数优先（解决 000001 歧义：默认返回指数，股票由搜索另行给出）
  const idx = INDEX_WHITELIST[code];
  if (idx) return build(code, idx.market);

  // 板块规则
  const head2 = code.slice(0, 2);
  const head3 = code.slice(0, 3);

  if (code.startsWith('6')) return build(code, 'SH');
  if (code.startsWith('688') || code.startsWith('689')) return build(code, 'SH');
  if (/^[023]/.test(code)) return build(code, 'SZ');
  if (code.startsWith('4') || code.startsWith('8')) return build(code, 'BJ');
  if (code.startsWith('92')) return build(code, 'BJ');
  if (ETF_PREFIX_SH.includes(head2) || FUND_PREFIX_SH.includes(head2)) return build(code, 'SH');
  if (ETF_PREFIX_SZ.includes(head2)) return build(code, 'SZ');
  if (head3 === '110' || head3 === '113' || head3 === '123' || head3 === '127') return build(code, 'SH'); // 可转债
  return build(code, 'SH');
}

/** 港股代码标准化：不足 5 位左侧补零，symbol 形如 hk00700 */
export function buildHk(raw: string): NormalizedCode {
  const code = raw.padStart(5, '0');
  return {
    code,
    symbol: `hk${code}`,
    market: 'HK',
    kind: 'stock',
    board: '港股',
    secid: `116.${code}`,
  };
}

function build(code: string, market: Market): NormalizedCode {  const symbol = `${market.toLowerCase()}${code}`;
  const idx = INDEX_WHITELIST[code];
  let kind: AssetKind = 'stock';
  let board = 'A股';

  if (idx && idx.market === market) {
    kind = 'index';
    board = '指数';
  } else if (market === 'BJ') {
    board = '北交所';
  } else if (code.startsWith('688')) {
    board = '科创板';
  } else if (code.startsWith('300') || code.startsWith('301')) {
    board = '创业板';
  } else if (code.startsWith('6')) {
    board = '沪市主板';
  } else if (code.startsWith('0')) {
    board = '深市主板';
  } else if (ETF_PREFIX_SH.includes(code.slice(0, 2)) || ETF_PREFIX_SZ.includes(code.slice(0, 2))) {
    kind = code.startsWith('15') && code.startsWith('159') ? 'etf' : 'etf';
    board = 'ETF/基金';
  }

  const secid = `${market === 'SH' ? '1' : '0'}.${code}`;
  return { code, symbol, market, kind, board, secid };
}

/** Use the stock context to disambiguate bare codes shared with indices. */
export function normalizeStockCode(input: string): NormalizedCode | null {
  const raw = input.trim();
  const hk = raw.match(/^(?:hk)?(\d{1,5})(?:\.hk)?$/i);
  if (hk && !/^\d{6}$/.test(raw)) return buildHk(hk[1]);
  const symbol = /^\d{6}$/.test(raw)
    ? `${/^[023]/.test(raw) ? 'sz' : /^(4|8|92)/.test(raw) ? 'bj' : 'sh'}${raw}` : raw;
  const n = normalizeCode(symbol);
  return n?.kind === 'stock' ? n : null;
}

/** 批量标准化（行情接口一次可查多个代码，提高吞吐） */
export function toSymbols(inputs: string[]): string[] {
  const out: string[] = [];
  for (const i of inputs) {
    const n = normalizeCode(i);
    if (n) out.push(n.symbol);
  }
  return Array.from(new Set(out));
}

/** 是否为交易时段（粗略，用于决定是否强缓存） */
export function isTradingNow(d = new Date()): boolean {
  return isShanghaiTradingTime(d);
}

/** 数字格式化：亿元为单位时保留 2 位 */
export function fmtNumber(v: number | null, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '--';
  return v.toFixed(digits);
}

/** 大数字智能单位（亿 / 万） */
export function fmtCompact(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '--';
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${(v / 1e4).toFixed(2)}万`;
  return v.toFixed(2);
}

