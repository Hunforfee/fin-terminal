import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {loadQmtPackage,importQmtPackage} from '../import-qmt-watchlist.mjs';
import {load} from './load-modules.mjs';
const runtime=await load('marketImportedBars');
const {fileMarketStore,marketRecord}=await load('marketStore');
const candles=[{date:'2026-10-19',open:10,high:11,low:9,close:10},{date:'2026-10-20',open:10,high:12,low:9,close:11}];
async function fixture(fn){
 const parent=path.resolve('data');await fs.mkdir(parent,{recursive:true});const dir=await fs.mkdtemp(path.join(parent,'qmt-import-test-'));
 try{
  await fs.mkdir(path.join(dir,'raw'));const payload={schema:'fin-terminal-qmt-raw-v1',symbol:'sh600519',qmtCode:'600519.SH',source:'qmt',currency:'CNY',adjust:'none',period:'day',fillData:false,requestedFrom:'2026-10-19',requestedTo:'2026-10-20',candles};
  const raw=JSON.stringify(payload);await fs.writeFile(path.join(dir,'raw/sh600519.json'),raw);
  const manifest={version:1,scopeSha256:'a'.repeat(64),scope:[{symbol:'sh600519'},{symbol:'hk00700'}],uniqueStocks:2,requestedFrom:'2026-10-19',requestedTo:'2026-10-20',stocks:{sh600519:{status:'exported',from:'2026-10-19',to:'2026-10-20',count:2,files:{'raw/sh600519.json':createHash('sha256').update(raw).digest('hex')}}}};
  await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify(manifest));
  await fn({dir,manifest,payload,store:fileMarketStore(path.join(dir,'store'))});
 }finally{if(!path.resolve(dir).startsWith(parent+path.sep))throw Error('Unsafe fixture cleanup');await fs.rm(dir,{recursive:true,force:true});}
}
test('package dry-run never writes prices; apply verifies reads and a repeated import skips unchanged data',()=>fixture(async f=>{
 const bundle=await loadQmtPackage(f.dir);
 assert.equal((await importQmtPackage(bundle,f.store,runtime)).totalBars,2);
 assert.equal(await f.store.read(runtime.importedBarsKey('sh600519')),null);
 const first=await importQmtPackage(bundle,f.store,runtime,{apply:true});assert.equal(first.imported,1);assert.equal(first.verified,1);assert.deepEqual(first.pendingSymbols,['hk00700']);
 const old=await f.store.read(runtime.importedBarsKey('sh600519'));
 const again=await importQmtPackage(bundle,f.store,runtime,{apply:true});assert.equal(again.unchanged,1);assert.equal(again.imported,0);
 assert.equal((await f.store.read(runtime.importedBarsKey('sh600519'))).acquiredAt,old.acquiredAt);
}));
test('tampered source files are rejected before any import',()=>fixture(async f=>{
 await fs.writeFile(path.join(f.dir,'raw/sh600519.json'),'{}');
 await assert.rejects(loadQmtPackage(f.dir),/校验失败/);assert.equal(await f.store.read(runtime.importedBarsKey('sh600519')),null);
}));
test('manifest paths cannot escape the package directory',()=>fixture(async f=>{
 f.manifest.stocks.sh600519.files['../outside.json']='a'.repeat(64);await fs.writeFile(path.join(f.dir,'manifest.json'),JSON.stringify(f.manifest));
 await assert.rejects(loadQmtPackage(f.dir),/路径/);
}));
test('source overlaps that disagree are quarantined without adding a new primary series',()=>fixture(async f=>{
 const bundle=await loadQmtPackage(f.dir),wrong=candles.map(c=>({...c,close:10.5}));
 const key='kline:v2:sh600519:day:none:tencent:prices-only';
 await f.store.write(marketRecord(key,'kline','tencent',{symbol:'sh600519',period:'day',adjust:'none',candles:wrong},60000),null);
 const result=await importQmtPackage(bundle,f.store,runtime,{apply:true});assert.equal(result.conflicts.length,1);assert.equal(result.imported,0);
 assert.equal(await f.store.read(runtime.importedBarsKey('sh600519')),null);
}));
