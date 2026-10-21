import { marketDigest, marketRecord, type MarketStore } from './marketStore';
import { MarketUpdateQueue, updateSymbols } from './marketUpdateQueue';
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
  if(minute<1110)local.setUTCDate(local.getUTCDate()-1);
  while([0,6].includes(local.getUTCDay()))local.setUTCDate(local.getUTCDate()-1);
  return local.toISOString().slice(0,10);
}
/** 18:30 close pass, 06:30 recovery. The source's actual trading dates are retained, never invented on holidays. */
export async function scheduleMarketClose(store:MarketStore,now=Date.now()){
  const day=closeTarget(now);if(!day)return {scheduled:0};
  const d=new Date(now+8*3600e3),pass=d.getUTCHours()*60+d.getUTCMinutes()<1110?'recovery':'close';
  const target=`${day}:${pass}`;
  const latest=await store.read<{date:string;done?:boolean}>(SCHEDULE);if(latest?.payload.date===target && latest.payload.done)return {scheduled:0};
  return withMarketRefresh(store,'close-schedule',async()=>{
    let previous=await store.read<{date:string;symbols:string[];cursor:number;done:boolean}>(SCHEDULE);
    if(previous?.payload.date===target && previous.payload.done)return {scheduled:0};
    const registry=await store.read<Registry>(KEY);
    const symbols=previous?.payload.date===target ? previous.payload.symbols : [...new Set(Object.values(registry?.payload.owners??{}).flatMap(v=>v.symbols))].sort();
    const cursor=previous?.payload.date===target?previous.payload.cursor:0;
    if(previous?.payload.date!==target){
      const snapshot=marketRecord(SCHEDULE,'market-close-schedule','internal',{date:target,symbols,cursor:0,done:false,at:now},864e5,now);
      if(!await store.write(snapshot,previous?.digest??null))throw Error('收盘范围快照保存失败');
      previous=await store.read(SCHEDULE);
    }
    const queue=new MarketUpdateQueue(store,()=>now);
    const batch=symbols.slice(cursor,cursor+1000);
    if(batch.length)await queue.submit(`system:close:${target}:${cursor/1000}`,batch,false,'recent');
    const next=cursor+batch.length;
    if(!await store.write(marketRecord(SCHEDULE,'market-close-schedule','internal',{date:target,symbols,cursor:next,done:next>=symbols.length,at:now},864e5,now),previous?.digest??null))throw Error('收盘任务进度保存失败');
    return {scheduled:batch.length,date:target};
  });
}
