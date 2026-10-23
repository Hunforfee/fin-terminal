/**
 * 腾讯财经 Provider —— 主力数据源。
 *
 * 已实测可用端点（沙箱 2026-10）：
 *   实时行情  https://qt.gtimg.cn/q=sh600519,sz000001        (GBK)
 *   历史 K 线 ifzq.gtimg.cn / proxy.finance.qq.com 镜像（按序回退，JSON）
 *   分时      https://web.ifzq.gtimg.cn/appstock/app/minute/query
 *   搜索联想  https://smartbox.gtimg.cn/s3/?q=xxx&t=all      (GBK)
 *
 * 注意：上游 WAF 会返回 501 挑战页（HTML 而非 JSON）且不同域名/节点策略不一致，
 * 甚至 web 子域的 K 线端点会被拦截而分时正常。K 线因此走多镜像回退（见 KLINE_URLS）。
 */

import { fetchJson, fetchText } from './http';
import { numOrNull, normalizeCode, buildHk, INDEX_WHITELIST } from './codes';
import type { Candle, KLineSeries, MinutePoint, Period, Quote, SearchHit, Adjust } from './types';

const QUOTE_URL = 'https://qt.gtimg.cn/q=';
/**
 * 历史 K 线镜像列表（按优先级尝试）。
 * 上游 WAF 会按域名节点下发拦截策略（实测同一时刻 web 子域 501、主域与 finance 反代 200），
 * 因此逐个尝试，任何一个返回合法 JSON 即用。
 */
