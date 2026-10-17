/**
 * AI 分析前的联网检索：用 Bing 中文搜索抓取最新资料摘要，作为模型上下文。
 * 不依赖任何额外 API Key；搜索失败时返回空结果，主流程继续（模型仅凭自身知识作答）。
 */

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x[0-9a-fA-F]+;/g, ' ');
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/** 解析 Bing 结果页（b_algo 块） */
function parseBing(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const blocks = html.split('<li class="b_algo"').slice(1);
  for (const block of blocks) {
    const linkM = /<h2[^>]*><a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!linkM) continue;
    const url = decodeEntities(linkM[1]);
    const title = stripTags(linkM[2]);
    if (!url || !title) continue;
    const snipM = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block);
    const snippet = snipM ? stripTags(snipM[1]).slice(0, 300) : '';
    hits.push({ title, url, snippet });
  }
  return hits;
}

async function bingSearch(query: string, timeoutMs = 15000): Promise<SearchHit[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN&count=12`;
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: ctrl.signal,
    });
    if (!r.ok) return [];
    const html = await r.text();
    return parseBing(html);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** 针对个股的多查询检索：合并去重，返回最多 max 条 */
export async function searchStockContext(
  name: string,
  code: string,
  max = 10,
): Promise<{ hits: SearchHit[]; ok: boolean }> {
  const queries = [
    `${name} ${code} 最新业绩 公告`,
    `${name} 年报 营收 净利润`,
    `${name} 股票 分析 研报`,
  ];
  const settled = await Promise.allSettled(queries.map((q) => bingSearch(q)));
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  let anyOk = false;
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue;
    if (s.value.length > 0) anyOk = true;
    for (const h of s.value) {
      const key = new URL(h.url).hostname + new URL(h.url).pathname;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(h);
    }
  }
  // 优先保留巨潮/交易所/官方等权威来源
  const weight = (u: string) =>
    /cninfo|sse\.com\.cn|szse\.cn|eastmoney|sina|10jqka|cs\.com\.cn|stcn\.com/.test(u) ? 0 : 1;
  hits.sort((a, b) => weight(a.url) - weight(b.url));
  return { hits: hits.slice(0, max), ok: anyOk };
}

/** 把检索结果拼成注入 prompt 的文本块 */
export function formatHits(hits: SearchHit[]): string {
  if (hits.length === 0) return '';
  return hits
    .map((h, i) => `[${i + 1}] ${h.title}\n    链接: ${h.url}\n    摘要: ${h.snippet || '（无摘要）'}`)
    .join('\n\n');
}
