import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load-modules.mjs';
const {createSession,readSession,normalizePhone,maskPhone,sameOriginMutation,SESSION_SECONDS}=await load('auth/session');
const {allowAttempt}=await load('auth/limits');
const {phoneLoginConfigured,sendPhoneCode,verifyPhoneCode}=await load('auth/phoneProvider');
const {personalStorage,setStorageAccount,storageKey,snapshotFor,applySnapshot,mergeSnapshots,snapshotsEqual,validateSnapshot,mergeGuestData}=await load('personalStorage');
const {migrateWatchlist,changeWatchlist}=await load('watchlist');
const secret='test-only-session-secret-012345678901234567890',user={id:'account-a',phone:'138****0000'};
test('only signed unexpired sessions establish an identity; phone is masked',()=>{
 const now=1700000000000,token=createSession(user,secret,now);
 assert.deepEqual(readSession(token,secret,now+1000),user);
 assert.equal(readSession(token,secret,now+SESSION_SECONDS*1000),null);
 assert.equal(readSession(token,'other-secret-012345678901234567890123456'),null);
 assert.equal(readSession(token+'x',secret,now),null);
 assert.equal(readSession('bad.'+token.split('.')[1],secret,now),null);
 assert.equal(readSession(token,null,now),null);assert.equal(readSession(token,'short',now),null);
 assert.throws(()=>createSession({id:'a',phone:'13800000000'},secret),/无效/);
 assert.throws(()=>createSession(user,'weak'),/密钥/);
 assert.equal(normalizePhone('+86 138-0000-0000'),'13800000000');assert.equal(normalizePhone('008613800000000'),'13800000000');
 assert.equal(normalizePhone('12800000000'),null);assert.equal(maskPhone('13800000000'),'138****0000');
});
test('cross-origin and missing CSRF headers are rejected, proxy origin is explicit',()=>{
 const req=(origin,csrf='1',site='same-origin')=>new Request('https://app.example/api/account/data',{method:'PUT',headers:{...(origin?{origin}:{}),'x-fin-csrf':csrf,'sec-fetch-site':site}});
 assert.equal(sameOriginMutation(req('https://app.example'),''),true);
 assert.equal(sameOriginMutation(req('https://evil.example'),''),false);
 assert.equal(sameOriginMutation(req('https://app.example',''),''),false);
 assert.equal(sameOriginMutation(req(null),''),false);
 assert.equal(sameOriginMutation(req('https://app.example','1','cross-site'),''),false);
 assert.equal(sameOriginMutation(req('https://public.example'),'https://public.example'),true);
 assert.equal(sameOriginMutation(new Request('http://0.0.0.0:3101/api/account/data',{method:'PUT',headers:{host:'127.0.0.1:3101',origin:'http://127.0.0.1:3101','x-fin-csrf':'1'}}),''),true);
});
test('rate guards expire and fail closed at the attempt limit',()=>{
 assert.equal(allowAttempt('unit-phone',2,60000,1000),true);assert.equal(allowAttempt('unit-phone',2,60000,1001),true);assert.equal(allowAttempt('unit-phone',2,60000,1002),false);assert.equal(allowAttempt('unit-phone',2,60000,61000),true);
});
test('unintegrated phone service cannot send or verify any fixed OTP',async()=>{
 assert.equal(phoneLoginConfigured(),false);
 await assert.rejects(sendPhoneCode('13800000000'),/短信服务未配置/);
 for(const code of ['000000','123456','888888'])await assert.rejects(verifyPhoneCode('13800000000',code),/短信服务未配置/);
});
test('guest and two accounts have independent cache keys; credentials never enter a cloud snapshot',()=>{
 const memory=new Map();globalThis.window={localStorage:{get length(){return memory.size},key:i=>[...memory.keys()][i]??null,getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,String(v)),removeItem:k=>memory.delete(k)},dispatchEvent:()=>{}};
 try{
  setStorageAccount(null);personalStorage.setItem('fin.research.notes.v1','["guest"]');
  setStorageAccount('account-a');assert.equal(personalStorage.getItem('fin.research.notes.v1'),null);personalStorage.setItem('fin.research.notes.v1','["a"]');personalStorage.setItem('fin.ai.key','private-key');
  setStorageAccount('account-b');assert.equal(personalStorage.getItem('fin.research.notes.v1'),null);personalStorage.setItem('fin.research.notes.v1','["b"]');
  assert.deepEqual(snapshotFor('account-a'),{'fin.research.notes.v1':'["a"]'});assert.deepEqual(snapshotFor('account-b'),{'fin.research.notes.v1':'["b"]'});assert.deepEqual(snapshotFor(null),{'fin.research.notes.v1':'["guest"]'});
  assert.notEqual(storageKey('x','account-a'),storageKey('x','account-b'));
  applySnapshot('account-a',{'fin.ai.prompt':'my prompt'});assert.equal(window.localStorage.getItem(storageKey('fin.ai.key','account-a')),'private-key');assert.equal(window.localStorage.getItem(storageKey('fin.research.notes.v1','account-a')),null);
 }finally{setStorageAccount(null);delete globalThis.window;}
});
test('three-way merge preserves independent changes and reports same-key conflicts, including deletions',()=>{
 const a='fin.research.notes.v1',b='fin.ai.prompt';
 assert.deepEqual(mergeSnapshots({[a]:'old',[b]:'old'},{[a]:'local',[b]:'old'},{[a]:'old',[b]:'remote'}),{data:{[a]:'local',[b]:'remote'},conflicts:[]});
 assert.deepEqual(mergeSnapshots({[a]:'old'},{[a]:'local'},{[a]:'remote'}).conflicts,[a]);
 assert.deepEqual(mergeSnapshots({[a]:'old'},{},{[a]:'remote'}).conflicts,[a]);
 assert.deepEqual(mergeSnapshots({[a]:'old'},{},{[a]:'old'}),{data:{},conflicts:[]});
 assert.equal(snapshotsEqual({[a]:'1',[b]:'2'},{[b]:'2',[a]:'1'}),true);
});
test('cloud schema rejects tokens, unknown keys, oversized data and invalid snapshots',()=>{
 assert.equal(validateSnapshot({'fin.ai.key':'secret'}),null);assert.equal(validateSnapshot({'userId':'other'}),null);assert.equal(validateSnapshot({'fin.research.notes.v1':'broken json'}),null);
 assert.equal(validateSnapshot({'fin.ai.prompt':'a'.repeat(500001)}),null);
 assert.equal(validateSnapshot({'fin-terminal.watchlist.v2':'{}'}),null);
 assert.ok(validateSnapshot({'fin.ai.prompt':'plain prompt','fin.research.notes.v1':'[]','fin.financeModules.active.hk':'custom-id'}));
});
test('explicit guest import merges groups and notes without overwriting account assignments or copying secrets',()=>{
 let own=changeWatchlist(migrateWatchlist(['600519']),{type:'createGroup',id:'core',name:'Core'});own=changeWatchlist(own,{type:'move',codes:['600519'],groupId:'core'});
 let guest=changeWatchlist(migrateWatchlist(['600519','00700']),{type:'createGroup',id:'guest-core',name:'core'});guest=changeWatchlist(guest,{type:'move',codes:['600519','00700'],groupId:'guest-core'});
 const result=mergeGuestData({'fin-terminal.watchlist.v2':JSON.stringify(own),'fin.research.notes.v1':JSON.stringify([{id:'n',text:'own'}]),'fin.ai.prompt':'own prompt'},{'fin-terminal.watchlist.v2':JSON.stringify(guest),'fin.research.notes.v1':JSON.stringify([{id:'n',text:'guest'},{id:'new',text:'imported'}]),'fin.ai.prompt':'guest prompt','fin.ai.key':'secret'});
 const state=JSON.parse(result['fin-terminal.watchlist.v2']);assert.deepEqual(state.items,[{symbol:'sh600519',groupId:'core'},{symbol:'hk00700',groupId:'core'}]);assert.equal(state.groups.length,2);assert.equal(result['fin.ai.prompt'],'own prompt');assert.equal(result['fin.ai.key'],undefined);assert.deepEqual(JSON.parse(result['fin.research.notes.v1']).map(n=>n.text),['own','imported']);
});
