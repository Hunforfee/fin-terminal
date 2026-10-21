import { randomUUID } from 'node:crypto';
import { marketDigest, marketRecord, type MarketStore } from './marketStore';
import { currentUpstreamBudget } from './upstreamBudget';
type Lease = { owner: string; until: number };
/** Short CAS leases use the same PostgreSQL store across processes; no connection is held during HTTP. */
export async function withMarketRefresh<T>(store: MarketStore | null, identity: string, work: () => Promise<T>): Promise<T> {
  if (!store?.coordinated) return work();
  const key = 'market-fetch-lease:v1:'+marketDigest(identity), owner = randomUUID();
  const deadline = Date.now()+225e3, signal = currentUpstreamBudget()?.signal;
  while (true) {
    signal?.throwIfAborted();
    const row = await store.read<Lease>(key), now = Date.now();
    if ((!row || row.payload.until <= now) && await store.write(marketRecord(key,'fetch-lease','internal',{owner,until:now+90e3},90e3),row?.digest ?? null)) break;
    if (now >= deadline) throw Error('数据正在更新，请稍后重试');
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  let lost = false, renewing = Promise.resolve();
  const timer = setInterval(()=>{
    renewing = renewing.then(async()=>{
      const row = await store.read<Lease>(key);
      if (!row || row.payload.owner !== owner || !await store.write(marketRecord(key,'fetch-lease','internal',{owner,until:Date.now()+90e3},90e3),row.digest)) lost = true;
    }).catch(()=>{lost=true;});
  },20e3);
  try { const result = await work(); if (lost) throw Error('数据更新租约已失效，请重试'); return result; }
  finally {
    clearInterval(timer); await renewing;
    const row = await store.read<Lease>(key).catch(()=>null);
    if (row?.payload.owner === owner) await store.write(marketRecord(key,'fetch-lease','internal',{owner,until:0},0),row.digest).catch(()=>{});
  }
}
