'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { normalizeStockCode } from '@/lib/datasource/codes';
import type { UpdateProgress } from '@/lib/marketUpdateQueue';

/** 与自选分组更新共用同一队列通道；single 模式不要求自选云同步。 */
async function requestUpdate(body?: unknown, method: 'GET' | 'POST' | 'DELETE' = body ? 'POST' : 'GET') {
  const response = await fetch('/api/market-updates', {
    method, cache: 'no-store',
    credentials: 'same-origin',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(method === 'GET' ? {} : { 'x-fin-csrf': '1' }) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw Error(result.error ?? '更新服务暂不可用');
  return result.data as UpdateProgress | null;
}

const phaseText = (phase?: number) => phase === undefined ? '' : phase >= 3 && phase <= 9
  ? `${new Date(Date.now() + 8 * 3600e3).getUTCFullYear() - (phase - 3)} 年财报`
  : ({ 0: '历史行情', 1: '复权行情', 2: '最新财务与分红', 10: '估值基础数据', 11: '财报公告日期', 12: '公司资料', 13: '完整性检查' } as Record<number, string>)[phase] ?? '';

/**
 * 个股页「补齐数据」：只把当前这只股票排入五年补齐队列（后台执行，可停止）。
 * 抓取失败的阶段会登记缺口，由 WorkBuddy 经 MCP 取数补齐后自动复核。
 */
export default function StockFillButton({ code, name }: { code: string; name: string }) {
  const router = useRouter();
  const symbol = normalizeStockCode(code)?.symbol;
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
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
        if (next && !next.finished) observed.current = next.id;
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
      const value = await requestUpdate({ codes: [symbol], single: true, mode: 'five-year' });
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
  if (!symbol) return null;
  // 只把「本页面发起（或点击后并入）的任务」视为自己的进度；别处发起的分组任务不打扰个股页状态。
  const active = !!progress && !progress.finished && observed.current === progress.id;
  const label = busy ? '提交中…' : active ? `补齐中 ${progress!.done + progress!.skipped + progress!.failed}/${progress!.total}` : done ? '已补齐'
    : error ? error.includes('已手动停止') ? '已停止' : progress && progress.done + progress.skipped > 0 ? '部分失败' : '补齐失败' : '补齐数据';
  const title = error ? error : active
    ? `正在补齐${name}：${phaseText(progress!.phase) || '排队中'}（${progress!.workerOnline ? '后台执行中' : '等待后台执行器'}）`
    : `从网站接口补齐${name}五年行情、财报及估值输入，无需导入文件；可随时停止`;
  return (
    <>
      <button type="button" disabled={busy || active || !symbol} onClick={() => void start()} title={title}
        className={`chip min-h-10 border sm:min-h-8 ${error ? 'border-red-300 bg-red-50 text-red-600' : done ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-white text-slate-600 hover:border-brand-300 hover:text-brand-700'} disabled:cursor-default disabled:opacity-60`}>
        <svg viewBox="0 0 20 20" aria-hidden="true" className="mr-1 h-3.5 w-3.5"><path d="M10 2v10m0 0 3.5-3.5M10 12 6.5 8.5M3 14v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        {label}
      </button>
      {active && <button type="button" disabled={busy} onClick={() => void stop()} title="停止补齐：已排队和正在执行的阶段都会取消，已入库的数据保留"
        className="chip min-h-10 border border-slate-200 bg-white text-slate-600 hover:border-red-300 hover:text-red-600 sm:min-h-8">停止</button>}
    </>
  );
}
