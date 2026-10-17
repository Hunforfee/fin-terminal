'use client';

/** 单公司财报：自选指标与完整三表，支持报告期切换、搜索和 CSV 导出。 */

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import FieldPicker, { allFieldMetas, type PickerCatalog } from '@/components/FieldPicker';
import { INDICATORS } from '@/lib/datasource/sinaFinancial';

interface CompanyFinancials {
  code: string;
  name: string;
  periods: string[];
  periodLabels: string[];
  series: Record<string, (number | null)[]>;
  source: string;
}
type CustomData = { companies: CompanyFinancials[] };

/** 默认指标（理杏仁合并报表常用行；key 以新浪披露科目为准） */
const DEFAULT_FIELDS = [
  'pl_营业收入',
  'pl_归属于母公司所有者的净利润',
  'pl_营业成本',
  'pl_销售费用',
  'pl_管理费用',
  'pl_研发费用',
  'cf_经营活动产生的现金流量净额',
  'bs_资产总计',
  'bs_归属于母公司股东权益合计',
  'bs_存货',
  'bs_预收款项',
  'roe',
  'debtRatio',
  'eps',
];

const GRAN: {
  key: 'annual' | 'semi' | 'quarter';
  label: string;
  title: string;
}[] = [
  { key: 'annual', label: '年报', title: '仅年度报告（12-31）' },
  { key: 'semi', label: '中报', title: '半年报口径（H1 + H2）' },
  { key: 'quarter', label: '季报', title: '全部季度报告（Q1/Q2/Q3/年报）' },
];
const RANGES = [2, 3, 5, 10] as const;

const LS_FIELDS = 'fin.mergeTable.fields';

function loadFields(): string[] {
  try {
    const raw = localStorage.getItem(LS_FIELDS);
    const arr = raw ? JSON.parse(raw) : null;
    if (Array.isArray(arr) && arr.length > 0) return arr.slice(0, 60);
  } catch {
    /* ignore */
  }
  return DEFAULT_FIELDS;
}

function loadShowAll(): boolean {
  try {
    return localStorage.getItem('fin.mergeTable.showAll') === '1';
  } catch {
    return false;
  }
}

