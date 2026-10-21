import { cachedMarketInput } from './marketInputs';
import { normalizeStockCode } from './datasource/codes';
import { fetchJson } from './datasource/http';
export interface SecurityBasics { symbol:string; listingDate:string; source:string }
export const securityBasicsKey=(symbol:string)=>`security-basics:v1:${symbol}`;
export const validMarketDate=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
  && new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
/** Listing is a source fact, never inferred from the first downloaded candle. */
export function getSecurityBasics(symbol:string):Promise<SecurityBasics>{
 const n=normalizeStockCode(symbol);if(!n)throw Error('证券无效');
 return cachedMarketInput(securityBasicsKey(n.symbol),'security-basics','eastmoney:listing-date',7*864e5,async()=>{
  let row:Record<string,unknown>|undefined;
  if(n.market==='HK'){
   const u=new URL('https://datacenter.eastmoney.com/securities/api/data/v1/get');
   u.search=new URLSearchParams({reportName:'RPT_HKF10_INFO_ORGPROFILE',columns:'SECUCODE,LISTING_DATE',filter:`(SECUCODE="${n.code}.HK")`,pageSize:'1'}).toString();
   const j=await fetchJson<{result?:{data?:Record<string,unknown>[]}}>(u.toString());row=j.result?.data?.[0];
  }else{
   const j=await fetchJson<{fxxg?:Record<string,unknown>[]}>(`https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax?code=${n.symbol.toUpperCase()}`);
   row=j.fxxg?.find(r=>r.SECURITY_CODE===n.code);
  }
  const expected=`${n.code}.${n.market}`;
  if(row?.SECUCODE!==expected)throw Error('上市信息证券不匹配');
  return {symbol:n.symbol,listingDate:String(row.LISTING_DATE??'').slice(0,10),source:'eastmoney'};
 },value=>{
  const today=new Date(Date.now()+8*3600e3).toISOString().slice(0,10);
  if(value.symbol!==n.symbol || !validMarketDate(value.listingDate) || value.listingDate>today)throw Error('上市日期无效');
 });
}
