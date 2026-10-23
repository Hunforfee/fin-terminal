import { randomUUID } from 'node:crypto';
import { marketRecord, type MarketStore } from './marketStore';

export function upstreamGroup(url:string){
 const host=new URL(url).hostname;
 if(host==='eastmoney.com'||host.endsWith('.eastmoney.com'))return 'eastmoney';
 if(['sina.com.cn','sinajs.cn','sinajs.com.cn'].some(d=>host===d||host.endsWith('.'+d)))return 'sina';
 if(host==='gtimg.cn'||host.endsWith('.gtimg.cn'))return 'tencent';
 return host;
}
type State={owner:string;until:number;nextAt:number;cooldownUntil:number;status:number;failures:number};
export interface SourceSlot { observe(status:number,retryAfter?:string|null):void;release():Promise<void> }
/** A persistent source lease coordinates every worker process using the same DB.
 * Network requests hold no SQL transaction/connection. A dead process loses its lease. */
export async function acquireSourceSlot(store:MarketStore,url:string,signal?:AbortSignal,interval=1500):Promise<SourceSlot>{
 const group=upstreamGroup(url),key=`market-source-gate:v1:${group}`,owner=randomUUID();
 const deadline=Date.now()+180e3;
 let initial:State;
 while(true){
  signal?.throwIfAborted();
  const now=Date.now(),row=await store.read<State>(key);
  const state=row?.payload??{owner:'',until:0,nextAt:0,cooldownUntil:0,status:0,failures:0};
  if(state.cooldownUntil>now)throw Error(`来源 ${group} 冷却中，重试时间 ${new Date(state.cooldownUntil).toISOString()}（HTTP ${state.status||'连接失败'}）`);
  if(now>deadline)throw Error('等待来源请求额度超时');
  const wait=Math.max(state.until-now,state.nextAt-now);
  if(wait<=0){
   initial={...state,owner,until:now+90e3};
   if(await store.write(marketRecord(key,'source-gate','internal',initial,864e5),row?.digest??null))break;
  }else await new Promise<void>((resolve,reject)=>{
   const done=()=>{signal?.removeEventListener('abort',abort);resolve();};
   const timer=setTimeout(done,Math.min(250,wait));
   const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal?.reason??Error('请求取消'));};
   signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });
 }
 let status=0,retryAfter:string|null=null,released=false;
 return {observe(s,after){status=s;retryAfter=after??null;},async release(){
  if(released)return;released=true;
  const row=await store.read<State>(key);
  if(!row || row.payload.owner!==owner)return;
  const now=Date.now(),failed=status===0||[403,429,501,503].includes(status);
  const failures=failed?initial.failures+1:0;
  const numeric=retryAfter?.trim()?Number(retryAfter):NaN;
  const requested=Number.isFinite(numeric)?numeric*1000:retryAfter?Date.parse(retryAfter)-now:0;
  const defaults:Record<number,number>={403:60e3,429:300e3,501:60e3,503:30e3};
  const delay=failed?Math.min(1800e3,Math.max(requested||0,(defaults[status]??(failures>=2?30e3:0))*Math.min(4,2**Math.max(0,failures-1)))):0;
  const next={owner:'',until:0,nextAt:now+interval,cooldownUntil:now+delay,status,failures};
  if(!await store.write(marketRecord(key,'source-gate','internal',next,864e5),row.digest))throw Error('来源请求额度保存冲突');
 }};
}
