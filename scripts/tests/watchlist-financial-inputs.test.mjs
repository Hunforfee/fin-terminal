import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {load} from './load-modules.mjs';
const {storedMarketInput,validateDatedRows}=await load('marketInputs');
const source=ts.transpileModule(fs.readFileSync('src/lib/watchlistFinancialInputs.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function fixture(){
 let now=Date.now(),record=null,calls=0,value=12,fails=false;
 const fields=['roe','netMargin','ocfPerShare','debtRatio'];
 const payload=()=>({code:'600519',name:'贵州茅台',periods:['2025-12-31','2026-06-30'],periodLabels:['2025H2','2026H1'],series:Object.fromEntries(fields.map(k=>[k,[10,value]])),source:'test'});
 const store={read:async()=>structuredClone(record),write:async(r,expected)=>{if((record?.digest??null)!==expected)return false;record=structuredClone(r);return true;},incident:async()=>{}};
 const exported={};
 vm.runInNewContext(source,{exports:exported,require(name){
   if(name==='./datasource/codes')return {normalizeStockCode:()=>({symbol:'sh600519',code:'600519',market:'SH'})};
   if(name==='./datasource/sinaStatements')return {fetchCustomFinancials:async()=>{calls++;if(fails)throw Error('source down');return payload();}};
   if(name==='./datasource/hkFinance')return {};
   if(name==='./marketInputs')return {validateDatedRows,storedMarketInput:(...args)=>storedMarketInput(...args,store,now)};
   throw Error(name);
 }});
 return {get:exported.getWatchlistFinancialInputs,calls:()=>calls,set:v=>{value=v;},fail:()=>{fails=true;},advance:()=>{now+=31*60e3;}};
}
test('background update and table share one durable financial record, not an extra page TTL',async()=>{
 const f=fixture();assert.equal((await f.get('600519')).series.roe.at(-1),12);
 assert.equal((await f.get('600519')).series.roe.at(-1),12);assert.equal(f.calls(),1);
 f.advance();f.set(15);assert.equal((await f.get('600519')).series.roe.at(-1),15);
 assert.equal((await f.get('600519')).series.roe.at(-1),15);assert.equal(f.calls(),2);
});
test('expired table inputs do not fall back to older values on source outage',async()=>{
 const f=fixture();await f.get('600519');f.advance();f.fail();await assert.rejects(f.get('600519'),/source down/);
});
test('a populated old period cannot hide missing latest table metrics',async()=>{
 const f=fixture();f.set(null);await assert.rejects(f.get('600519'),/最新列表财务指标暂缺/);
});
