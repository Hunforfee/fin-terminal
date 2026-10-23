'use client';
import { useEffect, useRef, useState } from 'react';
import { useAccount } from './AccountProvider';
import { normalizeStockCode } from '@/lib/datasource/codes';
import type { UpdateProgress } from '@/lib/marketUpdateQueue';
import { collectionPhaseLabel } from '@/lib/marketHistoryPlan';

async function requestUpdate(body?: unknown, method: 'GET' | 'POST' | 'PUT' | 'DELETE' = body ? 'POST' : 'GET') {
  const response = await fetch('/api/market-updates', {
    method, cache: 'no-store',
    credentials: 'same-origin',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(method === 'GET' ? {} : { 'x-fin-csrf': '1' }) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw Error(result.error ?? '更新服务暂不可用');
  return result;
}
export default function MarketUpdateButton({ codes, groupId, onComplete }: { codes: string[]; groupId: string; onComplete: () => void }) {
  const { user } = useAccount();
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [details, setDetails] = useState(false);
  const [workerPausedUntil, setWorkerPausedUntil] = useState(0);
  const [workerBusy, setWorkerBusy] = useState(false);
  const completion = useRef(onComplete); completion.current = onComplete;
  const observed = useRef<string | null>(null);
  const eligible = [...new Set(codes.flatMap(c => { const n = normalizeStockCode(c); return n ? [n.symbol] : []; }))];
  const active = !!progress && !progress.finished;
  const phaseText=collectionPhaseLabel(progress?.phase);
  useEffect(() => {
    let alive = true; let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      let next: UpdateProgress | null = null;
      try {
        const result = await requestUpdate();
        next = result.data as UpdateProgress | null;
        if (!alive) return;
        setProgress(next);
        setWorkerPausedUntil(result.workerPausedUntil ?? 0);
        if (next && !next.finished) observed.current = next.id;
        if (next?.finished && observed.current === next.id) { observed.current = null; completion.current(); }
      } catch { /* Polling never turns a running job into an apparent success. */ }
      if (alive) timer = setTimeout(poll, next && !next.finished ? 5000 : 30000);
    }
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [user?.id, busy]);
  useEffect(() => { setProgress(null); setError(''); observed.current = null; }, [user?.id]);
  async function start(retry = false) {
    setBusy(true); setError('');
    try {
      const targets = retry ? progress?.errors.map(e => e.symbol).filter(s => eligible.includes(s)) ?? [] : eligible;
      const value = (await requestUpdate({ codes: targets, groupId, retry,mode:'ten-year' })).data as UpdateProgress | null;
      setProgress(value);
      if (value) {
        observed.current = value.finished ? null : value.id;
        if (value.finished) completion.current();
      }
    } catch (e) { setError(e instanceof Error ? e.message : '更新失败'); setDetails(true); }
    finally { setBusy(false); }
  }
  async function stop() {
    setBusy(true); setError('');
    try {
      const value = (await requestUpdate(undefined, 'DELETE')).data as UpdateProgress | null;
      setProgress(value);
      observed.current = null;
    } catch (e) { setError(e instanceof Error ? e.message : '停止失败'); setDetails(true); }
    finally { setBusy(false); }
  }
  /** 管理员主动暂停/恢复后台队列消费：暂停后不再派发新任务，已排队任务保留，恢复后继续。 */
  async function toggleWorker() {
    setWorkerBusy(true); setError('');
    const paused = workerPausedUntil <= Date.now();
    try {
      const result = await requestUpdate({ paused, hours: 24 }, 'PUT');
      setWorkerPausedUntil((result.data as { pausedUntil: number }).pausedUntil ?? 0);
    } catch (e) { setError(e instanceof Error ? e.message : (paused ? '暂停失败' : '恢复失败')); setDetails(true); }
    finally { setWorkerBusy(false); }
  }
  return <div className="border-t border-slate-100 px-3 py-2 text-xs">
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" disabled={busy || active || !eligible.length} onClick={()=>void start()}
        title="补齐当前分组十年行情、财报及估值输入，已有有效数据复用"
        className="min-h-8 rounded-md px-2 text-slate-700 hover:bg-slate-50 hover:text-brand-600 disabled:opacity-60">
        {busy ? '提交中…' : active ? `补齐中 ${progress.done + progress.skipped + progress.failed}/${progress.total}` : '补齐10年'}
      </button>
      {(progress || error) && <button type="button" aria-expanded={details} aria-label="查看补齐进度" onClick={() => setDetails(v => !v)}
        className="min-h-8 text-slate-500 hover:text-brand-600">{details?'收起进度':'查看进度'}</button>}
      <a href="/market-updates/log" className="min-h-8 text-slate-500 hover:text-brand-600">更新日志</a>
      {active && <button type="button" disabled={busy} onClick={() => void stop()}
        title="停止本次补齐，已入库的数据保留" className="min-h-8 text-slate-500 hover:text-red-600 disabled:opacity-60">停止补齐</button>}
      <button type="button" disabled={workerBusy} onClick={() => void toggleWorker()}
        title={workerPausedUntil > Date.now() ? '恢复后台队列派发新任务（暂停期间已排队任务保留）' : '暂停后台队列：不再派发新任务，在飞阶段照常收尾'}
        className={`min-h-8 disabled:opacity-60 ${workerPausedUntil > Date.now() ? 'text-brand-600' : 'text-slate-500 hover:text-red-600'}`}>
        {workerBusy ? '处理中…' : workerPausedUntil > Date.now() ? '启动后台队列' : '停止后台队列'}
      </button>
    </div>
    {details && <div role="status" className="mt-2 rounded-md bg-slate-50 p-2.5 leading-5 text-slate-600">
      <p className="mb-1 font-medium text-slate-900">十年数据补齐</p>
      {error && <p className="mb-2 text-orange-700">{error}</p>}
      {progress && <>
        <p>已完成 {progress.done} · 已复用 {progress.skipped} · 失败 {progress.failed}</p>
        {active && phaseText && <p className="mt-1">正在处理：{phaseText}</p>}
        {active && <p className="mt-1">{!progress.workerOnline ? '等待后台执行器恢复，任务已保存' : progress.pausedUntil > Date.now() ? '来源限流，已自动暂停' : `排队 ${progress.waiting} · 执行 ${progress.running}`}</p>}
        <p className="mt-2 text-slate-400">缺失或校验失败的数据保留原记录。</p>
        {!!progress.errors.length && <p className="mt-2 text-slate-400">失败缺口已登记入库，可由 WorkBuddy 经 MCP 取数补齐后自动复核。</p>}
        {!!progress.errors.length && <ul className="mt-2 max-h-40 space-y-1 overflow-auto">{progress.errors.slice(0, 20).map(e => <li key={e.symbol}>{e.symbol}：{e.message}</li>)}</ul>}
        {progress.finished && progress.errors.some(e => eligible.includes(e.symbol)) && <button type="button" disabled={busy} onClick={() => void start(true)} className="mt-2 text-brand-600">重试当前分组失败项</button>}
      </>}
    </div>}
  </div>;
}
