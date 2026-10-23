import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {load} from './load-modules.mjs';
const batch=await load('marketBatchImport'),jobs=await load('marketImportJobs'),market=await load('marketStore');
const now=Date.parse('2026-10-23T13:00:00Z');
const proof={source:'qmt',reference:'QMT verified sample package',files:[{name:'package.zip',sha256:'a'.repeat(64)}]};
const finance=(symbol='600415',year=2025,value=12)=>({type:'finance',record:{symbol,statement:'profit',unit:'wan',currency:'CNY',basis:'cumulative',reportDates:[`${year}-12-31`],items:[{name:'归属于母公司所有者的净利润',vals:[value]}]}});
const indicator=(symbol='600415',year=2025)=>({type:'a-indicators',record:{symbol,year,items:[{date:`${year}-12-31`,indicator:'资产负债率(%)',value:30}]}});
function memory(){const data=new Map();const counts={read:0,readInputs:0,write:0,writeInputs:0};
 const s={data,counts,coordinated:true,read:async k=>{counts.read++;return structuredClone(data.get(k)??null);},
  async write(r,d){counts.write++;if((data.get(r.key)?.digest??null)!==d)return false;data.set(r.key,structuredClone(r));return true;},
  async readInputs(keys){counts.readInputs++;return keys.map(k=>structuredClone(data.get(k))).filter(Boolean);},
  async writeInputs(items){counts.writeInputs++;let n=0;for(const i of items)if(await s.write(i.record,i.expected))n++;return n;},incident:async()=>{},
  seed(key,kind,payload){data.set(key,market.marketRecord(key,kind,'original',payload,1e8,now));}};return s;}
