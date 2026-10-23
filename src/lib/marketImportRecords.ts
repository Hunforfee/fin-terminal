import { marketRecord, marketDigest, type MarketStore } from './marketStore';
import { financialPageGaps } from './financialPageQuality';
import { requiredFinancialReports, reportCutoff, HISTORY_YEARS } from './marketHistoryPlan';

/**
 * 财务/分红的 QMT 导入写入器。记录写入与现有读取器完全相同的键位与 payload 结构：
 * - 财务：source-sina-page:v1:<code>:<statement>:<year>（payload {dates,rows,unit}）
 * - 分红预案：dividend-plans-v2:<code>；已实施：implemented-dividends-v4:<code>
 * source 标签沿用读取器期望值，保证 cachedMarketInput 直接消费；真实来源在导入日志中留痕。
 */
const isoDate = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  Number.isFinite(Date.parse(s + 'T00:00:00Z')) &&
  new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

const STATEMENTS = ['profit', 'balance', 'cashflow'] as const;
export type StatementId = typeof STATEMENTS[number];

const valStr = (v: unknown): string => {
  if (v === null || v === undefined || v === '' || v === '--' || v === '—') return '--';
  if (typeof v !== 'number' && (typeof v !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(v))) throw Error('科目值必须是数字或空值');
  const n = Number(v);
  if (!Number.isFinite(n)) throw Error(`科目值无效: ${JSON.stringify(v)}`);
  return String(n);
};

export interface FinanceImport {
  symbol: string; // 6 位 A 股代码
  statement: StatementId;
  unit?: 'wan'; currency?: 'CNY'; basis?: 'cumulative';
  reportDates: string[];
  announceDates?: (string | null)[];
  items: { name: string; vals: (number | string | null)[] }[];
}

