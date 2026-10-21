'use client';
import { useEffect, useRef, useState } from 'react';
import { useAccount } from './AccountProvider';
import { normalizeStockCode } from '@/lib/datasource/codes';
import type { UpdateProgress } from '@/lib/marketUpdateQueue';

async function requestUpdate(body?: unknown) {
  const response = await fetch('/api/market-updates', {
    method: body ? 'POST' : 'GET', cache: 'no-store',
    credentials: 'same-origin',
    headers: { ...(body ? { 'Content-Type': 'application/json', 'x-fin-csrf': '1' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw Error(result.error ?? '更新服务暂不可用');
  return result.data as UpdateProgress | null;
}
export default function MarketUpdateButton({ codes, groupId, onComplete }: { codes: string[]; groupId: string; onComplete: () => void }) {
  const { user } = useAccount();
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [details, setDetails] = useState(false);
  const completion = useRef(onComplete); completion.current = onComplete;
  const observed = useRef<string | null>(null);
  const eligible = [...new Set(codes.flatMap(c => { const n = normalizeStockCode(c); return n ? [n.symbol] : []; }))];
  const active = !!progress && !progress.finished;
  const phase=progress?.phase;
  const phaseText=phase===undefined?'':phase>=3 && phase<=9 ? `${new Date(Date.now()+8*3600e3).getUTCFullYear()-(phase-3)} 年财报`
    : ({0:'历史行情',1:'复权行情',2:'最新财务与分红',10:'估值基础数据',11:'财报公告日期',12:'公司资料',13:'完整性检查'} as Record<number,string>)[phase];
  useEffect(() => {
    let alive = true; let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      let next: UpdateProgress | null = null;
      try {
        next = await requestUpdate();
        if (!alive) return;
        setProgress(next);
        if (next && !next.finished) observed.current = next.id;
        if (next?.finished && observed.current === next.id) { observed.current = null; completion.current(); }
      } catch { /* Polling never turns a running job into an apparent success. */ }
      if (alive) timer = setTimeout(poll, next && !next.finished ? 5000 : 30000);
    }
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [user?.id, busy]);
  useEffect(() => { setProgress(null); setError(''); observed.current = null; }, [user?.id]);
  async function start(retry = false, mode:'recent'|'five-year'='recent') {
    setBusy(true); setError('');
    try {
      const selectedMode=retry?progress?.mode??mode:mode;
      const targets = retry ? progress?.errors.map(e => e.symbol).filter(s => eligible.includes(s)) ?? [] : eligible;
      const value = await requestUpdate({ codes: targets, groupId, retry,mode:selectedMode });
      setProgress(value);
      if (value) {
        observed.current = value.finished ? null : value.id;
        if (value.finished) completion.current();
      }
    } catch (e) { setError(e instanceof Error ? e.message : '更新失败'); setDetails(true); }
    finally { setBusy(false); }
  }
  return <div className="relative shrink-0">
    <button type="button" disabled={busy || active || !eligible.length} onClick={()=>void start(false,'five-year')}
      title="从网站接口补齐当前分组五年行情、财报及估值输入，无需导入文件；完成后每日收盘更新"
      className="mr-1 h-8 whitespace-nowrap rounded-md border border-slate-200 bg-white px-2.5 text-xs text-slate-600 hover:text-brand-600 disabled:opacity-60">补齐5年</button>
    <button type="button" disabled={busy || active || !eligible.length} onClick={() => void start()}
      title="只更新当前分组缺失或过期的近期价格、财务和分红，后台排队执行"
      className="h-8 whitespace-nowrap rounded-md border border-slate-200 bg-white px-2.5 text-xs text-slate-600 hover:border-brand-300 hover:text-brand-600 disabled:cursor-default disabled:opacity-60">
      {busy ? '提交中…' : active ? `更新 ${progress.done + progress.skipped + progress.failed}/${progress.total}` : '更新数据'}
    </button>
    {(progress || error) && <button type="button" aria-expanded={details} aria-label="查看更新进度" onClick={() => setDetails(v => !v)}
      className="ml-1 text-xs text-slate-500 hover:text-brand-600">{progress?.failed ? `${progress.failed} 失败` : active ? '进度' : error ? '详情' : '完成'}</button>}
    {details && <div role="status" className="absolute right-0 top-10 z-30 w-72 rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-600 shadow-lg">
      <div className="mb-2 flex justify-between font-medium text-slate-900"><span>{progress?.mode==='five-year'?'五年数据入库':'数据更新'}</span><button type="button" onClick={() => setDetails(false)} className="text-slate-400">关闭</button></div>
      {error && <p className="mb-2 text-orange-700">{error}</p>}
      {progress && <>
        <p>已完成 {progress.done} · 近期已更新 {progress.skipped} · 失败 {progress.failed}</p>
        {active && phaseText && <p className="mt-1">正在处理：{phaseText}</p>}
        {active && <p className="mt-1">{!progress.workerOnline ? '等待后台执行器恢复，任务已保存' : progress.pausedUntil > Date.now() ? '来源限流，已自动暂停' : `排队 ${progress.waiting} · 执行 ${progress.running}`}</p>}
        <p className="mt-2 text-slate-400">缺失或校验失败的数据保留原记录。</p>
        {!!progress.errors.length && <ul className="mt-2 max-h-40 space-y-1 overflow-auto">{progress.errors.slice(0, 20).map(e => <li key={e.symbol}>{e.symbol}：{e.message}</li>)}</ul>}
        {progress.finished && progress.errors.some(e => eligible.includes(e.symbol)) && <button type="button" disabled={busy} onClick={() => void start(true)} className="mt-2 text-brand-600">重试当前分组失败项</button>}
      </>}
    </div>}
  </div>;
}
