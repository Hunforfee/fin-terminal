/**
 * 东方财富 Provider —— 代码联想（可选增强）。
 *
 * 注意：该接口的响应格式不稳定，实测会在两种形态间切换：
 *   1) 纯 JSON：{"QuotationCodeTable":{"Data":[{"Code","Name","QuoteID",...}]}}
 *   2) JSONP（新版）：jQueryxxxx({...result.passportWeb...}) —— 返回的是股吧用户，无股票代码
 * 因此这里做容错解析：只在拿到 QuotationCodeTable 时才产出结果，否则返回空数组，
 * 由编排层用腾讯联想 + 本地标的池兜底，保证搜索功能始终可用。
 *
 * 另：push2 / push2his / clist 系列在本环境出口 IP 上被拦截（403），故不接入行情。
 */

import { fetchText } from './http';
import { normalizeCode, INDEX_WHITELIST } from './codes';
import type { SearchHit } from './types';

const SUGGEST_URL = 'https://searchapi.eastmoney.com/api/suggest/get';
const TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8';

export const PROVIDER_NAME = 'eastmoney';

interface SuggestItem {
  Code?: string;
  Name?: string;
  PinYin?: string;
  QuoteID?: string;
  SecurityTypeName?: string;
  MktNum?: string;
}

/** 剥离可能的 JSONP 包装，返回纯 JSON 文本 */
function stripJsonp(text: string): string {
  const t = text.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) {
    const m = t.match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/);
    if (m) return m[1];
  }
  return t;
}

/** 代码 / 名称 / 拼音联想；拿不到有效结构时返回空数组而非抛错 */
export async function fetchSearch(keyword: string, count = 12): Promise<SearchHit[]> {
  const url = `${SUGGEST_URL}?input=${encodeURIComponent(keyword)}&type=14&token=${TOKEN}&count=${count}`;
  const text = await fetchText(url, { timeoutMs: 6000 });
  const json = JSON.parse(stripJsonp(text)) as {
    QuotationCodeTable?: { Data?: SuggestItem[] };
  };
  const rows = json?.QuotationCodeTable?.Data ?? [];

  const hits: SearchHit[] = [];
  for (const r of rows) {
    if (!r.Code || !r.Name) continue;
    const code = r.Code;
    const market: 'SH' | 'SZ' | 'BJ' = r.QuoteID?.startsWith('1.') ? 'SH' : r.MktNum === '0' ? 'BJ' : 'SZ';
    const norm = normalizeCode(`${market.toLowerCase()}${code}`);
    const idx = INDEX_WHITELIST[code];
    hits.push({
      code,
      symbol: `${market.toLowerCase()}${code}`,
      name: r.Name,
      market,
      kind: norm?.kind ?? 'stock',
      pinyin: r.PinYin,
      board: r.SecurityTypeName ?? norm?.board ?? 'A股',
      secid: r.QuoteID ?? norm?.secid,
    });
  }
  return hits;
}

