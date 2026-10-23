import { NextResponse } from 'next/server';
import { withMarketReadStatus } from './marketReadContext';

export async function marketOk<T>(read: () => Promise<T>) { return ok(await withMarketReadStatus(read)); }

/** 统一成功响应 */
export function ok<T>(data: T, init?: { cacheSeconds?: number }) {
  const headers: Record<string, string> = {};
  if (init?.cacheSeconds !== undefined) {
    headers['Cache-Control'] = `public, max-age=${init.cacheSeconds}, stale-while-revalidate=60`;
  } else {
    headers['Cache-Control'] = 'no-store';
  }
  return NextResponse.json({ ok: true, data }, { headers });
}

/** 统一失败响应 */
export function fail(message: string, status = 500, detail?: unknown) {
  return NextResponse.json(
    { ok: false, error: message, detail: detail === undefined ? undefined : String(detail) },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

/** 把 Provider 抛出的异常转成合适状态码 */
export function handle(e: unknown, fallbackMsg: string) {
  const msg = e instanceof Error ? e.message : String(e);
  const isNotFound = /无法解析|无法获取|not found/i.test(msg);
  return NextResponse.json(
    { ok: false, error: msg || fallbackMsg },
    { status: isNotFound ? 404 : 502 },
  );
}

export function sp(request: Request): URLSearchParams {
  return new URL(request.url).searchParams;
}
