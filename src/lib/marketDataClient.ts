import { isMarketDataResource, marketDataMethodAllowed, type MarketDataResource } from './marketDataResources';
import type { MarketRecord, MarketRecordMeta, MarketStore } from './marketStore';
import { createHash } from 'node:crypto';
import { cached } from './datasource/cache';

export const remoteMarketDataEnabled = () => process.env.MARKET_DATA_MODE === 'remote';
const MAX_RESPONSE = 32 * 1024 * 1024;
const MAX_REQUEST = 64 * 1024;
export class MarketDataApiError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}
const failure = (message: string, status: number) => Response.json({ ok: false, error: message },
  { status, headers: { 'Cache-Control': 'private, no-store' } });

function connection() {
  const value = process.env.MARKET_DATA_API_URL;
  const token = process.env.MARKET_DATA_API_ACCESS_TOKEN;
  if (!value || !token || token.length < 32) throw new MarketDataApiError('远程市场数据接口尚未配置完整', 503);
  let url: URL;
  try { url = new URL(value); } catch { throw new MarketDataApiError('远程市场数据接口地址无效', 503); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash)
    throw new MarketDataApiError('远程接口须使用 HTTPS，且地址不能包含凭证或查询参数', 503);
  return { url, token };
}

/** Bounded streaming reads, including chunked bodies without Content-Length. */
export async function readMarketBody(response: Response | Request, limit: number): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length') ?? 0) > limit) throw new MarketDataApiError('数据体积超出接口上限', 413);
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  let size = 0;
  const parts: Uint8Array[] = [];
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new MarketDataApiError('数据体积超出接口上限', 413); }
      parts.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.length; }
  return bytes;
}

/** No cookies, browser credentials, AI keys or user-provided destinations cross this boundary. */
async function requestMarketDataUncached(resource: MarketDataResource, params = new URLSearchParams(),
  options: { method?: 'GET' | 'POST'; body?: Uint8Array; signal?: AbortSignal; callerOrigin?: string } = {}): Promise<Response> {
  const { url, token } = connection();
  if (options.callerOrigin && url.origin === options.callerOrigin)
    throw new MarketDataApiError('远程数据接口不能指向当前网站自身', 503);
  const method = options.method ?? 'GET';
  if (!isMarketDataResource(resource) || !marketDataMethodAllowed(resource, method)) throw new MarketDataApiError('不支持的数据接口或方法', 405);
  for (const [key, value] of params) if (!['resource', 'token', 'sql', 'api_key'].includes(key)) url.searchParams.append(key, value);
  url.searchParams.set('resource', resource);
  const signals = [AbortSignal.timeout(resource==='search'?3500:90000), ...(options.signal ? [options.signal] : [])];
  try {
    const response = await fetch(url, {
      method, headers: { Accept: 'application/json', 'x-fin-data-token': token,
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
      ...(options.body ? { body: options.body as BodyInit } : {}),
      signal: AbortSignal.any(signals), cache: 'no-store', redirect: 'error',
    });
    if (response.headers.get('x-fin-data-version') !== '1')
      throw new MarketDataApiError('远程数据接口尚未部署或版本不兼容，请检查原服务器', 503);
    if (!response.headers.get('content-type')?.includes('application/json'))
      throw new MarketDataApiError('远程接口未返回有效 JSON 数据');
    const bytes = await readMarketBody(response, MAX_RESPONSE);
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MarketDataApiError('远程接口数据格式无效');
    // Authentication errors and internal upstream details must never leak to a browser.
    if (response.status === 401 || response.status === 403) throw new MarketDataApiError('远程市场数据接口鉴权失败，请检查服务器配置', 503);
    if (response.status >= 500) throw new MarketDataApiError('远程市场数据服务暂不可用，请稍后重试', 502);
    if (value.ok === false && response.ok) throw new MarketDataApiError('远程市场数据服务返回失败结果', 502);
    const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store', 'X-Fin-Market-Source': 'remote-api', 'X-Fin-Data-Version': '1' });
    const retry = response.headers.get('retry-after'); if (retry && /^\d+$/.test(retry)) headers.set('Retry-After', retry);
    return new Response(bytes as BodyInit, { status: response.status, headers });
  } catch (error) {
    if (error instanceof MarketDataApiError) throw error;
    throw new MarketDataApiError(options.signal?.aborted ? '数据请求已取消' : '远程市场数据服务连接失败，请稍后重试');
  }
}

/** Search repeats are served from the original API response, never local market
 * snapshots. Coalesce bursts; a cancelled browser must not cancel other waiters. */
export async function requestMarketData(resource: MarketDataResource, params = new URLSearchParams(),
 options: {method?:'GET'|'POST';body?:Uint8Array;signal?:AbortSignal;callerOrigin?:string}={}):Promise<Response>{
 if(resource!=='search' || options.method==='POST')return requestMarketDataUncached(resource,params,options);
 options.signal?.throwIfAborted();
 const {url,token}=connection();
 if(options.callerOrigin===url.origin)throw new MarketDataApiError('远程数据接口不能指向当前网站自身',503);
 const query=new URLSearchParams(params);query.set('q',(query.get('q')??'').trim().toLowerCase());
 const identity=createHash('sha256').update(token).digest('hex');
 const key=`remote-search:v1:${url.href}:${identity}:${query.toString()}`;
 const value=await cached(key,300000,async()=>{
  const response=await requestMarketDataUncached(resource,query,{...options,signal:undefined});
  if(!response.ok){const error=await response.json();throw new MarketDataApiError(error.error??'搜索暂不可用',response.status);}
  const text=await response.text(),json=JSON.parse(text);
  if(!Array.isArray(json.data))throw new MarketDataApiError('远程搜索结果格式无效');
  return {text,status:response.status,headers:[...response.headers.entries()]};
 },{staleOnError:false});
 options.signal?.throwIfAborted();
 return new Response(value.text,{status:value.status,headers:value.headers});
}

/** Used by server-rendered pages as well as external server-side integrations. */
export async function readRemoteMarketData<T>(resource: MarketDataResource,
  params: Record<string, string | number | boolean | undefined> = {}, body?: unknown): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, String(value));
  const response = await requestMarketData(resource, query, body === undefined ? {} : {
    method: 'POST', body: new TextEncoder().encode(JSON.stringify(body)),
  });
  const json = await response.json();
  if (!response.ok || json.ok !== true || !Object.hasOwn(json, 'data'))
    throw new MarketDataApiError(json.error ?? '远程市场数据读取失败', response.status);
  return json.data as T;
}

