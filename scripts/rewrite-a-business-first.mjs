/** User approved rewriting only these two 500-company batches. Preserve all other fields and companies. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {businessFirstSummary} from './business-first-summary.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),style='business-product-industry-v3';
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
export const retainedSections=a=>JSON.stringify(Object.fromEntries(Object.entries(a).filter(([k])=>!['summary','evidence'].includes(k))));
const backup=path.resolve(root,'../a-business-rewrite-backup-20261020-v3');
await fs.mkdir(backup,{recursive:true});
let total=0;
for(const suffix of ['', '-2']){
 const file=path.join(root,`docs/a-research-batch-500${suffix}.json`),batch=JSON.parse(await fs.readFile(file,'utf8'));
 const staged=[];
 for(const c of batch.companies){
  const target=path.join(root,c.file),before=await fs.readFile(target,'utf8'),a=JSON.parse(before);
  if(hash(before)!==c.sha256||a.researchStatus!=='draft'||a.evidence?.batchId!==batch.id)throw Error('Changed or non-owned analysis: '+c.code);
  const raw=JSON.parse(await fs.readFile(path.join(root,`src/data/analyses/_raw/a-batch-500${suffix}`,c.code+'.json'),'utf8'));
  const summary=businessFirstSummary(raw,a);
  if(a.evidence.editorialStyle===style&&a.summary===summary)continue;
  if(summary.length<1000||summary.split('\n\n').length!==5)throw Error('Business article incomplete: '+c.code);
  staged.push({c,target,before,a,summary});
 }
 for(const {c,target,before,a,summary}of staged){
  const originalSummary=a.summary,retainedHash=hash(retainedSections(a));
  const backupFile=path.join(backup,hash(before).slice(0,12)+'-'+c.code+'.json');
  try{await fs.writeFile(backupFile,before,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;const previous=await fs.readFile(backupFile,'utf8');if(previous!==before)throw Error('Backup differs; review required: '+c.code);}
  a.summary=summary;
  a.evidence.editorialStyle=style;
  a.evidence.editorialMethod='按逐家公司主营、产品结构和经营评述整理，使用分商业模式框架分析客户需求、交付链条与行业竞争；分析机制不等于已核验的具体合同或客户事实。';
  a.evidence.previousSummarySha256=hash(originalSummary);
  if(hash(retainedSections(a))!==retainedHash)throw Error('Unexpected section change: '+c.code);
  const after=JSON.stringify(a,null,2)+'\n';
  await fs.writeFile(target,after);
  c.businessRevision={style,updatedAt:batch.asOf,previousFileSha256:hash(before),previousSummarySha256:hash(originalSummary),retainedSectionsSha256:retainedHash};
  c.sha256=hash(after);total++;
 }
 batch.editorialStyle=style;batch.businessRewritten=batch.companies.filter(x=>x.businessRevision?.style===style).length;
 batch.status='local-business-first-drafts-awaiting-user-review';
 batch.qualityNote='业务与模式按产品、客户、交付及行业竞争为主线；包含分商业模式的分析框架，不等于1000家逐项人工精修或财务核验。来源、证据及原有其他版块保留。';
 await fs.writeFile(file,JSON.stringify(batch,null,2)+'\n');
 console.log(JSON.stringify({batch:batch.id,businessRewritten:batch.businessRewritten}));
}
console.log(JSON.stringify({updated:total,backup}));
