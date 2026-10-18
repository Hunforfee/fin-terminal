import { NextRequest, NextResponse } from 'next/server';
import { searchStockContext, formatHits } from '@/lib/aiSearch';

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

const DEFAULT_URL = 'https://api.deepseek.com/v1/chat/completions';
const DEFAULT_MODEL = 'deepseek-chat';

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
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const name = (body.name ?? '').trim();
  const code = (body.code ?? '').trim();
  const prompt = (body.prompt ?? '').trim();
  if (!prompt) {
    return NextResponse.json({ ok: false, error: '提示词为空' }, { status: 400 });
  }

  const key = req.headers.get('x-ai-key') || process.env.AI_API_KEY || '';
  const url = req.headers.get('x-ai-url') || process.env.AI_API_URL || DEFAULT_URL;
  const model = req.headers.get('x-ai-model') || process.env.AI_MODEL || DEFAULT_MODEL;

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

  // ── 第 1 步：联网检索最新资料（失败不阻塞，模型继续用自身知识） ──
  const { hits, ok: searchOk } = await searchStockContext(name, code);
  const contextBlock = formatHits(hits);

  const searchNote = searchOk
    ? `\n\n─── 以下是通过搜索引擎实时检索到的最新资料（截取自结果摘要，可能不完整）───\n${contextBlock}\n─── 检索资料结束 ───\n\n使用要求：\n1. 优先依据上述检索资料中的最新数据，引用时标注来源编号（如 [1]）与资料日期；\n2. 检索资料与你的既有知识冲突时，以检索资料为准并说明；\n3. 检索资料未覆盖的部分才使用你的知识，并明确标注“未核实（依据模型知识，截至训练时间）”；\n4. 绝不编造数字与来源。`
    : `\n\n（实时检索本次不可用，以下分析完全基于模型自身知识，时效性有限，请务必自行核对最新公告。）`;

  const userContent = `${prompt}\n\n分析对象：${name}（${code}），A股上市公司。要求：引用数据时注明来源与数据日期；对无法核实的数据明确标注“未核实”；不要编造数字。${searchNote}`;

  const systemContent =
    '你是一名严谨的 A 股基本面分析师。你会收到用户提示词和一组实时检索到的网络资料摘要。输出结构化 Markdown（使用中文），在开头列出“信息来源”小节引用所用链接。所有关键数字注明来源与日期；不确定的内容明确说明，绝不编造。';

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
  const content = j?.choices?.[0]?.message?.content ?? '';
  if (!content) {
    return NextResponse.json({ ok: false, error: 'AI 接口返回内容为空' }, { status: 502 });
  }

  return NextResponse.json({ ok: true, data: { content, model: usedModel, generatedAt: new Date().toISOString(), sources: hits.length } });
}
