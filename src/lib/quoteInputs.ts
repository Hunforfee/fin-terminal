import { getMarketStore, marketRecord, type MarketStore } from './marketStore';
import { withMarketRefresh } from './marketRefresh';
import { cached, defaultTtl } from './datasource/cache';
import type { Quote } from './datasource/types';
const inflight = new Map<string,Promise<Quote | null>>();
const key = (symbol: string)=>`latest-quote:v1:${symbol}:raw-provider`;
const valid = (row: Quote, symbol: string)=>row.symbol===symbol && row.price!==null && Number.isFinite(row.price) && row.price>=0 && !row.stale;
const fresh = (row: {refreshAfter:string;acquiredAt:string},symbol:string)=>Date.parse(row.refreshAfter)>Date.now()
  && Date.parse(row.acquiredAt)+defaultTtl(symbol.startsWith('hk')?'HK':'A')>Date.now();

/** Single-stock identity across different page batches. HK derived PB/yield are applied AFTER this layer. */
export async function sharedQuotes(symbols: string[], fetcher: (symbols: string[])=>Promise<Quote[]>, store: MarketStore | null = getMarketStore()): Promise<Quote[]> {
  const unique=[...new Set(symbols)].sort(), found=new Map<string,Quote>(), waits=new Map<string,Promise<Quote|null>>();
  if (store) for (const symbol of unique) {
    const row=await store.read<Quote>(key(symbol)).catch(()=>null);
    if(row && fresh(row,symbol) && valid(row.payload,symbol))found.set(symbol,row.payload);
  }
  const missing=unique.filter(s=>!found.has(s));
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const owned=missing.filter(s=>!inflight.has(s));
  for(const symbol of missing){
    if(inflight.has(symbol)){waits.set(symbol,inflight.get(symbol)!);continue;}
    const promise=gate.then(()=>results.get(symbol)??null);inflight.set(symbol,promise);waits.set(symbol,promise);
  }
  const results=new Map<string,Quote>();
  async function acquire(index: number): Promise<void>{
    if(index<owned.length)return withMarketRefresh(store,'quote:'+owned[index],()=>acquire(index+1));
    const pending: string[]=[], digests=new Map<string,string|null>();
    for(const symbol of owned){
      const row=await store?.read<Quote>(key(symbol));
      if(row && fresh(row,symbol) && valid(row.payload,symbol))results.set(symbol,row.payload);
      else {pending.push(symbol);digests.set(symbol,row?.digest??null);}
    }
    if(!pending.length)return;
    const requestOrder=symbols.filter(s=>pending.includes(s)),ttl=Math.min(...pending.map(s=>defaultTtl(s.startsWith('hk')?'HK':'A')));
    const rows=await (store?fetcher(requestOrder):cached(`raw-quotes:${requestOrder.join(',')}:${ttl}`,ttl,()=>fetcher(requestOrder)));
    for(const row of rows){
      if(!pending.includes(row.symbol))continue;
      results.set(row.symbol,row);
      if(store && valid(row,row.symbol)){
        const written=await store.write(marketRecord(key(row.symbol),'latest-quote',row.source,row,defaultTtl(row.symbol.startsWith('hk')?'HK':'A')),digests.get(row.symbol)??null);
        if(!written){const latest=await store.read<Quote>(key(row.symbol));if(latest && fresh(latest,row.symbol) && valid(latest.payload,row.symbol))results.set(row.symbol,latest.payload);}
      }
    }
  }
  try {if(owned.length)await acquire(0);}
  finally { release();for(const symbol of owned)inflight.delete(symbol); }
  for(const [symbol,promise]of waits){const row=await promise;if(row)found.set(symbol,row);}
  return symbols.flatMap(s=>found.has(s)?[found.get(s)!]:[]);
}
