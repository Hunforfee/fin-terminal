import { getMarketStore, marketRecord, type MarketStore } from './marketStore';
import { getKLine, getValuation } from './datasource';
import { fetchStatementSourcePage } from './datasource/sinaStatements';
import { fetchIndicatorSourceYear } from './datasource/sinaFinancial';
import { fetchStatementHistory } from './datasource/sinaFinStatements';
import { fetchDisclosureDates } from './datasource/disclosures';
import { fetchHkIndicatorPoints, fetchHkStatement } from './datasource/hkFinance';
import { cachedMarketInput, validateDatedRows } from './marketInputs';
import { importedBarsKey, type ImportedBars } from './marketImportedBars';
import { normalizeStockCode } from './datasource/codes';
import { withUpstreamBudget } from './marketUpdateContext';
import { UpstreamBudget } from './upstreamBudget';
import { fetchCompanyProfile } from './datasource/profile';
import { fetchBusiness } from './datasource/business';
import { fetchReports } from './datasource/research';
import { fetchAnnouncements } from './datasource/announcements';
import { getFinancialReports } from './datasource/financialReports';
import { fetchDebtRatios } from './datasource/debtRatios';
import { fetchInterestExpenses } from './datasource/interestExpenses';
import { fetchDeductedPeriods } from './datasource/deductedPe';

