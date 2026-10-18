import { NextRequest, NextResponse } from 'next/server';
import { aiConnection } from '@/lib/aiConnection';

export const dynamic = 'force-dynamic';

/**
 * GET /api/ai-models（凭据经请求头传入：x-ai-key / x-ai-url）
 * 拉取 OpenAI 兼容服务商的可用模型列表（GET {base}/v1/models）。
 * 例：url = https://tokenhub.tencentmaas.com/v1/chat/completions → GET .../v1/models
 */
export async function GET(req: NextRequest) {
  let connection;
  try { connection = aiConnection(req.headers); } catch {
    return NextResponse.json({ ok: false, error: 'AI 接口地址无效' }, { status: 400 });
  }
  const { key, url: chatUrl } = connection;
  if (!key) return NextResponse.json({ ok: false, error: '请先填写 API Key' }, { status: 400 });
  if (!chatUrl) return NextResponse.json({ ok: false, error: '请先选择服务商或填写接口地址' }, { status: 400 });

  // 从 chat/completions 地址推导 /models 地址
  const modelsUrl = chatUrl.replace(/\/chat\/completions\s*$/, '/models').replace(/\/v1\/?$/, '/v1/models');
  if (modelsUrl === chatUrl) {
    return NextResponse.json({ ok: false, error: '无法从接口地址推导模型列表地址' }, { status: 400 });
  }

  const r = await fetch(modelsUrl, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15000),
  }).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
  if (r instanceof Error) {
    return NextResponse.json({ ok: false, error: `模型列表请求失败：${r.message}` }, { status: 502 });
  }
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    return NextResponse.json({ ok: false, error: `模型列表返回 ${r.status}：${text.slice(0, 200)}` }, { status: 502 });
  }

  const j = (await r.json().catch(() => null)) as { data?: { id?: string }[] } | null;
  if (!Array.isArray(j?.data))
    return NextResponse.json({ ok: false, error: '模型列表返回格式无效' }, { status: 502 });
  const models = j.data.map((m) => typeof m?.id === 'string' ? m.id : '').filter(Boolean).sort();
  return NextResponse.json({ ok: true, data: { models } });
}