const KLINE_URLS = [
  'https://ifzq.gtimg.cn/appstock/app/fqkline/get',
  'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get',
  'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get',
];
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
export function parseQuoteLine(symbol: string, body: string): Quote | null {
  const f = body.split('~');
  if (f[2] && f[2] !== symbol.slice(2)) return null;
  // 港股（v_hk00700=...）字段布局不同，走专用解析
  if (symbol.startsWith('hk')) return parseHkQuoteLine(symbol, body);
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
  // A 股形如 20261016161447；港股形如 2026/10/16 16:08:22
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`;
  const hk = raw.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (hk) {
    const p = (n: string) => n.padStart(2, '0');
    return `${hk[1]}-${p(hk[2])}-${p(hk[3])}T${p(hk[4])}:${hk[5]}:${hk[6]}+08:00`;
  }
  return null;
}

/**
 * 港股行情行解析。港股字段位与 A 股不同（实测 2026-10）：
 *  1 名称 2 代码 3 现价 4 昨收 5 今开 6 成交量(股)
 *  30 时间(2026/10/16 16:08:22) 31 涨跌额 32 涨跌幅 33 最高 34 最低
 *  36 成交量(股) 37 成交额(港元) 39 PE(TTM) 43 振幅
 *  44/45 总市值(亿港元) 48 52周高 49 52周低
 */
function parseHkQuoteLine(symbol: string, body: string): Quote | null {
  const f = body.split('~');
  if (f.length < 40) return null;
  const code = f[2] || symbol.slice(2);
  const price = numOrNull(f[3]);
  const high52w = numOrNull(f[48]);
  const low52w = numOrNull(f[49]);
  // 港股成交量单位为股，统一折算成手
  const volShare = numOrNull(f[36]) ?? numOrNull(f[6]);
  return {
    code,
    symbol,
    name: cleanName(f[1] || code),
    market: 'HK',
    kind: 'stock',
    price,
    prevClose: numOrNull(f[4]),
    open: numOrNull(f[5]),
    high: numOrNull(f[33]),
    low: numOrNull(f[34]),
    change: numOrNull(f[31]),
    changePct: numOrNull(f[32]),
    volume: volShare === null ? null : volShare / 100,
    amount: numOrNull(f[37]),
    turnoverRate: null,
    volumeRatio: null,
    amplitude: numOrNull(f[43]),
    pe: numOrNull(f[39]),
    peForward: null,
    peStatic: null,
    // 港股行情不含 PB 与股息率：字段 72 实为 52 周低、字段 58 为年内涨幅%，
    // 估值指标统一由 hkFundamental.ts 用 BPS / DPS 与现价计算，这里必须留空。
    pb: null,
    dividendYield: null,
    totalMarketCap: numOrNull(f[45]),
    floatMarketCap: numOrNull(f[44]),
    high52w: high52w !== null && price !== null && high52w >= price ? high52w : null,
    low52w: low52w !== null && price !== null && low52w <= price ? low52w : null,
    ts: parseTs(f[30] || ''),
    source: PROVIDER_NAME,
    stale: false,
  };
}

/** 批量取实时行情，一次最多 60 个代码 */
export async function fetchQuotes(symbols: string[]): Promise<Quote[]> {
  if (symbols.length === 0) return [];
  const text = await fetchText(QUOTE_URL + symbols.join(','), { encoding: 'gbk', timeoutMs: 8000 });
  const out: Quote[] = [];
  // 形如 v_sh600519="..."；港股为 v_hk00700="..."（5 位代码）
  const re = /v_([a-z]{2}\d{4,6})="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (!symbols.includes(m[1])) continue;
    const q = parseQuoteLine(m[1], m[2]);
    if (q && q.price !== null && Number.isFinite(q.price) && q.price > 0) out.push(q);
  }
  if (out.length === 0) throw new Error('tencent quote parse yielded nothing');
  return out;
}

export async function fetchQuote(symbol: string): Promise<Quote | null> {
  const list = await fetchQuotes([symbol]);
  return list[0] ?? null;
}

/**
 * WAF 挑战页（501）与限频（429）都是瞬时状态，值得原地重试；
 * 这些状态码按节点策略下发，同一节点立刻重试往往还是同样结果，因此配合换镜像 + 退避。
 */
const KLINE_RETRY_STATUSES = [403, 408, 418, 429, 500, 501, 502, 503, 504];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 依次尝试 K 线镜像域名，直到拿到合法 JSON（WAF 常返回 501 挑战页） */
async function fetchKLineJson(param: string): Promise<Record<string, unknown>> {
  let lastErr: unknown;
  for (let i = 0; i < KLINE_URLS.length; i++) {
    const url = `${KLINE_URLS[i]}?param=${encodeURIComponent(param)}`;
    try {
      return await fetchJson<Record<string, unknown>>(url, {
        timeoutMs: 10000,
        retries: 2,
        backoffMs: 500,
        retryStatuses: KLINE_RETRY_STATUSES,
      });
    } catch (e) {
      lastErr = e;
      // 换镜像前稍等：同一节点的 WAF 策略不会因为立刻重试而改变
      if (i < KLINE_URLS.length - 1) await sleep(400);
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error('tencent kline: all mirrors failed');
}

/** 历史 K 线。
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
    let complete = true;
    const pages = Math.ceil(count / 640) + 1;
    for (let page = 0; page < pages; page++) {
      // 单页多重试几次：WAF 挑战与限频都是瞬时的；仍失败则保留已取得的页，优雅截断
      let part;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          part = await fetchKLine(symbol, period, adjust, 640, undefined, end);
          break;
        } catch {
          if (attempt < 2) await sleep(500 * (attempt + 1));
        }
      }
      if (!part) { complete = false; break; }
      const rows = part.candles;
      if (!rows.length) break;
      const oldest = rows[0].date;
      const before = byDate.size;
      for (const c of rows) byDate.set(c.date, c);
      if (byDate.size === before || (startDate && oldest <= startDate) || byDate.size >= count) break;
      end = new Date(Date.parse(oldest + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
      // 页间 pacing：连续翻页最容易触发上游限频
      if (page < pages - 1) await sleep(350);
    }
    if (byDate.size === 0) throw new Error(`tencent kline: empty series (${adjust})`);
    return { symbol, code: symbol.slice(2), period, adjust,
      candles: [...byDate.values()].sort((a,b) => a.date.localeCompare(b.date))
        .filter(c => !startDate || c.date >= startDate).slice(-count), source: PROVIDER_NAME, stale: false, complete, ...(complete ? {} : { warnings: ['历史分页中断，当前仅展示已取得区间。'] }) };
  }
  const p = period === 'minute' ? 'day' : period;
  const param = [symbol, p, startDate ?? '', endDate ?? '', String(count), adjust === 'none' ? '' : adjust].join(',');
  const json = await fetchKLineJson(param);

  const data = json.data as Record<string, unknown> | undefined;
  const node = data?.[symbol] as Record<string, unknown> | undefined;
  if (!node) throw new Error(`tencent kline: no data node for ${symbol}`);

  const key = adjust === 'qfq' ? `qfq${p}` : adjust === 'hfq' ? `hfq${p}` : p;
  // No market may label unadjusted prices as an adjusted series.
  const raw = (adjust === 'none' ? node[p] : node[key]) as unknown[] | undefined;
  if (!raw || raw.length === 0) throw new Error(`tencent kline: empty series (${key})`);

  // 腾讯行序： [date, open, close, high, low, volume]
  const candles: Candle[] = raw.map((r) => {
    const a = r as (string | number)[];
    const open = numOrNull(a[1]) ?? NaN;
    const close = numOrNull(a[2]) ?? NaN;
    const high = numOrNull(a[3]) ?? NaN;
    const low = numOrNull(a[4]) ?? NaN;
    return {
      date: String(a[0]),
      open,
      close,
      high,
      low,
      volume: (a[5] == null || String(a[5]).trim() === '' ? NaN : Number(a[5])) / (symbol.startsWith('hk') ? 100 : 1),
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

/** 分时（当日逐分钟）。港股返回量纲为股，统一折算成手 */
export async function fetchMinute(symbol: string): Promise<MinutePoint[]> {
  const url = `${MINUTE_URL}?code=${symbol}`;
  const json = await fetchJson<{ data?: Record<string, { data?: { data?: string[] } }> }>(url, { timeoutMs: 8000 });
  const rows = json?.data?.[symbol]?.data?.data;
  if (!rows) throw new Error('tencent minute: empty');
  const isHk = symbol.startsWith('hk');
  // 行格式："0930 1311.57 335 43937595.00"
  return rows.map((r) => {
    const [time, price, vol, amt] = r.split(' ');
    const v = Number(vol);
    return {
      time: `${time.slice(0, 2)}:${time.slice(2)}`,
      price: Number(price),
      volume: isHk ? v / 100 : v,
      amount: Number(amt),
    };
  });
}

/** smartbox 返回的名称是 \uXXXX 转义文本，需还原成中文 */
function unescapeUnicode(s: string): string {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** 搜索联想（支持拼音首字母，如 gzmt） */
export async function fetchSearch(keyword: string, signal?:AbortSignal): Promise<SearchHit[]> {
  const url = `${SMARTBOX_URL}?q=${encodeURIComponent(keyword)}&t=all`;
  const text = await fetchText(url, { encoding: 'gbk', timeoutMs: 1800, retries:0, signal });
  const hits: SearchHit[] = [];
  // 形如 v_hint="sh~600519~贵州茅台~gzmt~GP-A^sz~000001~平安银行~payh~GP-A"
  const m = text.match(/v_hint="([^"]*)"/);
  if (!m) return hits;
  for (const item of m[1].split('^')) {
    const p = item.split('~');
    if (p.length < 3) continue;
    const mk = p[0].toLowerCase();
    // 港股：hk~00700~腾讯控股~txkg~GP
    if (mk === 'hk') {
      const n = buildHk(p[1]);
      hits.push({
        code: n.code,
        symbol: n.symbol,
        name: unescapeUnicode(p[2]),
        market: 'HK',
        kind: p[4] === 'GP' ? 'stock' : 'unknown',
        pinyin: p[3],
        board: '港股',
        secid: n.secid,
      });
      continue;
    }
    // 暂只支持 A 股 + 港股，跳过美股 / 基金等其它市场行
    if (mk !== 'sh' && mk !== 'sz' && mk !== 'bj') continue;
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

