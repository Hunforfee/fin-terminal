import type { SearchHit } from './datasource/types';
import { fetchJson, FetchJsonError } from './fetchJson';
const recent=new Map<string,{until:number;hits:SearchHit[]}>();
/** Only successful public suggestions are memoized. Failures remain retryable. */
export async function fetchSearchSuggestions(query:string,signal:AbortSignal,timeoutMs=5000):Promise<SearchHit[]>{
 signal.throwIfAborted();
 const key=query.trim().toLowerCase(),saved=recent.get(key);
 if(saved && saved.until>Date.now())return saved.hits;
 const deadline=AbortSignal.timeout(timeoutMs);
 try{
  const json=await fetchJson(`/api/search?q=${encodeURIComponent(key)}`,{signal:AbortSignal.any([signal,deadline])});
  if(json.ok!==true || !Array.isArray(json.data))throw Error('搜索暂不可用，请重试');
  signal.throwIfAborted();
  if(json.data.length){recent.delete(key);recent.set(key,{until:Date.now()+300000,hits:json.data});while(recent.size>64)recent.delete(recent.keys().next().value!);}
  return json.data;
 }catch(e){
  if(deadline.aborted && !signal.aborted)throw Error('搜索超时，请重试');
  // 自动补全场景统一给简洁可读提示，不向用户暴露 HTTP 状态码等底层细节
  if(e instanceof FetchJsonError)throw Error('搜索暂不可用，请重试');
  throw e;
 }
}