/** Raw diagnostics also use the API in consumer mode; this adapter has no mutation methods. */
export function remoteMarketReadStore(): Pick<MarketStore, 'read' | 'scanPrefix' | 'readVersions'> {
  return {
    async read<T>(key: string): Promise<MarketRecord<T> | null> {
      try { return (await readRemoteMarketData<{ record: MarketRecord<T> }>('records', { key })).record; }
      catch (error) { if (error instanceof MarketDataApiError && error.status === 404) return null; throw error; }
    },
    async scanPrefix(prefix: string, limit: number, after = ''): Promise<MarketRecordMeta[]> {
      return (await readRemoteMarketData<{ records: MarketRecordMeta[] }>('records', { prefix, limit, after, payload: '0' })).records;
    },
    async readVersions(key: string, limit: number): Promise<MarketRecord[]> {
      return (await readRemoteMarketData<{ records: MarketRecord[] }>('records', { key, limit, versions: '1' })).records;
    },
  };
}

/** Consumer mode intercepts stock-data requests before any local route/provider runs. */
export async function proxyRemoteMarketRequest(request: Request): Promise<Response | null> {
  if (!remoteMarketDataEnabled()) return null;
  const url = new URL(request.url), name = url.pathname.replace(/^\/api\//, '');
  if (!isMarketDataResource(name)) {
    if (name === 'market-updates' || name.startsWith('market-updates/') || name === 'market-update-run-log' || name.startsWith('market/'))
      return failure('远程数据模式由原服务器统一维护股票数据', 503);
    return null;
  }
  try {
    if (!marketDataMethodAllowed(name, request.method)) return failure('共享数据接口不支持此操作', 405);
    const body = request.method === 'POST' ? await readMarketBody(name === 'company-learning' ? request.clone() : request, MAX_REQUEST) : undefined;
    if (name === 'company-learning' && body) {
      let query;
      try { query = JSON.parse(new TextDecoder().decode(body)); }
      catch { throw new MarketDataApiError('请求体须为有效 JSON', 400); }
      // AI generation stays on the consumer server; its digest provider still reads via the API.
      if (query?.action !== 'pool') return null;
    }
    return await requestMarketData(name, url.searchParams, { method: request.method as 'GET' | 'POST', body,
      signal: request.signal, callerOrigin: url.origin });
  } catch (error) {
    return failure(error instanceof MarketDataApiError ? error.message : '远程市场数据读取失败',
      error instanceof MarketDataApiError ? error.status : 502);
  }
}
