/** Read the ORIGINAL server API; never substitutes local snapshots or contacts providers. */
import fs from 'node:fs/promises';
const base=process.env.MARKET_DATA_API_URL,token=process.env.MARKET_DATA_API_ACCESS_TOKEN;
if(!base || !token)throw Error('请配置 MARKET_DATA_API_URL 和 MARKET_DATA_API_ACCESS_TOKEN');
const endpoint=new URL(base);
if(endpoint.protocol!=='https:' && !['localhost','127.0.0.1'].includes(endpoint.hostname))throw Error('数据 API 必须使用 HTTPS');
const requested=process.argv.slice(2);
async function read(params){
 const url=new URL(endpoint);for(const [k,v] of Object.entries(params))url.searchParams.set(k,v);
 for(let attempt=0;attempt<3;attempt++){
  const response=await fetch(url,{headers:{'x-fin-data-token':token},signal:AbortSignal.timeout(45000)});
  if(response.status===429 && attempt<2){const delay=Math.max(1,Math.min(60,Number(response.headers.get('retry-after'))||5));await new Promise(r=>setTimeout(r,delay*1000));continue;}
  if(!response.ok)throw Error(`数据 API HTTP ${response.status}；请核对接口部署、权限或服务状态`);
  const body=await response.json();if(!body.ok)throw Error('数据 API 未返回成功结果');return body.data;
 }
}
let symbols=requested;
if(requested.length===1 && requested[0]==='--all'){
 symbols=[];let after='';
 do{
  const page=await read({resource:'records',prefix:'kline:v2:',limit:'200',payload:'0',...(after?{after}:{})});
  for(const row of page.records??[]){const s=row.key.match(/^kline:v2:([^:]+):/)?.[1];if(s)symbols.push(s);}
  const next=page.nextCursor;if(next && next===after)throw Error('API 游标未前进');after=next;
 }while(after);
}
if(!symbols.length)throw Error('请提供股票代码，或 --all 检查所有已存行情标的');
const reports=[];
for(const code of [...new Set(symbols)]){
 const report=await read({resource:'diagnostics',code});reports.push(report);
 console.log(JSON.stringify({symbol:report.symbol,missingPages:report.missingPages,valuation:report.valuation,prices:report.prices}));
 await new Promise(r=>setTimeout(r,300));
}
await fs.mkdir('data/audits',{recursive:true});
const path=`data/audits/${new Date().toISOString().replaceAll(':','-')}.json`;
await fs.writeFile(path,JSON.stringify(reports,null,2));
console.log(`检查完成 ${reports.length} 只；报告 ${path}。结构检查不代表已核验原始披露。`);