/** 万元 → 亿（统一折算，与行头「亿」标签保持一致） */
function fmtWan(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '--';
  if (v === 0) return '0';
  return (v / 1e4).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function fmtVal(v: number | null, unit: string): string {
  if (v === null || !Number.isFinite(v)) return '--';
  if (unit === 'pct') return `${v.toFixed(2)}%`;
  if (unit === 'wan') return fmtWan(v);
  if (unit === 'yuan') return v.toFixed(2);
  return v.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

/** 百分比变动（同比/环比），null 安全 */
function pctChange(cur: number | null, prev: number | null): number | null {
  if (cur === null || prev === null || !Number.isFinite(cur) || !Number.isFinite(prev)) return null;
  if (prev === 0) return null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}

function pctCls(v: number | null): string {
  if (v === null) return 'text-slate-300';
  if (v > 0) return 'text-slate-600';
  if (v < 0) return 'text-slate-600';
  return 'text-slate-400';
}

export default function FinanceTable({ code }: { code: string }) {
  const [granularity, setGranularity] = useState<'annual' | 'semi' | 'quarter'>('quarter');
  const [years, setYears] = useState<number>(5);
  const [view, setView] = useState<'indicators' | 'pl' | 'bs' | 'cf'>('indicators');
  const [fields, setFields] = useState<string[]>(DEFAULT_FIELDS);
  const [showAll, setShowAll] = useState(false);
  const [kw, setKw] = useState('');
  const [data, setData] = useState<CustomData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<PickerCatalog | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [onlyHasData, setOnlyHasData] = useState(true);
  const bootedRef = useRef(false);
  const tableRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setFields(loadFields());
    setShowAll(loadShowAll());
    bootedRef.current = true;
  }, []);

  useEffect(() => {
    if (!bootedRef.current) return;
    try {
      localStorage.setItem(LS_FIELDS, JSON.stringify(fields));
      localStorage.setItem('fin.mergeTable.showAll', showAll ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [fields, showAll]);

  useEffect(() => {
    let alive = true;
    fetch(`/api/finance-fields?code=${code}`)
      .then((r) => r.json())
      .then((j) => alive && j.ok && setCatalog(j.data as PickerCatalog))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [code]);

  const fieldMetas = useMemo(() => {
    const map = allFieldMetas(catalog);
    for (const i of INDICATORS) {
      if (!map.has(i.key)) {
        map.set(i.key, {
          key: i.key,
          label: i.label,
          group: '财务指标',
          statement: 'indicator',
          unit: i.unit,
        });
      }
    }
    return map;
  }, [catalog]);

  /** 实际请求的字段：按视图切换——指标=用户所选/全部；三表=该表全部科目 */
  const fetchFields = useMemo(() => {
    if (view === 'indicators') {
      if (showAll) {
        const all = Array.from(fieldMetas.keys()).filter((k) => !k.startsWith('fx_'));
        return all.length > 0 ? all : fields;
      }
      return fields;
    }
    const stId = view === 'bs' ? 'balance' : view === 'pl' ? 'profit' : 'cashflow';
    return Array.from(fieldMetas.entries())
      .filter(([, m]) => m.statement === stId)
      .map(([k]) => k);
  }, [view, showAll, fieldMetas, fields]);

  const fieldsSig = useMemo(() => [...fetchFields].sort().join(','), [fetchFields]);
  const codesSig = code;

  useEffect(() => {
    if (fetchFields.length === 0) {
      setData(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setErr(null);
    setData(null);
    fetch('/api/finance-compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        codes: codesSig,
        years,
        granularity,
        fields: fieldsSig.split(','),
      }),
    })
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (j.ok) setData(j.data as CustomData);
        else setErr(j.error ?? '财报数据获取失败');
      })
      .catch((e) => alive && setErr(String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [codesSig, granularity, years, fieldsSig, fetchFields.length]);

  const companies = data?.companies ?? [];
  const primary = companies[0];
  /** 列（报告期）以主公司为准，倒序 = 最新在左 */
  const periodsAsc = primary?.periods ?? [];
  const labelsAsc = primary?.periodLabels ?? [];
  /** 列标题按当前粒度口径改写：年报视图的 12-31 显示「年报」，中报视图显示「中报」 */
  const labelOf = (period: string, raw: string): string => {
    if (granularity === 'annual' || granularity === 'semi') {
      if (period.endsWith('-12-31')) return `${period.slice(2, 4)}年报`;
      if (period.endsWith('-06-30')) return `${period.slice(2, 4)}中报`;
    }
    return raw;
  };
  const colsDesc = useMemo(() => {
    const idx = periodsAsc.map((p, i) => ({
      p,
      label: labelOf(p, labelsAsc[i] ?? p),
      i,
    }));
    return idx.reverse();
  }, [periodsAsc.join(','), labelsAsc.join(','), granularity]);

  /** 值查找：按公司 + 字段 + 列序号 */
  const valOf = (c: CompanyFinancials, key: string, i: number): number | null => {
    const ownIndex = c.periods.indexOf(periodsAsc[i]);
    return ownIndex >= 0 ? (c.series?.[key]?.[ownIndex] ?? null) : null;
  };

  /** 同比：上一年同期报告期 */
  const yoyIndex = (i: number): number => {
    const p = periodsAsc[i];
    if (!p) return -1;
    const prev = p.replace(/^(\d{4})/, (y) => String(Number(y) - 1));
    return periodsAsc.indexOf(prev);
  };
  /**
   * 单季同比（理杏仁口径）：
   *   单季值 = 当期累计 − 同年上一报告期累计（Q1 单季 = Q1 本身）
   *   单季同比 = 当期单季 vs 上年同期单季
   * 仅在季度粒度、且序列覆盖所需报告期时可算，否则返回 null（显示 —）。
   */
  const sqYoy = (c: CompanyFinancials, key: string, i: number): number | null => {
    if (granularity !== 'quarter') return null;
    const s = c.series?.[key];
    if (!s) return null;
    const v = s[i];
    if (v === null || v === undefined || !Number.isFinite(v)) return null;
    const qOfMonth = (p: string): number => {
      const md = p.slice(5, 10);
      if (md === '03-31') return 1;
      if (md === '06-30') return 2;
      if (md === '09-30') return 3;
      if (md === '12-31') return 4;
      return 0;
    };
    const p = periodsAsc[i];
    if (!p || qOfMonth(p) === 0) return null;
    // 当期单季 = 当期累计 − 同年上一季度累计
    let curQ: number | null = v;
    if (qOfMonth(p) > 1) {
      const y = p.slice(0, 4);
      const prevQDate = ['03-31', '06-30', '09-30', '12-31'][qOfMonth(p) - 2];
      const pi = periodsAsc.indexOf(`${y}-${prevQDate}`);
      const pv = pi >= 0 ? s[pi] : null;
      if (pv === null || pv === undefined || !Number.isFinite(pv)) return null;
      curQ = v - pv;
    }
    // 上年同期单季
    const prevYearDate = ['03-31', '06-30', '09-30', '12-31'][qOfMonth(p) - 1];
    const yi = periodsAsc.indexOf(`${Number(p.slice(0, 4)) - 1}-${prevYearDate}`);
    if (yi < 0) return null;
    const yv = s[yi];
    if (yv === null || yv === undefined || !Number.isFinite(yv)) return null;
    let prevQ: number | null = yv;
    if (qOfMonth(p) > 1) {
      const py = String(Number(p.slice(0, 4)) - 1);
      const prevQDate = ['03-31', '06-30', '09-30', '12-31'][qOfMonth(p) - 2];
      const pi2 = periodsAsc.indexOf(`${py}-${prevQDate}`);
      const pv2 = pi2 >= 0 ? s[pi2] : null;
      if (pv2 === null || pv2 === undefined || !Number.isFinite(pv2)) return null;
      prevQ = yv - pv2;
    }
    if (prevQ === null || prevQ === 0 || curQ === null) return null;
    return ((curQ - prevQ) / Math.abs(prevQ)) * 100;
  };

  /** 行渲染列表：搜索过滤 + 「仅显示有数据」过滤 */
  const rows = useMemo(() => {
    let list = fetchFields.map((key) => ({ key, meta: fieldMetas.get(key) }));
    if (kw.trim()) {
      const k = kw.trim().toLowerCase();
      list = list.filter(
        (r) => r.meta?.label.toLowerCase().includes(k) || r.key.toLowerCase().includes(k)
      );
    }
    if (onlyHasData && companies.length > 0) {
      list = list.filter((r) =>
        companies.some((c) =>
          (c.series?.[r.key] ?? []).some((v) => v !== null && Number.isFinite(v))
        )
      );
    }
    return list;
  }, [fetchFields, fieldMetas, kw, onlyHasData, companies]);

  const exportCsv = () => {
    const header = ['指标', '单位', ...colsDesc.map((c) => c.label)];
    const lines = [header.join(',')];
    for (const r of rows) {
      const unit = r.meta?.unit === 'pct' ? '%' : r.meta?.unit === 'wan' ? '万元' : '';
      for (const c of companies) {
        const name = companies.length > 1 ? `${c.name}(${c.code})` : '';
        const cells = colsDesc.map((col) => {
          const v = valOf(c, r.key, col.i);
          return v === null ? '' : String(v);
        });
        lines.push(
          [name || (r.meta?.label ?? r.key), unit, ...cells].map((x) => `"${x}"`).join(',')
        );
      }
    }
    const blob = new Blob(['\uFEFF' + lines.join('\n')], {
      type: 'text/csv;charset=utf-8',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `合并报表_${primary?.name ?? code}_${granularity}_${years}y.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="space-y-3">
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 sm:px-5">
          <div className="flex max-w-full gap-1 overflow-x-auto" role="group" aria-label="报表视图">
            {(
              [
                ['indicators', '指标'],
                ['pl', '利润表'],
                ['bs', '资产负债表'],
                ['cf', '现金流量表'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setView(key)}
                aria-pressed={view === key}
                className={`min-h-10 shrink-0 rounded-lg px-3 text-sm font-medium transition ${view === key ? 'bg-brand-50 text-brand-700' : 'text-slate-500 hover:bg-slate-50'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="text-sm font-medium text-slate-700">{primary?.name ?? code}</span>
        </div>
        <div className="flex flex-wrap items-center gap-3 px-4 py-4 sm:px-5">
          <div className="segmented" role="group" aria-label="报告类型">
            {GRAN.map((g) => (
              <button
                key={g.key}
                title={g.title}
                onClick={() => setGranularity(g.key)}
                aria-pressed={granularity === g.key}
                className={`segment !px-2.5 !text-xs ${granularity === g.key ? 'segment-active' : ''}`}
              >
                {g.label}
              </button>
            ))}
          </div>
          <div className="flex gap-1" role="group" aria-label="报表年份">
            {RANGES.map((y) => (
              <button
                key={y}
                onClick={() => setYears(y)}
                aria-pressed={years === y}
                className={`min-h-9 rounded-lg px-2.5 text-xs ${years === y ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-500 hover:bg-slate-50'}`}
              >
                {y}年
              </button>
            ))}
          </div>
          <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
            <div className="relative">
              <input
                value={kw}
                onChange={(e) => setKw(e.target.value)}
                placeholder="搜索指标"
                className="input !w-36 !pr-7 !text-xs"
                aria-label="搜索指标"
              />
              {kw && (
                <button
                  onClick={() => setKw('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400"
                  aria-label="清空搜索"
                >
                  ×
                </button>
              )}
            </div>
            {view === 'indicators' && (
              <button
                onClick={() => setShowAll((v) => !v)}
                aria-pressed={showAll}
                className={`btn !min-h-9 !px-2.5 !text-xs ${showAll ? '!border-brand-300 !bg-brand-50 !text-brand-700' : ''}`}
              >
                全部数据项
              </button>
            )}
            <button
              onClick={() => setOnlyHasData((v) => !v)}
              aria-pressed={onlyHasData}
              className="btn !min-h-9 !px-2.5 !text-xs"
            >
              {onlyHasData ? '隐藏空行' : '含空行'}
            </button>
            {view === 'indicators' && (
              <button onClick={() => setPickerOpen(true)} className="btn !min-h-9 !px-2.5 !text-xs">
                配置指标
              </button>
            )}
            <button
              onClick={exportCsv}
              disabled={loading || !primary}
              className="btn !min-h-9 !px-2.5 !text-xs"
            >
              导出 CSV
            </button>
          </div>
        </div>
      </div>

      {/* 表格 */}
      <div className="card overflow-hidden px-0 py-0">
        <div ref={tableRef} className="max-h-[720px] overflow-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="sticky top-0 z-20 bg-slate-50">
                <th className="sticky left-0 z-30 min-w-[140px] border-b border-slate-200 bg-slate-50 px-3 py-2 text-left font-medium text-slate-600">
                  指标{' '}
                  <span className="font-normal text-slate-400">
                    （{years}年 ·{' '}
                    {granularity === 'annual' ? '年报' : granularity === 'semi' ? '半年报' : '季度'}
                    ）
                  </span>
                </th>
                {colsDesc.map((c) => (
                  <th
                    key={c.p}
                    className="min-w-[92px] border-b border-l border-slate-200 bg-slate-50 px-2.5 py-2 text-center font-medium text-slate-700"
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            {loading && (
              <tbody>
                <tr>
                  <td colSpan={colsDesc.length + 1} className="py-16 text-center text-slate-400">
                    正在加载财报数据…
                  </td>
                </tr>
              </tbody>
            )}
            {!loading && err && (
              <tbody>
                <tr>
                  <td colSpan={colsDesc.length + 1} className="py-10 text-center text-red-600">
                    {err}
                  </td>
                </tr>
              </tbody>
            )}
            {!loading && !err && rows.length === 0 && (
              <tbody>
                <tr>
                  <td colSpan={colsDesc.length + 1} className="py-10 text-center text-slate-400">
                    {kw ? '没有匹配的指标' : '请在「数据显示设置」中选择指标'}
                  </td>
                </tr>
              </tbody>
            )}
            {!loading &&
              !err &&
              rows.map((r) => {
                const unit = r.meta?.unit ?? '';
                const isPct = unit === 'pct';
                const unitText = isPct ? '%' : unit === 'wan' ? '亿' : '';
                return (
                  <tbody key={r.key} className="border-b-2 border-slate-200">
                    {companies.map((c, ci) => {
                      const showYoY = companies.length === 1;
                      return (
                        <Fragment key={c.code}>
                          {/* 数值行 */}
                          <tr key={`${r.key}-${c.code}-v`} className="hover:bg-slate-50">
                            <td
                              className={`sticky left-0 z-10 bg-white px-3 pb-1 ${ci === 0 ? 'pt-2.5' : 'pl-6 pt-2.5'}`}
                            >
                              {ci === 0 && (
                                <div className="flex items-baseline gap-1.5">
                                  <span className="font-medium text-slate-800">
                                    {r.meta?.label ?? r.key}
                                  </span>
                                  <span className="text-[10px] text-slate-400">{unitText}</span>
                                </div>
                              )}
                              {ci > 0 && (
                                <span className="text-[11px] text-orange-600">{c.name}</span>
                              )}
                            </td>
                            {colsDesc.map((col) => (
                              <td
                                key={col.p}
                                className="border-l border-slate-100 px-2.5 pb-1 pt-2.5 text-center tabular-nums text-slate-800"
                              >
                                {fmtVal(valOf(c, r.key, col.i), unit)}
                              </td>
                            ))}
                          </tr>
                          {/* 同比 / 环比（仅单公司时展开；与理杏仁一致：上行同比、下行环比） */}
                          {showYoY && (
                            <>
                              <tr className="text-[11px] hover:bg-slate-50/60">
                                <td className="sticky left-0 z-10 bg-white px-3 py-0.5 text-[10px] text-slate-400">
                                  累积
                                </td>
                                {colsDesc.map((col) => {
                                  const yi = yoyIndex(col.i);
                                  const v =
                                    yi >= 0
                                      ? pctChange(valOf(c, r.key, col.i), valOf(c, r.key, yi))
                                      : null;
                                  return (
                                    <td
                                      key={col.p}
                                      className={`border-l border-slate-100 px-2.5 py-0.5 text-center tabular-nums ${pctCls(v)}`}
                                    >
                                      {v === null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`}
                                    </td>
                                  );
                                })}
                              </tr>
                              <tr className="text-[11px] hover:bg-slate-50/60">
                                <td className="sticky left-0 z-10 bg-white px-3 pb-2 pt-0.5 text-[10px] text-slate-400">
                                  单季
                                </td>
                                {colsDesc.map((col) => {
                                  const v = sqYoy(c, r.key, col.i);
                                  return (
                                    <td
                                      key={col.p}
                                      className={`border-l border-slate-100 px-2.5 py-0.5 text-center tabular-nums ${pctCls(v)}`}
                                    >
                                      {v === null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`}
                                    </td>
                                  );
                                })}
                              </tr>
                            </>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                );
              })}
          </table>
        </div>
        <div className="border-t border-slate-100 px-4 py-3 text-xs leading-6 text-slate-500">
          <details>
            <summary>报表口径</summary>
            口径：三大报表科目为新浪披露的累计值（单位：万元，统一折算为亿元展示）；财务指标（ROE
            等）来自新浪财务指标页。 累积 = 与上一年同期累计值相比；单季 = 单季值（当期累计 −
            同年上一报告期累计）与上年同期单季相比，仅季报视图提供；null 表示当期未披露。
            {showAll &&
              ' 当前为「全部数据项」模式（178 个科目 + 21 项指标），科目为累计值口径，行较多可搜索定位。'}
            {view === 'indicators' && !showAll && ` 当前显示 ${rows.length} 项指标。`}
          </details>
        </div>
      </div>

      <FieldPicker
        open={pickerOpen && view === 'indicators'}
        catalog={catalog}
        selected={fields}
        defaultSelected={DEFAULT_FIELDS}
        onClose={() => setPickerOpen(false)}
        onConfirm={(keys) => {
          setFields(keys);
          setShowAll(false);
          setPickerOpen(false);
        }}
        onResetAll={() => {
          setFields(DEFAULT_FIELDS);
          setShowAll(false);
          setPickerOpen(false);
        }}
        title="选择报表指标（合并报表）"
      />
    </div>
  );
}
