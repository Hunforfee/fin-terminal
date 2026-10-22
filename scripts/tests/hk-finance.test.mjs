import test from 'node:test';
import assert from 'node:assert/strict';
import {load} from './load-modules.mjs';
const hk=await load('datasource/hkFinance');
const {financeStorageKey}=await load('financePreferences');
const p=(date,kind,raw={},currency='HKD')=>({date,kind,label:kind,currency,raw});
test('HK current valuation uses one verified source snapshot and never invents dividends from DPS_HKD',()=>{
 const points=[p('2026-06-30','semi',{EPS_TTM:-1,BPS:20,DPS_HKD:2,DIVIDEND_RATE:99,PB_TTM:2,TOTAL_MARKET_CAP:4000,ISSUED_COMMON_SHARES:100})];
 const result=hk.summarizeHkSnapshot(points,'02714',{price:40,pe:12},'2026-10-16',5);
 assert.equal(result.pe,null);assert.equal(result.pb,2);assert.equal(result.dividendYield,null);
 assert.equal(result.marketComparison.pe,12);assert.equal(result.pePercentile,null);assert.deepEqual(result.history,[]);
 assert.equal(result.stats.dy.count,0);assert.ok(result.historyUnavailableReason);
});
test('HK trading currency alone cannot establish BPS or EPS currency; missing cross-currency metadata is not guessed',()=>{
 const points=[p('2026-06-30','semi',{EPS_TTM:10,BPS:50})];
 assert.equal(hk.summarizeHkSnapshot(points,'00700',{price:400,pe:99},'2026-10-16',5).pe,null);
 assert.equal(hk.summarizeHkSnapshot(points,'00700',{price:400,pe:99},'2026-10-16',5).pb,null);
 assert.equal(hk.summarizeHkSnapshot([{...points[0],currency:'CNY'}],'00700',{price:400,pe:99},'2026-10-16',5).pe,null);
});
test('HK fiscal year filtering retains March annual and September interim reports',()=>{
 const f={periods:['2025-09-30','2025-12-31','2026-03-31','2026-06-30'],periodLabels:['2025中报','2025Q3','2025年报','2026Q1'],periodKinds:{'2025-09-30':'semi','2025-12-31':'q3','2026-03-31':'annual','2026-06-30':'q1'},series:{eps:[1,2,3,4]}};
 assert.deepEqual(hk.filterHkPeriods(f,'annual').periods,['2026-03-31']);
 assert.deepEqual(hk.filterHkPeriods(f,'semi').periods,['2025-09-30','2026-03-31']);
 assert.deepEqual(hk.filterHkPeriods(f,'annual').series.eps,[3]);
});
test('HK report aliases are moved back to the true statement date and exact reports win',()=>{
 const rows=hk.parseHkStatementRows([{SECUCODE:'00700.HK',REPORT_DATE:'2026-06-30',STD_REPORT_DATE:'2026-03-31',STD_ITEM_CODE:'1',STD_ITEM_NAME:'资产总计',AMOUNT:999},{SECUCODE:'00700.HK',REPORT_DATE:'2026-03-31',STD_REPORT_DATE:'2026-03-31',STD_ITEM_CODE:'1',STD_ITEM_NAME:'资产总计',AMOUNT:100}]);
 assert.deepEqual(rows,[{date:'2026-03-31',itemCode:'1',itemName:'资产总计',amount:100}]);
});
test('a security whose STD dates all lag one period keeps its newest REPORT_DATE period',()=>{
 // 00016.HK 实测形态：全部行 STD 滞后一期，无 STD==REPORT 行，REPORT 集合含 STD 没有的最新期。
 const rows=hk.parseHkStatementRows([
   {SECUCODE:'00016.HK',REPORT_DATE:'2026-06-30',STD_REPORT_DATE:'2025-12-31',STD_ITEM_CODE:'004030999',ITEM_NAME:'股东权益',AMOUNT:633936000000},
   {SECUCODE:'00016.HK',REPORT_DATE:'2025-12-31',STD_REPORT_DATE:'2025-06-30',STD_ITEM_CODE:'004030999',ITEM_NAME:'股东权益',AMOUNT:633936000000},
 ]);
 const kept=rows.filter(r=>r.date==='2026-06-30');
 assert.equal(kept.length,1);assert.equal(kept[0].amount,633936000000);
 assert.equal(rows.filter(r=>r.date==='2025-12-31').length,1);
 // 混合场景：只要存在 STD==REPORT 行，仍按 STD 归位（个别挂错不改写整条链）
 const mixed=hk.parseHkStatementRows([
   {SECUCODE:'00700.HK',REPORT_DATE:'2026-06-30',STD_REPORT_DATE:'2025-12-31',STD_ITEM_CODE:'1',ITEM_NAME:'资产总计',AMOUNT:999},
   {SECUCODE:'00700.HK',REPORT_DATE:'2025-12-31',STD_REPORT_DATE:'2025-12-31',STD_ITEM_CODE:'1',ITEM_NAME:'资产总计',AMOUNT:100},
 ]);
 assert.deepEqual(mixed,[{date:'2025-12-31',itemCode:'1',itemName:'资产总计',amount:100}]);
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
test('HK cashflow grouped VALUE_LIST rows are flattened and the reported-currency report names are used',async()=>{
 const original=globalThis.fetch;const urls=[];
 globalThis.fetch=async url=>{urls.push(new URL(url).searchParams.get('reportName'));return new Response(JSON.stringify({success:true,result:{pages:1,data:[
   {REPORT_DATE:'2026-06-30 00:00:00',VALUE_LIST:[{SECUCODE:'00700.HK',STD_REPORT_DATE:'2026-06-30 00:00:00',STD_ITEM_CODE:'001001',ITEM_NAME:'除税前溢利',AMOUNT:39136000000,CURRENCY:'港元'},{SECUCODE:'00001.HK',STD_ITEM_CODE:'001001',ITEM_NAME:'其他证券',AMOUNT:1}]},
   {REPORT_DATE:'2025-12-31 00:00:00',VALUE_LIST:[{SECUCODE:'00700.HK',STD_REPORT_DATE:'2025-12-31 00:00:00',STD_ITEM_CODE:'001001',ITEM_NAME:'除税前溢利',AMOUNT:26607000000}]},
 ]}}),{status:200});};
 try{
   const rows=await hk.fetchHkStatement('00700.HK','cashflow',['2026-06-30','2025-12-31']);
   assert.equal(urls[0],'RPT_CUSTOM_HKSK_APPFN_CASHFLOW');
   assert.deepEqual(rows,[{date:'2026-06-30',itemCode:'001001',itemName:'除税前溢利',amount:39136000000},{date:'2025-12-31',itemCode:'001001',itemName:'除税前溢利',amount:26607000000}]);
 }finally{globalThis.fetch=original;}
});
