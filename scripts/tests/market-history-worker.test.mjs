import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function worker({phase=0,mode='five-year',failure=false}={}){
 const exported={},calls=[],finished=[];
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/marketUpdateWorker.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
  exports:exported,Error,AbortController,setTimeout,clearTimeout,setInterval,clearInterval,
  require(name){
   if(name==='./marketStore')return {getMarketStore:()=>({read:async()=>null})};
   if(name==='./marketUpdateQueue')return {MarketUpdateQueue:class{async claim(){return {symbol:'sh600519',lease:'lease',mode,phase};}async finish(...args){finished.push(args);return true;}async renew(){return true;}}};
   if(name==='./upstreamBudget')return {UpstreamBudget:class{limited=false;}};
   if(name==='./marketUpdateContext')return {withUpstreamBudget:(_budget,read)=>read()};
   if(name==='./marketHistoryCollection')return {coverageKey:s=>s,collectHistoryPhase:async(...args)=>{calls.push(args);if(failure)throw Error('校验失败');}};
   if(['./datasource','./datasource/codes','./datasource/valueScreen','./valuationInputs','./marketInputs','./datasource/sinaFinance','./watchlistFinancialInputs'].includes(name))return {};
   throw Error(name);
  },
 });return {run:exported.runMarketUpdateTick,calls,finished};
}
test('history worker checkpoints each successful phase instead of reporting the stock done',async()=>{
 const w=worker();const result=await w.run();
 assert.equal(result.ok,true);assert.equal(w.calls.length,1);assert.equal(w.calls[0][1],0);
 assert.equal(w.finished[0][4],1);
});
test('history worker failure retains the current phase for bounded retry',async()=>{
 const w=worker({phase:4,failure:true});const result=await w.run();
 assert.equal(result.ok,false);assert.equal(w.calls[0][1],4);assert.equal(w.finished[0][2],'校验失败');assert.equal(w.finished[0][4],undefined);
});
test('last history phase is the readiness check and only it finishes the stock',async()=>{
 const w=worker({phase:13});await w.run();assert.equal(w.calls[0][1],12);assert.equal(w.finished[0][4],undefined);
});
