import { marketDigest, marketRecord, type MarketStore } from './marketStore';
import { MarketUpdateQueue, updateSymbols, type UpdateMode } from './marketUpdateQueue';
import { withMarketRefresh } from './marketRefresh';
const KEY='market-collection-registry:v1',SCHEDULE='market-close-schedule:v1';
interface Registry {owners:Record<string,{symbols:string[];updatedAt:number}>}
export async function registerCollection(store:MarketStore,owner:string,symbols:string[]){
  const normalized=symbols.length?updateSymbols(symbols):[],id=marketDigest(owner);
  for(let i=0;i<12;i++){
    const old=await store.read<Registry>(KEY),value=old?.payload??{owners:{}};
    if(!value.owners[id] && Object.keys(value.owners).length>=256)throw Error('自动更新账号范围已满');
    if(JSON.stringify(value.owners[id]?.symbols)===JSON.stringify(normalized))return;
    if(normalized.length)value.owners[id]={symbols:normalized,updatedAt:Date.now()};
    else delete value.owners[id];
    if(await store.write(marketRecord(KEY,'market-collection-registry','internal',value,864e5),old?.digest??null))return;
  }throw Error('保存自动更新范围失败');
}
export function closeTarget(now=Date.now()):string|null{
  const local=new Date(now+8*3600e3),minute=local.getUTCHours()*60+local.getUTCMinutes();
  if(minute<390)return null;
  if(minute<990)local.setUTCDate(local.getUTCDate()-1);
  while([0,6].includes(local.getUTCDay()))local.setUTCDate(local.getUTCDate()-1);
  return local.toISOString().slice(0,10);
}
/** 16:30 close pass, 06:30 recovery. The source's actual trading dates are retained, never invented on holidays. */
export async function scheduleMarketClose(store:MarketStore,now=Date.now()){
  const day=closeTarget(now);if(!day)return {scheduled:0};
  const d=new Date(now+8*3600e3),pass=d.getUTCHours()*60+d.getUTCMinutes()<990?'recovery':'close';
  const target=`${day}:${pass}`;
  const latest=await store.read<{date:string;done?:boolean}>(SCHEDULE);if(latest?.payload.date===target && latest.payload.done)return {scheduled:0};
  return withMarketRefresh(store,'close-schedule',async()=>{
    let previous=await store.read<{date:string;symbols:string[];cursor:number;done:boolean;mode?:UpdateMode}>(SCHEDULE);
    if(previous?.payload.date===target && previous.payload.done)return {scheduled:0};
    const registry=await store.read<Registry>(KEY);
    const registered=[...new Set(Object.values(registry?.payload.owners??{}).flatMap(v=>v.symbols))].sort();
    // 自动更新范围 = 全部已登记自选（跨分组合并、按代码去重）。
    // 删除自选即不再登记，因此也不会再入队。
    const symbols=previous?.payload.date===target ? previous.payload.symbols : registered;
    const cursor=previous?.payload.date===target?previous.payload.cursor:0;
    // 平日轻量（仅当日增量 + 最新财报/分红），周日 06:30 补偿场跑一次完整 recent 复核。
    const mode:UpdateMode = previous?.payload.date===target ? (previous.payload.mode ?? 'daily')
      : (pass==='recovery' && d.getUTCDay()===0 ? 'recent' : 'daily');
    if(previous?.payload.date!==target){
      const snapshot=marketRecord(SCHEDULE,'market-close-schedule','internal',{date:target,symbols,cursor:0,done:false,at:now,mode},864e5,now);
      if(!await store.write(snapshot,previous?.digest??null))throw Error('收盘范围快照保存失败');
      previous=await store.read(SCHEDULE);
    }
    const queue=new MarketUpdateQueue(store,()=>now);
    const batch=symbols.slice(cursor,cursor+1000);
    if(batch.length)await queue.submit(`system:close:${target}:${cursor/1000}`,batch,false,mode);
    const next=cursor+batch.length;
    if(!await store.write(marketRecord(SCHEDULE,'market-close-schedule','internal',{date:target,symbols,cursor:next,done:next>=symbols.length,at:now,mode},864e5,now),previous?.digest??null))throw Error('收盘任务进度保存失败');
    return {scheduled:batch.length,date:target};
  });
}
