import { marketRecord, getMarketStore, type MarketStore, type MarketRecord } from './marketStore';
import { withMarketRefresh } from './marketRefresh';
import { marketCutoff } from './marketRetention';
type Raw = Record<string, unknown>;
interface Reports { main: Raw[]; income: Raw[] }
interface Input extends Reports { fetchedPeriods: Record<string, number> }
const key = (code: string) => `screen-company-input:v1:${code}:eastmoney:CNY`;

/** Canonical per-company financial inputs shared across watchlists/industries/scopes. */
export async function storedScreenFinancials(codes: string[], periods: string[],
  producer: (missing: string[]) => Promise<Reports>, store: MarketStore | null = getMarketStore(), now = Date.now()): Promise<Reports> {
  const unique = [...new Set(codes)].sort();
  periods = periods.filter(date=>date>=marketCutoff(now));
  if (!unique.length) return { main: [], income: [] };
  if (!store) return producer(unique);
  return withMarketRefresh(store,'screen-financial-inputs',async()=>{
  const records = new Map<string, MarketRecord<Input>>();
  try {
    if (store.readInputs) for (const row of await store.readInputs(unique.map(key))) records.set(row.key, row as MarketRecord<Input>);
    else for (const code of unique) { const row = await store.read<Input>(key(code)); if (row) records.set(row.key, row); }
  } catch { records.clear(); }
  const missing = unique.filter(code => {
    const row = records.get(key(code));
    return !row || !periods.every(period => now - (row.payload.fetchedPeriods?.[period] ?? 0) < 300_000);
  });
  const fresh = missing.length ? await producer(missing) : { main: [], income: [] };
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
      // Replace only the queried periods; retain earlier stored report periods.
      value = { main: [...(value?.main ?? []).filter(r => !periods.includes(String(r.REPORT_DATE).slice(0,10))), ...fetched.main],
        income: [...(value?.income ?? []).filter(r => !periods.includes(String(r.REPORT_DATE).slice(0,10))), ...fetched.income],
        fetchedPeriods: { ...value?.fetchedPeriods, ...Object.fromEntries(periods.map(p => [p, now])) } };
      // Empty responses are never negative-cached as proof that a company has no reports.
      if (fetched.main.length) writes.push({ record: marketRecord(key(code), 'latest-company-financial-input',
        'eastmoney:CNY:yuan:current-revisions:per-company', value, 300_000, now), expected: previous?.digest ?? null });
    }
    if (value) for (const kind of ['main', 'income'] as const)
      output[kind].push(...value[kind].filter(r => periods.includes(String(r.REPORT_DATE).slice(0,10))));
  }
  try {
    for (let i = 0; i < writes.length; i += 100) {
      const batch = writes.slice(i, i + 100);
      if (store.writeInputs) await store.writeInputs(batch);
      else for (const item of batch) await store.write(item.record, item.expected);
    }
  } catch { /* Current validated fetch remains usable during a database outage. */ }
  return output;
  });
}
