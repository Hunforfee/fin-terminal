import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load-modules.mjs';
const { migrateWatchlist, readWatchlist, changeWatchlist, emptyWatchlist, groupNameError, UNGROUPED } = await load('watchlist');
const create = (state, id = 'core', name = '核心持仓') => changeWatchlist(state, { type: 'createGroup', id, name });
test('legacy migration preserves order, deduplicates symbols, keeps empty lists empty', () => {
 const s=migrateWatchlist(['600519','sh600519','00700','hk00700','000001','sz000001',null,'wrong']);
 assert.deepEqual(s.items.map(i=>i.symbol),['sh600519','hk00700','sh000001','sz000001']);
 assert.ok(s.items.every(i=>i.groupId===UNGROUPED));
 assert.deepEqual(migrateWatchlist([]).items,[]);
});
test('add and move preserve global order, avoid duplicates, and reject missing destinations', () => {
 let s=create(migrateWatchlist(['600519','00700']));
 s=changeWatchlist(s,{type:'add',code:'600415',groupId:'core'});
 s=changeWatchlist(s,{type:'add',code:'sh600519',groupId:'core'});
 assert.deepEqual(s.items.map(i=>i.symbol),['sh600519','hk00700','sh600415']);
 assert.equal(s.items[0].groupId,'core');
 s=changeWatchlist(s,{type:'move',codes:['00700','600415'],groupId:UNGROUPED});
 assert.ok(s.items.slice(1).every(i=>i.groupId===UNGROUPED));
 assert.strictEqual(changeWatchlist(s,{type:'add',code:'600000',groupId:'deleted'}),s);
 assert.strictEqual(changeWatchlist(s,{type:'move',codes:['600519'],groupId:'deleted'}),s);
});
test('group rename keeps assignments; dissolve keeps stocks and order; ungrouped is protected', () => {
 let s=create(migrateWatchlist(['600519','00700']));
 s=changeWatchlist(s,{type:'move',codes:['600519','00700'],groupId:'core'});
 s=changeWatchlist(s,{type:'renameGroup',id:'core',name:'  长期跟踪  '});
 assert.equal(s.groups[1].name,'长期跟踪');assert.ok(s.items.every(i=>i.groupId==='core'));
 s=changeWatchlist(s,{type:'deleteGroup',id:'core'});
 assert.deepEqual(s.items.map(i=>i.symbol),['sh600519','hk00700']);assert.ok(s.items.every(i=>i.groupId===UNGROUPED));
 assert.strictEqual(changeWatchlist(s,{type:'deleteGroup',id:UNGROUPED}),s);
 assert.strictEqual(changeWatchlist(s,{type:'renameGroup',id:UNGROUPED,name:'自定义'}),s);
});
test('same digits in different markets stay distinct; removing clears membership; re-add appends', () => {
 let s=create(migrateWatchlist(['sh000001','sz000001','00700']));
 s=changeWatchlist(s,{type:'move',codes:['sz000001'],groupId:'core'});
 s=changeWatchlist(s,{type:'remove',codes:['sh000001','hk00700']});
 assert.deepEqual(s.items,[{symbol:'sz000001',groupId:'core'}]);
 s=changeWatchlist(s,{type:'add',code:'00700',groupId:UNGROUPED});assert.equal(s.items[1].groupId,UNGROUPED);
 assert.equal(changeWatchlist(s,{type:'clear'}).items.length,0);
});
test('validate group names and sanitize corrupted persisted references without inventing holdings', () => {
 const s=create(emptyWatchlist());
 for(const name of ['', '  ', '核心持仓', ' 未分组 ', '全部自选', '长'.repeat(21)]) assert.ok(groupNameError(name,s.groups));
 assert.equal(groupNameError('核心持仓',s.groups,'core'),null);
 assert.equal(readWatchlist({version:1,groups:[],items:[]}),null);
 const loaded=readWatchlist({...s,items:[{symbol:'600519',groupId:'missing'},{symbol:'sh600519',groupId:'core'},{symbol:'bad',groupId:'core'},null]});
 assert.deepEqual(loaded.items,[{symbol:'sh600519',groupId:UNGROUPED}]);
 assert.deepEqual(readWatchlist(emptyWatchlist()).items,[]);
});
