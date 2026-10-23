'use client';

import { useEffect, useMemo, useState } from 'react';
import { fetchJson } from '@/lib/fetchJson';
import EChart from './EChart';

import type {
  Valuation as ValuationResp,
  ValuationPoint,
} from '@/lib/datasource/types';

type Metric = 'pe' | 'pb' | 'dy';
const recentResults = new Map<string,{at:number;value:ValuationResp}>();

const METRICS: {
  key: Metric;
  label: string;
  unit: string;
  rightAxis: boolean;
}[] = [
  { key: 'pe', label: 'PE-TTM', unit: '倍', rightAxis: true },
  { key: 'pb', label: 'PB', unit: '倍', rightAxis: true },
  { key: 'dy', label: '股息率', unit: '%', rightAxis: true },
];

interface Stats {
  cur: number | null;
  pct: number | null;
  p80: number;
  p50: number;
  p20: number;
  max: number;
  mean: number;
  min: number;
}

/** 理杏仁式统计：当前值 / 当前分位 / 80、50、20 分位 / 最大 / 平均 / 最小（均在所选区间内计算） */
function computeStats(
  vals: (number | null)[],
  cur: number | null,
): Stats | null {
  const list = vals.filter(
    (v): v is number => v !== null && Number.isFinite(v),
  );
  if (list.length < 10) return null;
  const sorted = [...list].sort((a, b) => a - b);
  const q = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const mean = list.reduce((a, b) => a + b, 0) / list.length;
  let pct: number | null = null;
  if (cur !== null && Number.isFinite(cur)) {
    const below = sorted.filter((v) => v < cur).length;
    pct = (below / sorted.length) * 100;
  }
  return {
    cur,
    pct,
    p80: q(0.8),
    p50: q(0.5),
    p20: q(0.2),
    max: sorted[sorted.length - 1],
    mean,
    min: sorted[0],
  };
}

function pctColor(p: number | null): string {
  if (p === null) return 'text-slate-400';
  if (p < 20) return 'text-blue-600';
  if (p < 50) return 'text-sky-600';
  if (p < 80) return 'text-orange-500';
  return 'text-red-600';
}

function StatPanel({
  title,
  unit,
  stats,
  historicalSample = false,
}: {
  title: string;
  unit: string;
  stats: Stats;
  historicalSample?: boolean;
}) {
  const items: { label: string; value: string; cls?: string }[] = [
    {
      label: historicalSample ? '样本末值' : '当前值',
      value: stats.cur === null ? '--' : stats.cur.toFixed(2),
    },
    {
      label: historicalSample ? '末值分位点' : '当前分位点',
      value: stats.pct === null ? '--' : `${stats.pct.toFixed(2)}%`,
      cls: pctColor(stats.pct),
    },
    { label: '80%分位值', value: stats.p80.toFixed(2), cls: 'text-red-600' },
    { label: '50%分位值', value: stats.p50.toFixed(2), cls: 'text-slate-700' },
    {
      label: '20%分位值',
      value: stats.p20.toFixed(2),
      cls: 'text-emerald-600',
    },
    { label: '最大值', value: stats.max.toFixed(2), cls: 'text-red-600' },
    { label: '平均值', value: stats.mean.toFixed(2), cls: 'text-slate-700' },
    { label: '最小值', value: stats.min.toFixed(2), cls: 'text-emerald-600' },
  ];
  return (
    <div className="grid w-full grid-cols-2 gap-x-5 lg:block lg:w-40 lg:shrink-0 lg:space-y-1">
      <div className="col-span-2 mb-2 text-sm font-semibold text-slate-900">
        {title}
        {unit && (
          <span className="ml-1 text-xs font-normal text-slate-400">
            ({unit})
          </span>
        )}
      </div>
      {items.map((it) => (
        <div
          key={it.label}
          className="flex items-baseline justify-between gap-2 border-b border-dashed border-slate-100 py-1"
        >
          <span className="text-xs text-slate-500">{it.label}</span>
          <span
            className={`text-sm font-semibold tabular-nums ${it.cls ?? 'text-slate-800'}`}
          >
            {it.value}
          </span>
        </div>
      ))}
    </div>
  );
}

