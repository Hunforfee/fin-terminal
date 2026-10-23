import { HISTORY_YEARS } from './marketHistoryPlan';
/** Persist source inputs, not derived PE/PB/yields. Expired inputs never silently become current. */
import { getMarketStore, marketRecord, marketDigest, type MarketStore, type MarketRecord } from './marketStore';
import { cached } from './datasource/cache';
import { withMarketRefresh } from './marketRefresh';
import { retainMarketPayload } from './marketRetention';
import { databaseOnly, marketDataMissing, allowSavedMarketFallback } from './marketReadPolicy';
import { savedMarketValue, observeMarketValue, marketPersistenceFailed } from './marketReadStatus';
import { financialPageGaps, missingIndicatorReports } from './financialPageQuality';
import { dividendIdentity, mergeHkDividendEvents } from './hkDividendEvents';
import { currentUpstreamBudget } from './upstreamBudget';

export function cachedMarketInput<T>(key: string, kind: string, source: string, ttl: number,
  producer: () => Promise<T>, validate: (value: T) => void, sourceOf?: (value: T) => string,
  options: { forceRefresh?: boolean } = {}): Promise<T> {
  const store = getMarketStore();
  if (!currentUpstreamBudget() && /^(source-sina-page|source-sina-indicators)$/.test(kind)) ttl = Math.max(ttl, 6 * 3600e3);
  // The persistent record owns freshness. A second full TTL on a nearly expired
  // record would hide later writes and extend its effective lifetime.
  if (store || databaseOnly() || options.forceRefresh) return storedMarketInput(key, kind, source, ttl, producer, validate, store, Date.now(), sourceOf, options);
  return cached(`market-input:${key}`, ttl, () => storedMarketInput(key, kind, source, ttl, producer, validate, null, Date.now(), sourceOf));
}

const withoutStore = {};
const pendingInputs = new WeakMap<object, Map<string, Promise<unknown>>>();

const wire = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_key, value) => {
  if (value instanceof Map) return { $marketMap: [...value.entries()] };
  if (typeof value === 'number' && !Number.isFinite(value)) throw Error('来源含非有限数值');
  return value;
}));
const decode = <T>(v: unknown): T => JSON.parse(JSON.stringify(v), (_key, value) =>
  value && typeof value === 'object' && Array.isArray(value.$marketMap) ? new Map(value.$marketMap) : value);
function observeStoredInput<T>(value:T,row:MarketRecord):T {
  const issue=(value as {retainedSourceConflicts?:{source:string;acquiredAt:string}}|null)?.retainedSourceConflicts;
  return issue?savedMarketValue(value,{key:row.key,source:issue.source,acquiredAt:issue.acquiredAt,
    reason:'新旧披露数值冲突，已保留原值，待复核'}):value;
}

/** Complete old source years are immutable on ordinary reads; explicit force refresh still checks revisions. */
function completeHistoricalInput(key: string, kind: string, value: any, now: number): boolean {
  const match = /^source-sina-(page|indicators):v1:\d{6}:(?:(profit|balance|cashflow):)?(\d{4})$/.exec(key);
  if (!match || Number(match[3]) >= new Date(now + 8 * 3600e3).getUTCFullYear() - 1) return false;
  const dates = ['03-31','06-30','09-30','12-31'].map(d => `${match[3]}-${d}`);
  return kind === 'source-sina-page' && !!match[2]
    ? financialPageGaps(value, match[2] as 'profit'|'balance'|'cashflow', dates).length === 0
    : kind === 'source-sina-indicators' && missingIndicatorReports(value, dates).length === 0;
}
function savedFallback<T>(old: MarketRecord | null | undefined, kind: string, now: number,
  validate: (value: T) => void, reason: unknown): T | undefined {
  if (!old || !allowSavedMarketFallback()) return undefined;
  try {
    const value = retainMarketPayload(kind, decode<T>(old.payload), now); validate(value);
    return savedMarketValue(value, { key: old.key, source: old.source, acquiredAt: old.acquiredAt,
      reason: (reason instanceof Error ? reason.message : String(reason)).slice(0, 300) });
  } catch { return undefined; }
}

