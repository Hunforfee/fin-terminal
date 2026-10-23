/** Bounded, network-free staging and bulk commit for public A-share imports. */
import { marketDigest, marketRecord, type MarketRecord, type MarketStore } from './marketStore';
import { normalizeStockCode } from './datasource/codes';
import { writeFinanceStatements, writeFinancialHistory, writeShareHistory, writeDividendPlans, writeDividendImplemented } from './marketImportRecords';
import { importAIndicators, importDisclosureDates } from './marketAImportRecords';
import { importDailyPrices, importedBarsKey, equivalentRawPrice } from './marketImportedBars';

export const BATCH_TYPES = ['finance', 'financial-history', 'a-indicators', 'disclosure-dates', 'share-history', 'dividend-plans', 'dividend-impl', 'kline'] as const;
export type BatchType = typeof BATCH_TYPES[number];
export type BatchItem = { type: BatchType; record: Record<string, unknown> };
export type ImportProof = { source: 'qmt'|'tdx'|'manual'; reference: string; files: { name: string; sha256: string }[] };
export class BatchImportError extends Error { constructor(message: string, public status = 400) { super(message); } }
export class ImportConflict extends BatchImportError { constructor(message: string) { super(message, 409); } }
const finite = (v: unknown): v is number|string => v !== null && v !== undefined && String(v).trim() !== '' && Number.isFinite(Number(String(v).replaceAll(',', '')));
const equal = (a: unknown,b: unknown) => finite(a) && finite(b) ? Math.abs(Number(String(a).replaceAll(',',''))-Number(String(b).replaceAll(',',''))) <= Math.max(1e-9,Math.abs(Number(String(a).replaceAll(',','')))*1e-10) : a === b;
const name = (s:string) => {
  const n=s.replace(/[\s()（）:：]/g,'').replace(/^[一二三四五六七八九十]+、/,'');
  if(n==='资产总额')return '资产总计';
  if(n==='负债总计')return '负债合计';
  if(n==='经营活动产生现金流量净额')return '经营活动产生的现金流量净额';
  if(['归属于母公司股东的净利润','归属于母公司的净利润'].includes(n))return '归属于母公司所有者的净利润';
  if(['归属于母公司所有者权益合计','归属于母公司股东权益总计','归属于母公司所有者权益总计','归属于母公司股东的权益'].includes(n))return '归属于母公司股东权益合计';
  return n;
};
export function batchSymbol(item: BatchItem): string {
  const n=normalizeStockCode(String(item.record?.symbol ?? item.record?.code ?? ''));
  if(!n || n.kind!=='stock' || n.market==='HK')throw new BatchImportError('批量导入仅支持A股个股');
  return n.symbol;
}
export function validateBatch(input: unknown): { idempotencyKey:string; items:BatchItem[]; proof:ImportProof; rebuild:boolean; symbols:string[] } {
  const x=input as Record<string,any>;
  if(!x || typeof x!=='object' || Array.isArray(x) || !/^[A-Za-z0-9._:-]{1,100}$/.test(x.idempotencyKey??''))throw new BatchImportError('idempotencyKey须为1—100位字母、数字或 ._:-');
  if(!Array.isArray(x.items) || !x.items.length || x.items.length>1500)throw new BatchImportError('items须为1—1500项');
  for(const it of x.items)if(!it || !BATCH_TYPES.includes(it.type) || !it.record || typeof it.record!=='object' || Array.isArray(it.record))throw new BatchImportError('导入类型或record无效');
  const symbols=[...new Set<string>(x.items.map(batchSymbol))];
  if(symbols.length>50)throw new BatchImportError('每批最多50只A股');
  const p=x.proof;
  if(!p || !['qmt','tdx','manual'].includes(p.source) || typeof p.reference!=='string' || p.reference.length<5 || p.reference.length>500
    || !Array.isArray(p.files) || !p.files.length || p.files.length>100 || p.files.some((f:any)=>!f || typeof f.name!=='string' || !f.name.length || f.name.length>200 || !/^[a-f0-9]{64}$/i.test(f.sha256)))throw new BatchImportError('proof须包含来源、5—500字reference和文件名/SHA256清单');
  if(x.rebuild!==undefined && typeof x.rebuild!=='boolean')throw new BatchImportError('rebuild须为布尔值');
  return {idempotencyKey:x.idempotencyKey,items:x.items,proof:{source:p.source,reference:p.reference,files:p.files},rebuild:x.rebuild!==false,symbols};
}
/** Logical facts ignore paging order and metadata; zero is a known fact. */
function facts(row: MarketRecord | null): Map<string,unknown> {
  const out=new Map<string,unknown>();if(!row)return out;
  const p=row.payload as any;
  if(['source-sina-page','source-sina-indicators'].includes(row.kind)) {
    const entries=row.kind==='source-sina-page' ? p.rows.filter((r:any)=>r.kind==='field').map((r:any)=>[r.name,r.vals]) : p.rows instanceof Map ? [...p.rows] : p.rows.$marketMap;
    for(const [field,values] of entries)for(let i=0;i<p.dates.length;i++)if(finite(values[i])) {
      const key=JSON.stringify([name(field),p.dates[i]]);
      if(out.has(key) && !equal(out.get(key),values[i]))throw new ImportConflict('同一财报存在冲突的科目别名');
      out.set(key,values[i]);
    }
    if(row.kind==='source-sina-page' && Array.isArray(p.announceDates))p.dates.forEach((d:string,i:number)=>{if(p.announceDates[i])out.set(JSON.stringify(['published',d]),p.announceDates[i]);});
  } else if(row.kind==='disclosure-dates') {
    for(const [d,v] of p instanceof Map?[...p]:p.$marketMap??[])out.set(JSON.stringify(['published',d]),v);
  } else {
    const rows=row.kind==='kline'?p.candles:Array.isArray(p)?p:[];
    for(const r of rows){const identity=row.kind==='announced-dividend-plans'?`${r.reportDate}:${r.exDate??''}:${r.special??false}`:r.date??r.reportDate??r.exDate;for(const [field,v] of Object.entries(r))if(finite(v)||typeof v==='boolean'||typeof v==='string'&&v!=='')out.set(JSON.stringify([field,identity]),v);}
  }
  return out;
}
function preserve(old:MarketRecord|null,next:MarketRecord) {
  const a=facts(old),b=facts(next);
  for(const [key,v] of a)if(!b.has(key) || !equal(v,b.get(key)))throw new ImportConflict(`已有有效值冲突，未覆盖：${next.key} ${key}`);
  return [...b.keys()].filter(k=>!a.has(k));
}
function withProof(old:MarketRecord|null,next:MarketRecord,added:string[],tag:string):MarketRecord {
  if(!added.length)return next;
  const p=structuredClone(next.payload) as any,o=old?.payload as any;
  if(['source-sina-page','source-sina-indicators'].includes(next.kind)) {
    const fields=next.kind==='source-sina-page'?p.rows.filter((r:any)=>r.kind==='field').map((r:any)=>r.name):p.rows.$marketMap.map(([n]:[string])=>n);
    const changed=new Set(added),oldDates=o?.dates??[];
    p.fieldSources=Object.fromEntries(fields.map((f:string)=>[f,p.dates.map((d:string)=>changed.has(JSON.stringify([name(f),d]))?tag:o?.fieldSources?.[f]?.[oldDates.indexOf(d)]??'')]));
  } else if(next.kind==='financial-history' && Array.isArray(p)) {
    for(const r of p)if(added.some(k=>JSON.parse(k)[1]===r.date))r.sources=[...new Set([...(r.sources??[]),tag])];
  }
  return {...next,payload:p,digest:marketDigest(p)};
}
function keysFor(items:BatchItem[],symbol:string) {
  const code=symbol.slice(2),keys=new Set<string>();
  for(const it of items){const r=it.record as any;
    if(it.type==='finance'){
      keys.add(`security-basics:v1:${symbol}`);
      // The legacy writer also requests this inferred key.
      keys.add(`security-basics:v1:${/^6/.test(code)?'sh':/^[48]/.test(code)?'bj':'sz'}${code}`);
      for(const d of r.reportDates??[])if(typeof d==='string')keys.add(`source-sina-page:v1:${code}:${r.statement}:${d.slice(0,4)}`);
    } else if(it.type==='a-indicators')keys.add(`source-sina-indicators:v1:${code}:${r.year}`);
    else if(it.type==='disclosure-dates')keys.add(`disclosures-v3:${code}:${r.years??12}`);
    else if(it.type==='financial-history')for(let y=2;y<=12;y++)keys.add(`statements-v3:${code}:${y}`);
    else if(it.type==='share-history')keys.add(`shares-v3:${code}`);
    else if(it.type==='dividend-plans')keys.add(`dividend-plans-v2:${code}`);
    else if(it.type==='dividend-impl')keys.add(`implemented-dividends-v4:${code}`);
    else if(it.type==='kline'){
      keys.add(importedBarsKey(symbol));
      for(const source of ['canonical','tencent','sina','eastmoney'])keys.add(`kline:v2:${symbol}:day:none:${source}:prices-only`);
    }
  }
  if(keys.size>2000)throw new BatchImportError('单只股票涉及记录过多');
  return [...keys];
}
async function readMany(store:MarketStore,keys:string[]) {
  const bars=keys.filter(k=>k.startsWith('kline:')),other=keys.filter(k=>!k.startsWith('kline:'));
  const records=store.readInputs?await store.readInputs(other):(await Promise.all(other.map(k=>store.read(k)))).filter((r):r is MarketRecord=>!!r);
  return [...records,...(await Promise.all(bars.map(k=>store.read(k)))).filter((r):r is MarketRecord=>!!r)];
}
async function execute(store:MarketStore,it:BatchItem,symbol:string,proof:ImportProof,now:number):Promise<any> {
  const r={...it.record,symbol:symbol.slice(2)} as any;
  if(proof.source==='qmt' && (it.type==='disclosure-dates'||it.type==='finance'&&Array.isArray(r.announceDates)&&r.announceDates.some((v:unknown)=>v!==null)))throw new BatchImportError('QMT修订日期不能直接当作首次披露日期，请使用公告来源单独导入');
  switch(it.type){
    case 'finance':return writeFinanceStatements(store,r,now);
    case 'financial-history':return writeFinancialHistory(store,r,now);
    case 'share-history':return writeShareHistory(store,r,now);
    case 'dividend-plans':return writeDividendPlans(store,symbol.slice(2),r.plans,now);
    case 'dividend-impl':return writeDividendImplemented(store,symbol.slice(2),r.rows,now);
    case 'a-indicators':return importAIndicators(store,r,now);
    case 'disclosure-dates':return importDisclosureDates(store,r,now);
    case 'kline':{
      if(r.adjust!==undefined && r.adjust!=='none' || r.period!==undefined && r.period!=='day')throw new BatchImportError('仅支持不复权日线');
      if(proof.source==='manual')throw new BatchImportError('日线来源须为qmt或tdx');
      if(r.currency!==undefined&&r.currency!=='CNY')throw new BatchImportError('A股行情币种须为CNY');
      if(!Array.isArray(r.candles)||!r.candles.length)throw new BatchImportError('日线为空');
      for(const source of ['canonical','tencent','sina','eastmoney']){const saved=await store.read<any>(`kline:v2:${symbol}:day:none:${source}:prices-only`);const byDate=new Map((saved?.payload.candles??[]).map((c:any)=>[c.date,c]));for(const c of r.candles){const old=byDate.get(c.date) as any;if(old&&['open','high','low','close'].some(f=>finite(old[f])&&!equivalentRawPrice(Number(old[f]),c[f])))throw new ImportConflict(`与库内${source}不复权行情冲突：${c.date}`);}}
      return importDailyPrices(store,{...r,symbol,source:proof.source,mergeBatch:true},now);
    }
  }
}
/** No HTTP calls; prefetch once, run validators/mergers in memory, commit once, read back once. */
export async function importBatchSymbol(store:MarketStore,items:BatchItem[],symbol:string,proof:ImportProof,jobId:string,
  now=Date.now(),beforeCommit:()=>Promise<void>=async()=>{}) {
  const keys=keysFor(items,symbol),tag=`${proof.source}:${jobId}`;
  for(let attempt=0;attempt<3;attempt++) {
    const original=new Map((await readMany(store,keys)).map(r=>[r.key,r]));
    const cache=new Map<string,MarketRecord|null>(keys.map(k=>[k,original.get(k)??null]));
    const pending=new Map<string,MarketRecord>(),addedByKey=new Map<string,string[]>();
    const stage:MarketStore={
      async read<T>(key:string){if(!cache.has(key)){const r=await store.read(key);cache.set(key,r);if(r)original.set(key,r);}return structuredClone(cache.get(key)??null) as MarketRecord<T>|null;},
      async readInputs(ks){return (await Promise.all(ks.map(k=>stage.read(k)))).filter((r):r is MarketRecord=>!!r);},
      async write(row,expected){const prior=await stage.read(row.key);if((prior?.digest??null)!==expected)return false;
        preserve(prior,row);const added=preserve(original.get(row.key)??null,row),decorated=withProof(original.get(row.key)??null,row,added,tag);
        addedByKey.set(row.key,added);cache.set(row.key,decorated);pending.set(row.key,decorated);return true;},
      incident:async()=>{},
    };
    for(const it of items){
      const result=await execute(stage,it,symbol,proof,now);
      if(result?.conflicts?.length)throw new ImportConflict('导入项存在冲突：'+JSON.stringify(result.conflicts).slice(0,1000));
      if(result?.missing?.length)throw new BatchImportError('导入项未通过校验：'+JSON.stringify(result.missing).slice(0,1000));
    }
    const writes=[...pending.values()].filter(r=>r.digest!==(original.get(r.key)?.digest??null)).map(record=>({record,expected:original.get(record.key)?.digest??null}));
    await beforeCommit();
    const bulk=writes.filter(x=>x.record.kind!=='kline'),bars=writes.filter(x=>x.record.kind==='kline');
    let commitError:unknown;
    try{
      if(bulk.length){if(store.writeInputs)await store.writeInputs(bulk);else for(const i of bulk)await store.write(i.record,i.expected);}
      for(const i of bars)await store.write(i.record,i.expected);
    }catch(e){commitError=e;}
    const saved=new Map((await readMany(store,writes.map(x=>x.record.key))).map(r=>[r.key,r]));
    if(writes.some(i=>saved.get(i.record.key)?.digest!==i.record.digest)){
      if(attempt<2)continue;
      throw new BatchImportError('批量写入回读不一致；已提交部分保留，可安全重试'+(commitError?`：${String(commitError).slice(0,160)}`:''),503);
    }
    for(const i of writes)preserve(original.get(i.record.key)??null,saved.get(i.record.key)!);
    const evidenceKey=`market-import-proof:v1:${jobId}:${symbol}`,old=await store.read<any>(evidenceKey);
    const evidence={jobId,symbol,proof,verifiedAt:new Date(now).toISOString(),
      attempts:[...(old?.payload.attempts??[]),{records:writes.map(i=>({key:i.record.key,before:i.expected,after:i.record.digest,addedCells:addedByKey.get(i.record.key)??[]}))}].slice(-10)};
    if(!await store.write(marketRecord(evidenceKey,'market-import-proof',proof.source,evidence,30*864e5,now),old?.digest??null))throw new BatchImportError('来源凭据写入冲突，可安全重试',503);
    return {verified:true,skipped:!writes.length,records:writes.length,addedCells:[...addedByKey.values()].reduce((n,a)=>n+a.length,0),proofKey:evidenceKey};
  }
  throw new BatchImportError('导入重试次数耗尽',503);
}