function MetricChart({
  history,
  metric,
  stats,
  picked,
  onPick,
  overlay,
  dividendLabel = '预期股息率',
  priceLabel = '前复权收盘价(右轴)',
  currentLabel = '当前',
}: {
  history: ValuationPoint[];
  metric: Metric;
  stats: Stats;
  /** 用户点选的理解钉（交易日 + 数值），null 表示未选 */
  picked: { date: string; value: number | null } | null;
  onPick: (p: { date: string; value: number | null }) => void;
  /** 对照口径序列（用于「叠加对比」） */
  overlay?: { values: (number | null)[]; label: string } | null;
  dividendLabel?: string;
  priceLabel?: string;
  currentLabel?: string;
}) {
  const conf = METRICS.find((m) => m.key === metric)!;
  const option = useMemo(() => {
    const dates = history.map((h) => h.date);
    const vals = history.map((h) =>
      metric === 'pe' ? h.pe : metric === 'pb' ? h.pb : h.dy,
    );
    const closes = history.map((h) => h.close);
    const name = metric === 'dy' ? dividendLabel : conf.label;

    const mkLine = (
      yAxis: number,
      color: string,
      label: string,
      type: 'dotted' | 'dashed',
    ) => ({
      yAxis,
      lineStyle: { color, type, width: 1 },
      label: {
        formatter: label,
        fontSize: 10,
        color,
        position: 'insideEndTop' as const,
      },
    });

    // 点选处的十字参考线（横向=该日数值，纵向=该日期）
    const pickLines =
      picked && picked.value !== null
        ? [
            {
              yAxis: picked.value,
              lineStyle: { color: '#0ea5e9', type: 'solid' as const, width: 1 },
              label: {
                formatter: `${picked.date}｜${picked.value.toFixed(2)}`,
                fontSize: 10,
                color: '#0284c7',
                position: 'insideEndBottom' as const,
              },
            },
            {
              xAxis: picked.date,
              lineStyle: {
                color: '#0ea5e9',
                type: 'dashed' as const,
                width: 1,
              },
              label: { show: false },
            },
          ]
        : [];

    const series: Record<string, unknown>[] = [
      {
        name,
        type: 'line',
        data: vals,
        yAxisIndex: 0,
        symbol: 'none',
        lineStyle: { width: 1.5, color: '#2563eb' },
        itemStyle: { color: '#2563eb' },
        markLine: {
          silent: true,
          symbol: 'none',
          data: [
            mkLine(
              stats.p80,
              '#ef4444',
              `80%分位 ${stats.p80.toFixed(2)}`,
              'dotted',
            ),
            mkLine(
              stats.p50,
              '#64748b',
              `50%分位 ${stats.p50.toFixed(2)}`,
              'dashed',
            ),
            mkLine(
              stats.p20,
              '#10b981',
              `20%分位 ${stats.p20.toFixed(2)}`,
              'dotted',
            ),
            ...(stats.cur !== null
              ? [
                  {
                    yAxis: stats.cur,
                    lineStyle: {
                      color: '#2563eb',
                      type: 'solid' as const,
                      width: 1,
                      opacity: 0.35,
                    },
                    label: {
                      formatter: `${currentLabel} ${stats.cur.toFixed(2)}`,
                      fontSize: 10,
                      color: '#2563eb',
                      position: 'insideEndBottom' as const,
                    },
                  },
                ]
              : []),
            ...pickLines,
          ],
        },
      },
    ];

    if (overlay) {
      series.push({
        name: overlay.label,
        type: 'line',
        data: overlay.values,
        yAxisIndex: 0,
        symbol: 'none',
        lineStyle: { width: 1, color: '#94a3b8', type: 'dashed' },
        itemStyle: { color: '#94a3b8' },
      });
    }

    series.push({
      name: priceLabel,
      type: 'line',
      data: closes,
      yAxisIndex: 1,
      symbol: 'none',
      lineStyle: { width: 1.1, color: '#f59e0b' },
      itemStyle: { color: '#f59e0b' },
    });

    return {
      animation: false,
      tooltip: {
        trigger: 'axis',
        confine: true,
        backgroundColor: 'rgba(255,255,255,0.96)',
        borderColor: '#e2e8f0',
        textStyle: { color: '#0f172a', fontSize: 12 },
        valueFormatter: (value: unknown) =>
          typeof value === 'number' ? value.toFixed(2) : '--',
      },
      legend: {
        top: 0,
        left: 'center',
        itemWidth: 14,
        itemHeight: 8,
        textStyle: { fontSize: 11, color: '#64748b' },
        data: [name, ...(overlay ? [overlay.label] : []), priceLabel],
      },
      grid: {
        left: 8,
        right: 8,
        top: overlay ? 48 : 32,
        bottom: 36,
        containLabel: true,
      },
      xAxis: {
        type: 'category',
        data: dates,
        axisLine: { lineStyle: { color: '#cbd5e1' } },
        axisLabel: { color: '#64748b', fontSize: 11, hideOverlap: true },
      },
      yAxis: [
        {
          type: 'value',
          scale: true,
          axisLine: { show: false },
          axisLabel: {
            color: '#64748b',
            fontSize: 11,
            formatter: (v: number) => v.toFixed(v >= 100 ? 0 : 1),
          },
          splitLine: { lineStyle: { color: '#f1f5f9' } },
        },
        {
          type: 'value',
          scale: true,
          axisLine: { show: false },
          splitLine: { show: false },
          axisLabel: {
            color: '#f59e0b',
            fontSize: 11,
            formatter: (v: number) => v.toFixed(v >= 100 ? 0 : 1),
          },
        },
      ],
      dataZoom: [
        { type: 'inside', start: 0, end: 100 },
        {
          type: 'slider',
          start: 0,
          end: 100,
          height: 16,
          bottom: 6,
          borderColor: '#e2e8f0',
          fillerColor: 'rgba(37,99,235,0.08)',
          textStyle: { color: '#94a3b8', fontSize: 10 },
        },
      ],
      series,
    };
  }, [history, metric, stats, conf.label, picked, overlay, dividendLabel, priceLabel, currentLabel]);

  return (
    <div>
      <EChart
        option={option}
        height={360}
        onPointClick={(e) => onPick({ date: e.name, value: null })}
      />
    </div>
  );
}

