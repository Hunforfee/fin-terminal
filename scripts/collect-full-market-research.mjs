/** Entire website company-directory snapshot. Preserve every existing analysis; record source gaps honestly. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),dir=path.join(root,'src/data/analyses');
const args=process.argv.slice(2),market=args.find(x=>x.startsWith('--market='))?.split('=')[1]||'A';
if(!['A','HK'].includes(market))throw Error('Use --market=A or --market=HK');
const out=path.join(dir,'_raw/full-market'),manifest=path.join(root,market==='HK'?'docs/full-hk-research.json':'docs/full-market-research.json');
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const clean=s=>typeof s==='string'?s.replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim():'';
const date=s=>typeof s==='string'?s.slice(0,10):'';
const symbol=c=>(/^[489]/.test(c)?'bj':c.startsWith('6')?'sh':'sz')+c;
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
async function get(url){
 const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0',Referer:'https://emweb.securities.eastmoney.com/'},signal:AbortSignal.timeout(18000)});
 if(!r.ok)throw Error('HTTP '+r.status);return r.json();
}
async function pool(items,n,fn){let index=0;await Promise.all(Array.from({length:n},async()=>{while(index<items.length){const i=index++;await fn(items[i],i);}}));}
await fs.mkdir(out,{recursive:true});
let batch;try{batch=JSON.parse(await fs.readFile(manifest,'utf8'));}catch{}
if(!batch){
 const existing={};for(const f of await fs.readdir(dir))if(/^\d{5,6}\.json$/.test(f))existing[f.slice(0,-5)]=hash(await fs.readFile(path.join(dir,f)));
 const tree=JSON.parse(await fs.readFile(path.join(root,'src/lib/sw2021.json'),'utf8')),hk=JSON.parse(await fs.readFile(path.join(root,'src/lib/hk-industries.json'),'utf8'));
 const companies=new Map();
 if(market==='A')for(const i of tree.industries)for(const code of i.stocks)if(/^(?:00|30|60|68|43|83|87|88|92)\d{4}$/.test(code)&&!existing[code])companies.set(code,{code,market:'A',name:code,industry:i.name,status:'pending'});
 if(market==='HK')for(const m of hk.members)if(/^\d{5}$/.test(m.code)&&!existing[m.code])companies.set(m.code,{code:m.code,market:'HK',name:m.name,industry:m.industryDetail||m.industry||'未分类',industryPath:m.industryPath,listingDate:m.listingDate,status:'pending'});
 batch={version:1,id:`full-${market.toLowerCase()}-${today.replaceAll('-','')}`,asOf:today,scope:market==='HK'?'网站港股目录未覆盖公司；新增文字统一简体中文，既有解析保留。':'网站申万A股目录未覆盖公司（排除B股）。',baselineExisting:existing,requested:companies.size,companies:[...companies.values()].sort((a,b)=>a.code.localeCompare(b.code)),status:'collecting'};
 await fs.writeFile(manifest,JSON.stringify(batch,null,2)+'\n');
}
const targets=batch.companies.filter(t=>!market||t.market===market);let done=0;
await pool(targets,6,async target=>{
 const c=target.code,file=path.join(out,c+'.json');let old;try{old=JSON.parse(await fs.readFile(file,'utf8'));}catch{}
 if(old?.collected&&old.asOf===batch.asOf){done++;target.status='collected';return;}
 const hk=target.market==='HK',p=symbol(c).toUpperCase();
 const endpoint=(report,filter,count='1')=>'https://datacenter.eastmoney.com/securities/api/data/v1/get?'+new URLSearchParams({reportName:report,columns:'ALL',filter,pageSize:count,pageNumber:'1',...(count!=='1'?{sortColumns:'REPORT_DATE',sortTypes:'-1'}:{}),source:'F10',client:'PC'});
 const urls=hk?{
  profile:endpoint('RPT_HKF10_INFO_ORGPROFILE',`(SECUCODE="${c}.HK")`),finance:endpoint('RPT_HKF10_FN_MAININDICATOR',`(SECUCODE="${c}.HK")`,'6'),
  announcements:'https://np-anotice-stock.eastmoney.com/api/security/ann?'+new URLSearchParams({sr:'-1',page_size:'100',page_index:'1',ann_type:'H',stock_list:c})
 }:{
  profile:`https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax?code=${p}`,business:`https://emweb.securities.eastmoney.com/PC_HSF10/BusinessAnalysis/PageAjax?code=${p}`,
  finance:'https://datacenter-web.eastmoney.com/api/data/v1/get?'+new URLSearchParams({reportName:'RPT_F10_FINANCE_MAINFINADATA',columns:'ALL',filter:`(SECURITY_CODE="${c}")`,pageSize:'12',sortColumns:'REPORT_DATE',sortTypes:'-1'}),
  announcements:'https://np-anotice-stock.eastmoney.com/api/security/ann?'+new URLSearchParams({sr:'-1',page_size:'100',page_index:'1',ann_type:'A',stock_list:c})
 };
 const keys=Object.keys(urls),results=await Promise.allSettled(keys.map(k=>get(urls[k]))),data={},errors=[];
 results.forEach((r,i)=>{if(r.status==='fulfilled')data[keys[i]]=r.value;else errors.push({source:keys[i],error:r.reason.message});});
 const rawProfile=hk?data.profile?.result?.data?.find(x=>x.SECURITY_CODE===c):data.profile?.jbzl?.find(x=>x.SECURITY_CODE===c);
 const fields=['SECURITY_CODE','SECURITY_NAME_ABBR','ORG_NAME','EM2016','INDUSTRYCSRC1','ORG_WEB','ORG_PROFILE','MAIN_BUSINESS','BUSINESS_SCOPE','BELONG_INDUSTRY','INDUSTRY_TYPE','LISTING_DATE'];
 const profile=rawProfile?Object.fromEntries(fields.map(k=>[k,rawProfile[k]??null])):null;
 const financials=(data.finance?.result?.data||[]).filter(x=>x.SECURITY_CODE===c&&date(x.REPORT_DATE)<=batch.asOf&&(!x.NOTICE_DATE||date(x.NOTICE_DATE)<=batch.asOf)&&(!x.UPDATE_DATE||date(x.UPDATE_DATE)<=batch.asOf));
 const reviews=(data.business?.jyps||[]).filter(x=>date(x.REPORT_DATE)<=batch.asOf&&clean(x.BUSINESS_REVIEW));
 const segments=(data.business?.zygcfx||[]).filter(x=>date(x.REPORT_DATE)<=batch.asOf&&x.ITEM_NAME);
 const notices=(data.announcements?.data?.list||[]).filter(x=>x.codes?.some(y=>y.stock_code===c)&&date(x.notice_date)<=batch.asOf);
 const annual=notices.filter(x=>(hk?/年度報告|年度报告|中期報告|中期报告|年報|年报|Annual Report|Interim Report/i:/20\d{2}年?(?:半年度|年度)报告/).test(x.title)&&!/摘要|英文|取消|提示|董事|审计|更正公告|通知|說明|会计|法律|薪酬|管治|環境|可持續|社会责任/i.test(x.title));
 const reportRows=annual.length?annual:notices.filter(x=>/招股说明书|招股意向书|招股章程/.test(x.title)&&!/附录|提示|摘要/.test(x.title));
 const reports=reportRows.slice(0,3).map(x=>({title:x.title,publishedAt:date(x.notice_date),url:`https://data.eastmoney.com/notices/detail/${c}/${x.art_code}.html`,pdfUrl:`https://pdf.dfcfw.com/pdf/H2_${x.art_code}_1.pdf`,...(!annual.length?{kind:'prospectus'}:{})}));
 const collected=!!profile?.ORG_NAME;
 const r={...target,profile,financials,reviews,segments,reports,urls,errors,collected,asOf:batch.asOf,retrievedAt:today};
 await fs.writeFile(file,JSON.stringify(r,null,2)+'\n');
 target.name=profile?.SECURITY_NAME_ABBR||target.name;target.status=collected?'collected':'source-gap';target.sourceErrors=errors;target.reports=reports.length;
 done++;if(done%100===0||!collected)console.log(JSON.stringify({done,total:targets.length,code:c,market:target.market,name:target.name,collected,finance:financials.length,reviews:reviews.length,segments:segments.length,reports:reports.length,errors}));
});
batch.status='evidence-collected';batch.collected=batch.companies.filter(t=>t.status==='collected').length;
await fs.writeFile(manifest,JSON.stringify(batch,null,2)+'\n');console.log(JSON.stringify({requested:batch.requested,collected:batch.collected,sourceGaps:batch.companies.filter(t=>t.status==='source-gap').length}));