async function availableInput(store: MarketStore, key: string, kind: string, now: number): Promise<MarketRecord | null> {
  const primary = await store.read(key);
  if (primary) return primary;
  const match = /^(statements-v3|disclosures-v3):(\d{6}):(\d+)$/.exec(key);
  if (!match || kind !== (match[1] === 'statements-v3' ? 'financial-history' : 'disclosure-dates')) return null;
  const span = Number(match[3]);
  if (!Number.isInteger(span) || span < 2 || span >= HISTORY_YEARS+2) return null;
  const broader = Array.from({ length: HISTORY_YEARS+2 - span }, (_, i) => `${match[1]}:${match[2]}:${span + i + 1}`);
  const records = store.readInputs ? await store.readInputs(broader) : await Promise.all(broader.map(k => store.read(k)));
  // Reuse the actual record and its freshness; do not duplicate its payload or
  // manufacture a new acquisition time just because the display range changed.
  return records.filter((r): r is MarketRecord => !!r && broader.includes(r.key) && r.kind === kind
      && (databaseOnly() || Date.parse(r.refreshAfter) > now))
    .sort((a, b) => Number(b.key.split(':').at(-1)) - Number(a.key.split(':').at(-1)))[0] ?? null;
}

// Source pages are a date x field matrix. A shorter reply must not erase fields
// supplied by an import, and a missing cell is not evidence that its value is zero.
function mergeSourcePage(prior: any, next: any, priorSource: string, nextSource: string,
  conflict: (detail: unknown) => void = () => {}): any {
  const unit = (v: unknown) => ['wan', '万元', '人民币万元'].includes(String(v)) ? 'wan' : v;
  if (prior.unit && next.unit && unit(prior.unit) !== unit(next.unit)) throw Error('财报来源单位发生变化，未混合历史金额');
  const dates = [...new Set<string>([...prior.dates, ...next.dates])].sort().reverse();
  const oldIndex = new Map<string, number>(prior.dates.map((d: string, i: number) => [d, i]));
  const newIndex = new Map<string, number>(next.dates.map((d: string, i: number) => [d, i]));
  const incoming = new Map<string, any>(next.rows.filter((r: any) => r.kind === 'field').map((r: any) => [r.name, r]));
  const template = [...prior.rows];
  for (const row of next.rows) if (!template.some(r => r.kind === row.kind && r.name === row.name)) template.push(row);
  const populated = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== ''
    && Number.isFinite(Number(String(v).replaceAll(',', '')));
  const fieldSources: Record<string,string[]> = {};
  const rows = template.map(row => row.kind !== 'field' ? row : { ...row, vals: dates.map((d,i) => {
    const oi = oldIndex.get(d), ni = newIndex.get(d);
    const value = ni === undefined ? null : incoming.get(row.name)?.vals[ni];
    const previous=oi===undefined?'--':row.vals[oi]??'--';
    const different=populated(value) && populated(previous) && Math.abs(Number(String(value).replaceAll(',',''))-Number(String(previous).replaceAll(',','')))>
      Math.max(1e-9,Math.abs(Number(String(previous).replaceAll(',','')))*1e-9);
    if(different) conflict({date:d,field:row.name,stored:previous,incoming:value,storedSource:priorSource,incomingSource:nextSource});
    const fresh=populated(value) && !different;
    (fieldSources[row.name]??=Array(dates.length).fill(''))[i]=fresh
      ? next.fieldSources?.[row.name]?.[ni!] || nextSource
      : populated(previous) ? prior.fieldSources?.[row.name]?.[oi!] || priorSource : '';
    return fresh ? value : previous;
  }) });
  return { ...prior, ...next, dates, rows, fieldSources,
    sourceEvidence:{...prior.sourceEvidence,...next.sourceEvidence}, ...(prior.announceDates || next.announceDates ? {
    announceDates: dates.map(d => {
      const oi = oldIndex.get(d), ni = newIndex.get(d);
      return (ni === undefined ? null : next.announceDates?.[ni]) ?? (oi === undefined ? null : prior.announceDates?.[oi]) ?? null;
    }),
  } : {}) };
}
export async function storedMarketInput<T>(key: string, kind: string, source: string, ttl: number,
  producer: () => Promise<T>, validate: (value: T) => void,
  store: MarketStore | null = getMarketStore(), now = Date.now(), sourceOf?: (value: T) => string,
  options: { forceRefresh?: boolean } = {}): Promise<T> {
  const owner = store ?? withoutStore;
  let pending = pendingInputs.get(owner);
  if (!pending) { pending = new Map(); pendingInputs.set(owner, pending); }
  const identity = JSON.stringify([key, kind, source, ttl, databaseOnly(), !!options.forceRefresh]);
  const existing = pending.get(identity);
  if (existing) { const value = await existing as T; validate(value); return observeMarketValue(value); }
  const work = (async()=>{
    if (store) {
      const row = await availableInput(store, key, kind, now).catch(error => {
        if (databaseOnly()) throw Error(`数据库读取或校验失败：${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      if (row && (!options.forceRefresh && (Date.parse(row.refreshAfter)>now || completeHistoricalInput(key,kind,decode(row.payload),now)) || databaseOnly())) {
        try { const value=retainMarketPayload(kind,decode<T>(row.payload),now);validate(value);return observeStoredInput(value,row); }
        catch (error) { if (databaseOnly()) throw Error(`数据库输入未通过校验：${error instanceof Error ? error.message : String(error)}`); }
      }
    }
    if (databaseOnly()) throw marketDataMissing('财务或分红输入');
    return withMarketRefresh(store, key, () => readOrFetchInput(key, kind, source, ttl, producer, validate, store, now, sourceOf, options));
  })()
    .finally(() => pending!.delete(identity));
  pending.set(identity, work);
  return work.then(observeMarketValue);
}
async function readOrFetchInput<T>(key: string, kind: string, source: string, ttl: number,
  producer: () => Promise<T>, validate: (value: T) => void,
  store: MarketStore | null, now: number, sourceOf?: (value: T) => string,
  options: { forceRefresh?: boolean } = {}): Promise<T> {
  let old;
  if (store) {
    try {
      old = await store.read(key);
      if (old && (!options.forceRefresh && (Date.parse(old.refreshAfter) > now || completeHistoricalInput(key,kind,decode(old.payload),now)) || databaseOnly())) {
        const value = retainMarketPayload(kind, decode<T>(old.payload),now); validate(value); return observeStoredInput(value,old);
      }
    } catch { /* Store outage must not prevent source access. */ }
  }
  if (databaseOnly()) throw marketDataMissing('财务或分红输入');
  const failureKey=`market-input-failure:v1:${marketDigest(key)}`;
  if(store && !options.forceRefresh){
    const failed=await store.read<{until:number;message:string}>(failureKey);
    if(failed && failed.payload.until>now){
      const reason = `该输入暂不可用，重试时间 ${new Date(failed.payload.until).toISOString()}：${failed.payload.message}`;
      const saved = savedFallback(old,kind,now,validate,reason); if (saved !== undefined) return saved;
      throw Error(reason);
    }
  }
  let value: T;
  let produced = false;
  const conflicts: unknown[]=[];
  try {
    const incoming = await producer(); produced = true;
    value = retainMarketPayload(kind, incoming,now); validate(value);
    if (old) {
      const prior = retainMarketPayload(kind,decode<any>(old.payload),now), next = value as any;
      if (Array.isArray(prior) && Array.isArray(next) && prior.length && prior.every(r => r && typeof r.date === 'string')) {
        const byDate = new Map<any, any>(next.map(r => [r.date, r]));
        // An upstream response may legitimately cover fewer report dates than the
        // database (imported histories are often more complete, and providers
        // paginate or rate-limit). Dropping verified local history would destroy
        // data, so keep every known date and only let upstream add or refresh.
        const shrunk = prior.filter(r => !byDate.has(r.date));
        if (shrunk.length) {
          try { await store?.incident(key, 'source_history_shrank', { missingDates: shrunk.map(r => r.date), kept: shrunk.length }); } catch {}
          for (const row of prior) if (!byDate.has(row.date)) byDate.set(row.date, row);
          value = [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date))) as T;
        }
        if (kind === 'financial-history') {
          let repaired = false;
          for (const row of prior) {
            const target = byDate.get(row.date);
            if (!target) continue;
            for (const field of ['npParent', 'npTotal', 'equityParent', 'equityTotal', 'equityCommon', 'sharesYi'])
              if (typeof row[field] === 'number' && (target as any)[field] == null) { (target as any)[field] = row[field]; repaired = true; }
          }
          if (repaired) try { await store?.incident(key, 'source_amounts_partial', { key, keptFrom: 'local' }); } catch {}
        }
        if(kind==='share-events')for(const row of prior){
          const target=byDate.get(row.date);
          if(!target || row.baseline || target.baseline || typeof row.sharesWan!=='number' || typeof target.sharesWan!=='number')continue;
          const tolerance=Math.max(row.precisionShares??1,target.precisionShares??1)/2+.00001;
          if(Math.abs(row.sharesWan-target.sharesWan)*1e4>tolerance)throw Error('实际股本来源冲突，未覆盖已有历史');
        }
      }
      if(kind==='implemented-dividends' && Array.isArray(prior) && Array.isArray(next)){
        const events=new Map(next.map(r=>[r.exDate,r]));
        for(const row of prior){
          const target=events.get(row.exDate);
          if(!target){events.set(row.exDate,row);continue;}
          const tolerance=Math.max(row.precisionPerShare??0,target.precisionPerShare??0)/2+1e-10;
          if(Math.abs(row.perShare-target.perShare)>tolerance
            || row.perShareStock!=null && target.perShareStock!=null && Math.abs(row.perShareStock-target.perShareStock)>1e-10)
            throw Error('已实施分红来源冲突，未覆盖已有现金或送转记录');
          if((row.precisionPerShare??0)<(target.precisionPerShare??0))events.set(row.exDate,row);
        }
        value=[...events.values()].sort((a,b)=>a.exDate.localeCompare(b.exDate)) as T;
      }
      // Same rule for disclosure maps: a thinner upstream reply must not erase
      // publication dates that are already verified and stored.
      if (kind === 'source-sina-page') value = mergeSourcePage(prior, next, old.source, sourceOf?.(value)??source,detail=>conflicts.push(detail));
      if (kind === 'source-sina-indicators' && prior.rows instanceof Map && next.rows instanceof Map) {
        const matrix=(p:any)=>({...p,rows:[...p.rows].map(([name,vals])=>({kind:'field',name,vals}))});
        const merged=mergeSourcePage(matrix(prior),matrix(next),old.source,sourceOf?.(value)??source,detail=>conflicts.push(detail));
        value={...merged,rows:new Map(merged.rows.map((r:any)=>[r.name,r.vals.map((v:unknown)=>v==='--'?null:v)]))};
      }
      if (prior instanceof Map && next instanceof Map) {
        const missing = [...prior.keys()].filter(k => !next.has(k));
        for (const k of missing) next.set(k, prior.get(k));
        if (missing.length) try { await store?.incident(key, 'disclosure_coverage_shrank', { kept: missing.length }); } catch {}
      }
      // 港股分红按 eventId ?? exDate 合并：上游「已确认无派息」或更薄的回复
      // 不得擦除已入库的派息历史（该 kind 用 exDate 而非 date，不适用上面的按日期合并）。
      if (kind === 'hk-recent-dividend-events' && Array.isArray(prior) && Array.isArray(next) && prior.length) {
        const id = (r: any) => dividendIdentity(r);
        value = mergeHkDividendEvents(prior, next) as T;
        const missing = prior.filter((r: any) => !next.some((n: any) => id(n) === id(r)));
        if (missing.length) try { await store?.incident(key, 'source_history_shrank', { missingEvents: missing.map((r:any)=>r.eventId??id(r)), kept: prior.length }); } catch {}
      }
      validate(value);
    }
  }
  catch (e) {
    if(store)try {
      const oldFailure=await store.read(failureKey);
      const delay=/:(20\d{2})$/.test(key) && Number(key.slice(-4))<new Date(now).getUTCFullYear()-1 ? 24*3600e3 : 15*60e3;
      await store.write(marketRecord(failureKey,'input-failure','internal',{key,until:now+delay,message:(e instanceof Error?e.message:String(e)).slice(0,300)},delay,now),oldFailure?.digest??null);
    }catch{}
    try { await store?.incident(key, 'source_input_failed', { message: e instanceof Error ? e.message : String(e) }); } catch {}
    // Only a failed source read may use a previously validated snapshot. Conflicting
    // or invalid new amounts still fail; collectors never count fallback as success.
    const saved = !produced ? savedFallback(old,kind,now,validate,e) : undefined;
    if (saved !== undefined) return saved;
    if (kind === 'financial-history') throw Error(`财报数据不可用：${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
  if (store) {
    if(conflicts.length) {
      try { await store.incident(key,'financial_values_conflict',{priorDigest:old?.digest,conflicts}); } catch { marketPersistenceFailed(key+':conflict-evidence'); }
      if(old) {
        const origin=(old.payload as {retainedSourceConflicts?:{source:string;acquiredAt:string}})?.retainedSourceConflicts??{source:old.source,acquiredAt:old.acquiredAt};
        (value as Record<string,unknown>).retainedSourceConflicts={...origin,count:conflicts.length};
        savedMarketValue(value,{key,...origin,reason:'新旧披露数值冲突，保留原值并记录候选值，待复核'});
      }
    }
    const failure=await store.read(failureKey).catch(()=>null);
    if(failure && store.remove)await store.remove(failureKey,failure.digest).catch(()=>false);
    try {
      if (!await store.write(marketRecord(key, kind, sourceOf?.(value)??source, wire(value), ttl, now), old?.digest ?? null)) marketPersistenceFailed(key);
    } catch { marketPersistenceFailed(key); }
  }
  return value;
}

export function validateDatedRows(rows: readonly Record<string, unknown>[], dateKey: string,
  required: string[] = [], allowFuture = false): void {
  if (!Array.isArray(rows) || !rows.length) throw Error('缺少有效来源记录');
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const seen = new Set<string>();
  let populated = false;
  for (const row of rows) {
    const d = row[dateKey];
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d) ||
        new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) !== d || (!allowFuture && d > today) || seen.has(d))
      throw Error('来源日期无效、重复或晚于当前日期');
    seen.add(d);
    populated ||= required.length === 0 || required.some(k => typeof row[k] === 'number' && Number.isFinite(row[k]));
  }
  if (!populated) throw Error('来源关键字段全部缺失');
}
