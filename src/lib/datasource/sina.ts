/**
 * 新浪财经 Provider —— 备用数据源。
 *
 * 可用端点：
 *   历史 K 线 https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData
 *   实时行情 https://hq.sinajs.cn/list=sh600519 (GBK，需 Referer)
 *
 * 角色：腾讯 K 线挂掉时的第一顺位兜底；同时它的日/周/月线字段与腾讯互为交叉校验。
 */

import { fetchText, looseJson } from './http';
import { numOrNull, normalizeCode, INDEX_WHITELIST } from './codes';
import type { Candle, KLineSeries, Period, Quote } from './types';

const KLINE_URL = 'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData';
const HQ_URL = 'https://hq.sinajs.cn/list=';

export const PROVIDER_NAME = 'sina';

const SCALE: Record<string, number> = { minute: 240, day: 240, week: 1200, month: 7200 };

/** 历史 K 线（不复权；新浪不提供复权序列，因此仅作兜底） */
export async function fetchKLine(
  symbol: string,
  period: Period = 'day',
  count = 320,
  startDate?: string,
): Promise<KLineSeries> {
  const scale = SCALE[period] ?? 240;
  // 新浪复权接口：datalen 为向前取的条数；此处用不复权行情，PE/PB 序列只需价格
  const url = `${KLINE_URL}?symbol=${symbol}&scale=${scale}&ma=no&datalen=${count}`;
  const text = await fetchText(url, { timeoutMs: 10000, headers: { Referer: 'https://finance.sina.com.cn' } });
  const parsed = looseJson(text) as Array<Record<string, string>> | null;
  if (!parsed || !Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('sina kline: empty');
  }
  // 新浪行序： { day, open, high, low, close, volume }
  const candles: Candle[] = parsed.map((r) => {
    const open = numOrNull(r.open) ?? NaN;
    const close = numOrNull(r.close) ?? NaN;
    const high = numOrNull(r.high) ?? NaN;
    const low = numOrNull(r.low) ?? NaN;
    return {
      date: String(r.day).slice(0, 10),
      open,
      close,
      high,
      low,
      volume: (r.volume == null || String(r.volume).trim() === '' ? NaN : Number(r.volume)) / 100, // 新浪给的是股，换算成手
    };
  });
  return { symbol, code: symbol.slice(2), period, adjust: 'none', candles, source: PROVIDER_NAME, stale: false };
}

/**
 * 实时行情快照。
 * 字段序：0 名称 1 今开 2 昨收 3 现价 4 最高 5 最低 6 买一 7 卖一
 *        8 成交量(股) 9 成交额(元) ... 30 日期 31 时间
 */
export async function fetchQuotes(symbols: string[]): Promise<Quote[]> {
  if (symbols.length === 0) return [];
  const text = await fetchText(HQ_URL + symbols.join(','), {
    encoding: 'gbk',
    timeoutMs: 8000,
    headers: { Referer: 'https://finance.sina.com.cn' },
  });
  const out: Quote[] = [];
  const re = /hq_str_([a-z]{2}\d{6})="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const symbol = m[1];
    const f = m[2].split(',');
    if (f.length < 10) continue;
    const price = numOrNull(f[3]);
    if (price === null || price === 0) continue;
    const prevClose = numOrNull(f[2]);
    const code = symbol.slice(2);
    const norm = normalizeCode(symbol);
    const idx = INDEX_WHITELIST[code];
    out.push({
      code,
      symbol,
      name: f[0],
      market: norm?.market ?? (symbol.startsWith('sh') ? 'SH' : 'SZ'),
      kind: norm?.kind ?? 'stock',
      price,
      prevClose,
      open: numOrNull(f[1]),
      high: numOrNull(f[4]),
      low: numOrNull(f[5]),
      change: prevClose !== null ? price - prevClose : null,
      changePct: prevClose ? ((price - prevClose) / prevClose) * 100 : null,
      volume: (numOrNull(f[8]) ?? 0) / 100,
      amount: numOrNull(f[9]),
      turnoverRate: null,
      volumeRatio: null,
      amplitude:
        numOrNull(f[4]) !== null && numOrNull(f[5]) !== null && prevClose
          ? ((Number(f[4]) - Number(f[5])) / prevClose) * 100
          : null,
      pe: null, // 新浪快照不含估值，需由东财/腾讯补齐
      pb: null,
      peForward: null,
      peStatic: null,
      totalMarketCap: null,
      floatMarketCap: null,
      high52w: null,
      low52w: null,
      ts: f[30] && f[31] ? `${f[30]}T${f[31]}+08:00` : null,
      source: PROVIDER_NAME,
      stale: false,
    });
  }
  if (out.length === 0) throw new Error('sina quote parse yielded nothing');
  return out;
}

