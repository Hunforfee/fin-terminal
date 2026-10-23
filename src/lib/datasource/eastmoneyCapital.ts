/** Actual share quantities at reported effective dates; never paid-in capital. */
import { fetchJson } from './http';
import { normalizeStockCode, numOrNull } from './codes';
import type { ShareChange } from './sinaFinance';

type Row=Record<string,unknown>;
const date=(v:unknown)=>typeof v==='string'?v.slice(0,10):'';
const iso=(d:string)=>/^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d+'T00:00:00Z'))
  && new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;
export function parseEastmoneyShareHistory(rows:Row[],code:string,now=Date.now()):ShareChange[]{
  const n=normalizeStockCode(code);
  if(!n || n.market==='HK' || !/^\d{6}$/.test(code))throw Error('股本备用来源股票代码无效');
  const secucode=`${code}.${n.market}`,today=new Date(now+8*3600e3).toISOString().slice(0,10),values=new Map<string,ShareChange>();
  for(const row of rows){
    if(row.SECUCODE!==secucode || row.SECURITY_CODE!==code)throw Error('股本备用来源证券身份不匹配');
    if(row.IS_USE==='0')continue;
    const effective=date(row.END_DATE),notice=date(row.NOTICE_DATE),shares=numOrNull(row.TOTAL_SHARES);
    if(!iso(effective) || notice && !iso(notice))throw Error('股本变动或披露日期无效');
    if(effective>today || notice>today)continue;
    if(shares===null || !Number.isSafeInteger(shares) || shares<=0)throw Error('股本备用来源缺少实际整数股数');
    const previous=values.get(effective);
    if(previous && Math.abs(previous.sharesWan*1e4-shares)>.5)throw Error('同一生效日实际股数冲突');
    values.set(effective,{date:effective,sharesWan:shares/1e4,source:'eastmoney-equity',noticeDate:notice||undefined,
      precisionShares:1,reference:typeof row.INFO_CODE==='string'?row.INFO_CODE:undefined});
  }
  if(!values.size)throw Error('股本备用来源暂无已披露的有效历史');
  return [...values.values()].sort((a,b)=>a.date.localeCompare(b.date));
}
export async function fetchEastmoneyShareHistory(code:string):Promise<ShareChange[]>{
  const n=normalizeStockCode(code);
  if(!n || n.market==='HK' || !/^\d{6}$/.test(code))throw Error('股本备用来源股票代码无效');
  const rows:Row[]=[],seen=new Set<string>();let expected:number|undefined,pages:number|undefined;
  for(let page=1;page<=20;page++){
    const url=new URL('https://datacenter.eastmoney.com/securities/api/data/v1/get');
    url.search=new URLSearchParams({reportName:'RPT_F10_EH_EQUITY',columns:'ALL',filter:`(SECUCODE="${code}.${n.market}")`,
      pageSize:'100',pageNumber:String(page),sortColumns:'END_DATE,NOTICE_DATE',sortTypes:'-1,-1'}).toString();
    const json=await fetchJson<{success?:boolean;result?:{data?:Row[];pages?:number;count?:number}|null}>(url.toString(),{timeoutMs:12000,retries:0});
    const result=json.result;
    if(json.success!==true || !Array.isArray(result?.data) || !Number.isSafeInteger(result.pages) || (result.pages??0)<1 || (result.pages??0)>20
      || !Number.isSafeInteger(result.count) || (result.count??0)<1 || !result.data.length)throw Error('股本备用来源不可用或分页不完整');
    pages??=result.pages;expected??=result.count;
    if(pages!==result.pages || expected!==result.count)throw Error('股本分页期间来源发生变化');
    const signature=JSON.stringify(result.data);
    if(seen.has(signature))throw Error('股本备用来源重复返回同一页');
    seen.add(signature);rows.push(...result.data);
    if(page===pages){if(rows.length!==expected)throw Error('股本备用来源记录数不完整');return parseEastmoneyShareHistory(rows,code);}
  }
  throw Error('股本备用来源分页未结束');
}
