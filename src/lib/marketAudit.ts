import { marketRecord, type MarketStore } from './marketStore';
import { diagnoseMarketData } from './marketDiagnostics';
import { normalizeStockCode } from './datasource/codes';
/** One saved stock per minute, DB only. It never submits collection or calls a provider. */
export async function auditSavedMarketData(store:MarketStore,now=Date.now()) {
 if(!store.scanPrefix)return {enabled:false};
 const key='market-audit-cursor:v1';
 const old=await store.read<{cursor:string;nextAt:number}>(key);
 if((old?.payload.nextAt??0)>now)return {enabled:true,skipped:true};
 const rows=await store.scanPrefix('kline:v2:',50,old?.payload.cursor??'');
 let cursor=rows.at(-1)?.key??'',symbol:string|undefined;
 for(const row of rows){
  const candidate=row.key.match(/^kline:v2:([^:]+):/)?.[1];
  if(!candidate || !normalizeStockCode(candidate))continue;
  const prior=await store.read(`market-audit:v1:${candidate}`);
  if(prior && now-Date.parse(prior.acquiredAt)<864e5)continue;
  symbol=candidate;cursor=row.key;break;
 }
 if(symbol){
  const report=await diagnoseMarketData(store,symbol,now),reportKey=`market-audit:v1:${symbol}`;
  const previous=await store.read(reportKey);
  if(!await store.write(marketRecord(reportKey,'market-audit','internal:database-only',report,864e5,now),previous?.digest??null))throw Error('巡检报告保存冲突');
 }
 const nextAt=now+(rows.length?60e3:864e5);
 if(!await store.write(marketRecord(key,'market-audit-cursor','internal',{cursor,nextAt},864e5,now),old?.digest??null))throw Error('巡检游标保存冲突');
 return {enabled:true,symbol,finished:!rows.length};
}
