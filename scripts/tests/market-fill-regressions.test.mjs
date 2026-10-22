import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { load } from './load-modules.mjs';

const market = await load('marketStore'), hk = await load('marketHkImportRecords');
const statements = await load('marketHkStatements'), events = await load('datasource/hkDividends');
const gaps = await load('marketFillGaps'), codes = await load('datasource/codes');
const { MarketUpdateQueue } = await load('marketUpdateQueue');
const { mergeHkDividendEvents } = await load('hkDividendEvents');
const now = Date.parse('2026-10-22T08:00:00Z');
function memory() {
  const data = new Map();
  return { data, read: async key => structuredClone(data.get(key) ?? null),
    async write(row, expected) { if ((data.get(row.key)?.digest ?? null) !== expected) return false; data.set(row.key, structuredClone(row)); return true; },
    remove: async key => data.delete(key), incident: async () => {},
    seed(key, kind, payload) { data.set(key, market.marketRecord(key, kind, 'test', payload, 1e8, now)); },
  };
}
function compile(file, require, globals = {}) {
  const exported = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }, fileName: file,
  }).outputText, { exports: exported, require, console, Date, Error, Buffer, Headers, TextDecoder,
    AbortController, setTimeout, clearTimeout, setInterval, clearInterval, ...globals });
  return exported;
}

for (const running of [false, true]) test(`stopping one subscriber preserves shared ${running ? 'running' : 'queued'} work`, async () => {
  const s = memory(), q = new MarketUpdateQueue(s, () => now);
  await q.submit('alice', ['hk00700'], false, 'five-year');
  await q.submit('bob', ['hk00700'], false, 'five-year');
  let task = running ? await q.claim() : null;
  const cancelled = await q.cancel('alice');
  assert.equal(cancelled.finished, true); assert.equal(cancelled.failed, 1);
  assert.equal((await q.status('bob')).failed, 0);
  if (!task) task = await q.claim();
  assert.equal(await q.renew(task.symbol, task.lease), true);
  assert.equal(await q.finish(task.symbol, task.lease), true);
  assert.equal((await q.status('bob')).done, 1);
  assert.equal((await q.status('alice')).failed, 1, 'cancelled owner result stays immutable');
});

test('source and imported identities count one cash dividend once, preserving a same-day special', async () => {
  const s = memory(), key = 'hk-dividend-events-v4:hk00016';
  const native = events.parseHkDividends([{ SECURITY_CODE: '00016', ASSIGN_PERIOD: '2026年中期',
    EX_DIVIDEND_DATE: '2026-09-01', NOTICE_DATE: '2026-08-20', ASSIGN_PROGRESS: '已实施', PLAN_EXPLAIN: '每股派0.5港元' }], '2026-10-22');
  s.seed(key, 'hk-recent-dividend-events', native);
  const row = { exDate: '2026-09-01', noticeDate: '2026-08-20', dps: 0.5, period: '2026年中期', special: false };
  for (const identity of [undefined, 'mcp-other-provider-id']) await hk.writeHkDividendEvents(s, { symbol: 'hk00016', rows: [{ ...row, eventId: identity }] }, now);
  let saved = (await s.read(key)).payload;
  assert.equal(saved.length, 1); assert.equal(events.sumRollingTtmDividend(saved, '2026-10-22').ttmDps, 0.5);
  await hk.writeHkDividendEvents(s, { symbol: 'hk00016', rows: [{ ...row, special: true, kind: 'special' }] }, now);
  saved = (await s.read(key)).payload;
  assert.equal(saved.length, 2); assert.equal(events.sumRollingTtmDividend(saved, '2026-10-22').ttmDps, 1);
  await assert.rejects(hk.writeHkDividendEvents(s, { symbol: 'hk00016', rows: [{ ...row, dps: 0.6 }] }, now), /冲突/);
});

test('refreshing an imported dividend uses the same identity and preserves known DPS', async () => {
  const { storedMarketInput } = await load('marketInputs');
  const s = memory(), key = 'hk-dividend-events-v4:hk00016';
  const prior = { exDate: '2026-09-01', noticeDate: '2026-08-20', dps: 0.5, period: '2026中期', special: false, eventId: 'import-id' };
  s.data.set(key, market.marketRecord(key, 'hk-recent-dividend-events', 'import', [prior], -1));
  const rows = await storedMarketInput(key, 'hk-recent-dividend-events', 'source', 1000,
    async () => [{ ...prior, eventId: 'source-id', dps: null }], () => {}, s);
  assert.equal(rows.length, 1); assert.equal(rows[0].dps, 0.5);
});

test('uncertain events are not collapsed and special cash is not erased by a null patch',()=>{
  const a={exDate:'2026-09-01',noticeDate:'2026-08-20',period:'2026分配',special:false,kind:'unknown',dps:0.5};
  assert.equal(mergeHkDividendEvents([a],[{...a,dps:0.7}]).length,2,'different unknown components need their own facts');
  const special={...a,period:'2026特别分红',special:true,kind:'special'};
  const patched=mergeHkDividendEvents([special],[{...special,dps:null}]);
  assert.equal(patched.length,1);assert.equal(patched[0].dps,0.5);
});

