import { getMarketStore, marketRecord, type MarketStore } from './marketStore';
import { valuationInputVersion } from './valuationResultCache';
import { withMarketRefresh } from './marketRefresh';
type Saved<T>={revision:string;value:T};
export type MetricSnapshot<T>=T & {calculatedAt?:string;stale?:boolean};
/** Public per-security display results; no account/watchlist information is stored. */
export async function cachedDisplayMetric<T extends object>(symbol:string,name:string,ttl:number,produce:()=>Promise<T>,usable:(value:T)=>boolean,
  schedule:(work:()=>Promise<void>)=>void,store:MarketStore|null=getMarketStore()):Promise<MetricSnapshot<T>> {
  if(!store)return produce();
  const key=`display-metric:v1:${symbol}:${name}`;
  const [old,revision]=await Promise.all([store.read<Saved<T>>(key),valuationInputVersion(store,symbol)]);
  const result=(row:NonNullable<typeof old>,stale=false)=>({...row.payload.value,calculatedAt:row.acquiredAt,stale});
  if(old && old.payload.revision===revision && Date.parse(old.refreshAfter)>Date.now())return result(old);
  const rebuild=()=>withMarketRefresh(store,key,async()=>{
    const current=await store.read<Saved<T>>(key),version=await valuationInputVersion(store,symbol);
    if(current && current.payload.revision===version && Date.parse(current.refreshAfter)>Date.now())return result(current);
    const value=await produce();
    if(!usable(value))return current?result(current,true):value;
    const after=await valuationInputVersion(store,symbol);
    const saved=marketRecord(key,'display-metric','derived',{revision:version===after?after:'changed-during-build',value},ttl);
    if(!await store.write(saved,current?.digest??null))return value;
    return result(saved);
  });
  if(old){schedule(async()=>{await rebuild().catch(()=>{});});return result(old,true);}
  return rebuild();
}
