import { normalizeStockCode } from './datasource/codes';
import { isResearchDate } from './researchNotes';

export const COMPANY_LEARNING_KEY = 'fin.learning.companies.v1';
export interface LearningCandidate {
  symbol: string;
  code: string;
  name: string;
  industry: string;
  origin: 'watchlist' | 'industry' | 'universe';
}
export interface LearningDay extends LearningCandidate { date: string; skipped: string[] }
export interface LearnedCompany extends LearningCandidate { date: string }
export interface LearningState { version: 1; days: LearningDay[]; completed: LearnedCompany[] }
export const emptyLearningState = (): LearningState => ({ version: 1, days: [], completed: [] });

function candidate(value: unknown): value is LearningCandidate {
  if (!value || typeof value !== 'object') return false;
  const c = value as LearningCandidate, stock = normalizeStockCode(c.symbol);
  return stock?.kind === 'stock' && stock.symbol === c.symbol && stock.code === c.code &&
    typeof c.name === 'string' && c.name.length > 0 && c.name.length <= 120 &&
    typeof c.industry === 'string' && c.industry.length <= 160 &&
    ['watchlist', 'industry', 'universe'].includes(c.origin);
}
export function readLearningState(raw: string | null): LearningState {
  if (raw === null) return emptyLearningState();
  const state = JSON.parse(raw) as LearningState;
  if (state?.version !== 1 || !Array.isArray(state.days) || !Array.isArray(state.completed) ||
    state.days.length > 366 || state.completed.length > 2000 ||
    !state.days.every(d => candidate(d) && isResearchDate(d.date) && Array.isArray(d.skipped) && d.skipped.length <= 2000 && d.skipped.every(s => typeof s === 'string' && normalizeStockCode(s)?.kind === 'stock')) ||
    !state.completed.every(c => candidate(c) && isResearchDate(c.date)) ||
    new Set(state.days.map(d => d.date)).size !== state.days.length ||
    new Set(state.completed.map(c => c.symbol)).size !== state.completed.length) {
    throw Error('学习记录读取失败，原记录已保留');
  }
  return state;
}
export function learningHash(input: string): number {
  let hash = 2166136261;
  for (const char of input) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}