function coverageCollector(s) {
  let collection;
  collection = compile('src/lib/marketHistoryCollection.ts', name => {
    if (name === './marketStore') return { getMarketStore: () => s, marketRecord: market.marketRecord };
    if (name === './datasource') return { getKLine: async () => ({ candles: [{ date: collection.fiveYearStart(), close: 10 }, { date: '2026-10-21', close: 10 }], source: 'test' }), getValuation: async () => ({ history: [] }) };
    if (name === './datasource/codes') return codes;
    if (name === './marketImportedBars') return { importedBarsKey: symbol => 'bars:' + symbol };
    if (name === './marketSecurityBasics') return { securityBasicsKey: symbol => 'basics:' + symbol };
    if (name === './marketUpdateContext') return { withUpstreamBudget: (_b, read) => read() };
    if (name === './upstreamBudget') return { UpstreamBudget: class {} };
    if (name === './datasource/hkFinance') return { fetchHkIndicatorPoints: async () => [{ date: '2026-06-30', kind: 'semi' }] };
    if (name === './marketFillGaps') return gaps;
    if (name === './marketHkStatements') return statements;
    return {};
  });
  return collection;
}
test('partial or all-null imported statements never satisfy the reader or readiness gate', async () => {
  const s = memory(), date = '2026-06-30';
  for (const statement of ['balance','profit','cashflow']) await hk.writeHkStatements(s, { symbol: 'hk00016', statement,
    rows: [{ date, itemCode: 'X', itemName: '未知', amount: null }] }, now);
  const reader = compile('src/lib/datasource/hkFinance.ts', name => {
    if (name === '../marketStore') return { getMarketStore: () => s };
    if (name === '../marketReadPolicy') return { databaseOnly: () => true, marketDataMissing: () => Error('missing') };
    if (name === '../marketRetention') return { retainedDate: () => true };
    if (name === '../marketHkStatements') return statements;
    return {};
  });
  await assert.rejects(reader.fetchHkStatement('00016.HK','balance',[date]), /missing/);
  for (const key of ['source-hk-indicators:v1:00016.HK','watchlist-financial-inputs:v1:hk00016','hk-main-currency-v4:hk00016','hk-dividend-events-v4:hk00016']) s.seed(key, 'test', {});
  const collection = coverageCollector(s);
  await assert.rejects(collection.collectHistoryPhase('hk00016',12,new AbortController().signal), /已保存可用数据/);
  const checked = (await s.read(collection.coverageKey('hk00016'))).payload;
  assert.equal(checked.status, 'partial'); assert.equal(checked.missingInputs.length, 3);
  for (const statement of ['balance','profit','cashflow']) {
    const rows = [{ date, itemCode: 'X', itemName: '项目一', amount: 100 },{ date, itemCode: 'Y', itemName: '项目二', amount: 50 }];
    await hk.writeHkStatements(s, { symbol:'hk00016', statement, rows, completeReports:[{date,itemCodes:['X','Y']}] }, now);
  }
  await collection.collectHistoryPhase('hk00016',12,new AbortController().signal);
  assert.equal((await s.read(collection.coverageKey('hk00016'))).payload.status, 'ready');
  assert.equal(await gaps.readFillGap(s, 'hk00016'), null);
});

test('a complete-report declaration requires the entire declared inventory and actual amounts', async () => {
  const s = memory(), date = '2026-06-30', row = { date, itemCode:'X',itemName:'项目',amount:null };
  await assert.rejects(hk.writeHkStatements(s,{symbol:'hk00016',statement:'balance',rows:[row],completeReports:[{date,itemCodes:['X']}]},now),/有效金额/);
  await assert.rejects(hk.writeHkStatements(s,{symbol:'hk00016',statement:'balance',rows:[{...row,amount:1}],completeReports:[{date,itemCodes:['X','Y']}]},now),/清单不匹配/);
  assert.equal(s.data.size,0);
  s.seed('legacy','source-hk-statement',[{...row,amount:1}]);
  assert.equal(statements.completeHkStatement(await s.read('legacy'),date),false,'legacy imports have no verified full scope');
});

test('gap persistence and compare-and-swap failures never report successful clearing', async () => {
  const s = memory(), classification = { mcp:['kline'],manual:[],notes:[] };
  await gaps.applyGapClassification(s,'hk00016',classification,{},now);
  s.remove = async () => false;
  await assert.rejects(gaps.applyGapClassification(s,'hk00016',null),/版本冲突/);
  s.write = async () => false;
  await assert.rejects(gaps.applyGapClassification(s,'hk00016',classification),/版本冲突/);
  assert.ok(await gaps.readFillGap(s,'hk00016'));
});

