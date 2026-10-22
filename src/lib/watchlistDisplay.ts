import type { Quote } from './datasource/types';
export const WATCHLIST_DISPLAY_KEY='fin.watchlist.display.v1';
export interface DisplayFinancial { code:string;name:string;periods:string[];series:Record<string,(number|null)[]> }
export interface WatchlistDisplay {
  version:1;at:number;quotes:Quote[];otherAssets:Quote[];financials:DisplayFinancial[];
  dividendYields:[string,number|null][];deductedPes:[string,number|null][];
  metricDates?:[string,{at:string;stale:boolean}][];
}
export function readWatchlistDisplay(raw:string|null,codes:string[],now=Date.now()):WatchlistDisplay|null {
  try {
    const saved=JSON.parse(raw??'null');
    if(saved?.version!==1 || !Number.isFinite(saved.at) || saved.at>now || now-saved.at>7*864e5)return null;
    if(!['quotes','otherAssets','financials','dividendYields','deductedPes'].every(key=>Array.isArray(saved[key])))return null;
    const wanted=new Set(codes),financialCodes=new Set(codes.map(code=>code.slice(2)));
    return {...saved,quotes:saved.quotes.filter((q:Quote)=>wanted.has(q.symbol)),otherAssets:saved.otherAssets.filter((q:Quote)=>wanted.has(q.symbol)),
      financials:saved.financials.filter((f:DisplayFinancial)=>financialCodes.has(f.code)),
      dividendYields:saved.dividendYields.filter(([s]:[string,unknown])=>wanted.has(s)),deductedPes:saved.deductedPes.filter(([s]:[string,unknown])=>wanted.has(s)),
      metricDates:Array.isArray(saved.metricDates)?saved.metricDates.filter(([s]:[string,unknown])=>wanted.has(s.split(':')[0])):[]};
  }catch{return null;}
}
/** Re-evaluated after every response so a newly visible page moves to the front. */
export function takePrioritized(pending:Set<string>,visible:readonly string[],count:number):string[] {
  const selected=[...new Set([...visible,...pending])].filter(symbol=>pending.has(symbol)).slice(0,count);
  for(const symbol of selected)pending.delete(symbol);
  return selected;
}
export function requestLimiter(limit:number,signal:AbortSignal) {
  let running=0;const waiting:(()=>void)[]=[];
  return async <T>(work:()=>Promise<T>):Promise<T>=>{
    if(running>=limit)await new Promise<void>(resolve=>waiting.push(resolve));else running++;
    try {signal.throwIfAborted();return await work();}
    finally {const next=waiting.shift();if(next)next();else running--;}
  };
}
