'use client';

import { useEffect, useState } from 'react';
import { calendarRangeStart } from '@/lib/marketDataIntegrity';
import KLineChart from '@/components/KLineChart';
import MinuteChart from '@/components/MinuteChart';
import type { Candle, MinutePoint, Period, Adjust } from '@/lib/datasource/types';

const PERIODS: { key: Period; label: string }[] = [
  { key: 'day', label: '日K' },
  { key: 'week', label: '周K' },
  { key: 'month', label: '月K' },
];

const ADJUSTS: { key: Adjust; label: string }[] = [
  { key: 'qfq', label: '前复权' },
  { key: 'none', label: '不复权' },
  { key: 'hfq', label: '后复权' },
];

const RANGES: { key: string; label: string; months: number }[] = [
  { key: '6m', label: '近半年', months: 6 },
  { key: '1y', label: '近一年', months: 12 },
  { key: '3y', label: '近三年', months: 36 },
  { key: '5y', label: '近五年', months: 60 },
];

export interface KLineSectionProps {
  code: string;
  /** 是否为指数（指数无复权概念） */
  isIndex?: boolean;
  prevClose?: number | null;
}

/** K 线 / 分时区块：周期、复权、区间均可切换，切换后按需拉取 */
export default function KLineSection({ code, isIndex = false, prevClose = null }: KLineSectionProps) {
  const [period, setPeriod] = useState<Period>('day');
  const isHk = /^(?:hk\d+|\d{4,5}(?:\.hk)?)$/i.test(code);
  const [adjust, setAdjust] = useState<Adjust>(isHk ? 'none' : 'qfq');
  const [range, setRange] = useState(RANGES[1]);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [meta, setMeta] = useState<{ source: string; stale: boolean; adjust: Adjust } | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // 分时（仅日线时展示）
  const [minute, setMinute] = useState<MinutePoint[]>([]);
  const [showMinute, setShowMinute] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    setErr(null);
    const adj = isIndex ? 'none' : adjust;
    const count = period === 'day' ? range.months * 31 + 10 : period === 'week' ? Math.ceil(range.months * 4.5) + 2 : range.months + 2;
    const load = (attempt: number) => {
      fetch(`/api/kline?code=${encodeURIComponent(code)}&period=${period}&adjust=${adj}&count=${count}&start=${calendarRangeStart(range.months)}`)
        .then((r) => r.json())
        .then((j) => {
          if (!alive) return;
          if (j.ok) {
            setCandles((j.data.candles ?? []) as Candle[]);
            setMeta({ source: j.data.source, stale: j.data.stale, adjust: j.data.adjust });
            setLoading(false);
            return;
          }
          throw new Error(j.error ?? 'K 线获取失败');
        })
        .catch((e) => {
          if (!alive) return;
          // 上游行情源偶发被拦截（WAF 501 / 限频）：稍候自动重试，避免整块报错
          if (attempt < 2) {
            timer = setTimeout(() => load(attempt + 1), 1500);
            return;
          }
          setErr(e instanceof Error ? e.message : String(e));
          setLoading(false);
        });
    };
    load(1);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [code, period, adjust, range.months, isIndex]);

  useEffect(() => { setMinute([]); }, [code]);

  useEffect(() => {
    if (!showMinute || minute.length > 0) return;
    let alive = true;
    fetch(`/api/minute?code=${code}`)
      .then((r) => r.json())
      .then((j) => alive && j.ok && setMinute((j.data ?? []) as MinutePoint[]))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [showMinute, minute.length, code]);

  return (
    <div className="card-pad">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              onClick={() => {
                setPeriod(p.key);
                setShowMinute(false);
              }}
              className={`rounded px-2.5 py-1 text-xs font-medium transition ${
                period === p.key && !showMinute
                  ? 'bg-brand-600 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {p.label}
            </button>
          ))}
          {!isIndex && (
            <button
              onClick={() => setShowMinute((v) => !v)}
              className={`rounded px-2.5 py-1 text-xs font-medium transition ${
                showMinute ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              分时
            </button>
          )}
        </div>

        {!isIndex && !showMinute && (
          <div className="flex gap-1">
            {ADJUSTS.map((a) => (
              <button
                key={a.key}
                onClick={() => setAdjust(a.key)}
                className={`rounded px-2 py-1 text-xs transition ${
                  adjust === a.key
                    ? 'bg-slate-200 font-medium text-slate-800'
                    : 'text-slate-500 hover:bg-slate-100'
                }`}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}

        {!showMinute && (
          <div className="ml-auto flex gap-1">
            {RANGES.map((r) => (
              <button
                key={r.key}
                onClick={() => setRange(r)}
                className={`rounded px-2 py-1 text-xs transition ${
                  range.key === r.key
                    ? 'bg-slate-200 font-medium text-slate-800'
                    : 'text-slate-500 hover:bg-slate-100'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {err && <div className="py-10 text-center text-sm text-red-600">{err}</div>}
      {!err && loading && <div className="py-16 text-center text-sm text-slate-400">K 线加载中…</div>}
      {!err && !loading && candles.length === 0 && (
        <div className="py-16 text-center text-sm text-slate-400">暂无 K 线数据</div>
      )}
      {!err && !loading && showMinute && (
        <>
          {minute.length > 0 ? (
            <MinuteChart points={minute} prevClose={prevClose} />
          ) : (
            <div className="py-16 text-center text-sm text-slate-400">当日分时暂不可用（非交易时段或接口限制）</div>
          )}
        </>
      )}
      {!err && !loading && !showMinute && candles.length > 0 && (
        <>
          <div className="mb-2 text-xs text-slate-500">{candles[0].date} 至 {candles.at(-1)?.date} · 实际 {candles.length} 根 · {ADJUSTS.find(a => a.key === meta?.adjust)?.label} · {meta?.source}{meta?.stale ? ' · 历史快照，非实时' : ''}</div>
          <KLineChart candles={candles} height={430} />
        </>
      )}
    </div>
  );
}
