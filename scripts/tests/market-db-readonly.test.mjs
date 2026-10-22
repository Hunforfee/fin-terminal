import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';
import {load} from './load-modules.mjs';
const market=await load('marketStore');
const TOKEN='isolated-readonly-test-token-32-characters';
function endpoint(store){
 const exports={};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/api/market/db/route.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{
  exports,Date,process:{env:{MARKET_READONLY_TOKEN:TOKEN}},
  require(name){
   if(name==='next/server')return {NextResponse:{json:(body,o)=>({body,status:o?.status??200})}};
   if(name==='node:crypto')return crypto;
   if(name==='@/lib/marketStore')return {getMarketReadStore:()=>store};
   throw Error(name);
  },
 });return exports;
}
function request(params={},token=TOKEN){const u=new URL('https://site.test/api/market/db');for(const [k,v]of Object.entries(params))u.searchParams.set(k,v);return {nextUrl:u,headers:new Headers(token?{'x-fin-readonly-token':token}:{})};}

test('only header credentials and whitelisted market keys can read; private data and URL tokens cannot',async()=>{
 let reads=0;const api=endpoint({read:async()=>{reads++;return {payload:'market record'};}});
 assert.equal((await api.GET(request({key:'shares-v3:000923'},null))).status,401);
 assert.equal((await api.GET(request({key:'shares-v3:000923',token:TOKEN},null))).status,401);
 assert.equal((await api.GET(request({key:'shares-v3:000923',token:TOKEN}))).status,400);
 for(const key of ['import-log:v1','market-collection-registry:v1','market-update-queue:v1'])assert.equal((await api.GET(request({key}))).status,403);
 assert.equal(reads,0);assert.equal((await api.GET(request({key:'shares-v3:000923'}))).status,200);assert.equal(reads,1);
});
test('prefix pagination uses a bounded cursor and malformed input fails before querying',async()=>{
 let scans=0;
 const api=endpoint({scanPrefix:async(prefix,limit,after)=>{scans++;assert.equal(limit,3);return ['shares-v3:000001','shares-v3:000002','shares-v3:000003'].filter(key=>key>after).map(key=>({key}));}});
 const page=await api.GET(request({prefix:'shares-v3:',limit:'2'}));assert.equal(page.status,200);assert.equal(page.body.nextCursor,'shares-v3:000002');assert.equal(page.body.count,2);
 const next=await api.GET(request({prefix:'shares-v3:',limit:'2',after:page.body.nextCursor}));assert.equal(next.body.count,1);assert.equal(next.body.nextCursor,null);
 for(const params of [{prefix:'shares-v3:',limit:'NaN'},{prefix:'shares-v3:',limit:'1.1'},{prefix:'shares-v3:',limit:'201'},{prefix:'shares-v3:',payload:'1',limit:'21'},{key:'shares-v3:000923',sql:'SELECT secret'},{key:'shares-v3:000923',prefix:'shares-v3:'},{keys:Array(21).fill('shares-v3:000923').join(',')}])assert.equal((await api.GET(request(params))).status,400);
 assert.equal(scans,2);
});
test('history reads are bounded and storage failures are not silently reported as absent records',async()=>{
 const api=endpoint({read:async()=>{throw Error('postgres://sensitive credentials');},readVersions:async(key,limit)=>{assert.equal(limit,4);return [{key,payload:{dates:['2024-03-31']}}];}});
 assert.equal((await api.GET(request({key:'shares-v3:000923',versions:'1'}))).body.records.length,1);
 const bad=await api.GET(request({key:'shares-v3:000923'}));assert.equal(bad.status,503);assert.equal(JSON.stringify(bad).includes('sensitive'),false);
});
test('one process bounds read traffic',async()=>{
 const api=endpoint({read:async()=>null});
 for(let i=0;i<120;i++)assert.equal((await api.GET(request({key:'shares-v3:000923'}))).status,404);
 assert.equal((await api.GET(request({key:'shares-v3:000923'}))).status,429);
});
test('file metadata pagination and old versions retain full validated records',async()=>{
 const root=path.resolve('data');await fsp.mkdir(root,{recursive:true});
 const dir=await fsp.mkdtemp(path.join(root,'readonly-test-'));
 try{
  const store=market.fileMarketStore(dir),key='kline:v2:sh600415:day:none:canonical:prices-only';
  const p={candles:[{date:'2026-10-20',open:10,high:10,low:10,close:10}]};
  const first=market.marketRecord(key,'kline','qmt',p,1e6);assert.equal(await store.write(first,null),true);
  const second=market.marketRecord(key,'kline','qmt',{...p,complete:true},1e6);assert.equal(await store.write(second,first.digest),true);
  const meta=await store.scanPrefix('kline:v2:',5);assert.equal(meta.length,1);assert.equal('payload' in meta[0],false);
  const versions=await store.readVersions(key,4);assert.equal(versions[0].payload.candles.length,1);assert.equal(versions[0].digest,first.digest);
 }finally{assert.ok(path.resolve(dir).startsWith(root+path.sep));await fsp.rm(dir,{recursive:true,force:true});}
});
test('diagnostic PostgreSQL reader performs no schema setup or writes and lists bar metadata without hashing missing candles',async()=>{
 const statements=[],meta={key:'kline:v2:sh600415:day:none:canonical:prices-only',kind:'kline',source:'tdx',digest:'f'.repeat(64)};
 const pool={query:async(sql,args)=>{statements.push({sql,args});return {rows:[meta]};},end:async()=>{}};
 const store=market.postgresMarketStore('test-only',async()=>pool,{initialize:false,readOnly:true});
 assert.equal((await store.scanPrefix('kline:v2:',2))[0].key,meta.key);
 assert.equal(statements.length,1);assert.match(statements[0].sql,/SELECT key/);assert.doesNotMatch(statements[0].sql,/CREATE|INSERT|UPDATE|DELETE/);
 await assert.rejects(store.write({},null),/只读/);await assert.rejects(store.remove('k','d'),/只读/);await assert.rejects(store.writeInputs([]),/只读/);await assert.rejects(store.pruneAux(Date.now()),/只读/);await assert.rejects(store.incident('k','reason'),/只读/);
 assert.equal(statements.length,1);
});
