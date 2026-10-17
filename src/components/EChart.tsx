'use client';

import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, CandlestickChart, LineChart, ScatterChart } from 'echarts/charts';
import {
  AxisPointerComponent,
  DataZoomComponent,
  GraphicComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  BarChart,
  CandlestickChart,
  LineChart,
  ScatterChart,
  AxisPointerComponent,
  DataZoomComponent,
  GraphicComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

export interface EChartProps {
  option: echarts.EChartsCoreOption;
  height?: number | string;
  className?: string;
  /** 依赖变化时重新 setOption（默认整个 option 引用变化即刷新） */
  onReady?: (chart: echarts.ECharts) => void;
  /** 点击画布回调（x 轴类目名 + 像素坐标），用于「点图钉画参考线」 */
  onPointClick?: (e: { name: string; px: number; py: number }) => void;
}

/**
 * ECharts 通用容器：按需注册组件、随容器尺寸自适应、卸载时销毁实例。
 * 只在客户端渲染，避免 SSR 阶段访问 DOM。
 */
export default function EChart({ option, height = 360, className, onReady, onPointClick }: EChartProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const instRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!boxRef.current) return;
    const chart = echarts.init(boxRef.current, undefined, { renderer: 'canvas' });
    instRef.current = chart;
    onReady?.(chart);

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(boxRef.current);

    const onClick = (p: unknown) => {
      const e = p as { name?: string; event?: { offsetX?: number; offsetY?: number } };
      if (!onPointClick || !e?.name) return;
      onPointClick({ name: String(e.name), px: e.event?.offsetX ?? 0, py: e.event?.offsetY ?? 0 });
    };
    chart.on('click', onClick);

    return () => {
      ro.disconnect();
      chart.off('click', onClick);
      chart.dispose();
      instRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    instRef.current?.setOption(option, true);
  }, [option]);

  return <div ref={boxRef} style={{ height, width: '100%' }} className={className} />;
}
