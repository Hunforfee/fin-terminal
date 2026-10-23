import { getMarketStore, marketRecord, type MarketStore } from './marketStore';
import { normalizeStockCode } from './datasource/codes';
import { fetchKLine as tencent } from './datasource/tencent';
import { fetchKLine as eastmoney } from './datasource/eastmoneyKline';
import { validateKLine, type KLineFetcher } from './klineStorage';
import { importedBarsKey, equivalentRawPrice, type ImportedBars, completedDate } from './marketImportedBars';
import type { KLineSeries } from './datasource/types';

/** Exact-date requests bypass range expansion, broker overlap downloads and financial reads.
 * Source-specific storage deliberately never grafts an unverified mirror onto broker history. */
export async function collectDailyPrices(symbol:string, date:string, store:MarketStore|null=getMarketStore(),
  sources:KLineFetcher[]=[r=>tencent(r.symbol,'day','none',1,r.start,r.end),r=>eastmoney(r.symbol,'day','none',1,r.start,r.end)], now=Date.now()) {
  const n=normalizeStockCode(symbol);
  if(!store || !n)throw Error('行情数据库或证券代码无效');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date || date>completedDate(now))throw Error('目标日尚未收盘或日期无效');
  const mirrorRows=await Promise.all(['tencent','eastmoney','sina'].map(source=>store!.read<KLineSeries & {dailyConfirmed?:string[]}>(`kline:v2:${n.symbol}:day:none:${source}:prices-only`)));
  const confirmed=mirrorRows.find(r=>r?.payload.dailyConfirmed?.includes(date));
  if(confirmed)return {symbol:n.symbol,date,key:confirmed.key,changed:false,canonicalExtended:await extendFromStoredOverlap(store,n.symbol,date,confirmed.payload,now)};
  const request={symbol:n.symbol,period:'day' as const,adjust:'none' as const,count:1,start:date,end:date,recentOnly:true};
  const errors:string[]=[];
  for(const fetcher of sources) {
    let value:KLineSeries;
    try {
      value=await fetcher(request);
      validateKLine(value,request,now);
      if(value.stale || value.complete===false || value.candles.length!==1 || value.candles[0].date!==date)throw Error('来源未返回指定日的有效收盘行情（可能休市或停牌）');
      if(!['tencent','eastmoney','sina'].includes(value.source))throw Error('未知行情来源');
    } catch(e) { errors.push(e instanceof Error?e.message:String(e));continue; }
    const key=`kline:v2:${n.symbol}:day:none:${value.source}:prices-only`;
    for(let attempt=0;attempt<4;attempt++) {
      const old=await store.read<KLineSeries>(key);
      const rows=new Map((old?.payload.candles??[]).map(c=>[c.date,c]));
      const incoming=value.candles[0];rows.set(date,incoming);
      const candles=[...rows.values()].sort((a,b)=>a.date.localeCompare(b.date));
      const priorConfirmed=(old?.payload as KLineSeries & {dailyConfirmed?:string[]})?.dailyConfirmed??[];
      const payload={...old?.payload,...value,candles,dailyConfirmed:[...new Set([...priorConfirmed,date])].sort().slice(-16)};
      const record=marketRecord(key,'kline',value.source,payload,60e3,now);
      if(record.digest===old?.digest)return {symbol:n.symbol,date,key,changed:false};
      if(await store.write(record,old?.digest??null)){
        return {symbol:n.symbol,date,key,changed:true,canonicalExtended:await extendFromStoredOverlap(store,n.symbol,date,payload,now)};
      }
    }
    throw Error('指定日行情保存版本冲突');
  }
  throw Error(`指定日 ${date} 未取得有效数据；${errors.join('；')}`);
}

async function extendFromStoredOverlap(store:MarketStore,symbol:string,date:string,mirror:KLineSeries,now:number){
 const incoming=mirror.candles.find(c=>c.date===date)!;
 for(let attempt=0;attempt<4;attempt++){
  const canonical=await store.read<ImportedBars>(importedBarsKey(symbol));
  if(!canonical)return false;
  if(canonical.payload.candles.some(c=>c.date===date))return true;
  // Never replace an existing historical candle during a daily task.
  if(date<=canonical.payload.candles.at(-1)!.date)return false;
  const prior=new Map(canonical.payload.candles.map(c=>[c.date,c]));
  const overlap=mirror.candles.filter(c=>prior.has(c.date));
  const verified=overlap.length>=3 && overlap.every(c=>(['open','high','low','close'] as const).every(f=>equivalentRawPrice(c[f],prior.get(c.date)![f])));
  if(!verified)return false;
  const updated={...canonical.payload,candles:[...canonical.payload.candles,incoming],origins:[...canonical.payload.origins,{source:mirror.source,from:date,to:date,acquiredAt:new Date(now).toISOString()}]};
  if(await store.write(marketRecord(canonical.key,'kline','canonical:stored-overlap-verified',updated,60e3,now),canonical.digest))return true;
 }
 throw Error('指定日已保存，主行情合并版本冲突，请复核');
}
