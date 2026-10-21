import { NextRequest, NextResponse } from 'next/server';

// 行情数据查看器反代：/market-data/* → 本地只读查看器（127.0.0.1:3112）
// 查看器自身会剥离 /market-data 前缀，因此这里原样转发路径与查询串。
// 只转发 GET/HEAD——查看器没有任何写路径，其他方法一律 405。

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const VIEWER_ORIGIN = process.env.MARKET_VIEWER_ORIGIN || 'http://127.0.0.1:3112';
const MAX_BODY = 32 * 1024 * 1024; // 32MB，足够最大的 JSON 记录页

async function proxy(request: NextRequest, method: 'GET' | 'HEAD') {
  const target = new URL(request.nextUrl.pathname + request.nextUrl.search, VIEWER_ORIGIN);
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers: { accept: request.headers.get('accept') ?? '*/*' },
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json(
      { error: '数据查看器服务未响应（127.0.0.1:3112）。若刚重启沙箱，请确认 market-data-viewer 已随自启动拉起。' },
      { status: 502 }
    );
  }
  const buf = await upstream.arrayBuffer();
  if (buf.byteLength > MAX_BODY) {
    return NextResponse.json({ error: '响应过大' }, { status: 502 });
  }
  return new NextResponse(method === 'HEAD' ? null : buf, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export async function GET(request: NextRequest) {
  return proxy(request, 'GET');
}

export async function HEAD(request: NextRequest) {
  return proxy(request, 'HEAD');
}

export async function POST() {
  return NextResponse.json({ error: '数据查看器为只读，不支持写操作' }, { status: 405 });
}
