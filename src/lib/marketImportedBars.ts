import type { Candle, KLineSeries } from './datasource/types';
import { marketDigest, marketRecord, type MarketRecord, type MarketStore } from './marketStore';
import { marketCutoff } from './marketRetention';
import { normalizeStockCode } from './datasource/codes';

export const importedBarsKey=(symbol:string)=>`kline:v2:${symbol}:day:none:canonical:prices-only`;
export interface ImportedBars extends KLineSeries {
  listingDate?:string;
  origins:{source:string;from:string;to:string;acquiredAt:string}[];
}
const isoDate=(s:string)=>/^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
/** Recognize only binary32 representations (including TDX's six-decimal serialization), not a percentage price band. */
export function equivalentRawPrice(a:number,b:number):boolean {
  if(!Number.isFinite(a) || !Number.isFinite(b))return false;
  const same=(x:number,y:number)=>Math.abs(x-y)<=Math.max(1e-8,Math.abs(y)*1e-8);
  return same(a,b) || same(a,Math.fround(b)) || same(b,Math.fround(a))
    || same(a,Number(Math.fround(b).toFixed(6))) || same(b,Number(Math.fround(a).toFixed(6)));
}
const different=(a:number,b:number)=>!equivalentRawPrice(a,b);
export const completedDate=(now:number)=>{
  const d=new Date(now+8*3600e3);
  if(d.getUTCHours()*60+d.getUTCMinutes()<1110)d.setUTCDate(d.getUTCDate()-1);
  return d.toISOString().slice(0,10);
};
/** Used by WorkBuddy's SERVER importer. Never accept broker credentials or browser writes. */
export async function importDailyPrices(store:MarketStore,input:{symbol:string;candles:Candle[];source:'qmt'|'tdx';listingDate?:string;mergeBatch?:boolean},now=Date.now()){
  const n=normalizeStockCode(input.symbol),today=new Date(now+8*3600e3).toISOString().slice(0,10);
  if(!n || !['qmt','tdx'].includes(input.source) || !input.candles.length)throw Error('导入证券、来源或日线无效');
  if(input.listingDate && (!isoDate(input.listingDate) || input.listingDate>today))throw Error('上市日期无效');
  let previous='';
  for(const c of input.candles){
    if(!isoDate(c.date) || c.date>today || c.date<=previous || ![c.open,c.high,c.low,c.close].every(Number.isFinite)
      || c.low<=0 || c.low>Math.min(c.open,c.close) || c.high<Math.max(c.open,c.close) || c.high<c.low)throw Error('导入日线日期或价格校验失败');
    previous=c.date;
  }
  let candles=input.candles.filter(c=>c.date>=marketCutoff(now) && c.date<=completedDate(now)).map(({date,open,high,low,close})=>({date,open,high,low,close}));
  if(!candles.length || input.listingDate && candles[0].date<input.listingDate)throw Error('导入范围或上市日期不匹配');
  const key=importedBarsKey(n.symbol),old=await store.read<ImportedBars>(key);
  const priorCandles=old?.payload.candles.filter(c=>!input.mergeBatch || c.date>=marketCutoff(now))??[];
  if(old?.payload.listingDate && candles[0].date<old.payload.listingDate)throw Error('导入范围或上市日期不匹配');
  const incoming=candles;
  if(input.mergeBatch && old){
    const union=new Map(priorCandles.map(c=>[c.date,c]));
    for(const c of candles){
      const prior=union.get(c.date);
      if(prior && (['open','high','low','close'] as const).some(f=>different(prior[f],c[f])))
        throw Error('再次导入与原始不复权价格冲突，保留原记录');
      // A fresh QMT export may replace an equivalent binary32 representation.
      // A TDX import preserves existing higher-precision observations.
      if(!prior || input.source==='qmt')union.set(c.date,c);
    }
    candles=[...union.values()].sort((a,b)=>a.date.localeCompare(b.date));
    if(input.listingDate && candles[0].date<input.listingDate)throw Error('导入范围或上市日期不匹配');
    if(old.payload.listingDate && input.listingDate && old.payload.listingDate!==input.listingDate)throw Error('上市日期与原记录冲突');
    if(marketDigest(candles)===marketDigest(old.payload.candles) && (!input.listingDate || input.listingDate===old.payload.listingDate))
      return {symbol:n.symbol,from:candles[0].date,to:candles.at(-1)!.date,count:candles.length,skipped:true};
  }
  if(priorCandles.length && (candles[0].date>priorCandles[0].date || candles.at(-1)!.date<priorCandles.at(-1)!.date))throw Error('导入数据覆盖减少，保留原记录');
  if(old){
    const next=new Map(candles.map(c=>[c.date,c]));
    const conflict=priorCandles.some(c=>!next.has(c.date) || (['open','high','low','close'] as const).some(f=>different(c[f],next.get(c.date)![f])));
    if(conflict)
      throw Error('再次导入与原始不复权价格冲突，保留原记录');
  }
  const acquiredAt=new Date(now).toISOString();
  const payload:ImportedBars={symbol:n.symbol,code:n.code,period:'day',adjust:'none',candles,source:'canonical',stale:false,complete:true,listingDate:input.listingDate??old?.payload.listingDate,
    origins:[...(input.mergeBatch?old?.payload.origins??[]:[]),{source:input.source,from:incoming[0].date,to:incoming.at(-1)!.date,acquiredAt}]};
  if(!await store.write(marketRecord(key,'kline',`${input.source}:unadjusted`,payload,60e3,now),old?.digest??null))throw Error('导入版本冲突，请重试');
  return {symbol:n.symbol,from:candles[0].date,to:candles.at(-1)!.date,count:candles.length};
}

