import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { load } from './load-modules.mjs';
const {createFinancialRefreshes}=await load('financialDisplayRefresh');
test('refresh never executes before response; duplicate keys coalesce and capacity remains bounded',async()=>{
 const schedule=createFinancialRefreshes(1,2,1000),callbacks=[];
 let calls=0,active=0,max=0;
 const work=async()=>{calls++;active++;max=Math.max(max,active);await delay(10);active--;};
 const defer=fn=>callbacks.push(fn);
 assert.equal(schedule('a',defer,work).state,'pending');assert.equal(calls,0);
 assert.equal(schedule('a',defer,work).state,'pending');assert.equal(callbacks.length,1);
 schedule('b',defer,work);assert.equal(schedule('c',defer,work).state,'busy');
 await Promise.all(callbacks.map(fn=>fn()));assert.equal(calls,2);assert.equal(max,1);
 assert.equal(schedule('c',defer,work).state,'pending');
});
test('failed jobs expose the real error, cool down, and allow retry after cooldown',async()=>{
 let now=0;const schedule=createFinancialRefreshes(1,2,1000,()=>now),callbacks=[];
 const defer=fn=>callbacks.push(fn),fail=async()=>{throw Error('供应商 403');};
 schedule('a',defer,fail);await callbacks.shift()();
 assert.match(schedule('a',defer,fail).error,/403/);assert.equal(callbacks.length,0);
 now+=60001;assert.equal(schedule('a',defer,fail).state,'pending');
});
test('deadlines abort active network work and release the slot; failed defer does not leak capacity',async()=>{
 const schedule=createFinancialRefreshes(1,1,10),callbacks=[];
 const defer=fn=>callbacks.push(fn);
 schedule('a',defer,signal=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})));
 await callbacks.shift()();assert.match(schedule('a',defer,async()=>{}).error,/超时/);
 assert.equal(schedule('b',()=>{throw Error('no lifetime hook');},async()=>{}).state,'unavailable');
 assert.equal(schedule('b',defer,async()=>{}).state,'pending');await callbacks.shift()();
});
