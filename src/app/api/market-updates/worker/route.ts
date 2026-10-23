import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { runMarketUpdateTick } from '@/lib/marketUpdateWorker';
import { runMarketMaintenance } from '@/lib/marketMaintenance';
import { scheduleMarketClose, scheduleFinancialRefresh } from '@/lib/marketCollection';
import { auditSavedMarketData } from '@/lib/marketAudit';
import { getMarketStore } from '@/lib/marketStore';
import { runMarketImportTick } from '@/lib/marketImportJobs';
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
    const store=getMarketStore();
    const schedule=process.env.MARKET_CLOSE_UPDATE_ENABLED==='1' && store ? await scheduleMarketClose(store).catch(()=>({error:true})) : {enabled:false};
    const financialSchedule=process.env.MARKET_CLOSE_UPDATE_ENABLED==='1' && store ? await scheduleFinancialRefresh(store).catch(()=>({error:true})) : {enabled:false};
    const audit=store ? await auditSavedMarketData(store).catch(()=>({error:true})) : {enabled:false};
    const importBatch=await runMarketImportTick(store).catch(()=>({processed:false,error:true}));
    return NextResponse.json({ ok: true, data: { ...await runMarketUpdateTick(),maintenance,schedule,financialSchedule,audit,importBatch } }, { headers: { 'Cache-Control': 'no-store' } });
  }
  catch { return NextResponse.json({ ok: false, error: '后台更新暂不可用' }, { status: 503 }); }
}
