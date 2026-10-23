import { createHash, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { readMaintainIdentity } from '@/lib/marketMaintainAuth';
import { getMarketStore } from '@/lib/marketStore';
import { remoteMarketDataEnabled } from '@/lib/marketDataClient';
import { runMarketImportTick } from '@/lib/marketImportJobs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=120;
export async function POST(request:NextRequest) {
  const expected=process.env.MARKET_UPDATE_WORKER_TOKEN??'',supplied=request.headers.get('authorization')?.match(/^Bearer (\S+)$/)?.[1]??'';
  const hash=(s:string)=>createHash('sha256').update(s).digest();
  const worker=process.env.MARKET_UPDATE_WORKER_ENABLED==='1' && expected.length>=32 && supplied.length<=512 && timingSafeEqual(hash(expected),hash(supplied));
  if(!worker && !readMaintainIdentity(request))return NextResponse.json({ok:false,error:'无效执行器凭证'},{status:401});
  if(remoteMarketDataEnabled())return NextResponse.json({ok:false,error:'执行器须运行在原数据服务器'},{status:503});
  try{return NextResponse.json({ok:true,data:await runMarketImportTick(getMarketStore())},{headers:{'Cache-Control':'no-store'}});}
  catch{return NextResponse.json({ok:false,error:'批量导入执行暂不可用，任务已保留，可安全续跑'},{status:503});}
}
