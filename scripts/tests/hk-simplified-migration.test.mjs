import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {simplified} from '../hk-simplified.mjs';
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
test('every stored HK analysis is simplified, including all historical coverage',async()=>{
 const files=(await fs.readdir('src/data/analyses')).filter(x=>/^\d{5}\.json$/.test(x));assert.equal(files.length,2791);
 for(const f of files){const a=JSON.parse(await fs.readFile(`src/data/analyses/${f}`,'utf8'));assert.deepEqual(simplified(a),a,f);}
});
test('authorized language migration changes only Chinese strings and retains original proof',async()=>{
 const log=JSON.parse(await fs.readFile('docs/hk-simplified-migration.json','utf8'));assert(log.entries.length>0);
 for(const e of log.entries){
  const after=await fs.readFile(`src/data/analyses/${e.code}.json`);assert.equal(hash(after),e.after);
  const restored=JSON.parse(after);
  assert(e.changedStrings?.length);
  for(const change of e.changedStrings){let parent=restored;for(const key of change.path.slice(0,-1))parent=parent[key];const key=change.path.at(-1);assert.equal(parent[key],change.after);parent[key]=change.before;}
  assert.equal(hash(JSON.stringify(restored)),e.beforeCanonicalSha256);
  assert.deepEqual(JSON.parse(after),simplified(restored),e.code);
  try{const backup=await fs.readFile(e.backup);assert.equal(hash(backup),e.before);}catch(error){if(error.code!=='ENOENT')throw error;}
 }
});
