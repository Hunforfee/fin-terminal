/** Public evidence only. Re-runnable; never overwrite existing company analysis. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const batchArg=process.argv.find(x=>x.startsWith('--batch='))||'--batch=1';
if(!['--batch=1','--batch=2'].includes(batchArg))throw Error('Supported batch numbers: 1, 2');
const suffix=batchArg==='--batch=2'?'-2':'';
const rawDir=path.join(root,`src/data/analyses/_raw/a-batch-500${suffix}`);
const manifest=path.join(root,`docs/a-research-batch-500${suffix}.json`);
const today='2026-10-20';
const headers={'User-Agent':'Mozilla/5.0',Referer:'https://emweb.securities.eastmoney.com/'};
const clean=s=>typeof s==='string'?s.replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim():'';
const symbol=c=>(/^[489]/.test(c)?'bj':c.startsWith('6')?'sh':'sz')+c;
async function get(url,encoding){
 for(let attempt=0;attempt<2;attempt++)try{
  const r=await fetch(url,{headers,signal:AbortSignal.timeout(18000)});if(!r.ok)throw Error('HTTP '+r.status);
  return encoding?new TextDecoder(encoding).decode(await r.arrayBuffer()):await r.json();
 }catch(e){if(attempt)throw e;}
}
async function map(items,n,fn){let cursor=0;const output=new Array(items.length);await Promise.all(Array.from({length:Math.min(n,items.length)},async()=>{while(cursor<items.length){const i=cursor++;output[i]=await fn(items[i],i);}}));return output;}
await fs.mkdir(rawDir,{recursive:true});
let batch;try{batch=JSON.parse(await fs.readFile(manifest,'utf8'));}catch{}
if(!batch){
 const tree=JSON.parse(await fs.readFile(path.join(root,'src/lib/sw2021.json'),'utf8'));
 const existing=new Set((await fs.readdir(path.join(root,'src/data/analyses'))).filter(x=>/^\d{6}\.json$/.test(x)).map(x=>x.slice(0,-5)));
 const groups=tree.industries.map(i=>({name:i.name,codes:i.stocks.filter(c=>/^(?:00|30|60|68|43|83|87|88|92)\d{4}$/.test(c)&&!existing.has(c))}));
 const all=[...new Set(groups.flatMap(g=>g.codes))],quotes=new Map();
 await map(Array.from({length:Math.ceil(all.length/150)},(_,i)=>all.slice(i*150,(i+1)*150)),3,async codes=>{
  try{const text=await get('https://qt.gtimg.cn/q='+codes.map(symbol).join(','),'gb18030');for(const match of text.matchAll(/v_\w+="([^"]+)"/g)){
   const f=match[1].split('~');if(/^\d{6}$/.test(f[2])&&f[1]&&!/ST|退/.test(f[1]))quotes.set(f[2],{name:f[1],marketCapYi:Number(f[45])||0});
  }}catch(e){console.log('quote batch failed:',e.message);}
 });
 if(quotes.size<1000)throw Error('Quote identity/ranking incomplete; no batch selected');
 const buckets=groups.map(g=>({...g,codes:g.codes.filter(c=>quotes.has(c)).sort((a,b)=>quotes.get(b).marketCapYi-quotes.get(a).marketCapYi||a.localeCompare(b))}));
 const selected=[],used=new Set();let rank=0;
 while(selected.length<500){let added=0;for(const b of buckets){const c=b.codes[rank];if(c&&!used.has(c)&&selected.length<500){selected.push({code:c,name:quotes.get(c).name,industry:b.name,selectionMarketCapYi:quotes.get(c).marketCapYi});used.add(c);added++;}}if(!added)break;rank++;}
 if(selected.length!==500)throw Error('Not enough eligible companies');
 batch={version:1,id:`a-batch-500${suffix}-20261020`,asOf:today,status:'collecting',requested:500,selection:'行业快照中未覆盖的A股，排除B股、指数、基金及行情名称带ST/退的标的；每个一级行业按行情市值排序，轮流取样，最多500家。该排序仅用于研究排队，不是投资推荐。',baselineExistingCodes:[...existing].sort(),companies:selected};
 await fs.writeFile(manifest,JSON.stringify(batch,null,2)+'\n');
}
let done=0;
await map(batch.companies,5,async target=>{
 const c=target.code,file=path.join(rawDir,c+'.json');let old;try{old=JSON.parse(await fs.readFile(file,'utf8'));}catch{}
 if(old?.ok&&old.retrievedAt===today){done++;return;}
 const p=symbol(c).toUpperCase();
 const urls={profile:`https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax?code=${p}`,business:`https://emweb.securities.eastmoney.com/PC_HSF10/BusinessAnalysis/PageAjax?code=${p}`,finance:'https://datacenter-web.eastmoney.com/api/data/v1/get?'+new URLSearchParams({reportName:'RPT_F10_FINANCE_MAINFINADATA',columns:'ALL',filter:`(SECURITY_CODE="${c}")`,pageSize:'12',sortColumns:'REPORT_DATE',sortTypes:'-1'}),announcements:'https://np-anotice-stock.eastmoney.com/api/security/ann?'+new URLSearchParams({sr:'-1',page_size:'100',page_index:'1',ann_type:'A',stock_list:c})};
 const keys=Object.keys(urls),results=await Promise.allSettled(keys.map(k=>get(urls[k]))),data={},errors=[];
 results.forEach((r,i)=>{if(r.status==='fulfilled')data[keys[i]]=r.value;else errors.push(keys[i]+': '+r.reason.message);});
 const profile=data.profile?.jbzl?.find(x=>x.SECURITY_CODE===c);
 const financials=(data.finance?.result?.data||[]).filter(r=>r.SECURITY_CODE===c&&r.REPORT_DATE?.slice(0,10)<=today&&r.NOTICE_DATE?.slice(0,10)<=today&&r.UPDATE_DATE?.slice(0,10)<=today);
 const reviews=(data.business?.jyps||[]).filter(r=>r.REPORT_DATE?.slice(0,10)<=today&&clean(r.BUSINESS_REVIEW));
 const segments=(data.business?.zygcfx||[]).filter(r=>r.REPORT_DATE?.slice(0,10)<=today&&r.ITEM_NAME);
 const reports=(data.announcements?.data?.list||[]).filter(r=>r.codes?.some(x=>x.stock_code===c)&&r.notice_date?.slice(0,10)<=today&&/20\d{2}年?(?:半年度|年度)报告(?:全文)?$/.test(r.title)&&!/(摘要|英文|取消|更正|提示|董事|审计)/.test(r.title)).map(r=>({title:r.title,publishedAt:r.notice_date.slice(0,10),url:`https://data.eastmoney.com/notices/detail/${c}/${r.art_code}.html`,pdfUrl:`https://pdf.dfcfw.com/pdf/H2_${r.art_code}_1.pdf`,artCode:r.art_code})).slice(0,4);
 const safeProfile=profile?Object.fromEntries(['SECURITY_CODE','SECURITY_NAME_ABBR','ORG_NAME','EM2016','INDUSTRYCSRC1','ORG_WEB','ORG_PROFILE','BUSINESS_SCOPE'].map(k=>[k,profile[k]??null])):null;
 const ok=!!(safeProfile?.ORG_NAME&&financials.length&&reviews.length&&segments.length);
 const result={...target,profile:safeProfile,financials,reviews,segments,reports,urls,errors,ok,retrievedAt:today};
 await fs.writeFile(file,JSON.stringify(result,null,2)+'\n');
 target.evidenceStatus=ok?'collected':'incomplete';target.reportCatalog=reports.length;done++;
 if(done%25===0||!ok)console.log(JSON.stringify({done,code:c,name:target.name,ok,finance:financials.length,reviews:reviews.length,segments:segments.length,reports:reports.length,errors}));
});
for(const target of batch.companies){const r=JSON.parse(await fs.readFile(path.join(rawDir,target.code+'.json'),'utf8'));target.evidenceStatus=r.ok?'collected':'incomplete';target.reportCatalog=r.reports.length;}
batch.collected=batch.companies.filter(c=>c.evidenceStatus==='collected').length;batch.status=batch.collected===500?'evidence-collected':'evidence-incomplete';
await fs.writeFile(manifest,JSON.stringify(batch,null,2)+'\n');console.log(JSON.stringify({selected:500,collected:batch.collected}));