export async function writeFinanceStatements(store: MarketStore, input: FinanceImport, now = Date.now()) {
  const code = String(input.symbol ?? '');
  if (!/^\d{6}$/.test(code)) throw Error('财务导入仅支持 6 位 A 股代码');
  if ((input.unit !== undefined && input.unit !== 'wan') || (input.currency !== undefined && input.currency !== 'CNY') || (input.basis !== undefined && input.basis !== 'cumulative')) throw Error('财务导入口径必须是人民币万元累计值');
  if (!STATEMENTS.includes(input.statement)) throw Error('statement 必须是 profit/balance/cashflow');
  if (!Array.isArray(input.items) || !input.items.length) throw Error('财务科目为空');
  const dates = input.reportDates;
  if (!Array.isArray(dates) || !dates.length) throw Error('报告期为空');
  const seen = new Set<string>();
  for (const d of dates) {
    if (!isoDate(d)) throw Error(`报告期日期无效: ${d}`);
    if (seen.has(d)) throw Error(`报告期重复: ${d}`);
    seen.add(d);
    if (d.slice(5) !== '03-31' && d.slice(5) !== '06-30' && d.slice(5) !== '09-30' && d.slice(5) !== '12-31')
      throw Error(`报告期必须是季末: ${d}`);
    if (d > chinaDate(now)) throw Error('报告期不能是未来日期');
    if (d < reportCutoff(now)) throw Error('财报范围超出十二年历史输入准入期限');
  }
  const announce = input.announceDates;
  if (announce !== undefined) {
    if (!Array.isArray(announce) || announce.length !== dates.length) throw Error('披露日期数量与报告期不一致');
    for (let i=0;i<announce.length;i++) {
      const a=announce[i];
      if (a !== null && (!isoDate(a) || a<dates[i] || a>chinaDate(now))) throw Error(`披露日期无效: ${a}`);
    }
  }
  const names = new Set<string>();
  for (const it of input.items) {
    if (!it?.name || typeof it.name !== 'string') throw Error('科目名无效');
    if (!Array.isArray(it.vals) || it.vals.length !== dates.length) throw Error(`科目 ${it.name} 的值数量与报告期不一致`);
    if (names.has(it.name)) throw Error(`科目重复: ${it.name}`);
    names.add(it.name);
    it.vals.forEach(valStr);
  }
  // 按年拆分写入（读取器按年取页）
  const byYear = new Map<string, number[]>();
  dates.forEach((d, i) => {
    const y = d.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push(i);
  });
  const basics=await store.read<{listingDate?:string}>(`security-basics:v1:${/^6/.test(code)?'sh':/^[48]/.test(code)?'bj':'sz'}${code}`);
  const written: { key: string; dates: number }[] = [];
  const reconciliation: {key:string;requestedDates:string[];savedDates:string[];missingRequestedDates:string[];expectedDates:string[];missingInputs:{date:string;missing:string[]}[];status:'inserted'|'updated'|'unchanged';digest:string}[]=[];
  let identical = 0;
  for (const [year, idx] of [...byYear.entries()].sort()) {
    const key = `source-sina-page:v1:${code}:${input.statement}:${year}`;
    type Page = { dates: string[]; rows: {kind: string; name: string; vals: string[]}[]; unit: string; announceDates?: (string|null)[] };
    const old = await store.read<Page>(key), prior = old?.payload;
    const yearDates = [...new Set([...(prior?.dates ?? []), ...idx.map(i => dates[i])])].sort().reverse();
    const oldIndex = new Map(prior?.dates.map((d,i)=>[d,i]) ?? []);
    const nextIndex = new Map(idx.map(i=>[dates[i],i]));
    const fields = new Map(input.items.map(it=>[it.name,it]));
    const template = [...(prior?.rows ?? [])];
    for(const it of input.items) if(!template.some(r=>r.kind==='field' && r.name===it.name))
      template.push({kind:'field',name:it.name,vals:[]});
    const rows = template.map(row=>row.kind==='group'?row:{...row, vals:yearDates.map(d=>{
      const oi=oldIndex.get(d), ni=nextIndex.get(d);
      const previous=oi===undefined?'--':row.vals[oi]??'--';
      const item=fields.get(row.name);
      const next=ni!==undefined && item?valStr(item.vals[ni]):'--';
      // Missing input is not a deletion of a previously known financial fact.
      return next==='--'?previous:next;
    })});
    const payload: Page = { ...prior, dates: yearDates, rows, unit: prior?.unit ?? 'wan' };
    if(announce || prior?.announceDates)payload.announceDates=yearDates.map(d=>{
      const ni=nextIndex.get(d),oi=oldIndex.get(d);
      return (ni!==undefined?announce?.[ni]:null) ?? (oi!==undefined?prior?.announceDates?.[oi]:null) ?? null;
    });
    const receipt=async(status:'inserted'|'updated'|'unchanged')=>{
      const saved=await store.read<Page>(key);
      if(!saved)throw Error(`导入后读取失败: ${key}`);
      const requestedDates=idx.map(i=>dates[i]).sort(),savedDates=[...saved.payload.dates].sort();
      const missingRequestedDates=requestedDates.filter(d=>!savedDates.includes(d));
      if(missingRequestedDates.length)throw Error(`导入后缺少请求报告期: ${missingRequestedDates.join(',')}`);
      const expectedDates=[...new Set([...requiredFinancialReports(Number(year),basics?.payload.listingDate,now),...requestedDates])].sort();
      reconciliation.push({key,requestedDates,savedDates,missingRequestedDates,expectedDates,missingInputs:financialPageGaps(saved.payload,input.statement,expectedDates),status,digest:saved.digest});
    };
    // 相同内容幂等跳过（digest 对键序不敏感，规避 PG jsonb 重排）
    if (old && marketDigest(old.payload) === marketDigest(payload)) {
      identical++;
      written.push({ key, dates: yearDates.length });
      await receipt('unchanged');continue;
    }
    if (!await store.write(marketRecord(key, 'source-sina-page', 'sina:reported:wan', payload, 7 * 864e5, now), old?.digest ?? null))
      throw Error(`写入版本冲突: ${key}`);
    written.push({ key, dates: yearDates.length });
    await receipt(old?'updated':'inserted');
  }
  return { code, statement: input.statement, written, totalDates: dates.length,reconciliation,complete:reconciliation.every(r=>!r.missingInputs.length),
    ...(identical === byYear.size ? { skipped: true } : {}) };
}

/* ------------------------------------------------- 财务史（statements-v3） */

export interface FinancialHistoryImport {
  symbol: string;
  unit?: 'wan'; currency?: 'CNY'; shareUnit?: 'shares';
  reportDates: string[];
  /** 金额字段单位万元（累计），totalShares 单位股 */
  items: { code: string; vals: (number | null)[] }[];
}

const WAN_TO_YUAN = 1e4;

