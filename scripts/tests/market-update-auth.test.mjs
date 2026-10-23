import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { load } from './load-modules.mjs';
const { updateIdentity, localUpdatePreview } = await load('marketUpdateAuth');
const { WATCHLIST_KEY } = await load('watchlist');
const req=(token,host='site.test')=>({url:`https://${host}/api/market-updates`,headers:new Headers({host,...(token?{authorization:`Bearer ${token}`}:{})}),cookies:{get:()=>undefined}});

test('current signed-cookie account takes precedence over a retired Cloud token',async()=>{
  const exported={};let reads=0;
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/marketUpdateAuth.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{
    exports:exported,process:{env:{}},URL,Buffer,
    require(name){
      if(name==='node:crypto')return {};
      if(name==='./cloudPublic')return {cloudPublicConfig:{}};
      if(name==='./auth/session')return {SESSION_COOKIE:'fin_session',readSession:token=>token==='signed-cookie'?{id:'current-account'}:null};
      if(name==='./auth/accountData')return {readAccountData:async id=>{assert.equal(id,'current-account');reads++;return {data:{list:JSON.stringify({groups:[{id:'core'}]})}};}};
      if(name==='./watchlist')return {WATCHLIST_KEY:'list',readWatchlist:value=>value,watchCodes:()=>['sh600519']};
      if(name==='./marketUpdateQueue')return {UpdateQueueError:class extends Error{}};
      throw Error(name);
    },
    fetch(){throw Error('Retired Cloud credentials must not be used');},
  });
  const request=req('retired-cloud-token');request.cookies.get=()=>({value:'signed-cookie'});
  assert.equal((await exported.updateIdentity(request)).owner,'legacy:current-account');
  const scoped=await exported.updateIdentity(request,'core');assert.equal(scoped.allowed[0],'sh600519');
  await assert.rejects(exported.updateIdentity(request,'foreign'),/尚未同步/);assert.equal(reads,2);
});
test('cloud identities are verified remotely and group permissions come from RLS data',async()=>{
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async(url,options)=>{
    calls++;assert.equal(options.headers.Authorization,'Bearer test-real-token');assert.ok(String(url).startsWith('https://a-share-fin-terminal.app.workbuddy.host/.cloud/'));
    if(String(url).includes('/auth/'))return Response.json({sub:'verified-one'});
    return Response.json([{data:{[WATCHLIST_KEY]:JSON.stringify({version:2,groups:[{id:'core',name:'核心'}],items:[{symbol:'sh600519',groupId:'core'}]})}}]);
  };
  try{
    const value=await updateIdentity(req('test-real-token'),'core');
    assert.equal(value.owner,'cloud:verified-one');assert.deepEqual(value.allowed,['sh600519']);assert.equal(calls,2);
    await assert.rejects(updateIdentity(req('test-real-token'),'foreign-group'),/尚未同步/);
  }finally{globalThis.fetch=original;}
});
test('invalid or anonymous cloud tokens cannot queue public-data work',async()=>{
  const original=globalThis.fetch;
  try{
    globalThis.fetch=async()=>new Response('',{status:401});await assert.rejects(updateIdentity(req('bad-token')),/重新登录/);
    globalThis.fetch=async()=>Response.json({sub:'anonymous',is_anonymous:true});await assert.rejects(updateIdentity(req('anon-token')),/先登录/);
    await assert.rejects(updateIdentity(req()),/先登录/);
  }finally{globalThis.fetch=original;}
});
test('local preview bypass requires an explicit flag and both loopback URL and Host',()=>{
  const before=process.env.MARKET_UPDATE_LOCAL_PREVIEW;
  try{
    delete process.env.MARKET_UPDATE_LOCAL_PREVIEW;assert.equal(localUpdatePreview(req(null,'127.0.0.1')),false);
    process.env.MARKET_UPDATE_LOCAL_PREVIEW='1';assert.equal(localUpdatePreview(req(null,'127.0.0.1')),true);assert.equal(localUpdatePreview(req(null,'site.test')),false);
    const spoof=req(null,'127.0.0.1');spoof.headers.set('host','site.test');assert.equal(localUpdatePreview(spoof),false);
  }finally{if(before===undefined)delete process.env.MARKET_UPDATE_LOCAL_PREVIEW;else process.env.MARKET_UPDATE_LOCAL_PREVIEW=before;}
});
test('route rejects foreign group symbols, cross-site creation and oversized body',async()=>{
  const exported={},submitted=[];
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/api/market-updates/route.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{
    exports:exported,TextDecoder,process:{env:{MARKET_UPDATE_WORKER_ENABLED:'1',MARKET_UPDATE_WORKER_TOKEN:'x'.repeat(40),MARKET_DATABASE_URL:'configured'}},
    require(name){
      if(name==='next/server')return {NextResponse:{json:(body,options)=>({body,status:options?.status??200})}};
      if(name==='@/lib/marketImportAuth')return {denyReason:()=>null};
      if(name==='@/lib/marketStore')return {getMarketStore:()=>({})};
      if(name==='@/lib/marketCollection')return {registerCollection:async()=>{}};
      if(name==='@/lib/marketUpdateAuth')return {localUpdatePreview:()=>false,updateIdentity:async()=>({owner:'real',allowed:['sh600519']})};
      if(name==='@/lib/auth/session')return {sameOriginMutation:r=>r.safe};
      if(name==='@/lib/marketUpdateQueue')return {UpdateQueueError:class extends Error{constructor(m,status){super(m);this.status=status;}},updateSymbols:v=>v,MarketUpdateQueue:class{async submit(...args){submitted.push(args);return {id:'job'};}}};
      throw Error(name);
    },
  });
  const rawRequest=(raw,safe=true)=>({safe,headers:new Headers(),body:new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(raw));controller.close();}})});
  const request=(codes,safe=true)=>rawRequest(JSON.stringify({groupId:'all',codes}),safe);
  assert.equal((await exported.POST(request(['sh600519'],false))).status,403);
  assert.equal((await exported.POST(request(['sh600000']))).status,403);
  assert.equal((await exported.POST(rawRequest('x'.repeat(25001)))).status,413);
  assert.equal((await exported.POST(request(['sh600519']))).status,200);assert.equal(submitted.length,1);
});