export const COLLECTION_LAST_PHASE=13;
export const coverageKey=(symbol:string)=>`market-coverage:v1:${symbol}:5`;
export function fiveYearStart(now=Date.now()){
  const d=new Date(now+8*3600e3),month=d.getUTCMonth();d.setUTCFullYear(d.getUTCFullYear()-5);
  if(d.getUTCMonth()!==month)d.setUTCDate(0);
  return d.toISOString().slice(0,10);
}
const persistCheck=async(store:MarketStore,key:string)=>{
  const row=await store.read(key);if(!row || Date.parse(row.refreshAfter)<=Date.now())throw Error('采集结果尚未确认入库');return row;
};
/** One bounded phase, independent of tabs. Older annual pages have a seven-day revision TTL. */
export async function collectHistoryPhase(symbol:string,phase:number,signal:AbortSignal){
  const store=getMarketStore();if(!store)throw Error('市场数据库尚未配置');
  const n=normalizeStockCode(symbol)!;
  if(phase===0 || phase===1){
    const adjust=phase===0?'none':'qfq';
    const prices=await getKLine(symbol,'day',adjust,1500,fiveYearStart());
    if(prices.stale || prices.complete===false || prices.storage?.backend!=='persistent')throw Error('五年价格未确认完整入库');
  }else if(phase>=3 && phase<=9){
    if(n.market==='HK'){
      if(phase===3){
        const points=await fetchHkIndicatorPoints(`${n.code}.HK`,6);
        const dates=points.map(p=>p.date).filter(d=>d>=fiveYearStart());
        if(!dates.length)throw Error('港股历史财务指标暂缺');
        for(const id of ['balance','profit','cashflow'] as const){
          const rows=await fetchHkStatement(`${n.code}.HK`,id,dates);
          if(!rows.length)throw Error('港股历史报表暂缺');
          for(const date of new Set(rows.map(r=>r.date)))await persistCheck(store,`source-hk-statement:v1:${n.code}.HK:${id}:${date}`);
        }
      }
    }else{
      const year=new Date().getUTCFullYear()-(phase-3);
      // Confirm an old year already has rows before requesting it. A new listing is
      // allowed to retain a shorter range only with a verified listing date.
      const imported=await store.read<ImportedBars>(importedBarsKey(symbol));
      if(imported?.payload.listingDate && year<Number(imported.payload.listingDate.slice(0,4)))return;
      for(const id of ['balance','profit','cashflow'] as const){
        await fetchStatementSourcePage(n.code,id,year);
        await persistCheck(store,`source-sina-page:v1:${n.code}:${id}:${year}`);
      }
      await fetchIndicatorSourceYear(n.code,year);
      await persistCheck(store,`source-sina-indicators:v1:${n.code}:${year}`);
    }
  }else if(phase===10 && n.market!=='HK'){
    await cachedMarketInput(`statements-v3:${n.code}:6`,'financial-history','sina-statements:CNY:yuan:current-revisions',1800e3,
      ()=>withUpstreamBudget(new UpstreamBudget(signal,1500,40,true),()=>fetchStatementHistory(n.code,6)),rows=>validateDatedRows(rows as unknown as Record<string,unknown>[],'date',['npParent','equityParent']));
    await persistCheck(store,`statements-v3:${n.code}:6`);
  }else if(phase===11 && n.market!=='HK'){
    await cachedMarketInput(`disclosures-v3:${n.code}:7`,'disclosure-dates','sina+eastmoney:first-original-publication',1800e3,
      ()=>fetchDisclosureDates(n.code,new Date().getUTCFullYear()-7),dates=>{
        if(!dates.size)throw Error('缺少原始公告日期');
        const today=new Date(Date.now()+8*3600e3).toISOString().slice(0,10);
        for(const [report,published] of dates)if(!/^\d{4}-\d{2}-\d{2}$/.test(published) || published<=report || published>today)throw Error('公告日期无效');
      });
    await persistCheck(store,`disclosures-v3:${n.code}:7`);
  }else if(phase===13){
    const market=n.market==='HK'?'HK':'A';
    const tasks:[string,()=>Promise<unknown>][]=[
      ['公司资料',()=>fetchCompanyProfile(n.code,market)],['主营业务',()=>fetchBusiness(n.code,market)],
      ['研报目录',()=>fetchReports(n.code,market)],['财报原文目录',()=>getFinancialReports(n.symbol)],
    ];
    if(market==='A')tasks.push(['公司公告',()=>fetchAnnouncements(n.code,40)],['近期公告',()=>fetchAnnouncements(n.code,15)]);
    if(market==='A')tasks.push(['有息负债率',()=>fetchDebtRatios(n.code,5)],['利息费用',()=>fetchInterestExpenses(n.code,5)],['扣非利润',()=>fetchDeductedPeriods(n.code)]);
    for(const [name,read] of tasks){try{await read();}catch{await store.incident(symbol,'optional_content_unavailable',{name});}}
  }else if(phase===12){
    // This is a real database-only read, so missing source pages cannot be hidden
    // by a fresh network request during the readiness check.
    await withUpstreamBudget(new UpstreamBudget(signal,1500,40,true),async()=>{
      const prices=await getKLine(symbol,'day','none',1500,fiveYearStart());
      const imported=await store.read<ImportedBars>(importedBarsKey(symbol));
      const expected=imported?.payload.listingDate && imported.payload.listingDate>fiveYearStart()?imported.payload.listingDate:fiveYearStart();
      const rangeCovered=Date.parse(prices.candles[0].date)-Date.parse(expected)<=14*864e5;
      const valuation=await getValuation(symbol,5);
      const valuationMissing=n.market!=='HK' && (!valuation.history.length || valuation.history[0].date>prices.candles[0].date);
      const gaps=[...(!rangeCovered?['历史起点覆盖不足，或缺少已核实的上市日期']:[]),...(valuationMissing?['部分交易日缺少已披露财报、股本或复权数据']:[]),
        ...(n.market==='HK'?['港股历史估值仍缺少可核验的公告与分红快照，不生成历史分位']:[])];
      const record={symbol,years:5,requestedFrom:fiveYearStart(),from:prices.candles[0].date,to:prices.candles.at(-1)!.date,count:prices.candles.length,
        status:rangeCovered&&!valuationMissing?'ready':'partial',priceSource:prices.source,valuationHistory:n.market==='HK'?'unavailable':valuationMissing?'partial':'available',
        validation:'structural-and-source-overlap',gaps,checkedAt:new Date().toISOString()};
      const key=coverageKey(symbol),old=await store.read(key);
      if(!await store.write(marketRecord(key,'market-coverage','internal',record,864e5),old?.digest??null))throw Error('覆盖记录保存失败');
      if(record.status==='partial')throw Error(`已保存可用数据；${gaps.join('；')}`);
    });
  }
}
