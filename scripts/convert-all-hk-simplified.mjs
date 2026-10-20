import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {simplified} from './hk-simplified.mjs';
const dir='src/data/analyses',logFile='docs/hk-simplified-migration.json',hash=x=>crypto.createHash('sha256').update(x).digest('hex');
let log;try{log=JSON.parse(await fs.readFile(logFile,'utf8'));}catch{log={version:1,date:'2026-10-20',authorization:'用户要求此前覆盖的港股全部替换为简体中文',entries:[]};}
await fs.mkdir(`${dir}/_raw/language-before`,{recursive:true});
const protectedValues=v=>typeof v==='string'?(v.match(/https?:\/\/[^\s<>"']+/g)||[]):Array.isArray(v)?v.flatMap(protectedValues):v&&typeof v==='object'?Object.values(v).flatMap(protectedValues):[v];
let scanned=0;
for(const name of (await fs.readdir(dir)).filter(x=>/^\d{5}\.json$/.test(x))){
 scanned++;const file=`${dir}/${name}`,bytes=await fs.readFile(file),a=JSON.parse(bytes),next=simplified(a);
 if(JSON.stringify(a)===JSON.stringify(next))continue;
 if(JSON.stringify(protectedValues(a))!==JSON.stringify(protectedValues(next)))throw Error('URL/number change: '+name);
 const before=hash(bytes),backup=`${dir}/_raw/language-before/${name}`;
 try{await fs.writeFile(backup,bytes,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;if(hash(await fs.readFile(backup))!==before)throw Error('Backup differs: '+name);}
 const result=JSON.stringify(next,null,2)+'\n';await fs.writeFile(file,result);
 log.entries.push({code:name.slice(0,-5),before,after:hash(result),backup,method:'仅将字符串中的繁体转换为简体；结构、非字符串值及链接保持不变'});
 await fs.writeFile(logFile,JSON.stringify(log,null,2)+'\n');
}
// Update preservation baselines explicitly through the recorded, user-authorized migration.
for(const file of ['docs/full-market-research.json','docs/full-hk-research.json']){
 const b=JSON.parse(await fs.readFile(file,'utf8'));
 for(const e of log.entries){
  if(b.baselineExisting[e.code]===e.before)b.baselineExisting[e.code]=e.after;
  const t=b.companies.find(x=>x.code===e.code);if(t?.sha256===e.before)t.sha256=e.after;
 }
 b.languageMigration='hk-simplified-migration.json';await fs.writeFile(file,JSON.stringify(b,null,2)+'\n');
}
log.scanned=scanned;log.changed=log.entries.length;
await fs.writeFile(logFile,JSON.stringify(log,null,2)+'\n');console.log(JSON.stringify({scanned,converted:log.changed}));
