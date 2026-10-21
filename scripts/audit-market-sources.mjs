/** Read-only live source comparison. Does not publish, overwrite, or certify source values. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {load} from './tests/load-modules.mjs';
const tencent=await load('datasource/tencent'),sina=await load('datasource/sina');
const fin=await load('datasource/sinaFinStatements'),bonus=await load('datasource/sinaBonus');
const plans=await load('datasource/dividendPlans'),screen=await load('datasource/valueScreen');
const {validateKLine}=await load('klineStorage');
const {reconcileCashDividends}=await load('valuationInputs');
const now=new Date(),today=new Date(now.getTime()+8*3600e3).toISOString().slice(0,10);
const codes=['600519','300498','600036','601318','000333','600900','000063','600030','601899','603866'];
const year=Number(today.slice(0,4))-1,reportDate=`${year}-12-31`;
const report={at:now.toISOString(),basis:'aggregator cross-check only; not original issuer/stock-exchange audit',
  companies:[]};
const main=await screen.fetchValueScreenReportPages('RPT_F10_FINANCE_MAINFINADATA',
  'SECURITY_CODE,REPORT_DATE,NOTICE_DATE,UPDATE_DATE,CURRENCY,PARENTNETPROFIT', [reportDate],today,undefined,codes);
for(const code of codes){
  const symbol=(code.startsWith('6')?'sh':'sz')+code;
  const item={code};
  try{
    const request={symbol,period:'day',adjust:'none',count:80};
    const [a,b]=await Promise.all([tencent.fetchKLine(symbol,'day','none',80),sina.fetchKLine(symbol,'day',80)]);
    validateKLine(a,request);validateKLine(b,request);
    const right=new Map(b.candles.filter(c=>c.date<today).map(c=>[c.date,c]));
    const overlap=a.candles.filter(c=>c.date<today&&right.has(c.date));
    const differences=[];
    for(const c of overlap){const other=right.get(c.date);const priceDelta=Math.max(...['open','high','low','close'].map(k=>Math.abs(c[k]-other[k])));
      const volumeDelta=Math.abs(c.volume-other.volume);
      if(priceDelta>0.000001||volumeDelta>0.500001)differences.push({date:c.date,priceDelta,volumeDelta,tencent:c,sina:other});}
    item.prices={sources:[a.source,b.source],basis:'none; CNY; volume=100 shares',samples:overlap.length,
      from:overlap[0]?.date,to:overlap.at(-1)?.date,priceTolerance:0.000001,volumeTolerance:0.5,volumeToleranceReason:"integer hands versus fractional hands; half-unit display rounding",differences};
  }catch(e){item.prices={error:e.message};}
  try{
    const rows=await fin.fetchYearStatement(code,year),a=rows.find(r=>r.date===reportDate);
    const b=main.filter(r=>r.SECURITY_CODE===code).sort((a,b)=>String(b.UPDATE_DATE).localeCompare(String(a.UPDATE_DATE)))[0];
    const v=b?.PARENTNETPROFIT==null?null:Number(b.PARENTNETPROFIT);
    item.profit={reportDate,sinaParentProfitYuan:a?.npParent??null,eastmoneyParentProfitYuan:v,
      differenceYuan:a?.npParent!=null&&v!=null?a.npParent-v:null,
      status:a?.npParent==null||v==null?'missing':Math.abs(a.npParent-v)<=100?'within_display_rounding':'review_difference',
      note:'Sina statement amounts display in 10,000 CNY; tolerance 100 CNY permits display rounding only.'};
  }catch(e){item.profit={error:e.message};}
  try{
    const [events,announcements]=await Promise.all([bonus.fetchDividends(code),plans.fetchDividendPlans(code)]);
    const lastReport=new Map();for(const p of announcements)lastReport.set(p.reportDate,p);
    const byDate=new Map();for(const p of lastReport.values())if(!p.cancelled&&p.exDate&&p.exDate<today&&p.perShare!=null)
      byDate.set(p.exDate,(byDate.get(p.exDate)||0)+p.perShare);
    const reconciled=reconcileCashDividends(events,announcements,today);
    const matches=events.filter(e=>e.exDate<today&&e.exDate>=`${year}-01-01`&&byDate.has(e.exDate));
    item.dividends={sources:['sina implemented events','eastmoney latest report plan with ex-date'],
      matchedEvents:matches.length,unresolvedCashConflicts:reconciled.filter(e=>e.cashConflict).map(e=>({exDate:e.exDate,...e.cashConflict})),roundingReconciled:reconciled.filter(e=>e.cashSource==='sina+eastmoney-rounding-reconciled').map(e=>({exDate:e.exDate,perShare:e.perShare})),unmatchedRecentEvents:events.filter(e=>e.exDate>=`${year}-01-01`&&!byDate.has(e.exDate)).map(e=>e.exDate),
      comparisons:matches.map(e=>({exDate:e.exDate,sinaCnyPerShare:e.perShare,eastmoneyCnyPerShare:byDate.get(e.exDate),
        status:Math.abs(e.perShare-byDate.get(e.exDate))<0.000001?'match':'review_difference'})),
      note:'Agreement is not independent confirmation of implementation or announcement authenticity.'};
  }catch(e){item.dividends={error:e.message};}
  report.companies.push(item);console.log(code,JSON.stringify({prices:item.prices.samples,priceDifferences:item.prices.differences?.length,profit:item.profit.status,dividends:item.dividends.matchedEvents}));
  await new Promise(r=>setTimeout(r,350));
}
const output=path.resolve(process.argv[2]||'data/market-audit/latest.json');await fs.mkdir(path.dirname(output),{recursive:true});
await fs.writeFile(output,JSON.stringify(report,null,2));console.log('Audit written:',output);
