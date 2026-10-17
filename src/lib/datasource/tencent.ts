/**
 * 腾讯财经 Provider —— 主力数据源。
 *
 * 已实测可用端点（沙箱 2026-10）：
 *   实时行情  https://qt.gtimg.cn/q=sh600519,sz000001        (GBK)
 *   历史 K 线 https://ifzq.gtimg.cn/appstock/app/fqkline/get (JSON)
 *   分时      https://web.ifzq.gtimg.cn/appstock/app/minute/query
 *   搜索联想  https://smartbox.gtimg.cn/s3/?q=xxx&t=all      (GBK)
 *
 * 注意：web.ifzq.gtimg.cn 的 K 线端点已被 WAF 拦截（返回 501 页面），
 * 必须走 ifzq.gtimg.cn 这个域名。
 */

import { fetchJson, fetchText } from './http';
import { numOrNull, normalizeCode, INDEX_WHITELIST } from './codes';
import type { Candle, KLineSeries, MinutePoint, Period, Quote, SearchHit, Adjust } from './types';

const QUOTE_URL = 'https://qt.gtimg.cn/q=';
const KLINE_URL = 'https://ifzq.gtimg.cn/appstock/app/fqkline/get';
const MINUTE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query';
const SMARTBOX_URL = 'https://smartbox.gtimg.cn/s3/';

export const PROVIDER_NAME = 'tencent';

/**
 * 解析 qt.gtimg.cn 的单条记录。
 * 字段以 ~ 分隔，位置含义（A 股）：
 *  1 名称 2 代码 3 现价 4 昨收 5 今开 6 成交量(手)
 *  30 时间 31 涨跌额 32 涨跌幅 33 最高 34 最低
 *  36 成交量(手) 37 成交额(万) 38 换手率 39 PE(TTM)
 *  43 振幅 44 流通市值(亿) 45 总市值(亿) 46 PB
 *  47 涨停价 48 跌停价 49 量比 51 均价 52 PE(动) 53 PE(静)
 */
function parseQuoteLine(symbol: string, body: string): Quote | null {
  const f = body.split('~');
  if (f.length < 50) return null;

  const code = f[2] || symbol.slice(2);
  const norm = normalizeCode(symbol) ?? normalizeCode(code);
  const price = numOrNull(f[3]);
  const prevClose = numOrNull(f[4]);
  const high52w = numOrNull(f[67]);
  const low52w = numOrNull(f[68]);
  const tsRaw = f[30] || '';

  const idx = INDEX_WHITELIST[code];

  return {
    code,
    symbol,
    name: cleanName(f[1] || code),
    market: norm?.market ?? (symbol.startsWith('sh') ? 'SH' : 'SZ'),
    kind: norm?.kind ?? 'stock',
    price,
    prevClose,
    open: numOrNull(f[5]),
    high: numOrNull(f[33]),
    low: numOrNull(f[34]),
    change: numOrNull(f[31]),
    changePct: numOrNull(f[32]),
    volume: numOrNull(f[36]) ?? numOrNull(f[6]),
    // f[37] 单位为万元
    amount: (() => {
      const w = numOrNull(f[37]);
      return w === null ? null : w * 1e4;
    })(),
    turnoverRate: numOrNull(f[38]),
    volumeRatio: numOrNull(f[49]),
    amplitude: numOrNull(f[43]),
    pe: numOrNull(f[39]),
    peForward: numOrNull(f[52]),
    peStatic: numOrNull(f[53]),
    pb: numOrNull(f[46]),
    totalMarketCap: numOrNull(f[45]),
    floatMarketCap: numOrNull(f[44]),
    // 校验合理性，避免不同标的字段错位导致的脏数据
    high52w: high52w !== null && price !== null && high52w >= price ? high52w : null,
    low52w: low52w !== null && price !== null && low52w <= price ? low52w : null,
    ts: parseTs(tsRaw),
    source: PROVIDER_NAME,
    stale: false,
  };
}

/**
 * 上游部分名称带对齐空格（如 "五 粮 液"），统一去掉以便展示与搜索匹配。
 * 仅压缩空白，不改变字符本身。
 */
function cleanName(s: string): string {
  return s.replace(/\s+/g, '').trim() || s.trim();
}

