import fs from 'node:fs/promises';
import crypto from 'node:crypto';
const hash=x=>crypto.createHash('sha256').update(x).digest('hex'),changes=[],mapping=new Map();
for(const f of await fs.readdir('src/data/analyses'))if(/^\d{5,6}\.json$/.test(f)){
 const file=`src/data/analyses/${f}`,before=await fs.readFile(file),after=Buffer.from(before.toString('utf8').replaceAll('\r\n','\n'));
 if(before.equals(after))continue;
 if(JSON.stringify(JSON.parse(before))!==JSON.stringify(JSON.parse(after)))throw Error('Semantic change: '+f);
 const entry={code:f.slice(0,-5),before:hash(before),after:hash(after)};changes.push(entry);mapping.set(entry.before,entry.after);await fs.writeFile(file,after);
}
function replace(v){if(typeof v==='string')return mapping.get(v)||v;if(Array.isArray(v))return v.map(replace);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,replace(x)]));return v;}
for(const f of ['docs/full-market-research.json','docs/full-hk-research.json','docs/a-research-batch-500.json','docs/a-research-batch-500-2.json']){
 const before=JSON.parse(await fs.readFile(f,'utf8')),after=replace(before);if(JSON.stringify(before)!==JSON.stringify(after))await fs.writeFile(f,JSON.stringify(after,null,2)+'\n');
}
if(changes.length)await fs.writeFile('docs/research-line-endings.json',JSON.stringify({date:'2026-10-20',reason:'跨平台Git同步时统一LF；JSON内容不变，更新对应保留基线，后续通过.gitattributes固定换行。',changes},null,2)+'\n');
console.log(JSON.stringify({normalized:changes.length}));
