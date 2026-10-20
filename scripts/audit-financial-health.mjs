// Read-only provider audit. This checks identities, periods, ratios and units,
// not an issuer-document audit. Missing component balances are never written as zeros.
import fs from 'node:fs/promises';
const codes=['600415.SH','600519.SH','300498.SZ','002714.SZ','600036.SH','601318.SH','000333.SZ','600900.SH','601899.SH','603866.SH'];
const get=async(report,code)=>{
  const url=new URL('https://datacenter.eastmoney.com/securities/api/data/v1/get');
  url.search=new URLSearchParams({reportName:report,columns:'ALL',filter:`(SECUCODE="${code}")`,pageSize:'60',sortColumns:'REPORT_DATE',sortTypes:'-1'}).toString();
  const response=await fetch(url,{signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error(`${code}: HTTP ${response.status}`);
  const result=await response.json();
  if(result.success===false||!Array.isArray(result.result?.data))throw Error(`${code}: invalid source response`);
  return result.result.data;
};
const reports=[];
for(const code of codes){
  const [main,balance]=await Promise.all([get('RPT_F10_FINANCE_MAINFINADATA',code),get('RPT_F10_FINANCE_GBALANCE',code).catch(()=>[])]);
  const byDate=new Map(balance.map(r=>[r.REPORT_DATE,r]));
  const rows=main.map(r=>{
    if(r.SECUCODE!==code||r.CURRENCY!=='CNY')throw Error(`${code}: identity/currency mismatch`);
    const b=byDate.get(r.REPORT_DATE),ratio=r.INTEREST_DEBT_RATIO;
    if(ratio!==null&&!(typeof ratio==='number'&&Number.isFinite(ratio)&&ratio>=0))throw Error(`${code}: bad ratio`);
    const keys=['SHORT_LOAN','NONCURRENT_LIAB_1YEAR','LONG_LOAN','BOND_PAYABLE','LEASE_LIAB'];
    // A diagnostic only: null fields are listed explicitly and this sum is not
    // used by the app. Financial firms/other debt instruments can differ.
    const known=b?keys.reduce((s,k)=>s+(typeof b[k]==='number'?b[k]:0),0):null;
    const diagnostic=b?.TOTAL_ASSETS>0?known/b.TOTAL_ASSETS*100:null;
    return {date:r.REPORT_DATE.slice(0,10),ratio,partialBalanceSumRatio:diagnostic,
      unpopulatedComponents:b?keys.filter(k=>b[k]==null):keys,
      diagnosticDelta:ratio!==null&&diagnostic!==null?ratio-diagnostic:null};
  });
  reports.push({code,periods:rows.length,available:rows.filter(r=>r.ratio!==null).length,latest:rows[0],rows});
  console.log(JSON.stringify({code,periods:rows.length,available:rows.filter(r=>r.ratio!==null).length,latest:rows[0]}));
}
await fs.mkdir('data/market-audit',{recursive:true});
await fs.writeFile('data/market-audit/financial-health.json',JSON.stringify({checkedAt:new Date().toISOString(),scope:'provider consistency, not issuer-document verification',reports},null,2));
