import test from 'node:test';
import assert from 'node:assert/strict';
import {load} from './load-modules.mjs';
const hk=await load('datasource/hkFinance');
const {financeStorageKey}=await load('financePreferences');
const p=(date,kind,raw={},currency='HKD')=>({date,kind,label:kind,currency,raw});
test('HK current valuation uses matching currency and latest financial EPS; quote PE cannot override a loss',()=>{
 const points=[p('2026-06-30','semi',{EPS_TTM:-1,BPS:20,DPS_HKD:2,DIVIDEND_RATE:99})];
 const result=hk.summarizeHkSnapshot(points,'02714',{price:40,pe:12},'2026-10-16',5);
 assert.equal(result.pe,null);assert.equal(result.pb,2);assert.equal(result.dividendYield,5);
 assert.equal(result.marketComparison.pe,12);assert.equal(result.pePercentile,null);assert.deepEqual(result.history,[]);
 assert.equal(result.stats.dy.count,0);assert.ok(result.historyUnavailableReason);
});
test('HK EPS already standardized to HKD is not converted with current FX; unknown currency is not guessed',()=>{
 const points=[p('2026-06-30','semi',{EPS_TTM:10,BPS:50})];
 assert.equal(hk.summarizeHkSnapshot(points,'00700',{price:400,pe:99},'2026-10-16',5).pe,40);
 assert.equal(hk.summarizeHkSnapshot([{...points[0],currency:'CNY'}],'00700',{price:400,pe:99},'2026-10-16',5).pe,null);
});
test('HK fiscal year filtering retains March annual and September interim reports',()=>{
 const f={periods:['2025-09-30','2025-12-31','2026-03-31','2026-06-30'],periodLabels:['2025中报','2025Q3','2025年报','2026Q1'],periodKinds:{'2025-09-30':'semi','2025-12-31':'q3','2026-03-31':'annual','2026-06-30':'q1'},series:{eps:[1,2,3,4]}};
 assert.deepEqual(hk.filterHkPeriods(f,'annual').periods,['2026-03-31']);
 assert.deepEqual(hk.filterHkPeriods(f,'semi').periods,['2025-09-30','2026-03-31']);
 assert.deepEqual(hk.filterHkPeriods(f,'annual').series.eps,[3]);
});
test('HK report aliases are moved back to the true statement date and exact reports win',()=>{
 const rows=hk.parseHkStatementRows([{REPORT_DATE:'2026-06-30',STD_REPORT_DATE:'2026-03-31',STD_ITEM_CODE:'1',STD_ITEM_NAME:'资产总计',AMOUNT:999},{REPORT_DATE:'2026-03-31',STD_REPORT_DATE:'2026-03-31',STD_ITEM_CODE:'1',STD_ITEM_NAME:'资产总计',AMOUNT:100}]);
 assert.deepEqual(rows,[{date:'2026-03-31',itemCode:'1',itemName:'资产总计',amount:100}]);
});
test('HK and mainland saved modules/report fields cannot overwrite one another',()=>{
 assert.equal(financeStorageKey('fin.financeModules','600519'),'fin.financeModules');
 assert.equal(financeStorageKey('fin.financeModules','hk00700'),'fin.financeModules.hk');
 assert.equal(financeStorageKey('fin.mergeTable.fields','00700'),'fin.mergeTable.fields.hk');
});
test('HK statement pagination fetches every page instead of silently cutting long histories',async()=>{
 const original=globalThis.fetch;const pages=[];
 globalThis.fetch=async url=>{const page=Number(new URL(url).searchParams.get('pageNumber'));pages.push(page);return new Response(JSON.stringify({success:true,result:{pages:2,data:[{REPORT_DATE:`202${page}-12-31`,STD_ITEM_CODE:'1',STD_ITEM_NAME:'资产总计',AMOUNT:page*1e4}]}}),{status:200});};
 try{const rows=await hk.fetchHkStatement('00700.HK','balance',['2021-12-31','2022-12-31']);assert.deepEqual(pages,[1,2]);assert.equal(rows.length,2);}finally{globalThis.fetch=original;}
});
