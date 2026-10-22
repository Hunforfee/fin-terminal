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
import { getSecurityBasics,securityBasicsKey,type SecurityBasics } from './marketSecurityBasics';
import { applyGapClassification, classifyCoverage } from './marketFillGaps';
import { completeHkStatement } from './marketHkStatements';
import { fetchHkRatioHistory, hkRatioHistoryKey, hkValuationHistoryCovered } from './datasource/hkValuationHistory';
import { HISTORY_YEARS, HISTORY_BAR_COUNT, FINANCIAL_LOOKBACK, historyStart, financialYearForPhase, coverageKey } from './marketHistoryPlan';

export const COLLECTION_LAST_PHASE=18;
export { coverageKey, historyStart };
const persistCheck=async(store:MarketStore,key:string)=>{
  const row=await store.read(key);if(!row || Date.parse(row.refreshAfter)<=Date.now())throw Error('采集结果尚未确认入库');return row;
};
/** One bounded phase, independent of tabs. Older annual pages have a seven-day revision TTL. */
export async function collectHistoryPhase(symbol:string,phase:number,signal:AbortSignal){
  const store=getMarketStore();if(!store)throw Error('市场数据库尚未配置');
  const n=normalizeStockCode(symbol)!;
  if(phase===0 || phase===1){
    if(phase===0)try{await getSecurityBasics(symbol);}catch{await store.incident(symbol,'listing_date_unavailable');}
    const adjust=phase===0?'none':'qfq';
    const prices=await getKLine(symbol,'day',adjust,HISTORY_BAR_COUNT,historyStart());
    if(prices.stale || prices.complete===false || prices.storage?.backend!=='persistent')throw Error('十年价格未确认完整入库');
  }else if(financialYearForPhase(phase)!==null){
    if(n.market==='HK'){
      if(phase===3){
        const points=await fetchHkIndicatorPoints(`${n.code}.HK`,HISTORY_YEARS);
        const dates=points.map(p=>p.date).filter(d=>d>=historyStart());
        if(!dates.length)throw Error('港股历史财务指标暂缺');
        for(const id of ['balance','profit','cashflow'] as const){
          const rows=await fetchHkStatement(`${n.code}.HK`,id,dates);
          if(!rows.length)throw Error('港股历史报表暂缺');
          for(const date of new Set(rows.map(r=>r.date)))await persistCheck(store,`source-hk-statement:v1:${n.code}.HK:${id}:${date}`);
        }
      }
    }else{
      const year=financialYearForPhase(phase)!;
      // Confirm an old year already has rows before requesting it. A new listing is
      // allowed to retain a shorter range only with a verified listing date.
      const imported=await store.read<ImportedBars>(importedBarsKey(symbol));
      const basics=await store.read<SecurityBasics>(securityBasicsKey(symbol));
      const listingDate=basics?.payload.listingDate??imported?.payload.listingDate;
      if(listingDate && year<Number(listingDate.slice(0,4)))return;
      for(const id of ['balance','profit','cashflow'] as const){
        await fetchStatementSourcePage(n.code,id,year);
        await persistCheck(store,`source-sina-page:v1:${n.code}:${id}:${year}`);
      }
      await fetchIndicatorSourceYear(n.code,year);
      await persistCheck(store,`source-sina-indicators:v1:${n.code}:${year}`);
    }
  }else if((phase===10 || phase===11) && n.market==='HK'){
    const metric=phase===10?'pe':'pb';
    for(const years of [5,10]){
      await fetchHkRatioHistory(symbol,metric,years);
      await persistCheck(store,hkRatioHistoryKey(symbol,metric,years));
    }
  }else if(phase===10 && n.market!=='HK'){
    for(const span of [HISTORY_YEARS,5]) {
      await cachedMarketInput(`statements-v3:${n.code}:${span+1}`,'financial-history','sina-statements:CNY:yuan:current-revisions',1800e3,
        ()=>withUpstreamBudget(new UpstreamBudget(signal,1500,40,true),()=>fetchStatementHistory(n.code,span+1)),rows=>validateDatedRows(rows as unknown as Record<string,unknown>[],'date',['npParent','equityParent']));
      // A broader input may be reused without copying it to the narrower key.
      await persistCheck(store,`statements-v3:${n.code}:${HISTORY_YEARS+1}`);
    }
  }else if(phase===11 && n.market!=='HK'){
    await cachedMarketInput(`disclosures-v3:${n.code}:${HISTORY_YEARS+2}`,'disclosure-dates','sina+eastmoney:first-original-publication',1800e3,
      ()=>fetchDisclosureDates(n.code,new Date().getUTCFullYear()-HISTORY_YEARS-2),dates=>{
        if(!dates.size)throw Error('缺少原始公告日期');
        const today=new Date(Date.now()+8*3600e3).toISOString().slice(0,10);
        for(const [report,published] of dates)if(!/^\d{4}-\d{2}-\d{2}$/.test(published) || published<=report || published>today)throw Error('公告日期无效');
      });
    await persistCheck(store,`disclosures-v3:${n.code}:${HISTORY_YEARS+2}`);
  }else if(phase===13){
    const market=n.market==='HK'?'HK':'A';
    const tasks:[string,()=>Promise<unknown>][]=[
      ['公司资料',()=>fetchCompanyProfile(n.code,market)],['主营业务',()=>fetchBusiness(n.code,market)],
      ['研报目录',()=>fetchReports(n.code,market)],['财报原文目录',()=>getFinancialReports(n.symbol)],
    ];
    if(market==='A')tasks.push(['公司公告',()=>fetchAnnouncements(n.code,40)],['近期公告',()=>fetchAnnouncements(n.code,15)]);
    if(market==='A')tasks.push(['有息负债率',()=>fetchDebtRatios(n.code,HISTORY_YEARS)],['利息费用',()=>fetchInterestExpenses(n.code,HISTORY_YEARS)],['扣非利润',()=>fetchDeductedPeriods(n.code)]);
    for(const [name,read] of tasks){try{await read();}catch{await store.incident(symbol,'optional_content_unavailable',{name});}}
  }else if(phase===12){
    // This is a real database-only read, so missing source pages cannot be hidden
    // by a fresh network request during the readiness check.
    await withUpstreamBudget(new UpstreamBudget(signal,1500,40,true),async()=>{
      const prices=await getKLine(symbol,'day','none',HISTORY_BAR_COUNT,historyStart());
      const imported=await store.read<ImportedBars>(importedBarsKey(symbol));
      const basics=await store.read<SecurityBasics>(securityBasicsKey(symbol));
      const listingDate=basics?.payload.listingDate??imported?.payload.listingDate;
      const expected=listingDate && listingDate>historyStart()?listingDate:historyStart();
      const rangeCovered=Date.parse(prices.candles[0].date)-Date.parse(expected)<=14*864e5;
      const missingInputs:string[]=[];
      if(n.market!=='HK'){
        const required=[`screen-company-input:v1:${n.code}:eastmoney:CNY`,`watchlist-financial-inputs:v1:${symbol}`,
          `shares-v3:${n.code}`,`implemented-dividends-v4:${n.code}`,`dividend-plans-v2:${n.code}`,`disclosures-v3:${n.code}:${HISTORY_YEARS+2}`,`statements-v3:${n.code}:${HISTORY_YEARS+1}`];
        for(let year=new Date().getUTCFullYear();year>=new Date().getUTCFullYear()-FINANCIAL_LOOKBACK;year--){
          if(listingDate && year<Number(listingDate.slice(0,4)))continue;
          for(const id of ['balance','profit','cashflow'])required.push(`source-sina-page:v1:${n.code}:${id}:${year}`);
          required.push(`source-sina-indicators:v1:${n.code}:${year}`);
        }
        for(const key of required)if(!await store.read(key))missingInputs.push(key);
      }else{
        const secucode=`${n.code}.HK`;
        const required=[`source-hk-indicators:v1:${secucode}`,`watchlist-financial-inputs:v1:${symbol}`,
          ...[5,10].flatMap(years=>[hkRatioHistoryKey(symbol,'pe',years),hkRatioHistoryKey(symbol,'pb',years)]),
          `hk-main-currency-v4:${symbol}`,`hk-dividend-events-v4:${symbol}`];
        const points=await fetchHkIndicatorPoints(secucode,HISTORY_YEARS).catch(()=>[]);
        // Full three statements are required for annual/interim reports, not
        // an earnings-only quarterly trading update.
        const dates=points.filter(p=>p.date>=historyStart() && ['annual','semi'].includes(p.kind)).map(p=>p.date);
        if(!dates.length)missingInputs.push('港股十年年报/中报指标');
        for(const date of dates)for(const id of ['balance','profit','cashflow'])required.push(`source-hk-statement:v1:${secucode}:${id}:${date}`);
        for(const key of required){
          const row = await store.read(key);
          if(!row || key.startsWith('source-hk-statement:') && !completeHkStatement(row,key.slice(-10)))missingInputs.push(key);
        }
      }
      let valuationMissing=false,valuationError='';
      try{
        const valuation=await getValuation(symbol,HISTORY_YEARS,'disclosure',{force:true});
        // Warm both visible chart ranges from saved inputs after the update.
        await getValuation(symbol,5,'disclosure',{force:true}).catch(()=>null);
        valuationMissing=n.market==='HK' ? !hkValuationHistoryCovered(valuation,expected,prices.candles.at(-1)!.date)
          : !valuation.history.length || valuation.history[0].date>prices.candles[0].date || valuation.history.length<prices.candles.length;
      }catch(error){valuationMissing=true;valuationError=error instanceof Error?error.message:'估值输入未通过校验';}
      const gaps=[...(!rangeCovered?['历史起点覆盖不足，或缺少已核实的上市日期']:[]),...(valuationMissing?[n.market==='HK'?'港股历史估值样本暂缺、过旧或覆盖不足':'部分交易日缺少已披露财报、股本或复权数据']:[]),
        ...(missingInputs.length?[`${missingInputs.length} 项财报或分红基础数据尚未入库`]:[]),
        ...(valuationError?[valuationError]:[])];
      const record={symbol,years:HISTORY_YEARS,requestedFrom:historyStart(),from:prices.candles[0].date,to:prices.candles.at(-1)!.date,count:prices.candles.length,
        status:rangeCovered&&!valuationMissing&&!missingInputs.length?'ready':'partial',priceSource:prices.source,valuationHistory:valuationMissing?'partial':'available',
        collection:'website-apis',listingDate,missingInputs,validation:'structural-and-source-overlap',gaps,checkedAt:new Date().toISOString()};
      const key=coverageKey(symbol),old=await store.read(key);
      if(!await store.write(marketRecord(key,'market-coverage','internal',record,864e5),old?.digest??null))throw Error('覆盖记录保存失败');
      // 覆盖复核后落地缺口台账：partial 时按 missingInputs/gaps 分类登记（mcp 桶供 WorkBuddy 补齐），ready 时清除。
      await applyGapClassification(store, symbol, classifyCoverage(record), { mode: 'ten-year' });
      if(record.status==='partial')throw Error(`已保存可用数据；${gaps.join('；')}`);
    });
  }
}
