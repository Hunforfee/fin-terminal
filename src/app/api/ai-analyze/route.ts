import { NextRequest, NextResponse } from 'next/server';

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

  const userContent = `${prompt}\n\n分析对象：${name}（${code}），A股上市公司。要求：引用数据时注明来源与数据日期；对无法核实的数据明确标注“未核实”；不要编造数字。`;

  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content:
            '你是一名严谨的 A 股基本面分析师。基于你掌握的知识与最新公开信息进行分析，输出结构化 Markdown（使用中文）。所有关键数字都注明来源与日期；不确定的内容明确说明，绝不编造。',
        },
        { role: 'user', content: userContent },
      ],
      temperature: 0.4,
    }),
  }).catch((e) => e instanceof Error ? e : new Error(String(e)));

  if (upstream instanceof Error) {
    return NextResponse.json({ ok: false, error: `AI 接口请求失败：${upstream.message}` }, { status: 502 });
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    return NextResponse.json(
      { ok: false, error: `AI 接口返回 ${upstream.status}：${text.slice(0, 300)}` },
      { status: 502 },
    );
  }

  const j = (await upstream.json().catch(() => null)) as { choices?: { message?: { content?: string } }[] } | null;
  const content = j?.choices?.[0]?.message?.content ?? '';
  if (!content) {
    return NextResponse.json({ ok: false, error: 'AI 接口返回内容为空' }, { status: 502 });
  }

  return NextResponse.json({ ok: true, data: { content, model, generatedAt: new Date().toISOString() } });
}
