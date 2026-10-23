import { HISTORY_YEARS } from './marketHistoryPlan';
/** Durable import queue, independent of daily/weekly collection and browser lifetimes. */
import { randomUUID } from 'node:crypto';
import { marketDigest, marketRecord, type MarketStore, type MarketRecord } from './marketStore';
import { BatchImportError, ImportConflict, batchSymbol, importBatchSymbol, validateBatch, type BatchItem, type ImportProof } from './marketBatchImport';
import type { resolveMarketGaps } from './marketGapResolve';
const INDEX='market-import-index:v1',LEASE='market-import-worker:v1',TTL=7*864e5,LEASE_MS=10*60e3;
const key=(id:string)=>`market-import-job:v1:${id}`,payloadKey=(id:string)=>`market-import-payload:v1:${id}`;
const validId=(id:string)=>/^[a-f0-9]{64}$/.test(id);
export type ItemState='pending'|'imported'|'unchanged'|'conflict'|'error';
export type ImportJob={id:string;owner:string;operator:string;digest:string;createdAt:number;updatedAt:number;state:'queued'|'running'|'rebuilding'|'completed'|'completed_with_issues';rebuild:boolean;cancelRequested?:boolean;
  companies:{symbol:string;state:ItemState;result?:Awaited<ReturnType<typeof importBatchSymbol>>;error?:string;validation?:{state:'complete'|'blocked'|'error';result?:unknown;reason?:string}}[]};
