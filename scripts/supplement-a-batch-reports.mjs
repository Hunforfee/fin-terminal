import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),suffix=process.argv.includes('--batch=2')?'-2':'';
const b=JSON.parse(await fs.readFile(path.join(root,`docs/a-research-batch-500${suffix}.json`),'utf8'));
for(const t of b.companies){
 const f=path.join(root,`src/data/analyses/_raw/a-batch-500${suffix}`,t.code+'.json'),r=JSON.parse(await fs.readFile(f,'utf8'));
 if(r.reports.length)continue;
 const j=await(await fetch(r.urls.announcements,{signal:AbortSignal.timeout(18000)})).json();
 const notices=(j.data?.list||[]).filter(x=>x.codes?.some(y=>y.stock_code===t.code)&&x.notice_date.slice(0,10)<=b.asOf);
 const annual=notices.filter(x=>/20\d{2}年?(?:半年度|年度)报告/.test(x.title)&&!/摘要|英文|取消|提示|董事|审计|更正公告|说明|承诺|会计|法律/.test(x.title));
 const rows=annual.length?annual:notices.filter(x=>/招股说明书|招股意向书/.test(x.title)&&!/附录|提示|摘要/.test(x.title));
 r.reports=rows.slice(0,2).map(x=>({title:x.title,publishedAt:x.notice_date.slice(0,10),url:`https://data.eastmoney.com/notices/detail/${t.code}/${x.art_code}.html`,pdfUrl:`https://pdf.dfcfw.com/pdf/H2_${x.art_code}_1.pdf`,artCode:x.art_code,...(!annual.length?{kind:'prospectus'}:{})}));
 await fs.writeFile(f,JSON.stringify(r,null,2)+'\n');console.log(t.code,t.name,r.reports.map(x=>x.title));
}
