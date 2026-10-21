import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { runMarketUpdateTick } from '@/lib/marketUpdateWorker';
import { runMarketMaintenance } from '@/lib/marketMaintenance';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
export async function POST(request: NextRequest) {
  const expected = process.env.MARKET_UPDATE_WORKER_TOKEN ?? '';
  const supplied = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  if (process.env.MARKET_UPDATE_WORKER_ENABLED !== '1' || expected.length < 32 || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied)))
    return NextResponse.json({ ok: false, error: '无效执行器凭证' }, { status: 401 });
  try {
    const maintenance=await runMarketMaintenance().catch(()=>{console.error('Market data retention sweep failed; records preserved');return {enabled:true,error:true};});
    return NextResponse.json({ ok: true, data: { ...await runMarketUpdateTick(),maintenance } }, { headers: { 'Cache-Control': 'no-store' } });
  }
  catch { return NextResponse.json({ ok: false, error: '后台更新暂不可用' }, { status: 503 }); }
}