/** Stable for a Shanghai calendar day; changing the candidate pool never replaces today's saved choice. */
export function chooseLearningCompany(pool: LearningCandidate[], state: LearningState, date: string, replace = false): LearningDay | null {
  if (!isResearchDate(date)) throw Error('日期无效');
  const current = state.days.find(day => day.date === date);
  if (current && !replace) return current;
  const skipped = replace && current ? [...new Set([...current.skipped, current.symbol])] : [];
  const completed = new Set(state.completed.map(c => c.symbol));
  const prior = state.days.filter(d => d.date < date).sort((a,b) => b.date.localeCompare(a.date))[0];
  const priorIndustry = current?.industry || prior?.industry || '';
  const available = [...new Map(pool.filter(c => candidate(c) && !skipped.includes(c.symbol)).map(c => [c.symbol,c])).values()];
  available.sort((a,b) => {
    const score = (c: LearningCandidate) => (completed.has(c.symbol) ? 100 : 0) +
      (c.industry && c.industry === priorIndustry ? 10 : 0) +
      ({watchlist:0,industry:1,universe:2}[c.origin]);
    return score(a)-score(b) || learningHash(`${date}|${a.symbol}`)-learningHash(`${date}|${b.symbol}`) || a.symbol.localeCompare(b.symbol);
  });
  const selected = available[0];
  return selected ? {...selected,date,skipped} : null;
}
export function setLearningDay(state: LearningState, day: LearningDay): LearningState {
  return {...state,days:[day,...state.days.filter(d=>d.date!==day.date)].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,366)};
}
export function toggleLearned(state: LearningState, company: LearningCandidate, date: string): LearningState {
  if (!candidate(company) || !isResearchDate(date)) throw Error('公司或日期无效');
  const exists = state.completed.some(c=>c.symbol===company.symbol);
  return {...state,completed:exists?state.completed.filter(c=>c.symbol!==company.symbol):[{...company,date},...state.completed].slice(0,2000)};
}
export const learningNumber = (value: unknown): number | null => {
  if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'string' && !value.trim())) return null;
  const number=Number(value); return Number.isFinite(number)?number:null;
};
export function learningDate(value: unknown): string {
  const date=typeof value==='string'?value.slice(0,10):'';return isResearchDate(date)?date:'';
}
export interface LearningAnnual {
  period:string; revenue:number|null; profit:number|null; deducted:number|null;
  roe:number|null; ocf:number|null; debt:number|null;
}
/** Latest disclosed cumulative report; retained separately from complete annual totals. */
export function parseLearningLatest(rows: Record<string,unknown>[], code:string, today:string): LearningAnnual | null {
  const valid=rows.filter(row=>{
    const period=learningDate(row.REPORT_DATE),notice=learningDate(row.NOTICE_DATE),update=learningDate(row.UPDATE_DATE);
    return row.SECURITY_CODE===code&&row.CURRENCY==='CNY'&&period&&notice&&period<=today&&notice<=today&&(!update||update<=today);
  }).sort((a,b)=>String(b.REPORT_DATE).localeCompare(String(a.REPORT_DATE))||String(b.UPDATE_DATE??b.NOTICE_DATE).localeCompare(String(a.UPDATE_DATE??a.NOTICE_DATE)));
  const row=valid[0];
  return row?{period:learningDate(row.REPORT_DATE),revenue:learningNumber(row.OPERATE_INCOME_PK),profit:learningNumber(row.PARENTNETPROFIT),deducted:learningNumber(row.KCFJCXSYJLR),roe:learningNumber(row.ROEJQ),ocf:learningNumber(row.NETCASH_OPERATE_PK),debt:learningNumber(row.ZCFZL)}:null;
}
/** A-share flows are annual totals; never annualize interim data to fill a missing year. */
export function parseLearningAnnual(rows: Record<string,unknown>[], code:string, today:string): LearningAnnual[] {
  const dates=new Map<string,Record<string,unknown>>();
  for (const row of rows) {
    const period=learningDate(row.REPORT_DATE),notice=learningDate(row.NOTICE_DATE),update=learningDate(row.UPDATE_DATE);
    if (row.SECURITY_CODE!==code || row.CURRENCY!=='CNY' || !period.endsWith('-12-31') || !notice || notice>today || period>today || (update&&update>today)) continue;
    const old=dates.get(period);
    if (!old || String(row.UPDATE_DATE??row.NOTICE_DATE)>String(old.UPDATE_DATE??old.NOTICE_DATE)) dates.set(period,row);
  }
  return [...dates].sort(([a],[b])=>b.localeCompare(a)).slice(0,5).map(([period,row])=>({period,
    revenue:learningNumber(row.OPERATE_INCOME_PK),profit:learningNumber(row.PARENTNETPROFIT),deducted:learningNumber(row.KCFJCXSYJLR),
    roe:learningNumber(row.ROEJQ),ocf:learningNumber(row.NETCASH_OPERATE_PK),debt:learningNumber(row.ZCFZL)}));
}
export interface LearningAiSection { id:string; text:string; sources:string[] }
export const LEARNING_SECTIONS = ['business','model','edge','financial','valuation','risks'] as const;
/** AI text is always labelled an interpretation; its source links must belong to the supplied evidence. */
export function parseLearningAi(raw: string, allowed: string[]): LearningAiSection[] {
  const cleaned=raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  const data=JSON.parse(cleaned) as {sections?:LearningAiSection[]};
  if (!Array.isArray(data.sections) || data.sections.length!==6 ||
    !LEARNING_SECTIONS.every(id=>data.sections!.filter(s=>s.id===id).length===1) ||
    !data.sections.every(s=>typeof s.text==='string' && !!s.text.trim() && s.text.length<=1000 && Array.isArray(s.sources) && s.sources.length>0 && s.sources.every(id=>allowed.includes(id)))) throw Error('AI 速读的来源信息不完整');
  return LEARNING_SECTIONS.map(id=>data.sections!.find(s=>s.id===id)!);
}