test('single-stock fill needs no group sync and DELETE stops only the caller',async()=>{
  const exported={},submitted=[],cancelled=[];
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/api/market-updates/route.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{
    exports:exported,TextDecoder,process:{env:{MARKET_UPDATE_WORKER_ENABLED:'1',MARKET_UPDATE_WORKER_TOKEN:'x'.repeat(40),MARKET_DATABASE_URL:'configured'}},
    require(name){
      if(name==='next/server')return {NextResponse:{json:(body,options)=>({body,status:options?.status??200})}};
      if(name==='@/lib/marketImportAuth')return {denyReason:()=>null};
      if(name==='@/lib/marketStore')return {getMarketStore:()=>({})};
      if(name==='@/lib/marketCollection')return {registerCollection:async()=>{}};
      if(name==='@/lib/marketUpdateAuth')return {localUpdatePreview:()=>false,updateIdentity:async()=>({owner:'real',allowed:['sh600519']})};
      if(name==='@/lib/auth/session')return {sameOriginMutation:r=>r.safe};
      if(name==='@/lib/marketUpdateQueue')return {UpdateQueueError:class extends Error{constructor(m,status){super(m);this.status=status;}},updateSymbols:v=>v,MarketUpdateQueue:class{
        async submit(...args){submitted.push(args);return {id:'job',finished:true};}
        async cancel(owner){cancelled.push(owner);return {id:'job',finished:true,failed:1,errors:[{symbol:'sh600519',message:'已手动停止'}]};}
      }};
      throw Error(name);
    },
  });
  const rawRequest=(raw,safe=true)=>({safe,headers:new Headers(),body:new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(raw));controller.close();}})});
  const single=await exported.POST(rawRequest(JSON.stringify({single:true,codes:['sh600519'],mode:'five-year'})));
  assert.equal(single.status,200);
  const args=submitted.at(-1);
  assert.equal(args[0],'real');assert.deepEqual([...args[1]],['sh600519']);assert.equal(args[2],false);assert.equal(args[3],'ten-year');
  assert.equal((await exported.POST(rawRequest(JSON.stringify({single:true,codes:['sh600519'],mode:'recent'})))).status,400,'手动更新数据入口已移除');
  assert.equal((await exported.POST(rawRequest(JSON.stringify({single:true,codes:['sh600519','sh600000']})))).status,400,'单只补齐不接受多只');
  assert.equal((await exported.POST(rawRequest(JSON.stringify({codes:['sh600519']})))).status,400,'缺少分组仍被拒绝');
  const stopped=await exported.DELETE({safe:true,headers:new Headers()});
  assert.equal(stopped.status,200);assert.deepEqual(cancelled,['real']);assert.equal(stopped.body.data.failed,1);
  assert.equal((await exported.DELETE({safe:false,headers:new Headers()})).status,403,'跨源停止被拒绝');
});

