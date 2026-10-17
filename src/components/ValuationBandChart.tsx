'use client';

import { useMemo, useState } from 'react';
import EChart from './EChart';
import type { ValuationPoint } from '@/lib/datasource/types';

export interface ValuationBandChartProps {
  history: ValuationPoint[];
  pe: number | null;
  pb: number | null;
  pePercentile: number | null;
  pbPercentile: number | null;
  height?: number;
}

type Metric = 'pe' | 'pb';

/**
 * 估值带：PE / PB 历史曲线 + 当前值 + 均值 ±1σ 通道。
 * 通过「当前值落在历史分布的什么位置」判断贵贱，这是理杏仁式估值分析的核心视图。
 */
export default function ValuationBandChart({
  history,
  pe,
  pb,
  pePercentile,
  pbPercentile,
  height = 380,
}: ValuationBandChartProps) {
  const [metric, setMetric] = useState<Metric>('pe');

  const stats = useMemo(() => {
    const vals = history
      .map((h) => (metric === 'pe' ? h.pe : h.pb))
      .filter((v): v is number => v !== null && Number.isFinite(v) && v > 0);
    if (vals.length < 10) return null;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
    const sorted = [...vals].sort((a, b) => a - b);
    const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    return {
      mean,
      sd,
      low: Math.max(q(0.1), mean - sd),
      high: q(0.9),
      p20: q(0.2),
      p80: q(0.8),
      min: sorted[0],
      max: sorted[sorted.length - 1],
    };
  }, [history, metric]);

  const option = useMemo(() => {
    const dates = history.map((h) => h.date);
    const vals = history.map((h) => (metric === 'pe' ? h.pe : h.pb));
    const current = metric === 'pe' ? pe : pb;
    const name = metric === 'pe' ? 'PE(TTM)' : 'PB';

    return {
      animation: false,
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(255,255,255,0.96)',
        borderColor: '#e2e8f0',
        textStyle: { color: '#0f172a', fontSize: 12 },
        formatter: (params: { axisValue: string; value: number | null }[]) => {
          const p0 = params[0];
          if (!p0) return '';
          const v = p0.value;
          return `${p0.axisValue}<br/>${name}: ${v === null || v === undefined ? '--' : Number(v).toFixed(2)}`;
        },
      },
      grid: { left: 56, right: 24, top: 30, bottom: 40 },
      xAxis: {
        type: 'category',
        data: dates,
        axisLine: { lineStyle: { color: '#cbd5e1' } },
        axisLabel: { color: '#94a3b8', fontSize: 11 },
      },
      yAxis: {
        scale: true,
        axisLine: { show: false },
        axisLabel: { color: '#94a3b8', fontSize: 11, formatter: (v: number) => v.toFixed(1) },
        splitLine: { lineStyle: { color: '#f1f5f9' } },
      },
      dataZoom: [
        { type: 'inside', start: 0, end: 100 },
        {
          type: 'slider',
          start: 0,
          end: 100,
          height: 16,
          bottom: 8,
          borderColor: '#e2e8f0',
          fillerColor: 'rgba(37,99,235,0.08)',
          textStyle: { color: '#94a3b8', fontSize: 10 },
        },
      ],
      series: [
        {
          name,
          type: 'line',
          data: vals,
          symbol: 'none',
          lineStyle: { width: 1.4, color: '#2563eb' },
          areaStyle: { color: 'rgba(37,99,235,0.06)' },
          markLine: stats
            ? {
                silent: true,
                symbol: 'none',
                label: { fontSize: 10, color: '#64748b', position: 'insideEndTop' },
                data: [
                  { yAxis: stats.mean, lineStyle: { color: '#94a3b8', type: 'dashed' }, label: { formatter: `均值 ${stats.mean.toFixed(2)}` } },
                  {
                    yAxis: stats.p20,
                    lineStyle: { color: '#10b981', type: 'dotted' },
                    label: { formatter: `20% 分位 ${stats.p20.toFixed(2)}` },
                  },
                  {
                    yAxis: stats.p80,
                    lineStyle: { color: '#ef4444', type: 'dotted' },
                    label: { formatter: `80% 分位 ${stats.p80.toFixed(2)}` },
                  },
                  ...(current
                    ? [
                        {
                          yAxis: current,
                          lineStyle: { color: '#f59e0b', width: 1.5 },
                          label: { formatter: `当前 ${current.toFixed(2)}`, position: 'insideStartTop' as const },
                        },
                      ]
                    : []),
                ],
              }
            : undefined,
        },
      ],
    };
  }, [history, metric, pe, pb, stats]);

  const percentile = metric === 'pe' ? pePercentile : pbPercentile;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex gap-1">
          {(['pe', 'pb'] as Metric[]).map((m) => (
            <button
              key={m}
              onClick={() => setMetric(m)}
              className={`rounded px-2.5 py-1 text-xs font-medium transition ${
                metric === m ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {m === 'pe' ? '市盈率 PE' : '市净率 PB'}
            </button>
          ))}
        </div>
        {percentile !== null && (
          <span className="text-xs text-slate-500">
            当前处于历史 <b className="text-slate-800">{percentile.toFixed(1)}%</b> 分位
          </span>
        )}
      </div>
      <EChart option={option} height={height} />
    </div>
  );
}
