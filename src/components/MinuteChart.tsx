'use client';

import { useMemo } from 'react';
import EChart from './EChart';
import type { MinutePoint } from '@/lib/datasource/types';
import { intervalVolumes } from '@/lib/marketDataIntegrity';

export interface MinuteChartProps {
  points: MinutePoint[];
  prevClose: number | null;
  height?: number;
}

/** 当日分时：价格线 + 均价线 + 分钟成交量，昨收为基准轴 */
export default function MinuteChart({ points, prevClose, height = 300 }: MinuteChartProps) {
  const option = useMemo(() => {
    const times = points.map((p) => p.time);
    const prices = points.map((p) => p.price);
    // 均价 = 累计成交额 / 累计成交量（元/股）
    const avg = points.map((p) => (p.volume > 0 ? p.amount / (p.volume * 100) : null));
    const interval = intervalVolumes(points);
    const vols = points.map((p, i) => ({
      value: interval[i],
      itemStyle: {
        color:
          i === 0 ? 'rgba(148,163,184,0.5)' : prices[i] >= prices[i - 1] ? 'rgba(239,68,68,0.5)' : 'rgba(16,185,129,0.5)',
      },
    }));

    const min = Math.min(...prices, prevClose ?? Infinity);
    const max = Math.max(...prices, prevClose ?? -Infinity);
    const pad = (max - min) * 0.08 || 0.01;

    return {
      animation: false,
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(255,255,255,0.96)',
        borderColor: '#e2e8f0',
        textStyle: { color: '#0f172a', fontSize: 12 },
      },
      grid: [
        { left: 56, right: 24, top: 20, height: '62%' },
        { left: 56, right: 24, top: '76%', bottom: 28 },
      ],
      xAxis: [
        {
          type: 'category',
          data: times,
          axisLabel: { color: '#94a3b8', fontSize: 10, interval: Math.floor(times.length / 6) },
          axisLine: { lineStyle: { color: '#cbd5e1' } },
        },
        {
          type: 'category',
          gridIndex: 1,
          data: times,
          axisLabel: { show: false },
          axisTick: { show: false },
          axisLine: { lineStyle: { color: '#cbd5e1' } },
        },
      ],
      yAxis: [
        {
          scale: true,
          min: Number((min - pad).toFixed(2)),
          max: Number((max + pad).toFixed(2)),
          axisLine: { show: false },
          axisLabel: {
            color: '#94a3b8',
            fontSize: 11,
            formatter: (v: number) =>
              prevClose ? `${(((v - prevClose) / prevClose) * 100).toFixed(2)}%` : v.toFixed(2),
          },
          splitLine: { lineStyle: { color: '#f1f5f9' } },
        },
        {
          gridIndex: 1,
          axisLabel: { show: false },
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: '价格',
          type: 'line',
          data: prices,
          symbol: 'none',
          lineStyle: { width: 1.4, color: '#2563eb' },
          areaStyle: { color: 'rgba(37,99,235,0.08)' },
          markLine: prevClose
            ? {
                silent: true,
                symbol: 'none',
                lineStyle: { color: '#94a3b8', type: 'dashed' },
                label: { show: false },
                data: [{ yAxis: prevClose }],
              }
            : undefined,
        },
        { name: '均价', type: 'line', data: avg, symbol: 'none', lineStyle: { width: 1, color: '#f59e0b' } },
        { name: '分钟成交量（百股）', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: vols },
      ],
    };
  }, [points, prevClose]);

  return <EChart option={option} height={height} />;
}
