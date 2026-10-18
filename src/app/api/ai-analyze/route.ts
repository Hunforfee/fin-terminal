import { NextRequest, NextResponse } from 'next/server';
import { searchStockContext, enrichHitsWithPages, formatHits } from '@/lib/aiSearch';
import { getValuation, getFinancial, getQuote, getCompanyProfile } from '@/lib/datasource';
import { aiConnection } from '@/lib/aiConnection';

/** 把站点自建的结构化数据（行情估值/财务摘要/公司资料）拼成注入 prompt 的文本块 */
async function buildLocalDataBlock(code: string): Promise<string> {
  const [quoteR, valuationR, financialR, profileR] = await Promise.allSettled([
    getQuote(code),
    getValuation(code),
    getFinancial(code),
    getCompanyProfile(code),
  ]);
  const parts: string[] = [];

  if (quoteR.status === 'fulfilled' && quoteR.value) {
    const q = quoteR.value;
    parts.push(
      `- 现价：${q.price} 元；总市值：${q.totalMarketCap != null ? q.totalMarketCap.toFixed(0) + ' 亿元' : '--'}；PE-TTM：${q.pe ?? '--'}；PB：${q.pb ?? '--'}（行情源 ${q.source}，${q.ts ?? ''}）`,
    );
  }

  if (valuationR.status === 'fulfilled') {
    const v = valuationR.value;
    const pc = (x: number | null | undefined) => (x != null ? `${x.toFixed(1)}%` : '--');
    parts.push(
      [
        `- PE-TTM 历史分位：${pc(v.pePercentile)}（越低越便宜，序列 ${v.years ?? 10} 年，口径 ${v.basis ?? 'real'}）`,
        `- PB 历史分位：${pc(v.pbPercentile)}`,
        v.dividendYield != null ? `- 股息率：${v.dividendYield.toFixed(2)}%（分位 ${pc(v.dyPercentile)}）` : '',
        v.roe != null ? `- 由 PB/PE 派生的 ROE：${v.roe.toFixed(2)}%` : '',
        v.netProfit != null ? `- 估算年化净利润：${v.netProfit.toFixed(0)} 亿元` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  if (financialR.status === 'fulfilled') {
    const f = financialR.value;
    const n = Math.min(f.periods.length, 5);
    if (n > 0) {
      const lines: string[] = [];
      for (let i = 0; i < n; i++) {
        const fmt = (x: number | null, suffix = '') => (x != null ? `${x}${suffix}` : '--');
        lines.push(
          `- ${f.periods[i]}：营收 ${fmt(f.revenue[i], ' 亿')}，净利 ${fmt(f.netProfit[i], ' 亿')}，营收同比 ${fmt(f.revenueGrowth?.[i], '%')}，净利同比 ${fmt(f.profitGrowth?.[i], '%')}，ROE ${fmt(f.roe[i], '%')}，毛利率 ${fmt(f.grossMargin?.[i], '%')}，负债率 ${fmt(f.debtRatio[i], '%')}`,
        );
      }
      parts.push(`近 ${n} 期定期报告（营收/净利单位：亿元）：\n${lines.join('\n')}`);
    }
  }

  if (profileR.status === 'fulfilled') {
    const p = profileR.value;
    parts.push(
      `- 控股股东：${p.holder ?? '--'}${p.holderRatio != null ? `（持股 ${p.holderRatio.toFixed(2)}%）` : ''}\n- 实控人：${p.controller ?? '--'}\n- 行业：${p.industryPath ?? p.industry ?? '--'}`,
    );
  }

  if (parts.length === 0) return '';
  return `\n\n─── 以下是本站数据库的量化数据（东财/新浪/腾讯公开接口核验）───\n${parts.join('\n\n')}\n─── 本站数据结束 ───\n\n使用要求：这些是平台核验过的结构化数据，可直接引用（注明"本站数据库"），且优先级高于模型记忆。`;
}

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * AI 深度分析：调用 OpenAI 兼容的 chat/completions 接口。
 *
 * 凭据来源（优先级从高到低）：
 *   1. 请求头 x-ai-key / x-ai-url / x-ai-model（用户在页面设置里填写，存于浏览器本地）
 *   2. 服务端环境变量 AI_API_KEY / AI_API_URL / AI_MODEL
 *
 * 未配置时返回 400 与明确提示，不做任何伪 AI 兜底。
 */


/**
 * 模型自适应降级：当指定模型不存在/未开通（400004 / model ... not exist / 402 未开通）时，
 * 依次尝试备用模型（仅对腾讯 TokenHub 生效，其他服务商只用用户指定模型）。
 */
const TOKENHUB_FALLBACKS = ['deepseek-v4.1-flash', 'glm-5.3-flash', 'kimi-k2.6', 'minimax-m2.7'];
const isTokenHub = (u: string) => u.includes('tokenhub.tencentmaas.com');
const isModelUnavailable = (status: number, text: string) =>
  (status === 400 && /400004|does not exist/i.test(text)) || status === 402;

function chatOnce(url: string, key: string, model: string, systemContent: string, userContent: string) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: userContent },
      ],
      temperature: 0.4,
    }),
    signal: AbortSignal.timeout(280000),
  });
}

