import type { MarketStore } from './marketStore';
import type { FinancialSummary } from './datasource/types';
import type { StatementSourcePage } from './datasource/eastmoneyStatements';

type Indicators={dates:string[];rows:{$marketMap:[string,(string|null)[]][]}};
const numeric=(value:unknown):number|null=>{
  if(typeof value!=='number' && typeof value!=='string' || String(value).trim()==='')return null;
  const n=Number(String(value).replaceAll(',',''));return Number.isFinite(n)?n:null;
};
const names=(s:string)=>s.replace(/[\s()（）:：]/g,'');
function field(page:StatementSourcePage|undefined,date:string,aliases:string[]){
  const at=page?.dates.indexOf(date)??-1;if(at<0)return null;
  for(const alias of aliases){
    const row=page!.rows.find(r=>r.kind==='field' && names(r.name)===names(alias));
    const value=numeric(row?.vals[at]);if(value!==null)return value;
  }return null;
}
/** Summary and full reports consume the same saved A-share facts. No quotes,
 * provider requests, schema initialization or writes are needed for this read. */
export async function readStoredFinancialSummary(store:Pick<MarketStore,'read'>|null,code:string,now=Date.now()):Promise<FinancialSummary|null>{
  if(!store || !/^\d{6}$/.test(code))return null;
  const year=new Date(now+8*3600e3).getUTCFullYear(),today=new Date(now+8*3600e3).toISOString().slice(0,10);
  const years=[year,year-1,year-2];
  const pages=await Promise.all(years.map(async y=>({
    profit:(await store.read<StatementSourcePage>(`source-sina-page:v1:${code}:profit:${y}`))?.payload,
    balance:(await store.read<StatementSourcePage>(`source-sina-page:v1:${code}:balance:${y}`))?.payload,
    indicators:(await store.read<Indicators>(`source-sina-indicators:v1:${code}:${y}`))?.payload,
  })));
  for(const p of pages)for(const page of [p.profit,p.balance])if(page && !['wan','万元','人民币万元'].includes(page.unit))throw Error('摘要财报金额单位无效');
  const dates=[...new Set(pages.flatMap(p=>[...(p.profit?.dates??[]),...(p.balance?.dates??[])]))]
    .filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d) && d<=today).sort();
  const values=dates.map(date=>{
    const p=pages.find(p=>p.profit?.dates.includes(date))?.profit;
    const b=pages.find(p=>p.balance?.dates.includes(date))?.balance;
    const indicators=pages.find(p=>p.indicators?.dates.includes(date))?.indicators;
    const indicator=(alias:string)=>{
      const rows=indicators?.rows,entries=rows instanceof Map?[...rows]:rows?.$marketMap??[];
      return numeric(entries.find(([key])=>names(key)===names(alias))?.[1][indicators!.dates.indexOf(date)]);
    };
    const revenue=field(p,date,['营业收入','营业总收入']),cost=field(p,date,['营业成本']);
    const profit=field(p,date,['归属于母公司所有者的净利润','归属于母公司股东的净利润','归属于母公司的净利润']);
    const assets=field(b,date,['资产总计','资产总额']),debt=field(b,date,['负债合计','负债总计']);
    return {date,revenue,profit,roe:indicator('净资产收益率(%)'),
      grossMargin:revenue!==null && revenue>0 && cost!==null?(revenue-cost)/revenue*100:null,
      debtRatio:assets!==null && assets>0 && debt!==null?debt/assets*100:null};
  }).filter(p=>p.revenue!==null || p.profit!==null);
  if(!values.length)return null;
  const growth=(p:typeof values[number],key:'revenue'|'profit')=>{
    const prior=values.find(v=>v.date===`${Number(p.date.slice(0,4))-1}${p.date.slice(4)}`)?.[key];
    return p[key]!==null && prior!=null && prior!==0?(p[key]!-prior)/Math.abs(prior)*100:null;
  };
  return {code,currency:'CNY',periods:values.map(p=>p.date),revenue:values.map(p=>p.revenue===null?null:p.revenue/1e4),
    netProfit:values.map(p=>p.profit===null?null:p.profit/1e4),roe:values.map(p=>p.roe),grossMargin:values.map(p=>p.grossMargin),
    debtRatio:values.map(p=>p.debtRatio),revenueGrowth:values.map(p=>growth(p,'revenue')),profitGrowth:values.map(p=>growth(p,'profit')),
    provenance:'fetched',note:'读取与详细报表相同的库内披露数据；金额为人民币亿元、利润为累计归母净利润，非TTM。毛利率、负债率和同比由对应报表计算，ROE仅取已披露指标；缺项留空。'};
}