test('multiple years stage into one bulk write, prove readback, and preserve source per cell',async()=>{
 const s=memory(),list=[finance('600415',2024),finance('600415',2025),indicator()];
 const out=await batch.importBatchSymbol(s,list,'sh600415',proof,'job1',now);
 assert.equal(out.verified,true);assert.equal(out.records,3);assert.equal(out.addedCells,3);assert.equal(s.counts.writeInputs,1);assert.equal(s.counts.readInputs,2);
 const p=(await s.read('source-sina-page:v1:600415:profit:2024')).payload;assert.equal(p.fieldSources['归属于母公司所有者的净利润'][0],'qmt:job1');
 const again=await batch.importBatchSymbol(s,list,'sh600415',proof,'job2',now);assert.equal(again.skipped,true);assert.equal(s.counts.writeInputs,1);
 assert.ok(await s.read(out.proofKey));
});
test('known zero and alias conflicts block the company before any target write',async()=>{
 const s=memory(),key='source-sina-page:v1:600415:profit:2025';s.seed(key,'source-sina-page',{dates:['2025-12-31'],unit:'wan',rows:[{kind:'field',name:'归属于母公司的净利润',vals:['0']}]});
 await assert.rejects(batch.importBatchSymbol(s,[finance()], 'sh600415',proof,'job',now),batch.ImportConflict);
 assert.equal(s.counts.writeInputs,0);assert.equal(s.data.size,1);assert.equal(s.data.get(key).payload.rows[0].vals[0],'0');
});
test('invalid item late in a company writes none of that company',async()=>{
 const s=memory(),bad=finance();bad.record.unit='yuan';
 await assert.rejects(batch.importBatchSymbol(s,[finance('600415',2024),bad],'sh600415',proof,'job',now),/万元/);
 assert.equal(s.data.size,0);assert.equal(s.counts.writeInputs,0);
});
test('CAS race re-reads and merges concurrent cells instead of losing them',async()=>{
 const s=memory(),write=s.writeInputs;let first=true;
 s.writeInputs=async items=>{if(first){first=false;s.seed(items[0].record.key,'source-sina-page',{dates:['2025-12-31'],unit:'wan',rows:[{kind:'field',name:'营业收入',vals:['999']}]});return 0;}return write(items);};
 const out=await batch.importBatchSymbol(s,[finance()],'sh600415',proof,'job',now);
 assert.equal(out.verified,true);const p=s.data.get('source-sina-page:v1:600415:profit:2025').payload;
 assert.equal(p.rows.find(r=>r.name==='营业收入').vals[0],'999');assert.equal(p.rows.find(r=>r.name.includes('归属于')).vals[0],'12');
});
test('lost commit acknowledgement succeeds only after digest readback proves it',async()=>{
 const s=memory(),write=s.writeInputs;s.writeInputs=async items=>{await write(items);throw Error('connection lost after commit');};
 const out=await batch.importBatchSymbol(s,[finance()],'sh600415',proof,'job',now);assert.equal(out.verified,true);
});
test('batch bounds, A-only scope, metadata, and owner/idempotency isolation',async()=>{
 const s=memory(),input={idempotencyKey:'batch-1',proof,items:[finance()],rebuild:false};
 const a=await jobs.submitImportJob(s,'owner','operator',input,now),b=await jobs.submitImportJob(s,'owner','operator',input,now);
 assert.equal(b.reused,true);assert.equal(a.job.id,b.job.id);
 await assert.rejects(jobs.submitImportJob(s,'owner','operator',{...input,items:[finance('600415',2025,99)]},now),/幂等键/);
 await assert.rejects(jobs.readImportJob(s,'other',a.job.id,now),/不存在/);
 assert.throws(()=>batch.validateBatch({...input,items:[finance('hk00700')]}),/仅支持A股/);
 assert.throws(()=>batch.validateBatch({...input,proof:{...proof,files:[]}}),/proof/);
 assert.throws(()=>batch.validateBatch({...input,items:Array.from({length:51},(_,i)=>finance('600'+String(i).padStart(3,'0')))}),/50只/);
});
test('independent queue completes good stocks and quarantines conflicting stocks',async()=>{
 const s=memory();s.seed('source-sina-page:v1:600011:profit:2025','source-sina-page',{dates:['2025-12-31'],unit:'wan',rows:[{kind:'field',name:'归属于母公司所有者的净利润',vals:['0']}]});
 const {job}=await jobs.submitImportJob(s,'owner','op',{idempotencyKey:'mixed',proof,items:[finance(),finance('600011')],rebuild:false},now);
 await jobs.runMarketImportTick(s,{clock:()=>now,limit:5});
 const finished=jobs.publicImportJob((await jobs.readImportJob(s,'owner',job.id,now)).payload);
 assert.equal(finished.finished,true);assert.equal(finished.imported,1);assert.equal(finished.conflicts,1);assert.equal(finished.state,'completed_with_issues');
 assert.equal(s.data.get('source-sina-page:v1:600011:profit:2025').payload.rows[0].vals[0],'0');
});
test('worker restart resumes durable progress, skips completed stocks, and blocks missing first-disclosure dates',async()=>{
 const s=memory(),{job}=await jobs.submitImportJob(s,'owner','op',{idempotencyKey:'resume',proof,items:[finance(),finance('600011')],rebuild:true},now);
 await jobs.runMarketImportTick(s,{clock:()=>now,limit:1});const count=s.counts.writeInputs;
 await jobs.runMarketImportTick(s,{clock:()=>now,limit:5});assert.equal(s.counts.writeInputs,count+1);
 await jobs.runMarketImportTick(s,{clock:()=>now,limit:5});await jobs.runMarketImportTick(s,{clock:()=>now,limit:5});
 const j=(await jobs.readImportJob(s,'owner',job.id,now)).payload;assert.equal(j.state,'completed_with_issues');assert.ok(j.companies.every(c=>c.validation.state==='blocked'));
 assert.equal(s.counts.writeInputs,2);
});
test('worker lease prevents a second worker and cancellation preserves imported facts',async()=>{
 const s=memory(),{job}=await jobs.submitImportJob(s,'owner','op',{idempotencyKey:'cancel',proof,items:[finance(),finance('600011')],rebuild:false},now);
 await jobs.runMarketImportTick(s,{clock:()=>now,limit:1});await jobs.changeImportJob(s,'owner',job.id,'cancel',now);
 await jobs.runMarketImportTick(s,{clock:()=>now});const j=(await jobs.readImportJob(s,'owner',job.id,now)).payload;
 assert.equal(j.cancelRequested,true);assert.equal(j.companies[0].state,'imported');assert.equal(j.companies[1].state,'pending');
 const second=await jobs.submitImportJob(s,'owner','op',{idempotencyKey:'lease',proof,items:[finance('600011')],rebuild:false},now);
 s.seed('market-import-worker:v1','market-import-worker',{token:'other',until:now+10000});
 assert.equal((await jobs.runMarketImportTick(s,{clock:()=>now})).reason,'worker-busy');
 assert.equal((await jobs.readImportJob(s,'owner',second.job.id,now)).payload.state,'queued');
});
test('file-backed queue survives recreation of the store adapter',async()=>{
 const root=await fs.mkdtemp(path.resolve('data/batch-import-test-'));try{
  const a=market.fileMarketStore(root),{job}=await jobs.submitImportJob(a,'owner','op',{idempotencyKey:'disk',proof,items:[finance()],rebuild:false},now);
  await jobs.runMarketImportTick(market.fileMarketStore(root),{clock:()=>now,limit:5});
  const result=(await jobs.readImportJob(market.fileMarketStore(root),'owner',job.id,now)).payload;assert.equal(result.state,'completed');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('only one simultaneous worker wins the durable import lease',async()=>{
 const s=memory();await jobs.submitImportJob(s,'owner','op',{idempotencyKey:'two-workers',proof,items:[finance()],rebuild:false},now);
 const results=await Promise.all([jobs.runMarketImportTick(s,{clock:()=>now}),jobs.runMarketImportTick(s,{clock:()=>now})]);
 assert.equal(results.filter(x=>x.processed).length,1);assert.equal(s.counts.writeInputs,1);
});
test('same logical request in a new job changes no input; retry only replays failed stocks',async()=>{
 const s=memory(),write=s.writeInputs;let fail=true;s.writeInputs=async items=>{if(fail)throw Error('database unavailable');return write(items);};
 const input={idempotencyKey:'retry-error',proof,items:[finance()],rebuild:false};const {job}=await jobs.submitImportJob(s,'owner','op',input,now);
 await jobs.runMarketImportTick(s,{clock:()=>now});assert.equal((await jobs.readImportJob(s,'owner',job.id,now)).payload.companies[0].state,'error');
 fail=false;await jobs.changeImportJob(s,'owner',job.id,'retry',now);await jobs.runMarketImportTick(s,{clock:()=>now});
 assert.equal((await jobs.readImportJob(s,'owner',job.id,now)).payload.state,'completed');
 const count=s.counts.writeInputs;const b=await jobs.submitImportJob(s,'owner','op',{...input,idempotencyKey:'second-job'},now);await jobs.runMarketImportTick(s,{clock:()=>now});
 assert.equal(s.counts.writeInputs,count);assert.equal((await jobs.readImportJob(s,'owner',b.job.id,now)).payload.companies[0].state,'unchanged');
});
test('kline imports keep the newer tail and bypass the non-kline bulk reader/writer',async()=>{
 const s=memory(),k='kline:v2:sh600415:day:none:canonical:prices-only';const candle=(date,close)=>({date,open:close,high:close,low:close,close});
 s.seed(k,'kline',{symbol:'sh600415',code:'600415',adjust:'none',period:'day',candles:[candle('2026-10-22',10),candle('2026-10-23',11)],complete:true,source:'canonical'});
 const read=s.readInputs;s.readInputs=async keys=>{assert.ok(keys.every(k=>!k.startsWith('kline:')));return read(keys);};
 const out=await batch.importBatchSymbol(s,[{type:'kline',record:{symbol:'600415',adjust:'none',candles:[candle('2026-10-21',9),candle('2026-10-22',10)]}}],'sh600415',proof,'bars',now);
 assert.equal(out.verified,true);assert.equal(s.data.get(k).payload.candles.at(-1).date,'2026-10-23');assert.equal(s.counts.writeInputs,0);
});
test('QMT revisions cannot enter first-disclosure fields; original announcement dates are preserved',async()=>{
 const s=memory();await assert.rejects(batch.importBatchSymbol(s,[{type:'disclosure-dates',record:{symbol:'600415',items:[{date:'2025-12-31',published:'2026-04-30'}]}}],'sh600415',proof,'dates',now),/修订日期/);
 const it=finance();it.record.announceDates=['2026-04-30'];await assert.rejects(batch.importBatchSymbol(s,[it],'sh600415',proof,'dates',now),/修订日期/);assert.equal(s.data.size,0);
 s.seed('source-sina-page:v1:600415:profit:2025','source-sina-page',{dates:['2025-12-31'],announceDates:['2026-04-20'],unit:'wan',rows:[{kind:'field',name:'归属于母公司所有者的净利润',vals:['12']}]});
 await assert.rejects(batch.importBatchSymbol(s,[it],'sh600415',{...proof,source:'manual'},'dates',now),batch.ImportConflict);
});
test('sub-percent raw price conflicts across sources are rejected before canonical writes',async()=>{
 const s=memory(),c={date:'2026-10-22',open:10,high:10,low:10,close:10};s.seed('kline:v2:sh600415:day:none:tencent:prices-only','kline',{candles:[c]});
 await assert.rejects(batch.importBatchSymbol(s,[{type:'kline',record:{symbol:'600415',candles:[{...c,open:10.01,high:10.01,low:10.01,close:10.01}]}}],'sh600415',proof,'bars',now),batch.ImportConflict);assert.equal(s.counts.writeInputs,0);
});
test('coverage cleared alone never hides a stale valuation cache',async()=>{
 for(const matched of [false,true]){
  const s=memory();s.seed('disclosures-v3:600415:14','disclosure-dates',{$marketMap:[['2025-12-31','2026-04-20']]});
  const {job}=await jobs.submitImportJob(s,'owner','op',{idempotencyKey:'cache-check-'+matched,proof,items:[finance()],rebuild:true},now);
  const resolve=async()=>{s.seed('valuation-input-version:v1:sh600415','valuation-input-version',{version:'v2'});s.seed('valuation-result:v1:sh600415:12:disclosure','valuation-result',{revision:matched?'v2':'v1',value:{history:[{date:'2026-10-22',pe:10,pb:2}]}});return [{symbol:'sh600415',cleared:true,status:'cleared'}];};
  await jobs.runMarketImportTick(s,{clock:()=>now,resolve});await jobs.runMarketImportTick(s,{clock:()=>now,resolve});
  const j=(await jobs.readImportJob(s,'owner',job.id,now)).payload;
  assert.equal(j.companies[0].validation.state,matched?'complete':'blocked');assert.equal(j.state,matched?'completed':'completed_with_issues');
 }
});