test('GET falls back to owner-only identity when the watchlist is not synced',async()=>{
  class Err extends Error{constructor(m,status){super(m);this.status=status;}}
  const exported={},registered=[];
  let synced=false;
  const identity=async(_r,group)=>{
    if(group==='all'){if(!synced)throw new Err('自选分组尚未同步',409);return {owner:'real',allowed:['sh600519']};}
    if(group===undefined)return {owner:'real'};
    return {owner:'real',allowed:['sh600519']};
  };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/api/market-updates/route.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{
    exports:exported,TextDecoder,process:{env:{MARKET_UPDATE_WORKER_ENABLED:'1',MARKET_UPDATE_WORKER_TOKEN:'x'.repeat(40),MARKET_DATABASE_URL:'configured'}},
    require(name){
      if(name==='next/server')return {NextResponse:{json:(body,options)=>({body,status:options?.status??200})}};
      if(name==='@/lib/marketImportAuth')return {denyReason:()=>null};
      if(name==='@/lib/marketStore')return {getMarketStore:()=>({})};
      if(name==='@/lib/marketCollection')return {registerCollection:async(...args)=>{registered.push(args);}};
      if(name==='@/lib/marketUpdateAuth')return {localUpdatePreview:()=>false,updateIdentity:identity};
      if(name==='@/lib/auth/session')return {sameOriginMutation:r=>r.safe};
      if(name==='@/lib/marketUpdateQueue')return {UpdateQueueError:Err,updateSymbols:v=>v,MarketUpdateQueue:class{async workerPausedUntil(){return null;}async status(owner){return {owner,jobs:[]};}}};
      throw Error(name);
    },
  });
  // 未同步自选：409 降级为 owner-only，跳过 registerCollection，仍返回本人进度
  const ok=await exported.GET({headers:new Headers()});
  assert.equal(ok.status,200);assert.equal(ok.body.ok,true);
  assert.equal(ok.body.data.owner,'real');assert.deepEqual(ok.body.data.jobs,[]);
  assert.deepEqual(registered,[]);
  // 已同步分组：照旧注册收藏并返回带 allowed 的身份
  synced=true;
  const syncedRes=await exported.GET({headers:new Headers()});
  assert.equal(syncedRes.status,200);
  assert.equal(syncedRes.body.data.owner,'real');
  assert.equal(registered.length,1);
  assert.equal(registered[0][1],'real');assert.deepEqual([...registered[0][2]],['sh600519']);
});

test('GET surfaces auth failures without the owner-only fallback',async()=>{
  class Err extends Error{constructor(m,status){super(m);this.status=status;}}
  const exported={};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/api/market-updates/route.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{
    exports:exported,TextDecoder,process:{env:{MARKET_UPDATE_WORKER_ENABLED:'1',MARKET_UPDATE_WORKER_TOKEN:'x'.repeat(40),MARKET_DATABASE_URL:'configured'}},
    require(name){
      if(name==='next/server')return {NextResponse:{json:(body,options)=>({body,status:options?.status??200})}};
      if(name==='@/lib/marketImportAuth')return {denyReason:()=>null};
      if(name==='@/lib/marketStore')return {getMarketStore:()=>({})};
      if(name==='@/lib/marketCollection')return {registerCollection:async()=>{throw Error('不应注册');}};
      if(name==='@/lib/marketUpdateAuth')return {localUpdatePreview:()=>false,updateIdentity:async()=>{throw new Err('登录状态已失效，请重新登录',401);}};
      if(name==='@/lib/auth/session')return {sameOriginMutation:r=>r.safe};
      if(name==='@/lib/marketUpdateQueue')return {UpdateQueueError:Err,updateSymbols:v=>v,MarketUpdateQueue:class{async workerPausedUntil(){return null;}async status(){return {};}}};
      throw Error(name);
    },
  });
  const bad=await exported.GET({headers:new Headers()});
  assert.equal(bad.status,401);assert.equal(bad.body.ok,false);assert.match(bad.body.error,/重新登录/);
});
