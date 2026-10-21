import { fetchJson } from './http';
import { normalizeStockCode } from './codes';
import type { Adjust,KLineSeries,Period } from './types';
/** Independent fallback; the source must explicitly echo the requested security. */
export async function fetchKLine(symbol:string,period:Period,adjust:Adjust,count:number,start?:string,end?:string):Promise<KLineSeries>{
 const n=normalizeStockCode(symbol);if(!n || period==='minute')throw Error('不支持的行情请求');
 const u=new URL('https://push2his.eastmoney.com/api/qt/stock/kline/get');
 u.search=new URLSearchParams({secid:n.secid,klt:String({day:101,week:102,month:103}[period]),fqt:String({none:0,qfq:1,hfq:2}[adjust]),
  beg:start?.replaceAll('-','')??'0',end:end?.replaceAll('-','')??'20500101',lmt:String(Math.min(3200,count)),
  fields1:'f1,f2,f3,f4,f5,f6',fields2:'f51,f52,f53,f54,f55'}).toString();
 const json=await fetchJson<{rc:number;data?:{code:string;market:number;klines?:string[]}}>(u.toString(),{timeoutMs:12000,retries:0});
 const data=json.data;
 if(json.rc!==0 || !data || data.code!==n.code || String(data.market)!==n.secid.split('.')[0] || !Array.isArray(data.klines) || !data.klines.length)throw Error('备用行情证券或数据无效');
 const candles=data.klines.map(line=>{const [date,open,close,high,low]=line.split(',');
  if([open,close,high,low].some(v=>v==null || !v.trim()))throw Error('备用行情价格为空');
  return {date,open:Number(open),close:Number(close),high:Number(high),low:Number(low)};});
 if(candles.some(c=>!/^\d{4}-\d{2}-\d{2}$/.test(c.date) || [c.open,c.close,c.high,c.low].some(v=>!Number.isFinite(v))
   || start && c.date<start || end && c.date>end))throw Error('备用行情价格或范围无效');
 return {symbol:n.symbol,code:n.code,period,adjust,candles,source:'eastmoney',stale:false,complete:true};
}
