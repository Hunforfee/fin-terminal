import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {load} from './load-modules.mjs';
const plan=await load('marketHistoryPlan');
function worker({phase=0,mode='ten-year',failure=false,initialized=false,phaseErrors}={}){
 const exported={},calls=[],finished=[],gaps=[];
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/marketUpdateWorker.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
  exports:exported,Error,AbortController,setTimeout,clearTimeout,setInterval,clearInterval,
  require(name){
   if(name==='./marketHistoryPlan')return plan;
   if(name==='./marketStore')return {getMarketStore:()=>({read:async()=>initialized?{payload:{status:'ready'}}:null})};
   if(name==='./marketUpdateQueue')return {MarketUpdateQueue:class{async claim(){return {symbol:'sh600519',lease:'lease',mode,phase,phaseErrors};}async finish(...args){finished.push(args);return true;}async renew(){return true;}}};
   if(name==='./upstreamBudget')return {UpstreamBudget:class{limited=false;}};
   if(name==='./marketUpdateContext')return {withUpstreamBudget:(_budget,read)=>read()};
   if(name==='./marketHistoryCollection')return {coverageKey:s=>s,collectHistoryPhase:async(...args)=>{calls.push(args);if(failure)throw Error('校验失败');}};
   if(name==='./marketFillGaps')return {recordGapAfterFailure:async(...args)=>{gaps.push(args);return null;}};
   if(['./datasource','./datasource/codes','./datasource/valueScreen','./valuationInputs','./marketInputs','./datasource/sinaFinance','./watchlistFinancialInputs'].includes(name))return {};
   throw Error(name);
  },
 });return {run:exported.runMarketUpdateTick,calls,finished,gaps};
}
test('history worker checkpoints each successful phase instead of reporting the stock done',async()=>{
 const w=worker();const result=await w.run();
 assert.equal(result.ok,true);assert.equal(w.calls.length,1);assert.equal(w.calls[0][1],0);
 assert.equal(w.finished[0][4],1);
});
test('an unavailable phase is recorded while independent collection continues',async()=>{
 const w=worker({phase:4,failure:true});const result=await w.run();
 assert.equal(result.ok,false);assert.equal(w.calls[0][1],4);assert.equal(w.finished[0][2],'校验失败');assert.equal(w.finished[0][4],5);
});

test('a recent job without initialized coverage also starts the full website collection',async()=>{
 const w=worker({mode:'recent'});await w.run();assert.equal(w.calls[0][1],0);assert.equal(w.finished[0][4],1);
});

test('readiness failure never advances the stock to an apparent success',async()=>{
 const w=worker({phase:18,failure:true});const result=await w.run();assert.equal(result.ok,false);assert.equal(w.finished[0][4],undefined);
});
test('last history phase is the readiness check and only it finishes the stock',async()=>{
 const w=worker({phase:18});await w.run();assert.equal(w.calls[0][1],12);assert.equal(w.finished[0][4],undefined);
});

test('recent failures classify the actual collection phase and historical phase errors',async()=>{
 const w=worker({mode:'recent',initialized:true,phase:5,failure:true,phaseErrors:{1:'价格失败',7:'资料失败'}});
 await w.run();assert.equal(w.calls[0][1],10);assert.equal(w.gaps[0][2].phase,10);
 assert.deepEqual({...w.gaps[0][2].phaseErrors},{0:'价格失败',13:'资料失败'});
});
