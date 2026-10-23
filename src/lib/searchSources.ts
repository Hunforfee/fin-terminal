import type { SearchHit } from './datasource/types';

/** A usable source releases autocomplete without waiting for a slow mirror.
 * Keep a short merge window for near-simultaneous replies and cancel the loser. */
export function searchSources(sources:((signal:AbortSignal)=>Promise<SearchHit[]>)[],fallback:SearchHit[]=[],deadlineMs=2200,mergeMs=80):Promise<SearchHit[]>{
 return new Promise((resolve,reject)=>{
  const controller=new AbortController(),results:SearchHit[][]=sources.map(()=>[]);
  let pending=sources.length,successes=0,finished=false,merge:ReturnType<typeof setTimeout>|undefined;
  const finish=()=>{
   if(finished)return;finished=true;clearTimeout(deadline);clearTimeout(merge);controller.abort();
   const seen=new Set<string>(),out:SearchHit[]=[];
   for(const h of [...results.flat(),...fallback]){const key=`${h.market}:${h.kind}:${h.code}`;if(!seen.has(key)){seen.add(key);out.push(h);}}
   if(!out.length && !successes)reject(Error('搜索服务暂时不可用，请重试'));
   else resolve(out.slice(0,20));
  };
  const deadline=setTimeout(finish,deadlineMs);
  if(!sources.length){finish();return;}
  sources.forEach((source,index)=>{
   Promise.resolve().then(()=>source(controller.signal)).then(hits=>{
    if(finished)return;
    successes++;results[index]=hits;
    if(hits.length && !merge)merge=setTimeout(finish,mergeMs);
   },()=>{}).finally(()=>{if(!finished && !--pending)finish();});
  });
 });
}
