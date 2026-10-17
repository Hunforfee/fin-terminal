'use client';

import { useEffect, useMemo, useState } from 'react';
import EChart from './EChart';

interface ValuationPoint {
  date: string;
  pe: number | null;
  pb: number | null;
  close: number;
  dy: number | null;
}
interface SeriesStats {
  current: number | null;
  percentile: number | null;
  p80: number | null;
  p50: number | null;
  p20: number | null;
  max: number | null;
  avg: number | null;
  min: number | null;
  count: number;
}
interface ValuationResp {
  code: string;
  pe: number | null;
  pb: number | null;
  pePercentile: number | null;
  pbPercentile: number | null;
  dividendYield: number | null;
  dyPercentile?: number | null;
  netProfit: number | null;
  netAssets: number | null;
  history: ValuationPoint[];
  basis?: 'real' | 'estimate';
  years?: number;
  method?: 'disclosure' | 'cutoff';
  alt?: {
    method: 'disclosure' | 'cutoff';
    history: ValuationPoint[];
    stats: { pe: SeriesStats; pb: SeriesStats; dy: SeriesStats; from: string; to: string };
    current: { pe: number | null; pb: number | null; dy: number | null };
  };
  fin?: {
    report: string | null;
    npTTM: number | null;
    shares: number | null;
    bps: number | null;
    points: number;
    realDates: boolean;
    adjustGaps: number;
  };
  stats?: { pe: SeriesStats; pb: SeriesStats; dy: SeriesStats; from: string; to: string };
  source: string;
  stale: boolean;
}

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
    pct = (below / (sorted.length - 1)) * 100;
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
      name: '收盘价(右轴)',
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
        data: [name, ...(overlay ? [overlay.label] : []), '收盘价(右轴)'],
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

      {!loading && data && (
        <div className="space-y-4">
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
                      {chip('收盘价(右轴)', '#f59e0b')}
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
                        overlayOn && data.alt && data.alt.history.length === data.history.length
                          ? {
                              label: data.alt.method === 'cutoff' ? '截止日切换口径' : '当日披露口径',
                              values: data.alt.history.map((h) => (p.key === 'pe' ? h.pe : p.key === 'pb' ? h.pb : h.dy)),
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
              <li>
                <b>PE-TTM</b> = 不复权收盘价 ÷ EPS(TTM)；EPS(TTM) = 归母净利润(TTM) ÷ <b>该报告期期末总股本</b>
                （由资产负债表「实收资本（或股本）」÷ 面值还原，因此送转/增发不会把历史 PE 放大）。
              </li>
              <li>
                <b>归母净利润</b>取利润表「归属于母公司所有者的净利润」；TTM = 最近<b>四个单季</b>滚动（Q1 = 今年Q1 + 上年年报 − 上年Q3，中报/三季报同理），不做累计×4 年化。
              </li>
              <li>
                <b>生效口径</b>：
                {data.method === 'cutoff'
                  ? '法定披露截止日次日统一切换（一季报 5/1、中报 9/1、三季报 11/1、年报次年 5/1，中证/国证指数口径）。'
                  : '报告披露后即纳入（近似取「报告期 + 典型披露滞后」，理杏仁公司估值口径），因此财报季曲线逐期跳变。'}
                {data.alt && ' 点「口径对比」可叠加另一种口径查看差异。'}
              </li>
              <li>
                <b>PB</b> = 不复权收盘价 ÷ 归母净资产每股值；<b>股息率</b> = 近 12 个月每股税前现金分红（按除权除息日）÷ 不复权收盘价。
              </li>
              <li>
                分位点、分位值、最大/最小/平均值均在所选 {data.years ?? years} 年区间内按<b>全部交易日</b>计算（样本 {data.stats?.pe.count ?? data.history.length} 个交易日，{data.stats?.from} ~ {data.stats?.to}）。
                若你用周频/月频或不同区间复算，分位会有差异（样本数越少，极值越容易被低估）。
              </li>
              {data.fin && (
                <li>
                  <b>数据溯源</b>：最近一期报告期 {data.fin.report ?? '--'}，归母净利润 TTM{' '}
                  {data.fin.npTTM !== null ? `${data.fin.npTTM.toFixed(2)} 亿元` : '--'}，总股本{' '}
                  {data.fin.shares !== null ? `${data.fin.shares.toFixed(2)} 亿股` : '--'}，每股净资产{' '}
                  {data.fin.bps !== null ? `${data.fin.bps.toFixed(2)} 元` : '--'}，报表覆盖 {data.fin.points} 个报告期。
                  {data.fin.realDates ? '披露日取自真实公告日。' : '披露日按报告期 + 典型滞后估算（未取到真实公告日）。'}
                  {data.fin.adjustGaps > 0 &&
                    `图上的收盘价为后复权序列（共回填 ${data.fin.adjustGaps} 次除权除息），估值本身仍用不复权价，不受影响。`}
                </li>
              )}
            </ul>
            {data.basis === 'estimate' && <div className="mt-1 text-amber-600">财报抓取失败，已降级为估算口径，仅供参考。</div>}
          </div>
        </div>
      )}
    </section>
  );
}
