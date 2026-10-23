import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import ts from 'typescript';import zlib from 'node:zlib';
import {load} from './load-modules.mjs';
const jobs=await load('marketImportJobs'),batch=await load('marketBatchImport'),auth=await load('marketMaintainAuth'),client=await load('marketDataClient'),market=await load('marketStore');
const token='isolated-batch-route-token-at-least-32-characters';
function endpoint(){const data=new Map(),store={read:async k=>data.get(k)??null,write:async(r,d)=>{if((data.get(r.key)?.digest??null)!==d)return false;data.set(r.key,r);return true;},incident:async()=>{}};let remote=false;
 const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/api/market/import-batch/route.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports,process,TextDecoder,Uint8Array,
 require(name){if(name==='next/server')return {NextResponse:{json:(body,opts)=>({body,status:opts?.status??200})}};if(name==='node:zlib')return zlib;
 if(name==='@/lib/marketStore')return {getMarketStore:()=>store};if(name==='@/lib/marketDataClient')return {...client,remoteMarketDataEnabled:()=>remote};
 if(name==='@/lib/marketMaintainAuth')return auth;if(name==='@/lib/auth/limits')return {allowAttempt:()=>true};if(name==='@/lib/marketBatchImport')return batch;if(name==='@/lib/marketImportJobs')return jobs;throw Error(name);}});
 return {api:exports,data,remote:()=>{remote=true;}};}
const input={idempotencyKey:'route-1',proof:{source:'qmt',reference:'QMT source package verified',files:[{name:'data.zip',sha256:'a'.repeat(64)}]},rebuild:false,items:[{type:'finance',record:{symbol:'600415',statement:'profit',reportDates:['2025-12-31'],items:[{name:'归属于母公司所有者的净利润',vals:[1]}]}}]};
function request(method,body,headers={},query=''){const r=new Request('https://test.invalid/api/market/import-batch'+query,{method,headers,body:method==='POST'?body:undefined});Object.defineProperty(r,'nextUrl',{value:new URL(r.url)});return r;}
test('machine auth, gzip submit, polling, malformed requests and remote guard',async()=>{
 const old=process.env.MARKET_MAINTENANCE_TOKEN;process.env.MARKET_MAINTENANCE_TOKEN=token;
 try{const {api,data,remote}=endpoint();assert.equal((await api.POST(request('POST',JSON.stringify(input)))).status,401);assert.equal(data.size,0);
 const headers={'x-fin-maintain-token':token,'Content-Encoding':'gzip'};
 const first=await api.POST(request('POST',zlib.gzipSync(JSON.stringify(input)),headers));assert.equal(first.status,202);assert.equal(first.body.data.total,1);
 const again=await api.POST(request('POST',zlib.gzipSync(JSON.stringify(input)),headers));assert.equal(again.status,200);assert.equal(again.body.reused,true);
 const poll=await api.GET(request('GET',undefined,{'x-fin-maintain-token':token},'?jobId='+first.body.data.id));assert.equal(poll.status,200);assert.equal(poll.body.data.state,'queued');
 assert.equal((await api.POST(request('POST','not-json',{'x-fin-maintain-token':token}))).status,400);
 assert.equal((await api.POST(request('POST',zlib.gzipSync(Buffer.alloc(9*1024*1024,65)),headers))).status,413);
 remote();assert.equal((await api.POST(request('POST',JSON.stringify(input),{'x-fin-maintain-token':token}))).status,503);
 }finally{if(old===undefined)delete process.env.MARKET_MAINTENANCE_TOKEN;else process.env.MARKET_MAINTENANCE_TOKEN=old;}
});
