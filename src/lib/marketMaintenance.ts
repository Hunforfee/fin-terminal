import { getMarketStore, marketDigest, marketRecord, type MarketStore } from './marketStore';
import { disposableMarketRecord, retainMarketPayload, marketCutoff } from './marketRetention';
import { withMarketRefresh } from './marketRefresh';
const KEY='market-maintenance:v1';
type State={cursor:string;at:number;auxAt:number;cutoff:string;scanned:number;trimmed:number;removed:number};
/** Incremental sweeps, invoked by the independent worker even when the stock queue is idle. */
export async function runMarketMaintenance(store:MarketStore|null=getMarketStore(),now=Date.now(),limit=200){
  if(!store?.scan || !store.remove)return {enabled:false};
  const prior=await store.read<State>(KEY);
  if(prior && now-prior.payload.at<60e3)return {enabled:true,skipped:true};
  return withMarketRefresh(store,'market-maintenance',async()=>{
    const old=await store.read<State>(KEY);
    if(old && now-old.payload.at<60e3)return {enabled:true,skipped:true};
    const page=await store.scan!(old?.payload.cursor??'',Math.max(1,Math.min(500,limit)));
    let trimmed=0,removed=0;
    for(const row of page.records){
      if(row.key===KEY || row.kind==='market-update-queue' || row.kind==='fetch-lease' && now-Date.parse(row.acquiredAt)<864e5)continue;
      const payload=retainMarketPayload(row.kind,row.payload,now),digest=marketDigest(payload);
      const empty=row.kind==='kline' && !(payload as any).candles.length
        || ['source-sina-page','source-sina-indicators'].includes(row.kind) && !(payload as any).dates.length
        || ['source-hk-indicators','source-hk-statement','financial-history','implemented-dividends','announced-dividend-plans','hk-recent-dividend-events','deducted-periods'].includes(row.kind) && Array.isArray(payload) && !payload.length;
      if(empty || disposableMarketRecord(row,now) || row.kind==='fetch-lease' && (row.payload as any).until<=now){
        if(await store.remove!(row.key,row.digest))removed++;
      }else if(digest!==row.digest){
        if(await store.write({...row,payload,digest},row.digest))trimmed++;
      }
    }
    let auxAt=old?.payload.auxAt??0;
    if(now-auxAt>=864e5){await store.pruneAux?.(now);auxAt=now;}
    const state:State={cursor:page.done?'':page.cursor,at:now,auxAt,cutoff:marketCutoff(now),scanned:page.records.length,trimmed,removed};
    await store.write(marketRecord(KEY,'market-maintenance','internal',state,60e3,now),old?.digest??null);
    return {enabled:true,...state};
  });
}
