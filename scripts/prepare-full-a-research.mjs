/** Reuse evidence-linked section writer, strictly in the new A-only manifest. */
import fs from 'node:fs/promises';
const file='docs/full-market-research.json',batch=JSON.parse(await fs.readFile(file,'utf8'));
if(batch.companies.some(x=>x.market!=='A'))throw Error('A-only scope required');
if(process.argv.includes('--refresh-generated'))throw Error('This task preserves existing files; refresh is disabled.');
let source=await fs.readFile('scripts/prepare-a-research-batch.mjs','utf8');
for(const marker of ['`_raw/a-batch-500${suffix}`','`docs/a-research-batch-500${suffix}.json`','batch.companies.map(async t=>',"'otherFinance','amc'"," if(!competitors.length)throw Error('No supportable peer comparison: '+r.code);", " await fs.writeFile(target,JSON.stringify(analysis,null,2)+'\\n',{flag:replace?'w':'wx'});"]){
 if(!source.includes(marker))throw Error('Base writer changed; inspect before reuse: '+marker);
}
source=source.replace("`_raw/a-batch-500${suffix}`","'_raw/full-market'")
 .replace('`docs/a-research-batch-500${suffix}.json`',"'docs/full-market-research.json'")
 .replace('batch.companies.map(async t=>','batch.companies.filter(t=>t.readiness===\'ready\').map(async t=>')
 .replace("'otherFinance','amc'","'otherFinance','amc','trust','payment'")
 .replace(" if(!competitors.length)throw Error('No supportable peer comparison: '+r.code);",'')
 .replace(" await fs.writeFile(target,JSON.stringify(analysis,null,2)+'\\n',{flag:replace?'w':'wx'});", " analysis.summary=businessFirstSummary(r,analysis);\n analysis.evidence.editorialStyle='business-product-industry-v3';\n analysis.evidence.method='逐家公司身份、主营、财务聚合资料与分业务研究框架整理；原文与具体经营事实仍按任务核验。';\n await fs.writeFile(target,JSON.stringify(analysis,null,2)+'\\n',{flag:replace?'w':'wx'});")
 .replace('不表示500份逐页人工复核报告','不表示逐家公司已完成原文人工复核');
// Import generated sibling module so relative imports and root resolution stay correct.
const temp='scripts/.prepare-full-a-runtime.mjs';
if(!source.includes("analysis.summary=businessFirstSummary"))throw Error('Writer shape changed');
source="import {businessFirstSummary} from './business-first-summary.mjs';\n"+source;
await fs.writeFile(temp,source);
try{await import('./.prepare-full-a-runtime.mjs?run='+Date.now());}finally{await fs.unlink(temp);}
