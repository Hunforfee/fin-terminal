import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load-modules.mjs';
const { createSecurityDirectory, DIRECTORY_KEY } = await load('securityDirectory');
const { marketRecord } = await load('marketStore');
const hit = (symbol,name,kind='stock') => ({symbol,name,kind,code:symbol.slice(2),market:symbol.startsWith('hk')?'HK':symbol.startsWith('sh')?'SH':'SZ'});
function fake(initial) {
 let row=initial,reads=0,writes=0;
 return {get reads(){return reads;},get row(){return row;},get writes(){return writes;},
  async read(){reads++;return row;},async write(next,expected){writes++;if((row?.digest??null)!==expected)return false;row=next;return true;},async incident(){}};
}
test('cold directory seeds both A and HK; name/code/full pinyin/initials work without financial records',async()=>{
 const store=fake(null),directory=createSecurityDirectory(()=>store);
 for(const keyword of ['600519','贵州茅台','guizhoumaotai','gzmt'])assert.ok((await directory.search(keyword)).some(r=>r.symbol==='sh600519'));
 assert.ok((await directory.search('腾讯')).some(r=>r.symbol==='hk00700'));
 assert.ok((await directory.search('00700')).some(r=>r.symbol==='hk00700'));
 assert.ok(store.row.payload.filter(r=>r.market==='HK').length>2500);
 assert.ok(store.row.payload.filter(r=>r.market!=='HK'&&r.kind==='stock').length>5000);
 assert.equal(store.writes,1);assert.equal(store.reads,2);
});
test('database names win and concurrent queries share one read; colliding index/stock codes remain distinct',async()=>{
 const rows=[hit('sz000001','平安银行'),hit('sh000001','上证指数','index'),hit('hk00700','腾讯新名称')];
 const store=fake(marketRecord(DIRECTORY_KEY,'security-directory','test',rows,1000));
 const directory=createSecurityDirectory(()=>store);
 const results=await Promise.all(Array.from({length:8},()=>directory.search('000001')));
 assert.equal(store.reads,1);assert.equal(results[0].length,2);
 assert.equal((await directory.search('00700'))[0].name,'腾讯新名称');
});
test('discovered securities persist; optimistic retries re-read and merge other writers',async()=>{
 let row=marketRecord(DIRECTORY_KEY,'security-directory','test',[hit('sh600519','贵州茅台')],1000),attempts=0;
 const store={async read(){return row;},async write(next){if(!attempts++){row=marketRecord(DIRECTORY_KEY,'security-directory','other',[...row.payload,hit('hk00700','腾讯控股')],1000);return false;}row=next;return true;}};
 const directory=createSecurityDirectory(()=>store);
 await directory.remember([hit('sz000001','平安银行')]);
 assert.equal(row.payload.length,3);assert.equal((await directory.search('pinganyinhang'))[0].symbol,'sz000001');
});
test('storage outage uses baseline and never accepts malformed directory writes',async()=>{
 const directory=createSecurityDirectory(()=>({async read(){throw Error('offline');}}));
 assert.ok((await directory.search('腾讯')).some(r=>r.symbol==='hk00700'));
 await directory.remember([]);
});
test('another process updating the directory is visible after the memory refresh interval',async()=>{
 let row=marketRecord(DIRECTORY_KEY,'security-directory','test',[hit('hk00700','旧名称')],1000);
 const directory=createSecurityDirectory(()=>({async read(){return row;}}));
 const original=Date.now;let now=original();
 try {
  Date.now=()=>now;
  assert.equal((await directory.search('00700'))[0].name,'旧名称');
  row=marketRecord(DIRECTORY_KEY,'security-directory','test',[hit('hk00700','新名称')],1000);
  now+=60001;
  assert.equal((await directory.search('00700'))[0].name,'新名称');
 }finally{Date.now=original;}
});