function parseTs(raw: string): string | null {
  // 形如 20261016161447
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`;
}

/** 批量取实时行情，一次最多 60 个代码 */
export async function fetchQuotes(symbols: string[]): Promise<Quote[]> {
  if (symbols.length === 0) return [];
  const text = await fetchText(QUOTE_URL + symbols.join(','), { encoding: 'gbk', timeoutMs: 8000 });
  const out: Quote[] = [];
  // 形如 v_sh600519="...";
  const re = /v_([a-z]{2}\d{6})="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const q = parseQuoteLine(m[1], m[2]);
    if (q && Number.isFinite(q.price)) out.push(q);
  }
  if (out.length === 0) throw new Error('tencent quote parse yielded nothing');
  return out;
}

export async function fetchQuote(symbol: string): Promise<Quote | null> {
  const list = await fetchQuotes([symbol]);
  return list[0] ?? null;
}

/**
 * 历史 K 线。
 * param: code,period,start,end,count,adjust
 * 返回体 key 随复权变化：day / qfqday / hfqday
 */
export async function fetchKLine(
  symbol: string,
  period: Period = 'day',
  adjust: Adjust = 'qfq',
  count = 320,
  startDate?: string,
  endDate?: string,
): Promise<KLineSeries> {
  if (count > 640) {
    const byDate = new Map<string, Candle>();
    let end = endDate;
    for (let page = 0; page < Math.ceil(count / 640) + 1; page++) {
      const part = await fetchKLine(symbol, period, adjust, 640, undefined, end);
      const rows = part.candles;
      if (!rows.length) break;
      const oldest = rows[0].date;
      const before = byDate.size;
      for (const c of rows) byDate.set(c.date, c);
      if (byDate.size === before || (startDate && oldest <= startDate) || byDate.size >= count) break;
      end = new Date(Date.parse(oldest + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
    }
    return { symbol, code: symbol.slice(2), period, adjust,
      candles: [...byDate.values()].sort((a,b) => a.date.localeCompare(b.date))
        .filter(c => !startDate || c.date >= startDate).slice(-count), source: PROVIDER_NAME, stale: false };
  }
  const p = period === 'minute' ? 'day' : period;
  const param = [symbol, p, startDate ?? '', endDate ?? '', String(count), adjust === 'none' ? '' : adjust].join(',');
  const url = `${KLINE_URL}?param=${encodeURIComponent(param)}`;
  const json = await fetchJson<Record<string, unknown>>(url, { timeoutMs: 10000 });

  const data = json.data as Record<string, unknown> | undefined;
  const node = data?.[symbol] as Record<string, unknown> | undefined;
  if (!node) throw new Error(`tencent kline: no data node for ${symbol}`);

  const key = adjust === 'qfq' ? `qfq${p}` : adjust === 'hfq' ? `hfq${p}` : p;
  const raw = (adjust === 'none' ? node[p] : node[key]) as unknown[] | undefined;
  if (!raw || raw.length === 0) throw new Error(`tencent kline: empty series (${key})`);

  // 腾讯行序： [date, open, close, high, low, volume]
  const candles: Candle[] = raw.map((r) => {
    const a = r as (string | number)[];
    const open = Number(a[1]);
    const close = Number(a[2]);
    const high = Number(a[3]);
    const low = Number(a[4]);
    return {
      date: String(a[0]),
      open,
      close,
      high: Number.isFinite(high) ? Math.max(high, open, close) : Math.max(open, close),
      low: Number.isFinite(low) ? Math.min(low, open, close) : Math.min(open, close),
      volume: Number(a[5]) || 0,
    };
  });

  return {
    symbol,
    code: symbol.slice(2),
    period,
    adjust,
    candles,
    source: PROVIDER_NAME,
    stale: false,
  };
}

/** 分时（当日逐分钟） */
export async function fetchMinute(symbol: string): Promise<MinutePoint[]> {
  const url = `${MINUTE_URL}?code=${symbol}`;
  const json = await fetchJson<{ data?: Record<string, { data?: { data?: string[] } }> }>(url, { timeoutMs: 8000 });
  const rows = json?.data?.[symbol]?.data?.data;
  if (!rows) throw new Error('tencent minute: empty');
  // 行格式："0930 1311.57 335 43937595.00"
  return rows.map((r) => {
    const [time, price, vol, amt] = r.split(' ');
    return {
      time: `${time.slice(0, 2)}:${time.slice(2)}`,
      price: Number(price),
      volume: Number(vol),
      amount: Number(amt),
    };
  });
}

/** smartbox 返回的名称是 \uXXXX 转义文本，需还原成中文 */
function unescapeUnicode(s: string): string {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** 搜索联想（支持拼音首字母，如 gzmt） */
export async function fetchSearch(keyword: string): Promise<SearchHit[]> {
  const url = `${SMARTBOX_URL}?q=${encodeURIComponent(keyword)}&t=all`;
  const text = await fetchText(url, { encoding: 'gbk', timeoutMs: 6000 });
  const hits: SearchHit[] = [];
  // 形如 v_hint="sh~600519~贵州茅台~gzmt~GP-A^sz~000001~平安银行~payh~GP-A"
  const m = text.match(/v_hint="([^"]*)"/);
  if (!m) return hits;
  for (const item of m[1].split('^')) {
    const p = item.split('~');
    if (p.length < 3) continue;
    const market = p[0].toUpperCase() as 'SH' | 'SZ' | 'BJ';
    const code = p[1];
    const norm = normalizeCode(`${market.toLowerCase()}${code}`);
    const idx = INDEX_WHITELIST[code];
    hits.push({
      code,
      symbol: `${market.toLowerCase()}${code}`,
      name: unescapeUnicode(p[2]),
      market,
      kind: norm?.kind ?? 'stock',
      pinyin: p[3],
      board: norm?.board ?? 'A股',
      secid: norm?.secid,
    });
  }
  return hits;
}

