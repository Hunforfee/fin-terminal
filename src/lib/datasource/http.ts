/**
 * 上游 HTTP 抓取工具：超时控制、GBK 解码、重试、UA 伪装。
 * 只运行在服务端（Route Handler / Server Component），浏览器不直连上游。
 */

import { acquireSharedSourceSlot, currentUpstreamBudget } from '../upstreamBudget';
import { allowMarketNetwork, marketDataMissing } from '../marketReadPolicy';
import { marketSourceCooldown } from './sourceCooldown';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface FetchOpts {
  /** Caller cancellation (autocomplete deadlines / superseded searches). */
  signal?: AbortSignal;
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  /** 响应编码，默认 utf-8 */
  encoding?: 'utf-8' | 'gbk';
  /** 视为临时失败、可切下一数据源的状态码（默认不重试，保持原有行为） */
  retryStatuses?: number[];
  /** 重试基础退避（毫秒），默认 200；第 n 次重试等待 backoffMs*n */
  backoffMs?: number;
}

const DEFAULT_TIMEOUT = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 8000);

export class UpstreamError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly kind: 'timeout' | 'http' | 'parse' | 'empty',
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export async function fetchText(url: string, opts: FetchOpts = {}): Promise<string> {
  if (!allowMarketNetwork(url)) throw marketDataMissing('来源数据');
  const { timeoutMs = DEFAULT_TIMEOUT, retries = 1, headers = {}, encoding = 'utf-8', retryStatuses, backoffMs = 200 } = opts;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    opts.signal?.throwIfAborted();
    const budget = currentUpstreamBudget();
    budget?.signal.throwIfAborted();
    const unavailable=()=>{
      const state=marketSourceCooldown.active(url);
      if(!state)return;
      budget?.observe(state.status,url);
      const reason=[403,429].includes(state.status)?'来源限流，冷却中': '来源冷却中';
      throw new UpstreamError(state.status?`HTTP ${state.status} ${reason}，稍后重试`:'来源连接暂时不可用，稍后重试',url,state.status?'http':'timeout');
    };
    unavailable();
    const release = await budget?.enter(url);
    const ctrl = new AbortController();
    let timer:ReturnType<typeof setTimeout>|undefined;
    let received=false;
    let slot:Awaited<ReturnType<typeof acquireSharedSourceSlot>>;
    try {
      const signals=[ctrl.signal,...(budget?[budget.signal]:[]),...(opts.signal?[opts.signal]:[])];
      const signal=AbortSignal.any(signals);
      slot=await acquireSharedSourceSlot(url,signal);
      unavailable(); // A queued request may have waited behind a failing request.
      timer=setTimeout(() => ctrl.abort(),timeoutMs);
      const res = await fetch(url, {
        signal,
        headers: {
          'User-Agent': UA,
          Accept: '*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          ...headers,
        },
        cache: 'no-store',
      });
      received=true;
      slot?.observe(res.status,res.headers.get('retry-after'));
      budget?.observe(res.status, url);
      marketSourceCooldown.observe(url,res.status,res.headers.get('retry-after'));
      if (!res.ok && retryStatuses?.includes(res.status)) {
        // 命中可重试状态（如 WAF 501）：抛普通错误以便重试 / 交由上层切换数据源
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) throw new UpstreamError(`HTTP ${res.status}`, url, 'http');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new UpstreamError('empty body', url, 'empty');
      marketSourceCooldown.succeeded(url);
      return encoding === 'gbk' ? new TextDecoder('gbk').decode(buf) : buf.toString('utf-8');
    } catch (e) {
      lastErr = e;
      if (e instanceof Error && e.name === 'AbortError') {
        lastErr = new UpstreamError(`timeout ${timeoutMs}ms`, url, 'timeout');
      }
      if(!received && !budget?.signal.aborted && !opts.signal?.aborted)marketSourceCooldown.failed(url);
      if(marketSourceCooldown.active(url) || budget?.signal.aborted || opts.signal?.aborted)break;
      // 最后一次尝试不再等待
      if (attempt < retries) await sleep(backoffMs * (attempt + 1));
    } finally {
      clearTimeout(timer);
      try { await slot?.release(); } finally { release?.(); }
    }
  }
  throw lastErr instanceof Error ? lastErr : new UpstreamError(String(lastErr), url, 'http');
}

export async function fetchJson<T>(url: string, opts: FetchOpts = {}): Promise<T> {
  const text = await fetchText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new UpstreamError('invalid json', url, 'parse');
  }
}

/** 新浪返回的 JSON key 无引号，做一次宽松修复 */
export function looseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const fixed = text
      .replace(/(\{|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
      .replace(/:\s*'([^']*)'/g, ':"$1"');
    return JSON.parse(fixed);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
