'use client';

import { useMemo } from 'react';
import EChart from './EChart';
import type { IndicatorDef } from '@/lib/datasource/sinaFinancial';

export interface CompanySeries {
  code: string;
  name: string;
  periodLabels: string[];
  values: (number | null)[];
}

export interface FinanceCompareChartProps {
  /** 只依赖单位做格式化；调用方可传完整 IndicatorDef 或最小形状 */
  indicator: { unit: IndicatorDef['unit'] | string };
  /** 主公司（蓝色） */
  primary: CompanySeries;
  /** 对比公司（橙色），可缺省 */
  compare?: CompanySeries | null;
  height?: number;
}

const C_PRIMARY = '#3b82f6';
const C_COMPARE = '#f97316';
const C_MEAN = '#ef4444';

function stats(values: (number | null)[]) {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x));
  if (v.length === 0) return null;
  const sorted = [...v].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    max: sorted[sorted.length - 1],
    min: sorted[0],
    median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    mean: v.reduce((a, b) => a + b, 0) / v.length,
    current: v[v.length - 1],
  };
}

/** 万元 → 亿 的展示口径：≥1 亿显示「x.x亿」，否则显示原万元值 */
function fmtWan(v: number): string {
  if (Math.abs(v) >= 1e4) return `${(v / 1e4).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}亿`;
  return `${v.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}万`;
}

function fmtVal(v: number, unit: string): string {
  if (unit === 'pct') return `${v.toFixed(2)}%`;
  if (unit === 'wan') return fmtWan(v);
  return v.toFixed(2);
}

function yFmt(unit: string) {
  if (unit === 'pct') return (v: number) => `${v}%`;
  if (unit === 'wan') return (v: number) => (Math.abs(v) >= 1e4 ? `${(v / 1e4).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}亿` : `${v}`);
  return (v: number) => `${v}`;
}

/**
 * 理杏仁风格的双公司财务对比图：
 * 蓝（主）橙（对比）双序列，逐点数值标注，红色均值虚线，报告期横轴。
 */
export default function FinanceCompareChart({
  indicator,
  primary,
  compare,
  height = 300,
}: FinanceCompareChartProps) {
  const option = useMemo(() => {
    const labels = primary.periodLabels;
    const series: Record<string, unknown>[] = [];

    const mk = (s: CompanySeries, color: string, isPrimary: boolean) => ({
      name: s.name,
      type: 'line',
      data: s.values,
      symbol: 'circle',
      symbolSize: 6,
      lineStyle: { width: 2, color },
      itemStyle: { color },
      label: {
        show: true,
        position: isPrimary ? 'top' : 'bottom',
        fontSize: 10,
        color,
        formatter: (p: { value: number | null }) =>
          p.value === null ? '' : fmtVal(p.value, indicator.unit),
      },
      labelLayout: { hideOverlap: true },
      markLine: {
        silent: true,
        symbol: 'none',
        animation: false,
        data: (() => {
          const st = stats(s.values);
          if (!st) return [];
          return [
            {
              yAxis: st.mean,
              lineStyle: { color: C_MEAN, type: 'dashed', width: 1 },
              label: {
                show: true,
                position: 'insideStartTop',
                fontSize: 10,
                color: '#fff',
                backgroundColor: C_MEAN,
                padding: [2, 4],
                borderRadius: 2,
                formatter: `${s.name}均值 ${indicator.unit === 'pct' ? `${st.mean.toFixed(1)}%` : indicator.unit === 'wan' ? fmtWan(st.mean) : st.mean.toFixed(1)}`,
              },
            },
          ];
        })(),
      },
    });

    series.push(mk(primary, C_PRIMARY, true));
    if (compare && compare.periodLabels.length > 0) {
      series.push(mk(compare, C_COMPARE, false));
    }

    return {
      animation: false,
      color: [C_PRIMARY, C_COMPARE],
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(255,255,255,0.97)',
        borderColor: '#e2e8f0',
        textStyle: { color: '#0f172a', fontSize: 12 },
        valueFormatter: (v: number | null) => (v === null || v === undefined ? '--' : fmtVal(v, indicator.unit)),
      },
      legend: {
        top: 0,
        right: 0,
        itemWidth: 14,
        itemHeight: 8,
        textStyle: { fontSize: 11, color: '#64748b' },
      },
      grid: { left: 56, right: 20, top: 30, bottom: 26 },
      xAxis: {
        type: 'category',
        data: labels,
        boundaryGap: false,
        axisLine: { lineStyle: { color: '#cbd5e1' } },
        axisLabel: { color: '#94a3b8', fontSize: 10 },
        axisTick: { show: false },
      },
      yAxis: {
        scale: true,
        axisLine: { show: false },
        axisLabel: { color: '#94a3b8', fontSize: 10, formatter: yFmt(indicator.unit) },
        splitLine: { lineStyle: { color: '#f1f5f9' } },
      },
      series,
    };
  }, [primary, compare, indicator]);

  const stA = stats(primary.values);
  const stB = compare ? stats(compare.values) : null;
  const unitSuffix = indicator.unit === 'pct' ? '%' : '';
  const unitStr = String(indicator.unit);

  return (
    <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
      {/* 统计卡（主公司口径，对齐参考图左栏） */}
      <div className="space-y-3">
        <div>
          <div className="text-xs text-slate-500">当前值</div>
          <div className="text-2xl font-semibold tabular" style={{ color: C_PRIMARY }}>
            {stA ? fmtVal(stA.current, unitStr) : '--'}
          </div>
        </div>
        <div className="space-y-1 text-xs">
          <div className="mb-1 font-medium text-slate-700">统计数据（{primary.name}）</div>
          {stA ? (
            <StatRows st={stA} unit={unitStr} />
          ) : (
            <div className="text-slate-400">暂无数据</div>
          )}
        </div>
        {stB && (
          <div className="space-y-1 border-t border-slate-100 pt-2 text-xs">
            <div className="mb-1 font-medium text-slate-700">对比（{compare!.name}）</div>
            <StatRows st={stB} unit={unitStr} color={C_COMPARE} />
          </div>
        )}
      </div>

      <EChart option={option} height={height} />
    </div>
  );
}

function StatRows({
  st,
  unit,
  color,
}: {
  st: NonNullable<ReturnType<typeof stats>>;
  unit: string;
  color?: string;
}) {
  const rows = [
    ['最大值', st.max],
    ['中位数', st.median],
    ['最小值', st.min],
    ['平均值', st.mean],
  ] as const;
  return (
    <>
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between">
          <span className="text-slate-500">{k}</span>
          <span className="tabular font-medium" style={{ color: color ?? '#334155' }}>
            {fmtVal(v, unit)}
          </span>
        </div>
      ))}
    </>
  );
}
