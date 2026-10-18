/**
 * AI 分析前的联网检索：用 Bing 中文搜索抓取最新资料摘要，作为模型上下文。
 * 不依赖任何额外 API Key；搜索失败时返回空结果，主流程继续（模型仅凭自身知识作答）。
 */

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  /** 网页正文全文（可选，抓取成功时填充） */
  content?: string;
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

/** 解析搜狗结果页（h3>a 块；链接多为 /link?url= 跳转，fetch 会自动跟随 302） */
function parseSogou(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const blocks = html.split(/<h3[^>]*>/).slice(1);
  for (const block of blocks) {
    const linkM = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!linkM) continue;
    let url = decodeEntities(linkM[1]);
    if (url.startsWith('/')) url = `https://www.sogou.com${url}`;
    if (!/^https?:\/\//.test(url)) continue;
    const title = stripTags(linkM[2]);
    if (!url || !title) continue;
    hits.push({ title, url, snippet: '' });
  }
  return hits;
}

async function sogouSearch(query: string, timeoutMs = 15000): Promise<SearchHit[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = `https://www.sogou.com/web?query=${encodeURIComponent(query)}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: ctrl.signal,
    });
    if (!r.ok) return [];
    return parseSogou(await r.text());
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
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

/** 单查询检索：搜狗优先（中文结果质量好、不拆词），Bing 兜底 */
async function webSearch(query: string): Promise<SearchHit[]> {
  const sogou = await sogouSearch(query);
  if (sogou.length > 0) return sogou;
  return bingSearch(query);
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
  const settled = await Promise.allSettled(queries.map((q) => webSearch(q)));
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  let anyOk = false;
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue;
    if (s.value.length > 0) anyOk = true;
    for (const h of s.value) {
      // 去重键：普通链接按 host+path；搜狗 /link?url= 跳转链接 path 都相同，改用完整 URL
      const u = new URL(h.url);
      const key = /^\/link\b/.test(u.pathname) ? h.url : u.hostname + u.pathname;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(h);
    }
  }
  // 相关性分级：标题命中公司名（含简称别名）/代码的排前，完全不相关的直接过滤
  // 别名：去掉「控股/集团/股份」后缀；再去掉省市前缀（贵州茅台→茅台）
  const PROVINCE = '北京|上海|天津|重庆|内蒙古|广西|西藏|新疆|宁夏|黑龙江|辽宁|吉林|河北|河南|山东|山西|江苏|浙江|安徽|福建|江西|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海';
  const base = name.replace(/(控股|集团|股份)$/, '');
  const alias = [name, code, base];
  const noProv = new RegExp(`^(?:${PROVINCE})`).test(base) ? base.replace(new RegExp(`^(?:${PROVINCE})`), '') : '';
  if (noProv.length >= 2) alias.push(noProv);
  const rel = (h: SearchHit) => (alias.some((a) => a.length >= 2 && h.title.includes(a)) ? 0 : 2);
  const kept = hits.filter((h) => rel(h) < 2);
  // 保底：相关结果不足 3 条（如搜索源限频）时，放宽补入低相关结果，避免空上下文
  const ranked = kept.length >= 3 ? kept : [...kept, ...hits.filter((h) => rel(h) === 2)];
  // 优先保留巨潮/交易所/官方等权威来源
  const weight = (u: string) =>
    /cninfo|sse\.com\.cn|szse\.cn|eastmoney|sina|10jqka|cs\.com\.cn|stcn\.com/.test(u) ? 0 : 1;
  ranked.sort((a, b) => weight(a.url) - weight(b.url));
  return { hits: ranked.slice(0, max), ok: anyOk };
}

/** 把检索结果拼成注入 prompt 的文本块（有全文的附全文节选） */
export function formatHits(hits: SearchHit[]): string {
  if (hits.length === 0) return '';
  return hits
    .map((h, i) => {
      const head = `[${i + 1}] ${h.title}\n    链接: ${h.url}\n    摘要: ${h.snippet || '（无摘要）'}`;
      return h.content ? `${head}\n    正文节选: ${h.content}` : head;
    })
    .join('\n\n');
}

/** 抓取网页正文纯文本（供模型精读，截断 maxChars） */
export async function fetchPageText(url: string, maxChars = 3000, timeoutMs = 12000): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: ctrl.signal,
    });
    if (!r.ok) return '';
    const ct = r.headers.get('content-type') ?? '';
    if (!/text\/html|text\/plain/.test(ct)) return '';
    const html = await r.text();
    // 去掉 script/style 及注释，保留正文
    const body = html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' ');
    const text = decodeEntities(body).replace(/\s+/g, ' ').trim();
    return text.slice(0, maxChars);
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/** 对检索结果并行抓取正文（只抓前 N 条，失败跳过） */
export async function enrichHitsWithPages(
  hits: SearchHit[],
  topN = 4,
): Promise<SearchHit[]> {
  const top = hits.slice(0, topN);
  const texts = await Promise.all(top.map((h) => fetchPageText(h.url)));
  return hits.map((h, i) => {
    const idx = top.indexOf(h);
    return idx >= 0 && texts[idx] ? { ...h, content: texts[idx] } : h;
  }) as (SearchHit & { content?: string })[] as SearchHit[];
}
