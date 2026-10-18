import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load-modules.mjs';
const { readResearchTable, compareResearchValues, defaultResearchTable, RESEARCH_TABLE_KEY } = await load('researchColumns');
const { isCloudKey, validateSnapshot, mergeGuestData } = await load('personalStorage');
const { migrateWatchlist, changeWatchlist, groupsFor, watchCodes, readWatchlist } = await load('watchlist');

test('custom columns retain order, sanitize unknown fields and hidden sorts, support explicit empty selection',()=>{
 assert.deepEqual(readResearchTable(null),defaultResearchTable());
 assert.deepEqual(readResearchTable({columns:['pb','pe','pb','unknown'],sort:{column:'pe',direction:'desc'}}),{columns:['pb','dy','pe'],sort:{column:'pe',direction:'desc'}});
 assert.deepEqual(readResearchTable({columns:[],sort:{column:'pe',direction:'asc'}}),{columns:['dy'],sort:null});
 assert.equal(readResearchTable({sort:{column:'pe',direction:'invalid'}}).sort,null);
 assert.deepEqual(readResearchTable({columns:[],sort:{column:'name',direction:'asc'}}).sort,{column:'name',direction:'asc'});
});
test('saved preferences without a dividend-yield column gain it right after PB, once',()=>{
 assert.deepEqual(readResearchTable({columns:['pe','pb','roe']}).columns,['pe','pb','dy','roe']);
 assert.deepEqual(readResearchTable({columns:['pe','pb','dy','roe']}).columns,['pe','pb','dy','roe']);
 assert.deepEqual(readResearchTable({columns:['roe']}).columns,['roe','dy']);
 assert.deepEqual(readResearchTable({columns:[]}).columns,['dy']);
 assert.ok(defaultResearchTable().columns.includes('dy'));
});
test('ascending and descending use numeric values including negatives and zero; absent data always sorts last',()=>{
 const source=[null,0,-211.69,56.65,13.43,NaN,undefined];
 for(const direction of ['asc','desc']) {
  const sorted=source.map(value=>({value})).sort((a,b)=>compareResearchValues(a.value,b.value,direction)).map(x=>x.value);
  assert.deepEqual(sorted.slice(0,4),direction==='asc'?[-211.69,0,13.43,56.65]:[56.65,13.43,0,-211.69]);
  assert.ok(sorted.slice(4).every(x=>x==null||Number.isNaN(x)));
 }
 assert.ok(compareResearchValues('2025-12-31','2026-06-30','asc')<0);
 assert.ok(compareResearchValues('2025-12-31','2026-06-30','desc')>0);
 assert.equal(compareResearchValues(null,3,'desc'),1);
});
test('column preferences and overlapping group memberships are accepted by account snapshots and guest merge',()=>{
 assert.ok(isCloudKey(RESEARCH_TABLE_KEY));
 const table=JSON.stringify({columns:['pb','pe'],sort:{column:'pe',direction:'desc'}});
 assert.ok(validateSnapshot({[RESEARCH_TABLE_KEY]:table}));
 const grouped=(id,name)=>changeWatchlist(changeWatchlist(migrateWatchlist(['600519']),{type:'createGroup',id,name}),{type:'setGroups',code:'600519',groupIds:[id]});
 const result=mergeGuestData({'fin-terminal.watchlist.v2':JSON.stringify(grouped('a','A'))},{'fin-terminal.watchlist.v2':JSON.stringify(grouped('b','B')),[RESEARCH_TABLE_KEY]:table});
 const state=readWatchlist(JSON.parse(result['fin-terminal.watchlist.v2']));
 assert.equal(groupsFor(state,'600519').length,2);assert.deepEqual(watchCodes(state),['sh600519']);assert.equal(result[RESEARCH_TABLE_KEY],table);
});
