import { getMarketStore, marketRecord, valuationRevisionKey, type MarketStore } from './marketStore';
import { withMarketRefresh } from './marketRefresh';
import type { Valuation } from './datasource/types';

export type ValuationCacheOptions = { schedule?: (work: () => Promise<void>) => void; force?: boolean };
const ALGORITHM = 'daily-share-amounts-v2';
type Saved = { algorithm?: string; revision: string; day: string; value: Valuation };
const pending = new WeakMap<MarketStore,Map<string,Promise<Valuation>>>();
export const valuationResultKey = (symbol:string,years:number,method:string) => `valuation-result:v1:${symbol}:${years}:${method}`;
const day = () => new Date(Date.now()+8*3600e3).toISOString().slice(0,10);
export async function valuationInputVersion(store:MarketStore|null,symbol:string) {
  return (await store?.read<{version:string}>(valuationRevisionKey(symbol)))?.payload.version ?? 'initial';
}
function annotate(value:Valuation,row:{acquiredAt:string},state:'fresh'|'updating'|'saved'):Valuation {
  return {...value,historyCache:{generatedAt:row.acquiredAt,state}};
}
/** Reuse the entire successful result across requests/restarts; failed builds retain it. */
export async function cachedValuationResult(symbol:string,years:number,method:string,produce:()=>Promise<Valuation>,
  options:ValuationCacheOptions={},store:MarketStore|null=getMarketStore()):Promise<Valuation> {
  if(!store)return produce();
  const key=valuationResultKey(symbol,years,method);
  const [old,revision]=await Promise.all([store.read<Saved>(key),valuationInputVersion(store,symbol)]);
  const fresh=old && old.payload.algorithm===ALGORITHM && old.payload.revision===revision && old.payload.day===day() && Date.parse(old.refreshAfter)>Date.now();
  if(fresh && !options.force)return annotate(old.payload.value,old,'fresh');
  let jobs=pending.get(store);if(!jobs){jobs=new Map();pending.set(store,jobs);}
  const rebuild=()=>{
    const running=jobs!.get(key);if(running)return running;
    const work=withMarketRefresh(store,key,async()=>{
      const current=await store.read<Saved>(key),before=await valuationInputVersion(store,symbol);
      if(!options.force && current?.payload.algorithm===ALGORITHM && current.payload.revision===before && current.payload.day===day() && Date.parse(current.refreshAfter)>Date.now())return annotate(current.payload.value,current,'fresh');
      let version=before,value=await produce();
      let after=await valuationInputVersion(store,symbol);
      // A cold build can itself acquire source inputs. Rebuild once against their
      // saved versions; never label a moving input set as a stable result.
      if(after!==version){version=after;value=await produce();after=await valuationInputVersion(store,symbol);}
      if(after!==version)throw Error('估值输入仍在更新，保留上次曲线');
      if(value.stale || !value.history.length)return value;
      const saved=marketRecord(key,'valuation-result','derived',{algorithm:ALGORITHM,revision:version,day:day(),value},24*3600e3);
      if(!await store.write(saved,current?.digest??null))throw Error('估值结果保存冲突，请稍后重试');
      return annotate(value,saved,'fresh');
    }).finally(()=>jobs!.delete(key));
    jobs!.set(key,work);return work;
  };
  if(old && options.schedule && !options.force) {
    options.schedule(async()=>{await rebuild().catch(async error=>{await store.incident(key,'valuation_rebuild_failed',{message:String(error)}).catch(()=>{});});});
    return annotate(old.payload.value,old,'updating');
  }
  try{return await rebuild();}
  catch(error){if(old && options.schedule)return annotate(old.payload.value,old,'saved');throw error;}
}