type Index={jobs:{id:string;createdAt:number}[]};
type Payload={items:BatchItem[];proof:ImportProof};
const terminal=(j:ImportJob)=>j.state==='completed'||j.state==='completed_with_issues';
async function many(store:MarketStore,keys:string[]) {return store.readInputs?store.readInputs(keys):(await Promise.all(keys.map(k=>store.read(k)))).filter((r):r is MarketRecord=>!!r);}
async function register(store:MarketStore,id:string,now:number) {
  for(let a=0;a<10;a++){
    const old=await store.read<Index>(INDEX);const refs=(old?.payload.jobs??[]).filter(j=>now-j.createdAt<TTL);
    if(refs.some(j=>j.id===id))return;
    if(refs.length>=50){const states=new Map((await many(store,refs.map(j=>key(j.id)))).map(r=>[r.key,r.payload as ImportJob]));
      const at=refs.findIndex(r=>{const j=states.get(key(r.id));return !j||terminal(j);});
      if(at<0)throw new BatchImportError('批量导入队列已满',429);refs.splice(at,1);
    }
    refs.push({id,createdAt:now});
    if(await store.write(marketRecord(INDEX,'market-import-queue','internal',{jobs:refs},TTL,now),old?.digest??null))return;
  }
  throw new BatchImportError('导入队列繁忙，请用相同幂等键重试',503);
}
export async function submitImportJob(store:MarketStore,owner:string,operator:string,input:unknown,now=Date.now()) {
  const batch=validateBatch(input),id=marketDigest([owner,batch.idempotencyKey]),digest=marketDigest({items:batch.items,proof:batch.proof,rebuild:batch.rebuild});
  const old=await store.read<ImportJob>(key(id));
  if(old){if(old.payload.digest!==digest)throw new ImportConflict('幂等键已用于不同数据，请使用新的idempotencyKey');
    if(now-old.payload.createdAt>=TTL)throw new BatchImportError('任务已超过7天查询期，请使用新的幂等键',410);
    await register(store,id,now);return {job:old.payload,reused:true};}
  const body=marketRecord(payloadKey(id),'market-import-payload',batch.proof.source,{items:batch.items,proof:batch.proof},TTL,now);
  if(!await store.write(body,null)){
    const prior=await store.read<Payload>(payloadKey(id));
    if(prior?.digest!==body.digest)throw new ImportConflict('同一幂等键的提交内容冲突');
  }
  const job:ImportJob={id,owner,operator,digest,createdAt:now,updatedAt:now,state:'queued',rebuild:batch.rebuild,companies:batch.symbols.map(symbol=>({symbol,state:'pending'}))};
  if(!await store.write(marketRecord(key(id),'market-import-job','internal',job,TTL,now),null)){
    const concurrent=await store.read<ImportJob>(key(id));if(!concurrent||concurrent.payload.digest!==digest)throw new ImportConflict('任务并发提交冲突');
    await register(store,id,now);return {job:concurrent.payload,reused:true};
  }
  await register(store,id,now);return {job,reused:false};
}
export async function readImportJob(store:MarketStore,owner:string,id:string,now=Date.now()) {
  if(!validId(id))throw new BatchImportError('任务编号无效');
  const row=await store.read<ImportJob>(key(id));
  if(!row||row.payload.owner!==owner)throw new BatchImportError('任务不存在',404);
  if(now-row.payload.createdAt>=TTL)throw new BatchImportError('任务已超过7天查询期',410);
  return row;
}
export async function changeImportJob(store:MarketStore,owner:string,id:string,action:'retry'|'cancel',now=Date.now()) {
  for(let a=0;a<8;a++){
    const old=await readImportJob(store,owner,id,now),j=structuredClone(old.payload);
    if(action==='retry'){
      if(!terminal(j))throw new ImportConflict('任务仍在运行，暂不能重试');
      for(const c of j.companies){if(c.state==='error'){c.state='pending';delete c.error;}if(c.validation?.state==='error')delete c.validation;}
      j.cancelRequested=false;j.state=j.companies.some(c=>c.state==='pending')?'queued':'rebuilding';
    }else{j.cancelRequested=true;if(j.state==='queued')j.state='completed_with_issues';}
    j.updatedAt=now;
    if(await store.write(marketRecord(key(id),'market-import-job','internal',j,TTL,now),old.digest)){await register(store,id,now);return j;}
  }
  throw new BatchImportError('任务状态并发更新，请重试',503);
}
export function publicImportJob(j:ImportJob) {
  return {id:j.id,state:j.state,createdAt:j.createdAt,updatedAt:j.updatedAt,cancelRequested:!!j.cancelRequested,total:j.companies.length,
    imported:j.companies.filter(c=>c.state==='imported').length,unchanged:j.companies.filter(c=>c.state==='unchanged').length,
    failed:j.companies.filter(c=>c.state==='error').length,conflicts:j.companies.filter(c=>c.state==='conflict').length,
    pending:j.companies.filter(c=>c.state==='pending').length,finished:terminal(j),companies:j.companies};
}
/** One worker owns the import queue for a bounded tick; abandoned work replays idempotently. */
export async function runMarketImportTick(store:MarketStore|null,options:{clock?:()=>number;limit?:number;budgetMs?:number;resolve?:typeof resolveMarketGaps}={}) {
  if(!store)return {processed:false,reason:'store-unavailable'};
  const clock=options.clock??Date.now,now=clock(),index=await store.read<Index>(INDEX);
  if(!index?.payload.jobs.length)return {processed:false,reason:'idle'};
  const lease=await store.read<{token:string;until:number}>(LEASE);
  if(lease && lease.payload.until>now)return {processed:false,reason:'worker-busy'};
  const token=randomUUID();
  if(!await store.write(marketRecord(LEASE,'market-import-worker','internal',{token,until:now+LEASE_MS,at:now},TTL,now),lease?.digest??null))return {processed:false,reason:'worker-busy'};
  const fence=async()=>{const l=await store.read<{token:string;until:number}>(LEASE);if(l?.payload.token!==token || l.payload.until<=clock())throw new BatchImportError('执行器租约已失效，等待安全续跑',503);};
  let processed=0;
  try{
    const rows=await many(store,index.payload.jobs.filter(r=>now-r.createdAt<TTL).map(r=>key(r.id)));
    const active=rows.find(r=>!terminal(r.payload as ImportJob));
    if(!active)return {processed:false,reason:'idle'};
    let job=active.payload as ImportJob;
    const payload=await store.read<Payload>(payloadKey(job.id));if(!payload)throw new BatchImportError('任务输入丢失',503);
    const save=async()=>{
      await fence();const current=await store.read<ImportJob>(key(job.id));
      if(!current)throw new BatchImportError('任务状态丢失',503);
      job.cancelRequested ||= current.payload.cancelRequested;job.updatedAt=clock();
      if(!await store.write(marketRecord(key(job.id),'market-import-job','internal',job,TTL,clock()),current.digest))throw new BatchImportError('任务状态并发更新，请续跑',503);
    };
    const started=clock(),limit=Math.max(1,Math.min(10,options.limit??5));
    while(processed<limit && clock()-started<(options.budgetMs??20000)){
      await fence();const current=await store.read<ImportJob>(key(job.id));job.cancelRequested ||= current?.payload.cancelRequested;
      if(job.cancelRequested){job.state='completed_with_issues';await save();break;}
      const company=job.companies.find(c=>c.state==='pending');
      if(company){
        job.state='running';await save();
        try{company.result=await importBatchSymbol(store,payload.payload.items.filter(i=>batchSymbol(i)===company.symbol),company.symbol,payload.payload.proof,job.id,clock(),fence);company.state=company.result.skipped?'unchanged':'imported';delete company.error;}
        catch(e){company.state=e instanceof ImportConflict?'conflict':'error';company.error=(e instanceof Error?e.message:'导入失败').slice(0,2000);}
        processed++;await save();continue;
      }
      const validate=job.rebuild?job.companies.find(c=>['imported','unchanged'].includes(c.state)&&!c.validation):undefined;
      if(validate){
        job.state='rebuilding';await save();
        const code=validate.symbol.slice(2),disclosures=await store.read(`disclosures-v3:${code}:${HISTORY_YEARS+2}`);
        if(!disclosures)validate.validation={state:'blocked',reason:'缺少已核实的首次披露日期；财务已入库，历史估值尚不能完整重建'};
        else try{const resolve=options.resolve??(await import('./marketGapResolve')).resolveMarketGaps;const result=await resolve(store,[validate.symbol]);
          const snapshots=await many(store,[`valuation-result:v1:${validate.symbol}:${HISTORY_YEARS}:disclosure`,`valuation-input-version:v1:${validate.symbol}`]);
          const cached=snapshots.find(r=>r.key.startsWith('valuation-result:'))?.payload as any,revision=snapshots.find(r=>r.key.startsWith('valuation-input-version:'))?.payload as any;
          const history=cached?.value?.history??[],cache={revisionMatches:!!cached&&cached.revision===(revision?.version??'initial'),days:history.length,missingInputs:history.filter((p:any)=>p.missingInputs?.length).length};
          validate.validation={state:result[0]?.status==='error'?'error':result[0]?.cleared&&cache.revisionMatches&&cache.days>0&&!cache.missingInputs?'complete':'blocked',result:{coverage:result,cache}};}
        catch(e){validate.validation={state:'error',reason:e instanceof Error?e.message:'估值重建失败'};}
        processed++;await save();break; // Rebuild may use up to 30 seconds; yield between companies.
      }
      job.state=job.companies.some(c=>['error','conflict'].includes(c.state)||c.validation&&c.validation.state!=='complete')?'completed_with_issues':'completed';await save();break;
    }
    return {processed:processed>0,processedCompanies:processed,job:publicImportJob(job)};
  }finally{
    const l=await store.read<{token:string;until:number}>(LEASE);
    if(l?.payload.token===token)await store.write(marketRecord(LEASE,'market-import-worker','internal',{token,until:0,at:clock()},TTL,clock()),l.digest);
  }
}
