import { marketRecord, marketDigest, getMarketStore, type MarketStore, type MarketRecord } from './marketStore';
import { withMarketRefresh } from './marketRefresh';
import { marketCutoff } from './marketRetention';
import { databaseOnly, marketDataMissing, allowSavedMarketFallback } from './marketReadPolicy';
import { savedMarketValue, marketPersistenceFailed } from './marketReadStatus';
type Raw = Record<string, unknown>;
interface Reports { main: Raw[]; income: Raw[] }
interface Input extends Reports { fetchedPeriods: Record<string, number>; retainedSourceConflicts?:{source:string;acquiredAt:string} }
const key = (code: string) => `screen-company-input:v1:${code}:eastmoney:CNY`;
const TTL = 6 * 3600e3;
// A partial current response cannot erase another report or previously known cells.
function mergeRows(previous: Raw[], incoming: Raw[], conflict:(detail:unknown)=>void): Raw[] {
  const rows = new Map(previous.map(row => [String(row.REPORT_DATE).slice(0,10), row]));
  for (const row of incoming) {
    const date = String(row.REPORT_DATE).slice(0,10), old = rows.get(date) ?? {};
    const merged={...old};
    for(const [field,value] of Object.entries(row)) {
      if(value===null || value===undefined || value==='')continue;
      const prior=old[field];
      const numeric=(v:unknown)=>typeof v==='number'&&Number.isFinite(v) || typeof v==='string'&&v.trim()!==''&&Number.isFinite(Number(v));
      if(numeric(prior)&&numeric(value)&&!['SECURITY_CODE'].includes(field)&&Math.abs(Number(prior)-Number(value))>Math.max(1e-9,Math.abs(Number(prior))*1e-9)) {
        conflict({date,field,stored:prior,incoming:value});continue;
      }
      merged[field]=value;
    }
    rows.set(date,merged);
  }
  return [...rows.values()];
}

/** Canonical per-company financial inputs shared across watchlists/industries/scopes. */
export async function storedScreenFinancials(codes: string[], periods: string[],
  producer: (missing: string[]) => Promise<Reports>, store: MarketStore | null = getMarketStore(), now = Date.now()): Promise<Reports> {
  const unique = [...new Set(codes)].sort();
  periods = periods.filter(date=>date>=marketCutoff(now));
  if (!unique.length) return { main: [], income: [] };
  if (!store) { if(databaseOnly())throw marketDataMissing('选股财报');return producer(unique); }
  const read = async()=>{
  const records = new Map<string, MarketRecord<Input>>();
  try {
    if (store.readInputs) for (const row of await store.readInputs(unique.map(key))) records.set(row.key, row as MarketRecord<Input>);
    else for (const code of unique) { const row = await store.read<Input>(key(code)); if (row) records.set(row.key, row); }
  } catch { records.clear(); }
  const missing = unique.filter(code => {
    const row = records.get(key(code));
    return !row || !periods.every(period => databaseOnly() ? !!row.payload.fetchedPeriods?.[period] : now - (row.payload.fetchedPeriods?.[period] ?? 0) < TTL);
  });
  if(databaseOnly() && missing.length)throw marketDataMissing(`${missing.length} 家公司的选股财报`);
  let fresh: Reports;
  try { fresh = missing.length ? await producer(missing) : { main: [], income: [] }; }
  catch (error) {
    if (!allowSavedMarketFallback() || !records.size) throw error;
    const output: Reports = { main: [], income: [] };
    for (const code of unique) {
      const row=records.get(key(code)); if (!row) continue;
      for (const kind of ['main','income'] as const) output[kind].push(...row.payload[kind].filter(r => periods.includes(String(r.REPORT_DATE).slice(0,10))));
      if (missing.includes(code)) savedMarketValue(output, {key:row.key,source:row.source,acquiredAt:row.acquiredAt,reason:String(error).slice(0,300)});
    }
    if (!output.main.length) throw error;
    return output;
  }
  const set = new Set(missing);
  if ([...fresh.main, ...fresh.income].some(row => !set.has(String(row.SECURITY_CODE)))) throw Error('财报存储证券范围不匹配');
  const byCode = new Map<string, Reports>();
  for (const code of missing) byCode.set(code, { main: [], income: [] });
  for (const kind of ['main', 'income'] as const) for (const row of fresh[kind]) byCode.get(String(row.SECURITY_CODE))![kind].push(row);
  const writes: { record: MarketRecord; expected: string | null }[] = [];
  const output: Reports = { main: [], income: [] };
  for (const code of unique) {
    const previous = records.get(key(code));
    let value = previous?.payload;
    if (set.has(code)) {
      const fetched = byCode.get(code)!;
      const returned = [...new Set(fetched.main.map(r => String(r.REPORT_DATE).slice(0,10)))];
      const conflicts:unknown[]=[];
      value = { ...value, main: mergeRows(value?.main ?? [],fetched.main,detail=>conflicts.push(detail)), income: mergeRows(value?.income ?? [],fetched.income,detail=>conflicts.push(detail)),
        fetchedPeriods: { ...value?.fetchedPeriods, ...Object.fromEntries(returned.map(p => [p, now])) } };
      if(conflicts.length && previous) {
        value.retainedSourceConflicts??={source:previous.source,acquiredAt:previous.acquiredAt};
        try{await store.incident(key(code),'financial_values_conflict',{priorDigest:previous.digest,conflicts});}catch{marketPersistenceFailed(key(code)+':conflict-evidence');}
      }
      // Empty responses are never negative-cached as proof that a company has no reports.
      if (fetched.main.length) writes.push({ record: marketRecord(key(code), 'latest-company-financial-input',
        'eastmoney:CNY:yuan:current-revisions:per-company', value, TTL, now), expected: previous?.digest ?? null });
      else if (previous && allowSavedMarketFallback()) savedMarketValue(value,{key:previous.key,source:previous.source,acquiredAt:previous.acquiredAt,reason:'来源未返回有效财报，保留原有数据'});
    }
    if (value) {
      for (const kind of ['main', 'income'] as const) output[kind].push(...value[kind].filter(r => periods.includes(String(r.REPORT_DATE).slice(0,10))));
      if(value.retainedSourceConflicts)savedMarketValue(output,{key:key(code),...value.retainedSourceConflicts,reason:'新旧披露数值冲突，已保留原值，待复核'});
    }
  }
  try {
    for (let i = 0; i < writes.length; i += 100) {
      const batch = writes.slice(i, i + 100);
      if (store.writeInputs) { if(await store.writeInputs(batch)!==batch.length) for(const item of batch) marketPersistenceFailed(item.record.key); }
      else for (const item of batch) if(!await store.write(item.record, item.expected)) marketPersistenceFailed(item.record.key);
    }
  } catch { for(const item of writes) marketPersistenceFailed(item.record.key); }
  return output;
  };
  return databaseOnly() ? read() : withMarketRefresh(store,`screen-financial-inputs:${marketDigest([unique,periods])}`,read);
}
