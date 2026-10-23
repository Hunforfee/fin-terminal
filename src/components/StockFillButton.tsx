'use client';
import { useEffect, useRef, useState } from 'react';
import { fetchJson } from '@/lib/fetchJson';
import { useRouter } from 'next/navigation';
import { normalizeStockCode } from '@/lib/datasource/codes';
import type { UpdateProgress } from '@/lib/marketUpdateQueue';
import { collectionPhaseLabel } from '@/lib/marketHistoryPlan';

/** 与自选分组更新共用同一队列通道；single 模式不要求自选云同步。 */
async function requestUpdate(body?: unknown, method: 'GET' | 'POST' | 'DELETE' = body ? 'POST' : 'GET') {
  const result = await fetchJson('/api/market-updates', {
    method, cache: 'no-store',
    credentials: 'same-origin',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(method === 'GET' ? {} : { 'x-fin-csrf': '1' }) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!result.ok) throw Error(result.error ?? '更新服务暂不可用');
  return result.data as UpdateProgress | null;
}

/**
 * 个股页图标：只把当前这只股票排入十年补齐队列（后台执行，可停止）。
 * 抓取失败的阶段会登记缺口，由 WorkBuddy 经 MCP 取数补齐后自动复核。
 */
export default function StockFillButton({ code, name }: { code: string; name: string }) {
  const router = useRouter();
  const symbol = normalizeStockCode(code)?.symbol;
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [details, setDetails] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const observed = useRef<string | null>(null);
  function complete(value: UpdateProgress) {
    const failed = value.failed > 0 || value.errors.length > 0;
    setDone(!failed);
    setError(failed ? value.errors.map(e => e.message).join('；') || '部分数据补齐失败' : '');
    router.refresh();
  }
  useEffect(() => {
    if (busy) return;
    let alive = true; let timer: ReturnType<typeof setTimeout>; let doneTimer: ReturnType<typeof setTimeout>;
    async function poll() {
      let next: UpdateProgress | null = null;
      try {
        next = await requestUpdate();
        if (!alive) return;
        setProgress(next);
        if (next?.finished && observed.current === next.id) {
          observed.current = null; complete(next);
          if (!next.failed && !next.errors.length) doneTimer = setTimeout(() => { if (alive) setDone(false); }, 8000);
        }
      } catch { /* 轮询失败不改变界面状态，下次继续 */ }
      if (alive) timer = setTimeout(poll, next && !next.finished ? 5000 : 30000);
    }
    void poll();
    return () => { alive = false; clearTimeout(timer); clearTimeout(doneTimer); };
  }, [router, busy]);
  async function start() {
    if (!symbol) return;
    setBusy(true); setError(''); setDone(false);
    try {
      const value = await requestUpdate({ codes: [symbol], single: true, mode: 'ten-year' });
      setProgress(value);
      observed.current = value && !value.finished ? value.id : null;
      if (value?.finished) complete(value);
    } catch (e) { setError(e instanceof Error ? e.message : '补齐失败'); }
    finally { setBusy(false); }
  }
  async function stop() {
    setBusy(true); setError('');
    try {
      const value = await requestUpdate(undefined, 'DELETE');
      setProgress(value);
      observed.current = null;
      setDone(false);
      if (value?.finished) complete(value);
    } catch (e) { setError(e instanceof Error ? e.message : '停止失败'); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (!details) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setDetails(false);
    };
    const escape = (event: KeyboardEvent) => { if(event.key==='Escape')setDetails(false); };
    document.addEventListener('pointerdown',outside);
    document.addEventListener('keydown',escape);
    return () => { document.removeEventListener('pointerdown',outside); document.removeEventListener('keydown',escape); };
  }, [details]);
  if (!symbol) return null;
  // 只把「本页面发起（或点击后并入）的任务」视为自己的进度；别处发起的分组任务不打扰个股页状态。
  const active = !!progress && !progress.finished && observed.current === progress.id;
  const label = busy ? '提交中…' : active ? `补齐中 ${progress!.done + progress!.skipped + progress!.failed}/${progress!.total}` : done ? '已补齐'
    : error ? error.includes('已手动停止') ? '已停止' : progress && progress.done + progress.skipped > 0 ? '部分失败' : '补齐失败' : '补齐10年数据';
  const title = error ? error : active
    ? `正在补齐${name}：${collectionPhaseLabel(progress!.phase) || '排队中'}（${progress!.workerOnline ? '后台执行中' : '等待后台执行器'}）`
    : `补齐${name}十年行情、财报及估值输入，已有有效数据复用`;
  return (
    <div ref={root} className="relative inline-flex shrink-0">
      <button type="button" disabled={busy} aria-label={`${name}：${label}`} aria-expanded={details} onClick={() => {
        if(active || error || done){setDetails(v=>!v);return;}
        setDetails(true); void start();
      }} title={title}
        className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300 ${error ? 'bg-red-50 text-red-600' : done ? 'bg-emerald-50 text-emerald-700' : 'text-slate-500 hover:bg-slate-100 hover:text-brand-700'} disabled:opacity-60`}>
        <svg viewBox="0 0 20 20" aria-hidden="true" className={`h-[18px] w-[18px] ${active || busy ? 'animate-pulse' : ''}`}><path d="M10 2v10m0 0 3.5-3.5M10 12 6.5 8.5M3 14v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {details && <div role="status" className="fixed inset-x-4 top-28 z-40 rounded-lg border border-slate-200 bg-white p-3 text-xs leading-5 text-slate-600 shadow-lg sm:absolute sm:inset-x-auto sm:left-0 sm:top-9 sm:w-64">
        <div className="flex items-center justify-between gap-2"><span className="font-medium text-slate-900">{label}</span><button type="button" onClick={()=>setDetails(false)} aria-label="关闭补齐进度" className="text-slate-400 hover:text-slate-600">关闭</button></div>
        {active && <><p className="mt-1">{collectionPhaseLabel(progress?.phase) || '任务已排队'}</p><p>{!progress?.workerOnline?'等待后台执行器':progress.pausedUntil>Date.now()?'来源限流，已自动暂停':'后台执行中，可关闭页面'}</p></>}
        {error && <p className="mt-1 break-words text-red-600">{error}</p>}
        {done && <p className="mt-1">本次数据补齐已完成。</p>}
        <p className="mt-1 text-slate-400">补齐十年数据，已有有效数据复用。</p>
        {active && <button type="button" disabled={busy} onClick={()=>void stop()} className="mt-2 min-h-8 text-red-600 disabled:opacity-60">停止补齐</button>}
        {!active && error && <button type="button" disabled={busy} onClick={()=>void start()} className="mt-2 min-h-8 text-brand-600 disabled:opacity-60">重新补齐</button>}
      </div>}
    </div>
  );
}