/** 写入 statements-v3:<code>:<span>（financial-history，供估值/收盘/净利史读取）。 */
export async function writeFinancialHistory(store: MarketStore, input: FinancialHistoryImport, now = Date.now()) {
  const code = aShareCode(input.symbol);
  if(input.unit!==undefined && input.unit!=='wan' || input.currency!==undefined && input.currency!=='CNY')throw Error('财务史金额必须是人民币万元');
  if (!/^\d{6}$/.test(code)) throw Error('财务史导入仅支持 6 位 A 股代码');
  const dates = input.reportDates;
  if (!Array.isArray(dates) || dates.length < 2) throw Error('财务史报告期不足');
  const seen = new Set<string>();
  for (const d of dates) {
    if (!isoDate(d)) throw Error(`报告期日期无效: ${d}`);
    if (!['03-31','06-30','09-30','12-31'].includes(d.slice(5))) throw Error('财务史报告期必须是季末');
    if (seen.has(d)) throw Error(`报告期重复: ${d}`);
    seen.add(d);
    if (d > chinaDate(now)) throw Error('报告期不能是未来日期');
    if (d < reportCutoff(now)) throw Error('财报范围超出十二年历史输入准入期限');
  }
  const WAN_CODES = new Set(['npParent', 'npTotal', 'equityParent', 'equityTotal', 'equityCommon']);
  if(!Array.isArray(input.items) || !input.items.length)throw Error('财务史科目为空');
  const allowed=new Set([...WAN_CODES,'totalShares']);
  const byCode=new Map<string,(number|null)[]>();
  for(const it of input.items){
    if(!it || !allowed.has(it.code) || byCode.has(it.code))throw Error('财务史科目无效或重复');
    if(!Array.isArray(it.vals) || it.vals.length!==dates.length || it.vals.some(v=>v!==null && (typeof v!=='number' || !Number.isFinite(v))))throw Error('财务史科目数量或值无效');
    if(it.code==='totalShares' && it.vals.some(v=>v!==null && (!Number.isSafeInteger(v) || v<=0)))throw Error('总股数必须为正整数股数；不能使用万元股本金额');
    byCode.set(it.code,it.vals);
  }
  for (const req of ['npParent', 'equityParent']) {
    const vals = byCode.get(req);
    if (!vals) throw Error(`缺少必需科目 ${req}`);
  }
  if(byCode.has('totalShares') && input.shareUnit!=='shares')throw Error('必须声明 shareUnit=shares；禁止将实收资本金额当作实际股数');
  const idx = dates.map((d, i) => ({ d, i })).sort((a, b) => a.d.localeCompare(b.d));
  const incoming = idx.map(({ d, i }) => {
    const row: Record<string, unknown> = { date: d };
    for (const [code2, vals] of byCode) {
      const v = vals[i];
      const field=code2==='totalShares'?'sharesYi':code2;
      if (v === null || v === undefined) { row[field] = null; continue; }
      if (!Number.isFinite(Number(v))) throw Error(`科目 ${code2} 值无效: ${v}`);
      row[field] = code2 === 'totalShares' ? Number(v) / 1e8
        : WAN_CODES.has(code2) ? Number(v) * WAN_TO_YUAN : Number(v);
    }
    return row;
  });
  // Read every span before writing. A missing/outdated 12-year key must not erase another span.
  const snapshots = await Promise.all(Array.from({length:HISTORY_YEARS+1},(_,i)=>store.read<Record<string,unknown>[]>(`statements-v3:${code}:${i+2}`)));
  const union = new Map<string,Record<string,unknown>>();
  for(const row of [...snapshots.flatMap(r=>r?.payload??[]), ...incoming]) {
    const merged={...union.get(String(row.date))};
    for(const [field,value] of Object.entries(row))if(value!==null && value!==undefined || merged[field]===undefined)merged[field]=value;
    union.set(String(row.date),merged);
  }
  // Remove the obsolete wrong field only where the new import explicitly supplies actual shares.
  for(const row of incoming)if(typeof row.sharesYi==='number')delete union.get(String(row.date))!.totalShares;
  const rows=[...union.values()].filter(r=>String(r.date)>=reportCutoff(now)).sort((a,b)=>String(a.date).localeCompare(String(b.date)));
  let written=0;
  for(let i=0;i<snapshots.length;i++) {
    const key=`statements-v3:${code}:${i+2}`, old=snapshots[i];
    const record=marketRecord(key,'financial-history','sina-statements:CNY:yuan:current-revisions',rows,1800e3,now);
    if(old?.digest===record.digest)continue;
    if(!await store.write(record,old?.digest??null))throw Error(`写入版本冲突: ${key}`);
    written++;
  }
  return {code,rows:rows.length,spans:written,...(!written?{skipped:true}:{})};
}

/* ------------------------------------------------------------ 分红 */

