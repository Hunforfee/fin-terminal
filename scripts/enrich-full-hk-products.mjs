import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {businessSignals} from './hk-business-signals.mjs';
const file='docs/full-hk-research.json',b=JSON.parse(await fs.readFile(file,'utf8')),hash=x=>crypto.createHash('sha256').update(x).digest('hex');let count=0;
for(const t of b.companies)if(t.analysisStatus==='draft'){
 if(b.baselineExisting[t.code])throw Error('Baseline issuer must not be edited');
 const bytes=await fs.readFile(t.file);if(hash(bytes)!==t.sha256)throw Error('Edited file; preserve it: '+t.code);
 const a=JSON.parse(bytes);if(a.evidence?.companyBusinessSignals)continue;
 const r=JSON.parse(await fs.readFile(`src/data/analyses/_raw/full-market/${t.code}.json`,'utf8')),s=businessSignals(r.profile.MAIN_BUSINESS);
 if(s.text){const paragraphs=a.summary.split('\n\n');paragraphs[0]+=` ${s.text}[主营] 这些是资料中的业务范围，不代表收入排序、利润权重或全部地区均有同等经营规模。`;a.summary=paragraphs.join('\n\n');}
 a.evidence.companyBusinessSignals={sourceId:'profile',products:s.products,regions:s.regions,meaning:'仅提取本公司主营描述出现的产品及地区词，不据此推断占比或经营规模。'};
 await fs.writeFile(t.file,JSON.stringify(a,null,2)+'\n');t.sha256=hash(await fs.readFile(t.file));count++;
}
await fs.writeFile(file,JSON.stringify(b,null,2)+'\n');console.log(JSON.stringify({businessSignalsEnriched:count}));
