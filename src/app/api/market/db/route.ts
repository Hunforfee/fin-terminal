import { NextRequest, NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'node:crypto';
import { getMarketReadStore } from '@/lib/marketStore';
export const runtime='nodejs';
export const dynamic='force-dynamic';
const json=(body:unknown,status=200)=>NextResponse.json(body,{status,headers:{'Cache-Control':'no-store'}});
const families=['kline:v2:','source-sina-page:v1:','source-sina-indicators:v1:','statements-v3:',
 'shares-v3:','disclosures-v3:','implemented-dividends-v4:','dividend-plans-v2:',
 'deducted-periods:v1:','source-debt-ratios:v1:','source-interest-expenses:v1:',
 'screen-company-input:v1:','watchlist-financial-inputs:v1:','market-coverage:v1:',
 'security-basics:v1:','source-hk-indicators:v1:','source-hk-statement:v1:',
 'hk-main-currency-v4:','hk-dividend-events-v4:'];
const allowed=(key:string,prefix=false)=>key.length<=300 && /^[a-zA-Z0-9:._-]+$/.test(key)
 && families.some(f=>key.startsWith(f) && (prefix || key.length>f.length));
const hash=(s:string)=>createHash('sha256').update(s).digest();
let windowStart=0,requests=0;
/** Fixed public-market queries. No owner registries, queues, import logs, personal tables or SQL. */
export async function GET(request:NextRequest){
 const expected=process.env.MARKET_READONLY_TOKEN;
 if(!expected || expected.length<32)return json({ok:false,error:'not found'},404);
 const got=request.headers.get('x-fin-readonly-token') ?? request.headers.get('authorization')?.match(/^Bearer (\S+)$/)?.[1];
 if(!got || got.length>512 || !timingSafeEqual(hash(got),hash(expected)))return json({ok:false,error:'invalid token'},401);
 const now=Date.now();if(now-windowStart>=60000){windowStart=now;requests=0;}
 if(++requests>120)return json({ok:false,error:'query rate exceeded; retry in one minute'},429);
 const sp=request.nextUrl.searchParams,key=sp.get('key'),keysParam=sp.get('keys'),prefix=sp.get('prefix');
 if(sp.has('token') || sp.has('sql'))return json({ok:false,error:'URL tokens and SQL are not supported'},400);
 if([key,keysParam,prefix].filter(v=>v!==null).length!==1)return json({ok:false,error:'provide exactly one of key, keys or prefix'},400);
 if(key && !allowed(key) || prefix && !allowed(prefix,true))return json({ok:false,error:'market key not allowed'},403);
 const limit=Number(sp.get('limit')??50);
 if(!Number.isSafeInteger(limit) || limit<1 || limit>200)return json({ok:false,error:'limit must be an integer from 1 to 200'},400);
 const store=getMarketReadStore();if(!store)return json({ok:false,error:'market store unavailable'},503);
 try{
  if(key){
   if(sp.get('versions')==='1'){
    if(!store.readVersions)return json({ok:false,error:'version reads unavailable'},501);
    return json({ok:true,key,versions:true,records:await store.readVersions(key,Math.min(limit,4))});
   }
   const record=await store.read(key);return record?json({ok:true,record}):json({ok:false,error:'not found',key},404);
  }
  if(keysParam){
   const keys=keysParam.split(',').map(s=>s.trim());
   if(!keys.length || keys.length>20 || keys.some(k=>!allowed(k)))return json({ok:false,error:'provide 1 to 20 allowed market keys'},400);
   const records=[];for(const k of keys){const record=await store.read(k);records.push(record?{key:k,found:true,record}:{key:k,found:false});}
   return json({ok:true,records});
  }
  if(prefix){
   const after=sp.get('after')??'';
   if(after && (!allowed(after) || !after.startsWith(prefix)))return json({ok:false,error:'invalid cursor'},400);
   const withPayload=sp.get('payload')==='1';
   if(withPayload && limit>20)return json({ok:false,error:'payload queries allow at most 20 records'},400);
   if(!store.scanPrefix)return json({ok:false,error:'prefix scans unavailable'},501);
   const found=await store.scanPrefix(prefix,limit+1,after),more=found.length>limit,records=[];
   for(const meta of found.slice(0,limit))records.push(withPayload?await store.read(meta.key)??meta:meta);
   return json({ok:true,prefix,count:records.length,records,truncated:more,nextCursor:more?found[limit-1].key:null});
  }
  return json({ok:false,error:'empty query'},400);
 }catch{return json({ok:false,error:'market store query failed'},503);}
}
