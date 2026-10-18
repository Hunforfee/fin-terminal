import type { NextRequest } from 'next/server';
import { ok, fail, sp } from '@/lib/api';
import { getScreenMeta, screen } from '@/lib/datasource';
import { readValueScreenCriteria } from '@/lib/valueScreen';
import type { ValueScreenCriteria } from '@/lib/valueScreen';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET provides the classification/annual-period options; scans require an explicit POST. */
export async function GET(request: NextRequest) {
  if (sp(request).get('meta') === '1') return ok(getScreenMeta());
  return fail('请使用 POST /api/screen 提交年报日期和筛选条件，或使用 ?meta=1 查询筛选选项', 400);
}

export async function POST(request: NextRequest) {
  let raw: unknown;
  try { raw = await request.json(); }
  catch { return fail('请求体必须为有效 JSON', 400); }

  let criteria: ValueScreenCriteria;
  try {
    criteria = readValueScreenCriteria(raw, getScreenMeta().industries.map(industry => industry.name));
  } catch (error) {
    return fail(error instanceof Error ? error.message : '筛选条件无效', 400);
  }
  try { return ok(await screen(criteria)); }
  catch (error) {
    return fail(error instanceof Error ? error.message : '财报筛选暂不可用', 502);
  }
}
