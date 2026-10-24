import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load-modules.mjs';

const { fetchJson, FetchJsonError } = await load('fetchJson');

function stubFetch(handler) {
  globalThis.fetch = handler;
}

test('fetchJson: 正常 JSON 直接返回解析结果', async () => {
  stubFetch(async () => new Response(JSON.stringify({ ok: true, data: [1, 2] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
  const j = await fetchJson('/api/x');
  assert.deepEqual(j, { ok: true, data: [1, 2] });
});

test('fetchJson: 空 body 抛可读错误而非 JSON 解析错误', async () => {
  stubFetch(async () => new Response('', { status: 200, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(
    fetchJson('/api/x'),
    (e) => e instanceof FetchJsonError && /空响应/.test(e.message) && !/JSON input/.test(e.message),
  );
});

test('fetchJson: 524/502 代理错误页（HTML 或空）转通用可读错误', async () => {
  stubFetch(async () => new Response('', { status: 524 }));
  await assert.rejects(
    fetchJson('/api/x'),
    (e) => e instanceof FetchJsonError && /HTTP 524/.test(e.message),
  );
  stubFetch(async () => new Response('<html>gateway timeout</html>', { status: 502, headers: { 'content-type': 'text/html' } }));
  await assert.rejects(
    fetchJson('/api/x'),
    (e) => e instanceof FetchJsonError && /HTTP 502/.test(e.message),
  );
});

test('fetchJson: 业务错误保留服务端 error 文案', async () => {
  stubFetch(async () => new Response(JSON.stringify({ ok: false, error: '该股票暂无数据' }), {
    status: 502, headers: { 'content-type': 'application/json' },
  }));
  await assert.rejects(
    fetchJson('/api/x'),
    (e) => e instanceof FetchJsonError && e.message === '该股票暂无数据' && e.status === 502,
  );
});

test('fetchJson: 畸形 JSON 转可读错误', async () => {
  stubFetch(async () => new Response('{oops', { status: 200, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(
    fetchJson('/api/x'),
    (e) => e instanceof FetchJsonError && /无法解析/.test(e.message),
  );
});

test('fetchJson: 网络层失败（fetch reject）转可读错误', async () => {
  stubFetch(async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(
    fetchJson('/api/x'),
    (e) => e instanceof FetchJsonError && /网络请求失败/.test(e.message),
  );
});

test('fetchJson: AbortError 原样抛出，保留取消语义', async () => {
  const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
  stubFetch(async () => { throw abortErr; });
  await assert.rejects(fetchJson('/api/x'), (e) => e === abortErr && e.name === 'AbortError');
});

test('fetchJson: timeout bounds response headers and body, while caller cancellation is preserved', async()=>{
  stubFetch(async(_input,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})));
  await assert.rejects(fetchJson('/api/x',undefined,10), /请求超时/);
  stubFetch(async(_input,{signal})=>({ok:true,status:200,text:()=>{signal.throwIfAborted();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}}));
  await assert.rejects(fetchJson('/api/x',undefined,10), /请求超时/);
  const controller=new AbortController();
  const pending=fetchJson('/api/x',{signal:controller.signal},1000);controller.abort();
  await assert.rejects(pending,{name:'AbortError'});
});