/** A short source tail may extend imported RAW bars only after overlapping prices agree. */
export async function extendImportedPrices(store:MarketStore,row:MarketRecord<ImportedBars>,tail:KLineSeries,now=Date.now()){
  const old=row.payload;
  if(tail.symbol!==old.symbol || tail.period!=='day' || tail.adjust!=='none' || tail.stale || tail.complete===false)throw Error('新增行情证券或口径不匹配');
  let previous='';const today=new Date(now+8*3600e3).toISOString().slice(0,10);
  for(const c of tail.candles){
    if(!isoDate(c.date) || c.date>today || c.date<=previous || ![c.open,c.high,c.low,c.close].every(Number.isFinite)
      || c.low<=0 || c.low>Math.min(c.open,c.close) || c.high<Math.max(c.open,c.close))throw Error('新增日线日期或价格无效');
    previous=c.date;
  }
  tail={...tail,candles:tail.candles.filter(c=>c.date<=completedDate(now))};
  const prior=new Map(old.candles.map(c=>[c.date,c]));
  const overlap=tail.candles.filter(c=>prior.has(c.date));
  if(overlap.length<Math.min(3,old.candles.length))throw Error('QMT 与网站行情缺少足够重叠日期，未续接');
  const conflict=overlap.some(c=>(['open','high','low','close'] as const).some(f=>different(c[f],prior.get(c.date)![f])));
  if(conflict){await store.incident(row.key,'import_overlap_conflict',{source:tail.source,dates:overlap.map(c=>c.date)});throw Error('QMT 与网站不复权价格不一致，保留原数据');}
  const added=tail.candles.filter(c=>c.date>old.candles.at(-1)!.date);
  const stamp=new Date(now).toISOString();
  const candles=[...old.candles,...added].filter(c=>c.date>=marketCutoff(now)).map(({date,open,high,low,close})=>({date,open,high,low,close}));
  const origins=old.origins.map(o=>({...o}));
  if(added.length){
    const last=origins.at(-1)!;
    if(last.source===tail.source)last.to=added.at(-1)!.date;
    else origins.push({source:tail.source,from:added[0].date,to:added.at(-1)!.date,acquiredAt:stamp});
  }
  const payload:ImportedBars={...old,candles,origins,source:'canonical',stale:false};
  if(!await store.write(marketRecord(row.key,'kline','canonical:overlap-verified',payload,60e3,now),row.digest))throw Error('行情续接版本冲突，请重试');
  return payload;
}
