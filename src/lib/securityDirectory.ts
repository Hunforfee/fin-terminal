import { pinyin } from 'pinyin-pro';
import seeds from './security-directory-seed.json' with { type: 'json' };
import { INDICES, STOCKS, FUNDS } from './universe';
import { normalizeCode, normalizeStockCode } from './datasource/codes';
import type { SearchHit } from './datasource/types';
import { getMarketStore, marketRecord, type MarketStore } from './marketStore';

export const DIRECTORY_KEY = 'security-directory:v1';
const identity = (r: SearchHit) => `${r.market}:${r.kind}:${r.symbol}`;
const normalized = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
type Entry = { hit: SearchHit; terms: string[] };
function index(rows: SearchHit[]): Entry[] {
  return rows.map(hit => ({ hit, terms: [hit.code, hit.symbol, hit.name, hit.pinyin ?? '',
    pinyin(hit.name, { toneType: 'none', separator: '' }),
    pinyin(hit.name, { pattern: 'first', toneType: 'none', separator: '' })].map(normalized) }));
}
export function matchDirectory(entries: Entry[], keyword: string): SearchHit[] {
  const kw = normalized(keyword);
  if (!kw) return [];
  return entries.map(entry => ({ ...entry, rank: entry.terms.some(t => t === kw) ? 0
    : entry.terms.some(t => t.startsWith(kw)) ? 1 : entry.terms.some(t => t.includes(kw)) ? 2 : 3 }))
    .filter(e => e.rank < 3).sort((a,b) => a.rank-b.rank || a.hit.symbol.localeCompare(b.hit.symbol))
    .slice(0,20).map(e => ({ ...e.hit }));
}
function seedDirectory(): SearchHit[] {
  const rows: SearchHit[] = [];
  const add = (code: string, name: string, kind: SearchHit['kind'], board?: string) => {
    const n = kind === 'stock' ? normalizeStockCode(code) : normalizeCode(code);
    if (n) rows.push({ code:n.code, symbol:n.symbol, market:n.market, kind, name, board, secid:n.secid });
  };
  for (const s of seeds) add(s.market === 'HK' ? `hk${s.code}` : s.code,s.name,'stock');
  // Official short names in the built-in pool take precedence over research titles.
  for (const s of STOCKS) add(s.code,s.name,'stock',s.board);
  for (const s of FUNDS) add(s.code,s.name,'fund',s.board);
  for (const s of INDICES) add(s.symbol,s.name,'index','指数');
  return [...new Map(rows.map(r => [identity(r),r])).values()];
}
function valid(rows: unknown): rows is SearchHit[] {
  return Array.isArray(rows) && rows.length > 0 && rows.every(r => r && typeof r.name === 'string'
    && r.name.trim() && typeof r.code === 'string' && typeof r.symbol === 'string'
    && ['stock','index','fund','etf'].includes(r.kind) && normalizeCode(r.symbol)?.market === r.market);
}

/** One directory read per minute, shared by every query. Never depends on financial coverage. */
export function createSecurityDirectory(storeOf: () => MarketStore | null = getMarketStore) {
  let memory: Entry[] | undefined, checkedAt = 0, pending: Promise<Entry[]> | undefined;
  const baseline = () => seedDirectory();
  async function load(): Promise<Entry[]> {
    if (memory && Date.now()-checkedAt < 60_000) return memory;
    if (pending) return pending;
    pending = (async () => {
      try {
        const store = storeOf();
        let record = await store?.read<SearchHit[]>(DIRECTORY_KEY);
        if (!record && store) {
          await store.write(marketRecord(DIRECTORY_KEY,'security-directory','repository-directory-seed',baseline(),864e5),null);
          record = await store.read<SearchHit[]>(DIRECTORY_KEY);
        }
        if (record && valid(record.payload)) memory = index(record.payload);
      } catch { /* Keep the last successful directory when storage is unavailable. */ }
      memory ??= index(baseline());
      checkedAt = Date.now();
      return memory;
    })().finally(() => { pending = undefined; });
    return pending;
  }
  return {
    async search(keyword: string) { return matchDirectory(await load(),keyword); },
    async remember(hits: SearchHit[]) {
      if (!valid(hits)) return;
      const store = storeOf();
      if (!store) return;
      for (let attempt=0;attempt<5;attempt++) {
        const old = await store.read<SearchHit[]>(DIRECTORY_KEY);
        if (old && !valid(old.payload)) throw Error('证券目录格式无效，未覆盖');
        const rows = [...new Map([...(old?.payload ?? baseline()),...hits].map(r => [identity(r),r])).values()];
        if (await store.write(marketRecord(DIRECTORY_KEY,'security-directory','directory+search-providers',rows,864e5),old?.digest ?? null)) {
          memory = index(rows); checkedAt=Date.now(); return;
        }
      }
      throw Error('证券目录并发更新冲突');
    },
  };
}
export const securityDirectory = createSecurityDirectory();
