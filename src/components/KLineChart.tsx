'use client';

import { useMemo } from 'react';
import EChart from './EChart';
import type { Candle } from '@/lib/datasource/types';

export interface KLineChartProps {
  candles: Candle[];
  title?: string;
  height?: number;
  /** 是否显示成交量副图 */
  showVolume?: boolean;
}

/** 计算简单移动均线 */
function ma(values: number[], n: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    out.push(i >= n - 1 ? Number((sum / n).toFixed(3)) : null);
  }
  return out;
}

/**
 * K 线主图（蜡烛 + MA5/20/60）+ 成交量副图 + 区间缩放。
 * 颜色遵循 A 股习惯：涨红跌绿。
 */
export default function KLineChart({ candles, title, height = 420, showVolume = true }: KLineChartProps) {
  const option = useMemo(() => {
    const dates = candles.map((c) => c.date);
    // ECharts candlestick 数据序： [open, close, low, high]
    const ohlc = candles.map((c) => [c.open, c.close, c.low, c.high]);
    const closes = candles.map((c) => c.close);
    const volumes = candles.map((c, i) => ({
      value: c.volume,
      itemStyle: { color: c.close >= c.open ? 'rgba(239,68,68,0.55)' : 'rgba(16,185,129,0.55)' },
      _i: i,
    }));

    const ma5 = ma(closes, 5);
    const ma20 = ma(closes, 20);
    const ma60 = ma(closes, 60);

    const series: Record<string, unknown>[] = [
      {
        name: 'K线',
        type: 'candlestick',
        data: ohlc,
        itemStyle: {
          color: '#ef4444',
          color0: '#10b981',
          borderColor: '#ef4444',
          borderColor0: '#10b981',
        },
      },
      { name: 'MA5', type: 'line', data: ma5, smooth: true, symbol: 'none', lineStyle: { width: 1 } },
      { name: 'MA20', type: 'line', data: ma20, smooth: true, symbol: 'none', lineStyle: { width: 1 } },
      { name: 'MA60', type: 'line', data: ma60, smooth: true, symbol: 'none', lineStyle: { width: 1 } },
    ];

    if (showVolume) {
      series.push({
        name: '成交量（百股）',
        type: 'bar',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: volumes,
      });
    }

    return {
      animation: false,
      title: title
        ? { text: title, left: 8, top: 4, textStyle: { fontSize: 13, fontWeight: 500, color: '#475569' } }
        : undefined,
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        backgroundColor: 'rgba(255,255,255,0.96)',
        borderColor: '#e2e8f0',
        textStyle: { color: '#0f172a', fontSize: 12 },
      },
      legend: {
        data: ['K线', 'MA5', 'MA20', 'MA60'],
        top: 4,
        right: 8,
        itemWidth: 14,
        itemHeight: 8,
        textStyle: { fontSize: 11, color: '#64748b' },
      },
      grid: showVolume
        ? [
            { left: 56, right: 24, top: 36, height: '58%' },
            { left: 56, right: 24, top: '76%', bottom: 44 },
          ]
        : [{ left: 56, right: 24, top: 36, bottom: 44 }],
      xAxis: showVolume
        ? [
            {
              type: 'category',
              data: dates,
              boundaryGap: true,
              axisLine: { lineStyle: { color: '#cbd5e1' } },
              axisLabel: { color: '#94a3b8', fontSize: 11 },
              splitLine: { show: false },
            },
            {
              type: 'category',
              gridIndex: 1,
              data: dates,
              axisLabel: { show: false },
              axisTick: { show: false },
              axisLine: { lineStyle: { color: '#cbd5e1' } },
            },
          ]
        : [
            {
              type: 'category',
              data: dates,
              axisLine: { lineStyle: { color: '#cbd5e1' } },
              axisLabel: { color: '#94a3b8', fontSize: 11 },
            },
          ],
      yAxis: showVolume
        ? [
            {
              scale: true,
              position: 'left',
              axisLine: { show: false },
              axisLabel: { color: '#94a3b8', fontSize: 11, formatter: (v: number) => v.toFixed(2) },
              splitLine: { lineStyle: { color: '#f1f5f9' } },
            },
            {
              gridIndex: 1,
              scale: true,
              axisLabel: { show: false },
              axisLine: { show: false },
              axisTick: { show: false },
              splitLine: { show: false },
            },
          ]
        : [
            {
              scale: true,
              axisLine: { show: false },
              axisLabel: { color: '#94a3b8', fontSize: 11, formatter: (v: number) => v.toFixed(2) },
              splitLine: { lineStyle: { color: '#f1f5f9' } },
            },
          ],
      dataZoom: [
        { type: 'inside', xAxisIndex: showVolume ? [0, 1] : [0], start: 40, end: 100 },
        {
          type: 'slider',
          xAxisIndex: showVolume ? [0, 1] : [0],
          start: 40,
          end: 100,
          height: 20,
          bottom: 12,
          borderColor: '#e2e8f0',
          fillerColor: 'rgba(37,99,235,0.08)',
          handleStyle: { color: '#94a3b8' },
          textStyle: { color: '#94a3b8', fontSize: 10 },
        },
      ],
      series,
    };
  }, [candles, title, showVolume]);

  return <EChart option={option} height={height} />;
}