test('resolve returns an error when partial coverage cannot be persisted', async () => {
  const route = compile('src/app/api/market/gaps/resolve/route.ts', name => {
    if (name==='next/server') return { NextResponse:{json:(body,o)=>({body,status:o?.status??200})} };
    if (name==='@/lib/marketStore') return { getMarketStore:()=>({read:async()=>({payload:{status:'partial',missingInputs:['hk-dividend-events-v4:hk00016']}})}) };
    if (name==='@/lib/marketImportAuth') return {denyReason:()=>null,readImportIdentity:()=>({userId:'test'})};
    if (name==='@/lib/marketHistoryCollection') return {coverageKey:s=>s,collectHistoryPhase:async()=>{throw Error('已保存可用数据；缺失');}};
    if (name==='@/lib/marketFillGaps') return {...gaps,applyGapClassification:async()=>{throw Error('database failure');},readFillGap:async()=>null};
    if (name==='@/lib/datasource/codes') return codes;
    throw Error(name);
  });
  const response = await route.POST({text:async()=>JSON.stringify({symbols:['hk00016']})});
  assert.equal(response.body.cleared,0); assert.equal(response.body.resolved[0].status,'error');
});

test('single-stock fill does not replace automatic subscriptions', async () => {
  let registrations=0;
  const route = compile('src/app/api/market-updates/route.ts', name => {
    if(name==='next/server')return {NextResponse:{json:(body,o)=>({body,status:o?.status??200})}};
    if(name==='@/lib/marketStore')return {getMarketStore:()=>({})};
    if(name==='@/lib/marketCollection')return {registerCollection:async()=>{registrations++;}};
    if(name==='@/lib/marketUpdateAuth')return {localUpdatePreview:()=>false,updateIdentity:async()=>({owner:'alice'})};
    if(name==='@/lib/auth/session')return {sameOriginMutation:()=>true};
    if(name==='@/lib/marketUpdateQueue')return {updateSymbols:v=>v,UpdateQueueError:class extends Error{},MarketUpdateQueue:class{async submit(){return {id:'job'};}}};
    throw Error(name);
  },{process:{env:{MARKET_UPDATE_WORKER_ENABLED:'1',MARKET_UPDATE_WORKER_TOKEN:'x'.repeat(40),MARKET_DATABASE_URL:'test'}}});
  const body=JSON.stringify({single:true,codes:['hk00016']});
  const response=await route.POST({headers:new Headers(),body:new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(body));c.close();}})});
  assert.equal(response.status,200);assert.equal(registrations,0);
});

function stockButton(fetch) {
  const state=[],effects=[],timers=new Map();let index=0,id=0;
  const router={refresh(){}};
  const component=compile('src/components/StockFillButton.tsx',name=>{
    if(name==='react')return {
      useState(initial){const i=index++;if(!(i in state))state[i]=initial;return [state[i],v=>{state[i]=typeof v==='function'?v(state[i]):v;}];},
      useRef(initial){const i=index++;if(!(i in state))state[i]={current:initial};return state[i];},useEffect(fn){effects.push(fn);},
    };
    if(name==='react/jsx-runtime')return {Fragment:'fragment',jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
    if(name==='next/navigation')return {useRouter:()=>router};
    if(name==='@/lib/datasource/codes')return codes;
    throw Error(name);
  },{fetch,setTimeout(fn,ms){const key=++id;timers.set(key,{fn,ms});return key;},clearTimeout(key){timers.delete(key);}});
  const render=()=>{index=0;return component.default({code:'hk00016',name:'新鸿基地产'});};
  return {render,effects,timers,label:()=>render().props.children[0].props.children[1],async tick(ms){const [key,timer]=[...timers].find(([,t])=>t.ms===ms)??[];assert.ok(timer,`missing timer ${ms}`);timers.delete(key);await timer.fn();}};
}
const progress=(id,finished,failed=0)=>({id,finished,total:1,done:finished&&!failed?1:0,failed,skipped:0,errors:failed?[{symbol:'hk00016',message:'数据缺失'}]:[]});
const response=data=>({ok:true,json:async()=>({ok:true,data})});
test('the stock button never labels a failed result as completed',async()=>{
  const button=stockButton(async()=>response(progress('job',true,1)));
  button.render().props.children[0].props.onClick();await new Promise(r=>setImmediate(r));
  assert.equal(button.label(),'补齐失败');
  assert.match(button.render().props.children[0].props.title,/数据缺失/);
});
test('the stock button keeps polling and can finish a second task on the same mount',async()=>{
  let gets=0;
  const button=stockButton(async(_url,o)=>response(o.method==='POST'?progress('second',false):progress(++gets>2?'second':'first',gets>1)));
  button.render();button.effects[0]();await new Promise(r=>setImmediate(r));
  await button.tick(5000);assert.equal(button.label(),'已补齐');
  await button.tick(8000);
  button.render().props.children[0].props.onClick();await new Promise(r=>setImmediate(r));
  assert.match(button.label(),/补齐中/);
  await button.tick(30000);assert.equal(button.label(),'已补齐');
  assert.ok([...button.timers.values()].some(t=>t.ms===30000));
});
