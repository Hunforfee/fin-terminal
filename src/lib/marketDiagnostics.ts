import type { MarketStore } from './marketStore';
import { normalizeStockCode } from './datasource/codes';
import { financialEarliestYear, requiredFinancialReports, historyStart, coverageKey, HISTORY_YEARS } from './marketHistoryPlan';
import { financialPageGaps } from './financialPageQuality';

/** Pure DB inspection: no fetching, writes, cache warming or lease acquisition. */
export async function diagnoseMarketData(store:Pick<MarketStore,'read'>,symbol:string,now=Date.now()) {
 const n=normalizeStockCode(symbol);if(!n)throw Error('无效股票代码');
 const basics=await store.read<{listingDate?:string}>(`security-basics:v1:${n.symbol}`);
 const listingDate=basics?.payload.listingDate;
 const pages=[];
 if(n.market!=='HK')for(let year=new Date(now+8*3600e3).getUTCFullYear();year>=financialEarliestYear(now);year--){
  const expected=requiredFinancialReports(year,listingDate,now);if(!expected.length)continue;
  for(const id of ['profit','balance','cashflow'] as const){
   const key=`source-sina-page:v1:${n.code}:${id}:${year}`;
   const row=await store.read<import('./datasource/eastmoneyStatements').StatementSourcePage>(key);
   pages.push({key,expectedDates:expected,savedDates:row?.payload.dates??[],missing:financialPageGaps(row?.payload,id,expected),
    source:row?.source??null,digest:row?.digest??null,acquiredAt:row?.acquiredAt??null,refreshAfter:row?.refreshAfter??null});
  }
 }
 const revision=await store.read<{version:string}>(`valuation-input-version:v1:${n.symbol}`);
 const valuation=await store.read<{revision:string;value:{history?:{date:string;missingInputs?:string[]}[]}}>(`valuation-result:v1:${n.symbol}:${HISTORY_YEARS}:disclosure`);
 const history=valuation?.payload.value.history??[];
 const prices=[];
 for(const source of ['canonical','tencent','sina','eastmoney']) {
  const key=`kline:v2:${n.symbol}:day:none:${source}:prices-only`;
  const row=await store.read<{candles:{date:string}[]}>(key),bars=row?.payload.candles??[];
  if(row)prices.push({key,source:row.source,from:bars[0]?.date,to:bars.at(-1)?.date,count:bars.length,digest:row.digest,acquiredAt:row.acquiredAt});
 }
 const shares=n.market==='HK'?null:await store.read<{date:string;sharesWan:number}[]>(`shares-v3:${n.code}`);
 const coverage=await store.read(coverageKey(n.symbol));
 return {symbol:n.symbol,checkedAt:new Date(now).toISOString(),readOnly:true,listingDate:listingDate??null,
  listingDateVerified:!!listingDate,pages,prices,shares:{count:shares?.payload.length??0,atWindowStart:shares?.payload.filter(p=>p.date<=historyStart(now)).at(-1)??null},
  valuation:{cached:!!valuation,revisionMatches:!!valuation && !!revision && valuation.payload.revision===revision.payload.version,
   missingInputs:history.filter(p=>p.missingInputs?.length).map(p=>({date:p.date,missing:p.missingInputs})),dates:history.length},
  coverage:coverage?.payload??null,
  // No single green flag: these are independent layers, not proof of accounting accuracy.
  missingPages:pages.filter(p=>p.missing.length).length,hkStatementAuditSupported:n.market!=='HK'};
}
