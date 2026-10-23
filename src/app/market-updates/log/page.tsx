'use client';
import { useEffect, useState } from 'react';
import type { RunLog } from '@/lib/marketUpdateRunLog';
import { fetchJson } from '@/lib/fetchJson';

type Live = { active: boolean; date?: string; mode?: string; total: number; done: number; failed: number; running: number; waiting: number; finished: boolean; pausedUntil: number; workerOnline: boolean } | null;

const MODE_LABEL: Record<string, string> = {
  daily: '每日轻量', recent: '周日完整复核', 'ten-year': '十年补齐', 'five-year': '五年补齐（旧）',
};
function modeLabel(mode: string, owner: string) {
  if (owner.startsWith('system:close')) return MODE_LABEL[mode] ?? '定时更新';
  return MODE_LABEL[mode] ?? '数据更新';
}
const fmtTime = (ts: number) => new Date(ts + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
const fmtDate = (ts: number) => new Date(ts + 8 * 3600e3).toISOString().slice(0, 10);

export default function UpdateRunLogPage() {
  const [runs, setRuns] = useState<RunLog[] | null>(null);
  const [live, setLive] = useState<Live>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let alive = true; let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      let active = false;
      try {
        const result = await fetchJson('/api/market-update-run-log', { cache: 'no-store', credentials: 'same-origin' });
        if (!alive) return;
        if (!result.ok) throw Error(result.error ?? '更新日志暂不可用');
        setRuns(result.data.runs ?? []);
        setLive(result.data.live ?? null);
        active = !!result.data.live?.active;
        setError('');
      } catch (e) { if (alive) setError(e instanceof Error ? e.message : '更新日志暂不可用'); }
      if (alive) timer = setTimeout(poll, active ? 5000 : 30000);
    }
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  const livePct = live && live.total ? Math.round(((live.done + live.failed) / live.total) * 100) : 0;
  // 区分三种"不动"：来源限流暂停 / 执行器离线 / 正在排队执行。
  const pauseMs = live && live.pausedUntil > Date.now() ? live.pausedUntil - Date.now() : 0;
  const pauseText = pauseMs >= 60e3 ? `${Math.round(pauseMs / 60e3)} 分钟` : `${Math.max(1, Math.ceil(pauseMs / 1000))} 秒`;
  const idleText = pauseMs ? `来源限流，已自动暂停（约 ${pauseText}后恢复）`
    : live && !live.workerOnline ? '后台执行器未在线，任务已保存，恢复后自动继续'
      : '排队中，等待后台执行器接续';

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-6 text-slate-700">
      <h1 className="text-lg font-semibold text-slate-900">更新日志</h1>
      <p className="mt-1 text-xs text-slate-500">每日轻量与周日完整复核的运行结果。仅记录原因与结果，失败缺口已另行登记，由 WorkBuddy 补齐。</p>

      {live?.active && (
        <section className="mt-5 rounded-lg border border-brand-200 bg-brand-50/40 p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-slate-900">正在进行：{modeLabel(live.mode ?? '', 'system:close')}{live.date ? `（${live.date}）` : ''}</span>
            <span className="tabular-nums text-slate-600">{live.done + live.failed}/{live.total}</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-white">
            <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${livePct}%` }} />
          </div>
          <p className="mt-2 text-xs text-slate-500">
            成功 {live.done} · 失败 {live.failed} · 排队 {live.waiting} · 执行 {live.running}
            {live.running === 0 && live.waiting === 0 && <span className="text-orange-600"> · {idleText}</span>}
          </p>
        </section>
      )}

      {error && <p className="mt-5 rounded-md border border-orange-200 bg-orange-50 px-3 py-2 text-xs text-orange-700">{error}</p>}

      <section className="mt-6">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
              <th className="py-2 pr-2 font-normal">时间</th>
              <th className="py-2 pr-2 font-normal">类型</th>
              <th className="py-2 pr-2 text-right font-normal">成功</th>
              <th className="py-2 pr-2 text-right font-normal">失败</th>
              <th className="py-2 font-normal">原因</th>
            </tr>
          </thead>
          <tbody>
            {(runs ?? []).map(r => (
              <tr key={r.id} className="border-b border-slate-100 align-top">
                <td className="py-2 pr-2 whitespace-nowrap text-slate-600">{fmtDate(r.finishedAt)} {fmtTime(r.finishedAt).slice(11)}</td>
                <td className="py-2 pr-2 whitespace-nowrap">{modeLabel(r.mode, r.owner)}</td>
                <td className="py-2 pr-2 text-right tabular-nums">{r.done}</td>
                <td className={`py-2 pr-2 text-right tabular-nums ${r.failed ? 'text-red-600' : ''}`}>{r.failed}</td>
                <td className="py-2">
                  {r.failed ? (
                    <>
                      <button type="button" onClick={() => setOpen(open === r.id ? null : r.id)} className="text-brand-600 hover:underline">
                        {open === r.id ? '收起' : `查看 ${r.failed} 项`}
                      </button>
                      {open === r.id && (
                        <ul className="mt-1 max-h-60 space-y-0.5 overflow-auto text-xs text-slate-500">
                          {r.errors.map(e => <li key={e.symbol}>{e.symbol}：{e.message}</li>)}
                        </ul>
                      )}
                    </>
                  ) : <span className="text-slate-400">—</span>}
                </td>
              </tr>
            ))}
            {runs && runs.length === 0 && (
              <tr><td colSpan={5} className="py-6 text-center text-xs text-slate-400">暂无运行记录（下一次每日/周日更新后出现）</td></tr>
            )}
          </tbody>
        </table>
        {runs === null && !error && <p className="py-6 text-center text-xs text-slate-400">加载中…</p>}
      </section>
    </main>
  );
}