export default function ValuationSection({ code }: { code: string }) {
  const [selected, setSelected] = useState<Metric>('pe');
  const [years, setYears] = useState<5 | 10 | 12>(12);
  const [data, setData] = useState<ValuationResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  /** 点选的理解钉（每个指标一个） */
  const [pins, setPins] = useState<Record<Metric, string | null>>({
    pe: null,
    pb: null,
    dy: null,
  });
  /** 叠加另一种口径（对照） */
  const [overlayOn, setOverlayOn] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller=new AbortController();
    const key=`${code}:${years}`,saved=recentResults.get(key);
    const previous=saved && Date.now()-saved.at<30*60e3?saved.value:null;
    let displayed=!!previous;
    setLoading(!previous);
    setData(previous);
    setErr(null);
    const load = (attempt: number, refreshes=0) => {
      fetchJson(`/api/valuation?code=${encodeURIComponent(code)}&years=${years}`,{signal:controller.signal,cache:'no-store'})
        .then((j) => {
          if (!alive) return;
          if (j.ok) {
            setData(j.data as ValuationResp);
            displayed=true;
            recentResults.delete(key);recentResults.set(key,{at:Date.now(),value:j.data});
            while(recentResults.size>20)recentResults.delete(recentResults.keys().next().value!);
            setLoading(false);
            if(j.data.historyCache?.state==='updating' && refreshes<4)timer=setTimeout(()=>load(1,refreshes+1),3000);
            return;
          }
          throw new Error(j.error ?? '估值数据加载失败');
        })
        .catch((e) => {
          if (!alive) return;
          // 上游行情源偶发被拦截（WAF 501 / 限频）：稍候自动重试，避免整块报错
          if (attempt < 2) {
            timer = setTimeout(() => load(attempt + 1,refreshes), 1500);
            return;
          }
          if(!displayed)setErr(e instanceof Error ? e.message : String(e));
          setLoading(false);
        });
    };
    load(1);
    return () => {
      alive = false;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [code, years]);

  const panels = useMemo(() => {
    if (!data) return [];
    return METRICS.map((m) => {
      const vals = (data.historyByMetric?.[m.key] ?? data.history).map((h) =>
        m.key === 'pe' ? h.pe : m.key === 'pb' ? h.pb : h.dy,
      );
      const cur =
        m.key === 'pe'
          ? data.pe
          : m.key === 'pb'
            ? data.pb
            : data.dividendYield;
      // 优先用服务端统计（算法一致、口径统一），缺失时前端兜底计算
      const srv = data.stats?.[m.key];
      if (srv && srv.count >= 10 && srv.p50 !== null) {
        const stats: Stats = {
          cur: data.historyBasis === 'provider' && m.key !== 'dy' ? srv.current : srv.current ?? cur,
          pct: srv.percentile,
          p80: srv.p80 ?? 0,
          p50: srv.p50,
          p20: srv.p20 ?? 0,
          max: srv.max ?? 0,
          mean: srv.avg ?? 0,
          min: srv.min ?? 0,
        };
        return { ...m, stats };
      }
      return { ...m, stats: computeStats(vals, cur) };
    });
  }, [data]);

  const current = panels.find((p) => p.key === selected);
  const selectedHistory = data?.historyByMetric?.[selected] ?? data?.history ?? [];
  const providerSamples = data?.historyBasis === 'provider' && selected !== 'dy';
  const availableOverlay = useMemo(() => {
    if (!data?.alt?.history.length) return null;
    const byDate = new Map(
      data.alt.history.map((point) => [point.date, point]),
    );
    const values = data.history.map((point) => {
      const alternate = byDate.get(point.date);
      const value = alternate?.[selected];
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    });
    if (!values.some((value) => value !== null)) return null;
    return {
      label: data.alt.method === 'cutoff' ? '截止日切换口径' : '当日披露口径',
      values,
    };
  }, [data, selected]);
  const dividendLabel = data?.dividendYieldMethod === 'hk-static'
    ? '股息率（静态）'
    : data?.dividendYieldMethod === 'announced-forward' ? '预期股息率' : '股息率';
  const dividendTitle = data?.dividendYieldMethod === 'hk-static'
    ? `${data.dividendFiscalYear ?? '暂无完整'}财年已实施现金股息 ÷ 当前股价；每股 ${data.dividendPerShare?.total?.toFixed(6) ?? '—'} 港元，其中普通 ${data.dividendPerShare?.ordinary?.toFixed(6) ?? '—'}、特别 ${data.dividendPerShare?.special?.toFixed(6) ?? '—'} 港元。`
    : '预期股息率：在该时间点买入后，未来一年预计税前股息收入占买入金额的比例。';
  return (
    <section id="valuation" aria-label="估值分析" aria-busy={loading}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="section-title">估值分析</h2>
        </div>
        <div className="segmented" role="group" aria-label="估值统计区间">
          {([5, 10, 12] as const).map((y) => (
            <button
              key={y}
              onClick={() => setYears(y)}
              aria-pressed={years === y}
              className={`segment ${years === y ? 'segment-active' : ''}`}
            >
              近{y}年
            </button>
          ))}
        </div>
      </div>
      {data?.historyCache?.state==='updating' && <p role="status" className="mb-2 text-xs text-slate-500">已显示上次生成的走势，后台正在刷新；数据截至日期见图表下方。</p>}
      {loading && (
        <div
          role="status"
          className="card-pad flex min-h-[420px] flex-col items-center justify-center gap-3 text-sm text-slate-500"
        >
          <span className="h-7 w-7 animate-spin rounded-full border-2 border-slate-200 border-t-brand-600 motion-reduce:animate-none" />
          正在加载近 {years} 年估值数据…
        </div>
      )}
      {err && (
        <div role="alert" className="card-pad text-sm text-red-600">
          {err}
        </div>
      )}
      {!loading && !err && data && (
        <div className="space-y-3">
          <div
            className="grid grid-cols-3 gap-2 sm:gap-3"
            role="group"
            aria-label="估值指标"
          >
            {panels.map((p) => (
              <button
                key={p.key}
                onClick={() => setSelected(p.key)}
                aria-pressed={selected === p.key}
                aria-controls="valuation-chart"
                className={`min-w-0 rounded-xl border p-2.5 text-left transition sm:p-4 ${selected === p.key ? 'border-brand-500 bg-white ring-1 ring-brand-500' : 'border-slate-200 bg-white hover:border-slate-400'}`}
              >
                <div className="flex items-center justify-between gap-1 text-xs font-medium text-slate-500 sm:text-sm">
                  <span>
                    {p.key === 'dy' ? dividendLabel : p.label}
                  </span>
                  <span
                    className={`hidden h-1.5 w-1.5 rounded-full sm:block ${selected === p.key ? 'bg-brand-600' : 'bg-slate-200'}`}
                  />
                </div>
                <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 tabular-nums">
                  <span
                    className={`inline-flex max-w-full flex-wrap items-baseline text-xl font-semibold tracking-tight sm:text-3xl ${p.key === 'dy' ? 'text-brand-600' : 'text-slate-900'}`}
                    title={
                      p.key === 'dy' ? dividendTitle : undefined
                    }
                  >
                    {(p.key === 'dy'
                      ? data.dividendYield
                      : p.key === 'pe'
                        ? data.pe
                        : data.pb
                    )?.toFixed(2) ?? '--'}
                    <span
                      className={`ml-0.5 text-xs font-normal ${p.key === 'dy' ? 'text-brand-600' : 'text-slate-500'}`}
                    >
                      {p.unit}
                    </span>
                  </span>
                  {p.key === 'dy' &&
                    data.dividendYieldMethod === 'announced-forward' && (
                      <span
                        className="max-w-full text-[11px] text-slate-500 sm:text-xs"
                        title="静态：过去十二个月已实施的税前现金分红占同日股价的比例。"
                      >
                        （静{' '}
                        <span className="font-medium text-red-500">
                          {data.staticDividendYield?.toFixed(2) ?? '--'}%
                        </span>
                        ）
                      </span>
                    )}
                </div>
                <div className="mt-2 text-[11px] text-slate-500 sm:text-xs">
                  {p.key === 'dy' && data.dividendYieldMethod === 'hk-static'
                    ? <span title={dividendTitle}>{data.dividendFiscalYear ? `${data.dividendFiscalYear}财年` : '暂无完整财年'}{(data.dividendPerShare?.special ?? 0) > 0 ? ' · 含特别现金息' : ''}</span>
                    : <span title={data.historyBasis === 'provider' ? `历史样本末值 ${data.stats?.[p.key].current ?? '--'}，截至 ${data.historyMetricAsOf?.[p.key] ?? '--'}；与上方当前估值可能采用不同口径。` : undefined}>
                      {data.historyBasis === 'provider' ? '历史末值分位' : '历史分位'}{' '}<span className="font-medium tabular-nums text-brand-600">
                      {p.stats?.pct == null ? '--' : p.stats.pct.toFixed(1) + '%'}
                    </span></span>}
                </div>
              </button>
            ))}
          </div>
          <div id="valuation-chart" className="card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-3 sm:px-4">
              <div className="flex items-center gap-3">
                <h3 className="font-semibold text-slate-900">
                  {current?.key === 'dy'
                    ? dividendLabel
                    : current?.label}{' '}
                  历史走势
                </h3>
                <span className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-500">
                  {providerSamples ? '源端历史估值' : data.priceAdjust === 'qfq' ? '价格前复权' : data.priceAdjust === 'none' ? '价格不复权' : '当前估值'}
                </span>
              </div>
              {availableOverlay && current?.stats && (
                <button
                  onClick={() => setOverlayOn((v) => !v)}
                  aria-pressed={overlayOn}
                  className={`min-h-10 text-xs font-medium underline-offset-4 hover:underline sm:min-h-8 ${overlayOn ? 'text-brand-600' : 'text-slate-500'}`}
                  title="叠加截止日切换与真实披露口径，比较估值差异"
                >
                  {overlayOn ? '关闭口径对比' : '对比计算口径'}
                </button>
              )}
            </div>
            {current?.stats ? (
              <div className="flex flex-col-reverse gap-4 p-3 sm:p-4 lg:flex-row">
                <div className="border-t border-slate-100 pt-3 lg:border-r lg:border-t-0 lg:pr-4 lg:pt-0">
                  <StatPanel
                    title="区间统计"
                    unit={current.unit}
                    stats={current.stats}
                    historicalSample={providerSamples}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <MetricChart
                    history={selectedHistory}
                    metric={current.key}
                    dividendLabel={
                      dividendLabel
                    }
                    stats={current.stats}
                    priceLabel={data.priceAdjust === 'none' ? '不复权收盘价(右轴)' : '前复权收盘价(右轴)'}
                    currentLabel={providerSamples ? '样本末值' : '当前'}
                    picked={(() => {
                      const date = pins[current.key];
                      if (!date) return null;
                      const row = selectedHistory.find((h) => h.date === date);
                      return {
                        date,
                        value: row
                          ? current.key === 'pe'
                            ? row.pe
                            : current.key === 'pb'
                              ? row.pb
                              : row.dy
                          : null,
                      };
                    })()}
                    onPick={(x) =>
                      setPins((prev) => ({
                        ...prev,
                        [current.key]:
                          prev[current.key] === x.date ? null : x.date,
                      }))
                    }
                    overlay={overlayOn ? availableOverlay : null}
                  />
                  <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-500">
                    <span>
                      <i className="mr-1.5 inline-block w-4 border-t border-dotted border-emerald-500" />
                      20% 分位
                    </span>
                    <span>
                      <i className="mr-1.5 inline-block w-4 border-t border-dashed border-slate-400" />
                      50% 分位
                    </span>
                    <span>
                      <i className="mr-1.5 inline-block w-4 border-t border-dotted border-red-400" />
                      80% 分位
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex min-h-80 items-center justify-center px-6 text-sm text-slate-500">
                {data.historyUnavailableReasons?.[selected] ?? data.historyUnavailableReason ??
                  '该区间有效数据不足，暂无法展示统计结果。'}
              </div>
            )}
            <div className="flex flex-wrap justify-between gap-2 border-t border-slate-100 bg-slate-50/50 px-3 py-2 text-xs text-slate-500 sm:px-4">
              <span>
                统计区间 {selectedHistory[0]?.date ?? data.stats?.from ?? '--'} 至 {selectedHistory.at(-1)?.date ?? data.stats?.to ?? '--'}
              </span>
              <span>{providerSamples ? '历史估值：百度股市通 · 按源端样本统计' : data.historyBasis === 'provider' ? '已实施完整财年现金分红 ÷ 不复权价格' : '估值由已披露财报复算'} · 截至 {data.historyMetricAsOf?.[selected] ?? data.stats?.to ?? '--'}</span>
            </div>
          </div>

          <details className="card px-3 py-3 text-xs leading-6 text-slate-500 sm:px-4">
            <summary className="font-medium text-slate-700">
              数据来源与计算说明
            </summary>
            {data.warnings?.length ? (
              <ul className="mt-3">
                {data.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            ) : null}
            {data.marketComparison && (
              <p className="mt-4">
                行情接口参考：PE {data.marketComparison.pe?.toFixed(2) ?? '--'}{' '}
                / PB {data.marketComparison.pb?.toFixed(2) ?? '--'}
                （与财报复算口径分别展示）
              </p>
            )}
            {!data.source.includes('hkf10') && (
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                <li>
                  价格曲线使用<b>前复权收盘价</b>
                  。EPS、每股净资产按同一复权因子换算后计算
                  PE、PB，复权前后的估值比率保持一致。
                </li>
                <li>
                  <b>PE-TTM</b>{' '}
                  使用归母净利润最近四个单季之和及交易日实际总股数。Q1 TTM =
                  今年Q1 + 上年年报 − 上年Q1。亏损或缺失利润时不显示 PE。
                </li>
                <li>
                  <b>PB</b> 使用归母净资产扣除其他权益工具后的普通股净资产；与
                  PE 分别计算。
                </li>
                <li>
                  <b>股息率</b>{' '}
                  默认显示预期值：以当时已公布、金额明确的分红方案延续最近一个报告年度周期的派息水平，估计买入后未来一年的税前股息收入占比；曲线与分位使用相同口径。
                  从公告次日起纳入。同一报告期的新方案替换旧方案；明确不分红为
                  0，金额未确定或数据缺失显示空值；旧方案超过公告周年三个月仍未更新则停止外推。已除息的特别分红不重复预测。
                  <b>（静）</b>{' '}
                  是过去十二个月已实施税前现金分红除以同日不复权收盘价，送转后的每股分红按股数调整。
                  两种股息率均用不复权价格与名义每股分红匹配，不直接以现金分红除以前复权价。当前值按最近交易日收盘计算。
                  方案延续属于估计；数据源不提供完整历次修订快照，历史分红金额可能包含后续修订，不用于严格时点回测。
                </li>
                <li>
                  <b>财报生效</b>：
                  {data.method === 'cutoff'
                    ? '法定截止日与实际公告次日取较晚者。'
                    : '真实公告次日起，使用最新已披露报告。'}
                  未取得原始公告日期的报告不建立新估值点，且缺失期间停止沿用该报告前的数据。
                </li>
                <li>
                  统计区间 {data.stats?.from ?? '--'} ~ {data.stats?.to ?? '--'}
                  ；PE / PB / 股息率有效样本分别为 {data.stats?.pe.count ??
                    0} / {data.stats?.pb.count ?? 0} /{' '}
                  {data.stats?.dy.count ?? 0}。分位 =
                  严格低于当前值的有效交易日数 ÷ 有效样本数。
                </li>
                <li>
                  当前值与整条曲线采用相同财报口径；行情参考值单独列示，可能因股本、权益工具或取数时间不同而有差异。
                </li>
                {data.fin && (
                  <li>
                    最新采用报告期 {data.fin.report ?? '--'}；归母利润 TTM{' '}
                    {data.fin.npTTM?.toFixed(2) ?? '--'} 亿元，报告期总股数{' '}
                    {data.fin.shares?.toFixed(2) ?? '--'}{' '}
                    亿股，报告期普通股每股净资产{' '}
                    {data.fin.bps?.toFixed(2) ?? '--'} 元。覆盖{' '}
                    {data.fin.points} 个报告期。
                  </li>
                )}
              </ul>
            )}

            {data.basis === 'estimate' && (
              <div className="mt-2 text-amber-700">
                财报抓取失败，已降级为估算口径，仅供参考。
              </div>
            )}
          </details>
        </div>
      )}
    </section>
  );
}