export interface ShareHistoryImport {symbol:string;unit:'shares';rows:{date:string;shares:number}[]}
/** Actual share quantities only. Paid-in capital is not an admissible substitute. */
export async function writeShareHistory(store:MarketStore,input:ShareHistoryImport,now=Date.now()){
  const code=aShareCode(input.symbol);
  if(input.unit!=='shares' || !Array.isArray(input.rows) || !input.rows.length)throw Error('股本史必须声明 unit=shares 并提供实际股数');
  const seen=new Set<string>();
  for(const r of input.rows){
    if(!isoDate(r.date) || r.date>chinaDate(now) || seen.has(r.date) || !Number.isSafeInteger(r.shares) || r.shares<=0)throw Error('股本日期、重复记录或实际股数无效');
    seen.add(r.date);
  }
  const key=`shares-v3:${code}`,old=await store.read<{date:string;sharesWan:number;baseline?:boolean}[]>(key);
  const union=new Map((old?.payload??[]).map(r=>[r.date,r]));
  for(const r of input.rows){
    const prior=union.get(r.date);
    if(prior && Math.abs(prior.sharesWan*1e4-r.shares)>0.5)throw Error(`实际股本与已有记录冲突: ${r.date}`);
    union.set(r.date,{...prior,date:r.date,sharesWan:r.shares/1e4});
  }
  const record=marketRecord(key,'share-events','qmt:capital-structure:10000shares',[...union.values()].sort((a,b)=>a.date.localeCompare(b.date)),1800e3,now);
  if(record.digest===old?.digest)return {code,count:record.payload.length,skipped:true};
  if(!await store.write(record,old?.digest??null))throw Error('股本史写入版本冲突');
  return {code,count:record.payload.length};
}

export interface DividendPlanItem {
  reportDate: string; announceDate: string | null; scheduleKnownDate?: string | null;
  exDate: string | null; perShare: number; perShareStock?: number;
  implemented: boolean; cancelled?: boolean; special?: boolean;
}

function checkPlan(p: DividendPlanItem) {
  if (!isoDate(p.reportDate)) throw Error(`分红报告期无效: ${p.reportDate}`);
  for (const k of ['announceDate', 'scheduleKnownDate', 'exDate'] as const)
    if (p[k] !== null && p[k] !== undefined && !isoDate(p[k])) throw Error(`分红 ${k} 无效: ${p[k]}`);
  if (!Number.isFinite(p.perShare) || p.perShare < 0) throw Error('每股分红金额无效');
  if (p.perShareStock !== undefined && p.perShareStock !== null &&
      (!Number.isFinite(p.perShareStock) || p.perShareStock < 0)) throw Error('送转比例无效');
  if (typeof p.implemented !== 'boolean') throw Error('implemented 必须为布尔');
}

const chinaDate=(now:number)=>new Date(now+8*3600e3).toISOString().slice(0,10);
function aShareCode(symbol:string){
  if(!/^(?:sh|sz|bj)?\d{6}$/.test(String(symbol??'')))throw Error('当前财务及分红导入仅支持 A 股，港股需独立币种和字段协议');
  return symbol.replace(/^(sh|sz|bj)/,'');
}


export async function writeDividendPlans(store: MarketStore, symbol: string, plans: DividendPlanItem[], now = Date.now()) {
  const code = aShareCode(symbol);
  if (!/^\d{4,6}$/.test(code)) throw Error('分红导入证券代码无效');
  if (!Array.isArray(plans) || !plans.length) throw Error('分红预案为空');
  const sorted = [...plans].sort((a, b) => a.reportDate.localeCompare(b.reportDate));
  for (const p of sorted) checkPlan(p);
  const key = `dividend-plans-v2:${code}`;
  const incoming = sorted.map(p => ({
    exDate: p.exDate ?? null, special: !!p.special, perShare: p.perShare,
    cancelled: !!p.cancelled, reportDate: p.reportDate, implemented: !!p.implemented,
    announceDate: p.announceDate ?? null, ...(p.scheduleKnownDate ? { scheduleKnownDate: p.scheduleKnownDate } : {}),
    ...(p.perShareStock != null ? { perShareStock: p.perShareStock } : {}),
  }));
  const old = await store.read<Record<string,unknown>[]>(key);
  const union=new Map((old?.payload??[]).map(p=>[`${p.reportDate}:${p.exDate??''}:${p.special??false}`,p]));
  for(const p of incoming){
    const id=`${p.reportDate}:${p.exDate??''}:${p.special??false}`;
    // Ambiguous preannounced/implemented matches require manual reconciliation instead of double-counting.
    if([...union.values()].some(v=>v.reportDate===p.reportDate && v.special===p.special && v.exDate!==p.exDate && (!v.exDate || !p.exDate)))throw Error('同报告期分红预案的除息日待对账，保留原记录');
    const prior=union.get(id);
    union.set(id,{...prior,...p,announceDate:p.announceDate??prior?.announceDate??null});
  }
  const payload=[...union.values()].sort((a,b)=>String(a.reportDate).localeCompare(String(b.reportDate)) || String(a.exDate).localeCompare(String(b.exDate)));
  if (old && marketDigest(old.payload) === marketDigest(payload)) return { code, count: payload.length, skipped: true };
  if (!await store.write(marketRecord(key, 'announced-dividend-plans', 'eastmoney:CNY:tax-before:per-share:announced-not-implemented', payload, 1800e3, now), old?.digest ?? null))
    throw Error('分红预案写入版本冲突，请重试');
  return { code, count: payload.length };
}

