import { NextRequest, NextResponse } from 'next/server';
import {
  readSession,
  sameOriginMutation,
  SESSION_COOKIE,
} from '@/lib/auth/session';
import { readAccountData, writeAccountData } from '@/lib/auth/accountData';
import { validateSnapshot } from '@/lib/personalStorage';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
export async function GET(request: NextRequest) {
  const user = readSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!user) return json({ ok: false, error: '请先登录' }, 401);
  try {
    return json({ ok: true, data: await readAccountData(user.id) });
  } catch {
    return json({ ok: false, error: '个人数据同步暂不可用' }, 503);
  }
}
export async function PUT(request: NextRequest) {
  if (!sameOriginMutation(request))
    return json({ ok: false, error: '请求来源无效' }, 403);
  const user = readSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!user) return json({ ok: false, error: '请先登录' }, 401);
  let body;
  try {
    const raw = await request.text();
    if (raw.length > 1200000)
      return json({ ok: false, error: '个人数据过大' }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: '请求格式无效' }, 400);
  }
  const data = validateSnapshot(body?.data);
  if (!data || !Number.isSafeInteger(body?.revision) || body.revision < 0)
    return json({ ok: false, error: '个人数据格式无效' }, 400);
  try {
    const saved = await writeAccountData(user.id, body.revision, data);
    if (!saved)
      return json(
        {
          ok: false,
          error: '另一台设备已更新数据，请重新同步',
          data: await readAccountData(user.id),
        },
        409,
      );
    return json({ ok: true, data: saved });
  } catch {
    return json({ ok: false, error: '个人数据同步暂不可用' }, 503);
  }
}
