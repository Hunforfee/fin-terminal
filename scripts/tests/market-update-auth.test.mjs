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
      if(name==='@/lib/marketStore')return {getMarketStore:()=>({})};
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
