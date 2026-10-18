import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load-modules.mjs';
const { parseImportTables, textImportTable, decodeImportText, readImportFile, uniqueImportRows, MAX_IMPORT_ROWS } = await load('watchlistImport');
const { migrateWatchlist, changeWatchlist } = await load('watchlist');
const parse = (content, market = 'auto') => parseImportTables([textImportTable(content)], market);
const symbols = rows => rows.map(row => row.symbol);
const file = (name, buffer) => ({name,size:buffer.byteLength,arrayBuffer:async()=>buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength)});

test('THS table headers isolate codes from price, count and market-cap columns', () => {
 const rows=parse('同花顺导出数据\n序号\t股票代码\t股票名称\t最新价\t总市值\n1\t600519\t贵州茅台\t600415\t000858\n2\t000001\t平安银行\t11.00\t600519\n数据来源：同花顺');
 assert.deepEqual(symbols(rows),['sh600519','sz000001']);assert.equal(rows[0].name,'贵州茅台');assert.equal(rows[0].row,3);
});
test('CSV quoting, Excel text wrappers, CRLF, aliases and HK preserve identity', () => {
 assert.deepEqual(symbols(parse('证券代码,证券名称\r\n="000001","平安,银行"\r\n600519.SH,贵州茅台\r\n00700,腾讯控股\r\nhk09988,阿里巴巴\r\n920123,北交股票')),
 ['sz000001','sh600519','hk00700','hk09988','bj920123']);
 assert.deepEqual(symbols(parse('代码\t名称\n沪600519\t贵州茅台\nSZSE.000001\t平安银行\nHKEX.00700\t腾讯控股')),['sh600519','sz000001','hk00700']);
 assert.throws(()=>parse('代码,名称\n600519,"未闭合'),/引号/);
});
test('ambiguous short codes require a market, per-row explicit exchanges take precedence', () => {
 const tables=[{source:'Excel',rows:[['代码','名称'],[1,'平安银行'],[700,'腾讯控股']]}];
 assert.ok(parseImportTables(tables).every(row=>row.symbol===null));
 assert.equal(parseImportTables(tables,'A')[0].symbol,'sz000001');assert.equal(parseImportTables(tables,'HK')[1].symbol,'hk00700');
 assert.deepEqual(symbols(parse('代码\t名称\t市场\n1\t平安银行\t深圳\n700\t腾讯控股\t香港','A')),['sz000001','hk00700']);
 assert.equal(parse('sh600519\t贵州茅台','HK')[0].symbol,'sh600519');
});
test('never find codes inside prices, dates, names or unsupported instrument rows', () => {
 for(const value of ['2026-10-18','600519.25','abc600519','600519abc','AAPL','1.23456E+5']) assert.equal(parse(value)[0].symbol,null,value);
 assert.equal(parse('代码\t名称\n510300\t沪深300ETF')[0].symbol,null);
 assert.equal(parse('代码\t名称\n000001\t上证指数')[0].symbol,null);
 assert.equal(parse('代码\t名称\n123456\t某债券')[0].symbol,null);
 assert.equal(parse('代码\t名称\n\t600519')[0].symbol,null);
});
test('plain lists and numbered table rows work; duplicate symbols across files merge in order', () => {
 const tables=[textImportTable('600519 000001\n1 00700 腾讯控股\nsh600519') ,textImportTable('600519.SH\n600415')];
 const result=uniqueImportRows(parseImportTables(tables));assert.deepEqual(symbols(result.candidates),['sh600519','sz000001','hk00700','sh600415']);assert.equal(result.duplicates,2);
});
test('UTF-8 BOM, GBK, UTF-16 LE and BE retain Chinese headers and stock names', () => {
 const gbk=Buffer.concat([Buffer.from('B4FAC2EB09C3FBB3C60D0A','hex'),Buffer.from('600519\t'),Buffer.from('B9F3D6DDC3A9CCA8','hex')]);
 assert.equal(parse(decodeImportText(gbk))[0].name,'贵州茅台');
 const content='代码\t名称\n000001\t平安银行';
 for(const data of [Buffer.from('\uFEFF'+content),Buffer.concat([Buffer.from([255,254]),Buffer.from(content,'utf16le')]),Buffer.concat([Buffer.from([254,255]),Buffer.from(content,'utf16le').swap16()])]) assert.equal(parse(decodeImportText(data))[0].symbol,'sz000001');
});
test('XLSX and legacy XLS numeric cells with 000000 formatting keep leading zeros', async () => {
 const XLSX=await import('xlsx');XLSX.set_cptable(await import('xlsx/dist/cpexcel.full.mjs'));
 for(const bookType of ['xlsx','biff8','biff5']){
  // SheetJS writes BIFF5 strings as ASCII; use supported writer fixtures for
  // that legacy container, and verify Chinese names in BIFF8/XLSX above it.
  const sheet=XLSX.utils.aoa_to_sheet(bookType==='biff5'?[['code','name'],[1,'Ping An'],['00700','Tencent'],[600519,'Moutai']]:[['股票代码','股票名称'],[1,'平安银行'],['00700','腾讯控股'],[600519,'贵州茅台']]);sheet.A2.z='000000';
  const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,sheet,'自选股');
  const data=XLSX.write(book,{type:'buffer',bookType,codepage:936});
  const tables=await readImportFile(file(bookType==='xlsx'?'同花顺.xlsx':'同花顺.xls',data));
  assert.deepEqual(symbols(parseImportTables(tables)),['sz000001','hk00700','sh600519']);
 }
});
test('HTML tables named XLS and TSV named XLS are read as exported data', async () => {
 const html='<html><meta charset="utf-8"><table><tr><td>代码</td><td>名称</td></tr><tr><td>600519</td><td>贵州茅台</td></tr><tr><td>000001</td><td>平安银行</td></tr><tr><td>00700</td><td>腾讯控股</td></tr></table></html>';
 assert.deepEqual(symbols(parseImportTables(await readImportFile(file('export.xls',Buffer.from(html))))),['sh600519','sz000001','hk00700']);
 assert.equal(parseImportTables(await readImportFile(file('export.xls',Buffer.from('代码\t名称\n600519\t贵州茅台'))))[0].symbol,'sh600519');
});
test('reject unsupported, oversized and malformed files; never silently truncate rows', async () => {
 await assert.rejects(readImportFile(file('file.exe',Buffer.from('600519'))),/请选择/);
 await assert.rejects(readImportFile({name:'large.csv',size:6000000,arrayBuffer:async()=>{throw Error('must not read')}}),/5 MB/);
 await assert.rejects(readImportFile(file('bad.xlsx',Buffer.from('600519'))),/有效/);
 assert.throws(()=>parseImportTables([{source:'large',rows:Array.from({length:MAX_IMPORT_ROWS+1},()=>['600519'])}]),/最多导入/);
});
test('bulk import is atomic, default skips existing assignments and preserves global order', () => {
 let state=migrateWatchlist(['600519','00700']);
 state=changeWatchlist(state,{type:'import',codes:['600519','600415','600415','000858'],groupId:'new',moveExisting:false,newGroup:{id:'new',name:'导入分组'}});
 assert.deepEqual(state.items.map(item=>[item.symbol,item.groupId]),[['sh600519','ungrouped'],['hk00700','ungrouped'],['sh600415','new'],['sz000858','new']]);
 state=changeWatchlist(state,{type:'import',codes:['600519','600415'],groupId:'new',moveExisting:true});assert.equal(state.items[0].groupId,'new');assert.equal(state.items.length,4);
 assert.strictEqual(changeWatchlist(state,{type:'import',codes:['600519'],groupId:'missing',moveExisting:true}),state);
 assert.strictEqual(changeWatchlist(state,{type:'import',codes:['600519'],groupId:'duplicate',moveExisting:true,newGroup:{id:'duplicate',name:'导入分组'}}),state);
});