export async function POST(req: NextRequest) {
  let body: { name?: string; code?: string; prompt?: string };
  try {
    const raw = await req.text();
    if (raw.length > 64000)
      return NextResponse.json({ ok: false, error: '请求内容过长' }, { status: 413 });
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400 });
  }

  if (!body || typeof body !== 'object' || Array.isArray(body) ||
    ['name', 'code', 'prompt'].some((field) => {
      const value = body[field as keyof typeof body];
      return value !== undefined && typeof value !== 'string';
    })) return NextResponse.json({ ok: false, error: '请求格式无效' }, { status: 400 });
  const name = (body.name ?? '').trim();
  const code = (body.code ?? '').trim();
  const prompt = (body.prompt ?? '').trim();
  if (!prompt) {
    return NextResponse.json({ ok: false, error: '提示词为空' }, { status: 400 });
  }

  let connection;
  try { connection = aiConnection(req.headers); } catch {
    return NextResponse.json({ ok: false, error: 'AI 接口地址无效' }, { status: 400 });
  }
  const { key, url, model } = connection;

  if (!key) {
    return NextResponse.json(
      {
        ok: false,
        error:
          '未配置 AI 接口。请在「AI 分析」面板的设置里填入 API Key（OpenAI 兼容格式，如 DeepSeek），或在服务端设置环境变量 AI_API_KEY / AI_API_URL / AI_MODEL。',
      },
      { status: 400 },
    );
  }

  // ── 第 1 步：联网检索最新资料（失败不阻塞），并对权威来源抓取正文全文 ──
  const { hits, ok: searchOk } = await searchStockContext(name, code);
  const enriched = await enrichHitsWithPages(hits, 4);
  const contextBlock = formatHits(enriched);

  // ── 第 1.5 步：注入本站数据库的量化数据（估值分位/财务/公司资料） ──
  const localDataBlock = await buildLocalDataBlock(code);

  const searchNote = searchOk
    ? `\n\n─── 以下是通过搜索引擎实时检索到的最新资料（权威来源已附网页正文节选）───\n${contextBlock}\n─── 检索资料结束 ───\n\n使用要求：\n1. 优先依据上述检索资料中的最新数据，引用时标注来源编号（如 [1]）与资料日期；\n2. 检索资料与你的既有知识冲突时，以检索资料为准并说明；\n3. 检索资料未覆盖的部分才使用你的知识，并明确标注“未核实（依据模型知识，截至训练时间）”；\n4. 绝不编造数字与来源。`
    : `\n\n（实时检索本次不可用，以下分析完全基于模型自身知识，时效性有限，请务必自行核对最新公告。）`;

  const userContent = `${prompt}\n\n分析对象：${name}（${code}）。要求：引用数据时注明来源与数据日期；对无法核实的数据明确标注“未核实”；不要编造数字。${localDataBlock}${searchNote}`;

  const systemContent = `你是一名严谨的基本面首席分析师，服务于专业投资者。输出结构化 Markdown（中文），必须包含：
1. 「信息来源」小节，列出实际引用的链接编号；
2. 核心结论前置（3-5 条要点）；
3. 业务与竞争格局分析（结合行业数据，避免空话）；
4. 财务质量分析（用提供的数据说话：营收/利润趋势、盈利能力、现金流/负债水平，给出同比变化）；
5. 估值判断（用提供的 PE/PB 历史分位数据，给出当前估值在历史中的位置，并区分"历史分位低"与"基本面恶化导致便宜"）；
6. 主要风险（具体、可证伪，不用"政策风险""市场风险"这类套话）；
7. 乐观/中性/悲观三情景推演，附关键假设。

要求：所有关键数字注明来源与日期；检索资料与本站数据优先于模型记忆；不确定的内容明确说明，绝不编造；宁可结论保守也不要夸夸其谈。`;

  // ── 第 2 步：调用模型（模型不可用时自动降级到备用模型） ──
  const triedModels = isTokenHub(url)
    ? [model, ...TOKENHUB_FALLBACKS.filter((m) => m !== model)]
    : [model];
  let upstream: Response | Error = new Error('no attempt');
  let usedModel = model;
  let lastErrText = '';
  for (const m of triedModels) {
    usedModel = m;
    const res = await chatOnce(url, key, m, systemContent, userContent).catch(
      (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
    );
    upstream = res;
    if (res instanceof Error) {
      lastErrText = res.message;
      break; // 网络错误换模型无意义
    }
    if (res.ok) break;
    lastErrText = await res.text().catch(() => '');
    if (!isModelUnavailable(res.status, lastErrText)) break; // 其他错误（如鉴权）不重试
  }

  if (upstream instanceof Error) {
    return NextResponse.json({ ok: false, error: `AI 接口请求失败：${upstream.message}` }, { status: 502 });
  }
  if (!upstream.ok) {
    return NextResponse.json(
      { ok: false, error: `AI 接口返回 ${upstream.status}：${lastErrText.slice(0, 300)}` },
      { status: 502 },
    );
  }

  const j = (await upstream.json().catch(() => null)) as { choices?: { message?: { content?: string } }[] } | null;
  const content = j?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    return NextResponse.json({ ok: false, error: 'AI 接口返回内容为空' }, { status: 502 });
  }

  return NextResponse.json({ ok: true, data: { content, model: usedModel, generatedAt: new Date().toISOString(), sources: hits.length } });
}
