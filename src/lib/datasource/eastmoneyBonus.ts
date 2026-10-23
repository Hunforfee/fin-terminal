/** Only completed, disclosed ex-date events. An announced proposal is not cash. */
import { fetchDividendPlanRows, parseDividendPlans } from './dividendPlans';
import { numOrNull, normalizeStockCode } from './codes';
import type { DividendEvent } from './sinaBonus';

type Row=Record<string,unknown>;
function numeric(row:Row,key:string):number|null{
  const raw=row[key],value=numOrNull(raw);
  if(value===null && raw!=null && !['','--','-'].includes(String(raw).trim()))throw Error(`已实施分红字段 ${key} 数值无效`);
  return value;
}
const iso=(v:unknown):string|null=>{
  const d=typeof v==='string'?v.slice(0,10):'';
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d+'T00:00:00Z'))
    && new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d?d:null;
};
function stockPer10(row:Row,profile:string):number|null{
  const combined=numeric(row,'BONUS_IT_RATIO');
  if(combined!==null)return combined>=0?combined:null;
  const song=numeric(row,'BONUS_RATIO'),transfer=numeric(row,'IT_RATIO');
  if(song!==null && transfer!==null)return song>=0 && transfer>=0?song+transfer:null;
  if(/^10(?:派|送|转)/.test(profile)){
    const parts=[...profile.matchAll(/(?:送|转增|转)(\d+(?:\.\d+)?)/g)];
    if(parts.length)return parts.reduce((sum,m)=>sum+Number(m[1]),0);
    if(!/送|转/.test(profile))return 0;
  }
  if(/不送.*不转|不送股不转增/.test(profile))return 0;
  return null;
}
export function parseEastmoneyImplementedDividends(rows:Row[],code:string,now=Date.now()):DividendEvent[]{
  const n=normalizeStockCode(code);
  if(!n || n.market==='HK' || !/^\d{6}$/.test(code))throw Error('已实施分红股票代码无效');
  const today=new Date(now+8*3600e3).toISOString().slice(0,10),events=new Map<string,{row:Row;notice:string;signature:string}>();
  for(const row of rows){
    if(row.SECUCODE!==`${code}.${n.market}` || row.SECURITY_CODE!==code)throw Error('已实施分红证券身份不匹配');
    const ex=iso(row.EX_DIVIDEND_DATE),notice=iso(row.NOTICE_DATE),period=iso(row.REPORT_DATE);
    const progress=String(row.ASSIGN_PROGRESS??'');
    if(/实施分配|已实施/.test(progress) && !/取消|终止|不实施/.test(progress) && (!ex || !notice || !period))
      throw Error('已实施分红缺少有效除息、披露或报告期日期');
    if(!ex || !notice || !period || ex>today || notice>today || period>today)continue;
    const profile=String(row.IMPL_PLAN_PROFILE??'').replace(/\s/g,''),special=/特别|特殊|special/i.test(profile);
    const key=`${period}:${ex}:${special?'special':'ordinary'}`,prior=events.get(key),signature=JSON.stringify([
      row.PRETAX_BONUS_RMB,row.BONUS_IT_RATIO,row.BONUS_RATIO,row.IT_RATIO,row.ASSIGN_PROGRESS,profile]);
    if(prior?.notice===notice && prior.signature!==signature)throw Error('同一实施公告的现金或送转比例冲突');
    if(!prior || notice>prior.notice)events.set(key,{row,notice,signature});
  }
  const byDate=new Map<string,DividendEvent>();
  for(const {row,notice} of events.values()){
    const progress=String(row.ASSIGN_PROGRESS??''),profile=String(row.IMPL_PLAN_PROFILE??'').replace(/\s/g,'');
    if(!/实施分配|已实施/.test(progress) || /取消|终止|不实施/.test(progress+profile))continue;
    const stock=stockPer10(row,profile),raw=numeric(row,'PRETAX_BONUS_RMB');
    const cash=raw===null && (stock!==null && stock>0 && !/派/.test(profile) || /不派|不分配现金/.test(profile))?0:raw;
    if(stock===null || cash===null || cash<0)throw Error('已实施分红缺少可核验的现金金额或送转比例');
    const ex=iso(row.EX_DIVIDEND_DATE)!;
    if(notice>ex)throw Error('实施公告晚于除息日，未按已知事件使用');
    const [coefficient,exponent='0']=String(cash).toLowerCase().split('e');
    const precision=10**(Number(exponent)-(coefficient.split('.')[1]?.length??0)-1),prior=byDate.get(ex);
    byDate.set(ex,{exDate:ex,perShare:(prior?.perShare??0)+cash/10,perShareStock:(prior?.perShareStock??0)+stock/10,
      precisionPerShare:(prior?.precisionPerShare??0)+precision,cashSource:'eastmoney-implemented',
      implementationEvidence:[...(prior?.implementationEvidence??[]),{reportDate:iso(row.REPORT_DATE)!,noticeDate:notice,profile}]});
  }
  return [...byDate.values()].sort((a,b)=>a.exDate.localeCompare(b.exDate));
}
export async function fetchEastmoneyImplementedDividends(code:string){
  const rows=await fetchDividendPlanRows(code),events=parseEastmoneyImplementedDividends(rows,code);
  if(!events.length && rows.length){
    const plans=parseDividendPlans(rows);
    if(plans.length!==rows.length || !plans.every(p=>p.perShare===0))
      throw Error('分红记录存在但尚不能确认完整的已实施分红历史');
  }
  return events;
}
