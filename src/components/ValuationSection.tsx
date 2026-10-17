'use client';

import { useEffect, useMemo, useState } from 'react';
import EChart from './EChart';

import type { Valuation as ValuationResp, ValuationPoint } from '@/lib/datasource/types';

type Metric = 'pe' | 'pb' | 'dy';

const METRICS: { key: Metric; label: string; unit: string; rightAxis: boolean }[] = [
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
function computeStats(vals: (number | null)[], cur: number | null): Stats | null {
  const list = vals.filter((v): v is number => v !== null && Number.isFinite(v));
  if (list.length < 10) return null;
  const sorted = [...list].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const mean = list.reduce((a, b) => a + b, 0) / list.length;
  let pct: number | null = null;
  if (cur !== null && Number.isFinite(cur)) {
    const below = sorted.filter((v) => v < cur).length;
    pct = (below / sorted.length) * 100;
  }
  return { cur, pct, p80: q(0.8), p50: q(0.5), p20: q(0.2), max: sorted[sorted.length - 1], mean, min: sorted[0] };
}

function pctColor(p: number | null): string {
  if (p === null) return 'text-slate-400';
  if (p < 20) return 'text-blue-600';
  if (p < 50) return 'text-sky-600';
  if (p < 80) return 'text-orange-500';
  return 'text-red-600';
}

function StatPanel({ title, unit, stats }: { title: string; unit: string; stats: Stats }) {
  const items: { label: string; value: string; cls?: string }[] = [
    { label: '当前值', value: stats.cur === null ? '--' : stats.cur.toFixed(2) },
    { label: '当前分位点', value: stats.pct === null ? '--' : `${stats.pct.toFixed(2)}%`, cls: pctColor(stats.pct) },
    { label: '80%分位值', value: stats.p80.toFixed(2), cls: 'text-red-600' },
    { label: '50%分位值', value: stats.p50.toFixed(2), cls: 'text-slate-700' },
    { label: '20%分位值', value: stats.p20.toFixed(2), cls: 'text-emerald-600' },
    { label: '最大值', value: stats.max.toFixed(2), cls: 'text-red-600' },
    { label: '平均值', value: stats.mean.toFixed(2), cls: 'text-slate-700' },
    { label: '最小值', value: stats.min.toFixed(2), cls: 'text-emerald-600' },
  ];
  return (
    <div className="w-full shrink-0 space-y-0.5 lg:w-40">
      <div className="text-sm font-semibold text-slate-900">
        {title}
        {unit && <span className="ml-1 text-xs font-normal text-slate-400">({unit})</span>}
      </div>
      {items.map((it) => (
        <div key={it.label} className="flex items-baseline justify-between gap-2 border-b border-dashed border-slate-100 py-1">
          <span className="text-[11px] text-slate-400">{it.label}</span>
          <span className={`text-xs font-semibold tabular-nums ${it.cls ?? 'text-slate-800'}`}>{it.value}</span>
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
}: {
  history: ValuationPoint[];
  metric: Metric;
  stats: Stats;
  /** 用户点选的理解钉（交易日 + 数值），null 表示未选 */
  picked: { date: string; value: number | null } | null;
  onPick: (p: { date: string; value: number | null }) => void;
  /** 对照口径序列（用于「叠加对比」） */
  overlay?: { values: (number | null)[]; label: string } | null;
}) {
  const conf = METRICS.find((m) => m.key === metric)!;
  const option = useMemo(() => {
    const dates = history.map((h) => h.date);
    const vals = history.map((h) => (metric === 'pe' ? h.pe : metric === 'pb' ? h.pb : h.dy));
    const closes = history.map((h) => h.close);
    const name = conf.label;

    const mkLine = (yAxis: number, color: string, label: string, type: 'dotted' | 'dashed') => ({
      yAxis,
      lineStyle: { color, type, width: 1 },
      label: { formatter: label, fontSize: 10, color, position: 'insideEndTop' as const },
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
            { xAxis: picked.date, lineStyle: { color: '#0ea5e9', type: 'dashed' as const, width: 1 }, label: { show: false } },
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
            mkLine(stats.p80, '#ef4444', `80%分位 ${stats.p80.toFixed(2)}`, 'dotted'),
            mkLine(stats.p50, '#64748b', `50%分位 ${stats.p50.toFixed(2)}`, 'dashed'),
            mkLine(stats.p20, '#10b981', `20%分位 ${stats.p20.toFixed(2)}`, 'dotted'),
            ...(stats.cur !== null
              ? [
                  {
                    yAxis: stats.cur,
                    lineStyle: { color: '#2563eb', type: 'solid' as const, width: 1, opacity: 0.35 },
                    label: { formatter: `当前 ${stats.cur.toFixed(2)}`, fontSize: 10, color: '#2563eb', position: 'insideEndBottom' as const },
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
      name: '前复权收盘价(右轴)',
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
        backgroundColor: 'rgba(255,255,255,0.96)',
        borderColor: '#e2e8f0',
        textStyle: { color: '#0f172a', fontSize: 12 },
      },
      legend: {
        top: 0,
        left: 'center',
        itemWidth: 14,
        itemHeight: 8,
        textStyle: { fontSize: 11, color: '#64748b' },
        data: [name, ...(overlay ? [overlay.label] : []), '前复权收盘价(右轴)'],
      },
      grid: { left: 56, right: 60, top: 28, bottom: 44 },
      xAxis: {
        type: 'category',
        data: dates,
        axisLine: { lineStyle: { color: '#cbd5e1' } },
        axisLabel: { color: '#94a3b8', fontSize: 11 },
      },
      yAxis: [
        {
          type: 'value',
          scale: true,
          axisLine: { show: false },
          axisLabel: { color: '#94a3b8', fontSize: 11, formatter: (v: number) => v.toFixed(v >= 100 ? 0 : 1) },
          splitLine: { lineStyle: { color: '#f1f5f9' } },
        },
        {
          type: 'value',
          scale: true,
          axisLine: { show: false },
          splitLine: { show: false },
          axisLabel: { color: '#f59e0b', fontSize: 10, formatter: (v: number) => v.toFixed(v >= 100 ? 0 : 1) },
        },
      ],
      dataZoom: [
        { type: 'inside', start: 0, end: 100 },
        { type: 'slider', start: 0, end: 100, height: 16, bottom: 6, borderColor: '#e2e8f0', fillerColor: 'rgba(37,99,235,0.08)', textStyle: { color: '#94a3b8', fontSize: 10 } },
      ],
      series,
    };
  }, [history, metric, stats, conf.label, picked, overlay]);

  return (
    <div>
      <EChart option={option} height={320} onPointClick={(e) => onPick({ date: e.name, value: null })} />
      <p className="mt-1 text-[10px] text-slate-400">提示：点击曲线任意位置可打点，显示该交易日的数值参考线（再点一次取消）。</p>
    </div>
  );
}

export default function ValuationSection({ code }: { code: string }) {
  const [years, setYears] = useState<5 | 10>(10);
  const [data, setData] = useState<ValuationResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  /** 点选的理解钉（每个指标一个） */
  const [pins, setPins] = useState<Record<Metric, string | null>>({ pe: null, pb: null, dy: null });
  /** 叠加另一种口径（对照） */
  const [overlayOn, setOverlayOn] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setData(null);
    setErr(null);
    fetch(`/api/valuation?code=${encodeURIComponent(code)}&years=${years}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (j.ok) setData(j.data as ValuationResp);
        else setErr(j.error ?? '估值数据加载失败');
      })
      .catch((e) => alive && setErr(String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [code, years]);

  const panels = useMemo(() => {
    if (!data) return [];
    return METRICS.map((m) => {
      const vals = data.history.map((h) => (m.key === 'pe' ? h.pe : m.key === 'pb' ? h.pb : h.dy));
      const cur = m.key === 'pe' ? data.pe : m.key === 'pb' ? data.pb : data.dividendYield;
      // 优先用服务端统计（算法一致、口径统一），缺失时前端兜底计算
      const srv = data.stats?.[m.key];
      if (srv && srv.count >= 10 && srv.p50 !== null) {
        const stats: Stats = {
          cur: srv.current ?? cur,
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

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-700">估值分析</h2>
        <div className="flex flex-wrap items-center gap-1">
          <button
            onClick={() => setOverlayOn((v) => !v)}
            className={`rounded px-2 py-1 text-[11px] transition ${
              overlayOn ? 'bg-slate-700 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
            }`}
            title="叠加另一种 TTM 生效口径（当日披露 vs 法定截止日切换），用于和理杏仁 / 中证口径对账"
          >
            {overlayOn ? '口径对比：开' : '口径对比'}
          </button>
          {([5, 10] as const).map((y) => (
            <button
              key={y}
              onClick={() => setYears(y)}
              className={`rounded px-3 py-1 text-xs font-medium transition ${
                years === y ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              近{y}年
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="card-pad py-16 text-center text-sm text-slate-400">正在加载近 {years} 年估值数据…</div>
      )}
      {err && <div className="card-pad text-sm text-red-600">{err}</div>}

      {!loading && !err && data && (
        <div className="space-y-4">
          <div className="rounded bg-slate-50 px-3 py-2 text-xs text-slate-500">
            截至 {data.stats?.to ?? '--'} · 价格采用前复权 · 估值由财报复算
            {data.marketComparison && <span className="ml-3">行情参考：PE {data.marketComparison.pe?.toFixed(2) ?? '--'} / PB {data.marketComparison.pb?.toFixed(2) ?? '--'}</span>}
          </div>
          {data.warnings?.length ? <ul className="rounded bg-amber-50 px-4 py-2 text-xs text-amber-800">{data.warnings.map(w => <li key={w}>{w}</li>)}</ul> : null}
          {panels.map((p) => (
            <div key={p.key} className="card-pad">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                {(() => {
                  const chip = (label: string, color: string, solid = false) => (
                    <span
                      className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] ${
                        solid ? 'text-white' : 'ring-1'
                      }`}
                      style={solid ? { backgroundColor: color } : { color, boxShadow: `inset 0 0 0 1px ${color}55` }}
                    >
                      {label}
                    </span>
                  );
                  return (
                    <>
                      {chip(p.label, '#2563eb', true)}
                      {chip('20%分位点', '#10b981')}
                      {chip('50%分位点', '#64748b')}
                      {chip('80%分位点', '#ef4444')}
                      {chip('前复权收盘价(右轴)', '#f59e0b')}
                    </>
                  );
                })()}
              </div>
              {p.stats ? (
                <div className="flex flex-col gap-3 lg:flex-row">
                  <StatPanel title={p.label} unit={p.unit} stats={p.stats} />
                  <div className="min-w-0 flex-1">
                    <MetricChart
                      history={data.history}
                      metric={p.key}
                      stats={p.stats}
                      picked={(() => {
                        const d = pins[p.key];
                        if (!d) return null;
                        const row = data.history.find((h) => h.date === d);
                        const v = row ? (p.key === 'pe' ? row.pe : p.key === 'pb' ? row.pb : row.dy) : null;
                        return { date: d, value: v };
                      })()}
                      onPick={(x) => setPins((prev) => ({ ...prev, [p.key]: prev[p.key] === x.date ? null : x.date }))}
                      overlay={
                        overlayOn && data.alt && data.alt.history.length > 0
                          ? {
                              label: data.alt.method === 'cutoff' ? '截止日切换口径' : '当日披露口径',
                              values: data.history.map(h => { const alt = data.alt!.history.find(a => a.date === h.date); return alt ? (p.key === 'pe' ? alt.pe : p.key === 'pb' ? alt.pb : alt.dy) : null; }),
                            }
                          : null
                      }
                    />
                  </div>
                </div>
              ) : (
                <div className="py-10 text-center text-sm text-slate-400">
                  {p.key === 'dy'
                    ? '暂无分红记录，无法计算股息率'
                    : `该区间内 ${p.label} 数据不足，无法计算分位`}
                </div>
              )}
            </div>
          ))}

          <div className="rounded bg-slate-50 p-2.5 text-[11px] leading-relaxed text-slate-500">
            <b className="text-slate-600">口径说明</b>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              <li>价格曲线使用<b>前复权收盘价</b>。EPS、每股净资产按同一复权因子换算后计算 PE、PB，复权前后的估值比率保持一致。</li>
              <li><b>PE-TTM</b> 使用归母净利润最近四个单季之和及交易日实际总股数。Q1 TTM = 今年Q1 + 上年年报 − 上年Q1。亏损或缺失利润时不显示 PE。</li>
              <li><b>PB</b> 使用归母净资产扣除其他权益工具后的普通股净资产；与 PE 分别计算。<b>股息率</b>使用已实施且除息日落在过去十二个月内的税前现金分红，无分红为 0，数据缺失显示空值。</li>
              <li><b>财报生效</b>：{data.method === 'cutoff' ? '法定截止日与实际公告次日取较晚者。' : '真实公告次日起，使用最新已披露报告。'}未取得原始公告日期的报告不建立新估值点，且缺失期间停止沿用该报告前的数据。</li>
              <li>统计区间 {data.stats?.from ?? '--'} ~ {data.stats?.to ?? '--'}；PE / PB / 股息率有效样本分别为 {data.stats?.pe.count ?? 0} / {data.stats?.pb.count ?? 0} / {data.stats?.dy.count ?? 0}。分位 = 严格低于当前值的有效交易日数 ÷ 有效样本数。</li>
              <li>当前值与整条曲线采用相同财报口径；行情参考值单独列示，可能因股本、权益工具或取数时间不同而有差异。</li>
              {data.fin && <li>最新采用报告期 {data.fin.report ?? '--'}；归母利润 TTM {data.fin.npTTM?.toFixed(2) ?? '--'} 亿元，报告期总股数 {data.fin.shares?.toFixed(2) ?? '--'} 亿股，报告期普通股每股净资产 {data.fin.bps?.toFixed(2) ?? '--'} 元。覆盖 {data.fin.points} 个报告期。</li>}
            </ul>
            {data.basis === 'estimate' && <div className="mt-1 text-amber-600">财报抓取失败，已降级为估算口径，仅供参考。</div>}
          </div>
        </div>
      )}
    </section>
  );
}

