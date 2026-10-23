import { NextRequest, NextResponse } from 'next/server';
import { gunzipSync } from 'node:zlib';
import { getMarketStore } from '@/lib/marketStore';
import { remoteMarketDataEnabled, readMarketBody, MarketDataApiError } from '@/lib/marketDataClient';
import { readMaintainIdentity } from '@/lib/marketMaintainAuth';
import { allowAttempt } from '@/lib/auth/limits';
import { BatchImportError } from '@/lib/marketBatchImport';
import { submitImportJob, readImportJob, changeImportJob, publicImportJob } from '@/lib/marketImportJobs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
const LIMIT=8*1024*1024;
const json=(body:unknown,status=200)=>NextResponse.json(body,{status,headers:{'Cache-Control':'no-store'}});
async function serve(request:NextRequest) {
  const identity=readMaintainIdentity(request);
  if(!identity)return json({ok:false,error:'维护接口凭证无效或尚未配置'},401);
  if(remoteMarketDataEnabled())return json({ok:false,error:'请向原数据服务器提交批量导入'},503);
  if(!allowAttempt(`market-import-batch:${identity.tokenId}`,120,60000))return json({ok:false,error:'请求过于频繁'},429);
  try{
    const store=getMarketStore();if(!store)return json({ok:false,error:'市场数据库不可用'},503);
    if(request.method==='GET'){
      const row=await readImportJob(store,identity.tokenId,request.nextUrl.searchParams.get('jobId')??'');
      return json({ok:true,data:publicImportJob(row.payload)});
    }
    const encoding=request.headers.get('content-encoding');
    if(encoding && encoding!=='identity' && encoding!=='gzip')return json({ok:false,error:'仅支持JSON或gzip压缩JSON'},415);
    let bytes:Uint8Array=await readMarketBody(request,LIMIT);
    if(encoding==='gzip'){
      try{bytes=gunzipSync(bytes,{maxOutputLength:LIMIT});}catch{return json({ok:false,error:'gzip无效或解压后超过8MiB'},413);}
    }
    let body:any;try{body=JSON.parse(new TextDecoder().decode(bytes));}catch{return json({ok:false,error:'请求须为有效JSON'},400);}
    if(body?.action==='retry'||body?.action==='cancel')return json({ok:true,data:publicImportJob(await changeImportJob(store,identity.tokenId,String(body.jobId??''),body.action))});
    if(body?.action!==undefined && body.action!=='submit')throw new BatchImportError('action须为submit/retry/cancel');
    const result=await submitImportJob(store,identity.tokenId,identity.operator,body);
    return json({ok:true,reused:result.reused,data:publicImportJob(result.job),workerConfigured:process.env.MARKET_UPDATE_WORKER_ENABLED==='1'},result.reused?200:202);
  }catch(e){return json({ok:false,error:e instanceof BatchImportError?e.message:e instanceof MarketDataApiError?e.message:'批量导入服务暂不可用，请使用相同幂等键重试'},e instanceof BatchImportError||e instanceof MarketDataApiError?e.status:503);}
}
export const GET=serve;
export const POST=serve;