export interface DividendImplRow { exDate: string; perShare: number; perShareStock?: number; precisionPerShare?: number; cashSource?: string }

export async function writeDividendImplemented(store: MarketStore, symbol: string, rows: DividendImplRow[], now = Date.now()) {
  const code = aShareCode(symbol);
  if (!/^\d{4,6}$/.test(code)) throw Error('分红导入证券代码无效');
  if (!Array.isArray(rows) || !rows.length) throw Error('已实施分红为空');
  const sorted = [...rows].sort((a, b) => a.exDate.localeCompare(b.exDate));
  let prev = '';
  for (const r of sorted) {
    if (r.exDate > chinaDate(now)) throw Error('未来除息日不能计入已实施分红');
    if (r.precisionPerShare !== undefined && (!Number.isFinite(r.precisionPerShare) || r.precisionPerShare <= 0)) throw Error('分红精度无效');
    if (r.cashSource !== undefined && !['qmt','sina','sina+eastmoney-rounding-reconciled','eastmoney','import'].includes(r.cashSource)) throw Error('分红来源无效');
    if (!isoDate(r.exDate)) throw Error(`除息日无效: ${r.exDate}`);
    if (r.exDate <= prev) throw Error(`除息日重复或未升序: ${r.exDate}`);
    prev = r.exDate;
    if (!Number.isFinite(r.perShare) || r.perShare < 0) throw Error('每股分红金额无效');
    if (r.perShareStock !== undefined && (!Number.isFinite(r.perShareStock) || r.perShareStock < 0)) throw Error('送转比例无效');
  }
  const key = `implemented-dividends-v4:${code}`;
  const old = await store.read<Record<string,unknown>[]>(key);
  const union=new Map((old?.payload??[]).map(r=>[String(r.exDate),r]));
  for(const r of sorted){
    const prior=union.get(r.exDate);
    if(prior && (Number(prior.perShare)!==r.perShare || r.perShareStock!==undefined && Number(prior.perShareStock??0)!==r.perShareStock))throw Error(`已实施分红金额冲突: ${r.exDate}，保留原记录`);
    union.set(r.exDate,{...prior,exDate:r.exDate,perShare:r.perShare,
      cashSource:r.cashSource??prior?.cashSource??'import',perShareStock:r.perShareStock??prior?.perShareStock??0,
      ...(r.precisionPerShare!==undefined?{precisionPerShare:r.precisionPerShare}:{}),
    });
  }
  const payload=[...union.values()].sort((a,b)=>String(a.exDate).localeCompare(String(b.exDate)));
  if (old && marketDigest(old.payload) === marketDigest(payload)) return { code, count: payload.length, skipped: true };
  if (!await store.write(marketRecord(key, 'implemented-dividends', 'import:CNY:tax-before:per-share:ex-date', payload, 1800e3, now), old?.digest ?? null))
    throw Error('已实施分红写入版本冲突，请重试');
  return { code, count: payload.length };
}

/* ---------------------------------------------------- K线跨源冲突检查 */

interface SimpleSeries { candles?: { date: string; close: number }[] }

/** 与库内 tencent/sina 重叠日收盘偏差 >1% 记为冲突（不写入）。 */
export async function klineCrossConflicts(store: MarketStore, symbol: string, candles: { date: string; close: number }[]) {
  const conflicts: { date: string; incoming: number; existing: number; source: string }[] = [];
  const incoming = new Map(candles.map(c => [c.date, c.close]));
  for (const src of ['tencent', 'sina']) {
    const row = await store.read<SimpleSeries>(`kline:v2:${symbol}:day:none:${src}:prices-only`).catch(() => null);
    for (const c of row?.payload?.candles ?? []) {
      const v = incoming.get(c.date);
      if (v === undefined || !Number.isFinite(c.close) || c.close === 0) continue;
      if (Math.abs(v - c.close) > Math.abs(c.close) * 0.01)
        conflicts.push({ date: c.date, incoming: v, existing: c.close, source: src });
    }
  }
  return conflicts.slice(0, 20);
}
