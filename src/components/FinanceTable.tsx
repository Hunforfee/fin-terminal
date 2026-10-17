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
  const amount = v / 1e4;
  if (amount !== 0 && Math.abs(amount) < 0.01) return amount < 0 ? '−<0.01' : '<0.01';
  return amount.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
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
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [onlyHasData, setOnlyHasData] = useState(true);
  const [periodLimit, setPeriodLimit] = useState(8);
  const [showGrowth, setShowGrowth] = useState(false);
  const [keyOnly, setKeyOnly] = useState(false);
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [hoveredPeriod, setHoveredPeriod] = useState<string | null>(null);
  const bootedRef = useRef(false);
  const tableRef = useRef<HTMLDivElement>(null);
  const [tableHeight, setTableHeight] = useState<number>();

  useEffect(() => {
    const table = tableRef.current;
    if (!table) return;
    const updateHeight = () => {
      const documentTop = table.getBoundingClientRect().top + window.scrollY;
      setTableHeight(Math.max(320, Math.floor(window.innerHeight - documentTop - 16)));
    };
    const observer = new ResizeObserver(updateHeight);
    const toolbar = table.parentElement?.previousElementSibling;
    const pageHeading = table.parentElement?.parentElement?.previousElementSibling;
    [toolbar, pageHeading, document.querySelector('header')].forEach((element) => {
      if (element) observer.observe(element);
    });
    updateHeight();
    window.addEventListener('resize', updateHeight);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateHeight);
    };
  }, []);

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
    setCatalogLoading(true);
    setCatalogError(null);
    setCatalog(null);
    fetch(`/api/finance-fields?code=${code}`)
      .then((r) => r.json())
      .then((j) => {
        if (!j.ok) throw new Error(j.error ?? '报表科目加载失败');
        if (alive) setCatalog(j.data as PickerCatalog);
      })
      .catch((e) => {
        if (alive) setCatalogError(e instanceof Error ? e.message : '报表科目加载失败');
      })
      .finally(() => {
        if (alive) setCatalogLoading(false);
      });
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
    for (const [key, meta] of map) {
      if (meta.statement === 'profit' && /元[/／]股/.test(meta.label))
        map.set(key, { ...meta, unit: 'yuan' });
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
    if (catalogLoading || catalogError) {
      setData(null);
      setLoading(catalogLoading);
      setErr(catalogError);
      return;
    }
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
  }, [codesSig, granularity, years, fieldsSig, fetchFields.length, catalogLoading, catalogError]);

  const companies = data?.companies ?? [];
  const primary = companies[0];
  /** 列（报告期）以主公司为准，倒序 = 最新在左 */
  const periodsAsc = primary?.periods ?? [];
  const labelsAsc = primary?.periodLabels ?? [];
  /** 列标题按当前粒度口径改写：年报视图的 12-31 显示「年报」，中报视图显示「中报」 */
  const labelOf = (period: string, raw: string): string => {
    const report = { '03-31': '一季报', '06-30': '中报', '09-30': '三季报', '12-31': '年报' }[
      period.slice(5)
    ];
    return report ? period.slice(0, 4) + report : raw;
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

  const visibleCols = periodLimit === 0 ? colsDesc : colsDesc.slice(0, periodLimit);
  const isKeyRow = (key: string) =>
    /合计|总计|小计|净额$/.test(key) ||
    [
      'pl_营业收入',
      'pl_营业利润',
      'pl_利润总额',
      'pl_归属于母公司所有者的净利润',
      'roe',
      'netMargin',
      'eps',
      'debtRatio',
      'ocfPerShare',
    ].includes(key);
  const groupName = (r: (typeof rows)[number]) => {
    const st = r.meta?.statement;
    if (view === 'indicators')
      return (
        (
          {
            profit: '利润与成本',
            balance: '资产与负债',
            cashflow: '现金流',
            indicator: '财务指标',
          } as Record<string, string>
        )[st ?? ''] ?? '其他指标'
      );
    if (st !== 'profit') return r.meta?.group ?? '其他科目';
    if (/每股收益/.test(r.key)) return '每股收益';
    if (/综合收益/.test(r.key)) return '综合收益';
    if (/净利润|股东损益|利润总额|营业利润|所得税/.test(r.key)) return '利润与税费';
    if (/营业外|非流动资产处置/.test(r.key)) return '营业外收支';
    if (/投资收益|公允价值|减值|汇兑/.test(r.key)) return '投资与其他收益';
    return '营业收入与成本';
  };
  const displayRows = keyOnly ? rows.filter((r) => isKeyRow(r.key)) : rows;
  const rowGroups = new Map<string, typeof rows>();
  displayRows.forEach((r) => {
    const name = groupName(r);
    rowGroups.set(name, [...(rowGroups.get(name) ?? []), r]);
  });
  const toggleRow = (key: string) =>
    setExpandedRows((prev) => ({ ...prev, [key]: !(prev[key] ?? showGrowth) }));
  const toggleGroup = (key: string) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  const growthText = (v: number | null) =>
    v === null ? '—' : (v > 0 ? '+' : '') + v.toFixed(1) + '%';

  const exportCsv = () => {
    const header = ['指标', '单位', ...colsDesc.map((c) => c.label)];
    const lines = [header.join(',')];
    for (const r of displayRows) {
      const unit =
        r.meta?.unit === 'pct'
          ? '%'
          : r.meta?.unit === 'wan'
            ? '万元'
            : r.meta?.unit === 'yuan'
              ? '元'
              : r.meta?.unit === 'ratio'
                ? '倍'
                : '';
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
    <div className="space-y-2">
      <div className="card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-1.5">
          <div className="flex max-w-full gap-1 overflow-x-auto" role="group" aria-label="报表视图">
            {(
              [
                ['indicators', '自选指标'],
                ['pl', '利润表'],
                ['bs', '资产负债表'],
                ['cf', '现金流量表'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => {
                  setView(key);
                  setExpandedRows({});
                }}
                aria-pressed={view === key}
                className={`min-h-9 shrink-0 rounded-lg px-3 text-sm font-medium transition ${view === key ? 'bg-brand-50 text-brand-700' : 'text-slate-500 hover:bg-slate-50'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="text-xs text-slate-500">
            金额：亿元<span className="hidden sm:inline">　·　每股 / 比率单位单列</span>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <div className="segmented" role="group" aria-label="报告类型">
            {GRAN.map((g) => (
              <button
                key={g.key}
                onClick={() => setGranularity(g.key)}
                aria-pressed={granularity === g.key}
                className={`segment !px-2.5 !text-xs ${granularity === g.key ? 'segment-active' : ''}`}
              >
                {g.label}
              </button>
            ))}
          </div>
          <select
            aria-label="报表年份"
            value={years}
            onChange={(e) => setYears(Number(e.target.value))}
            className="input !w-24 !text-xs"
          >
            {RANGES.map((y) => (
              <option key={y} value={y}>
                近{y}年
              </option>
            ))}
          </select>
          <select
            aria-label="显示报告期数"
            value={periodLimit}
            onChange={(e) => setPeriodLimit(Number(e.target.value))}
            className="input !w-28 !text-xs"
          >
            <option value={4}>最近 4 期</option>
            <option value={8}>最近 8 期</option>
            <option value={0}>全部报告期</option>
          </select>
          <div className="relative">
            <input
              value={kw}
              onChange={(e) => setKw(e.target.value)}
              placeholder="搜索科目"
              aria-label="搜索指标"
              className="input !w-36 !pr-7 !text-xs"
            />
            {kw && (
              <button
                onClick={() => setKw('')}
                aria-label="清空搜索"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400"
              >
                ×
              </button>
            )}
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button
              onClick={() => setKeyOnly((v) => !v)}
              aria-pressed={keyOnly}
              className={`btn !min-h-9 !px-2.5 !text-xs ${keyOnly ? '!border-brand-300 !bg-brand-50 !text-brand-700' : ''}`}
            >
              关键科目
            </button>
            <button
              onClick={() => {
                setShowGrowth((v) => !v);
                setExpandedRows({});
              }}
              aria-pressed={showGrowth}
              className={`btn !min-h-9 !px-2.5 !text-xs ${showGrowth ? '!border-brand-300 !bg-brand-50 !text-brand-700' : ''}`}
            >
              显示同比
            </button>
            <details className="relative">
              <summary
                aria-label="报表显示设置"
                className="btn !min-h-9 list-none !px-2.5 !text-xs [&::-webkit-details-marker]:hidden"
              >
                显示设置 ▾
              </summary>
              <div className="absolute right-0 top-full z-40 mt-2 min-w-40 rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
                <button
                  onClick={() => setOnlyHasData((v) => !v)}
                  aria-pressed={onlyHasData}
                  className="block w-full rounded px-3 py-2 text-left text-xs text-slate-600 hover:bg-slate-50"
                >
                  {onlyHasData ? '显示空行' : '隐藏空行'}
                </button>
                {view === 'indicators' && (
                  <>
                    <button
                      onClick={() => setShowAll((v) => !v)}
                      aria-pressed={showAll}
                      className="block w-full rounded px-3 py-2 text-left text-xs text-slate-600 hover:bg-slate-50"
                    >
                      {showAll ? '恢复自选指标' : '全部数据项'}
                    </button>
                    <button
                      onClick={(e) => {
                        setPickerOpen(true);
                        e.currentTarget.closest('details')?.removeAttribute('open');
                      }}
                      className="block w-full rounded px-3 py-2 text-left text-xs text-slate-600 hover:bg-slate-50"
                    >
                      配置指标
                    </button>
                  </>
                )}
              </div>
            </details>
            <button
              onClick={exportCsv}
              disabled={loading || !primary}
              title="导出当前筛选科目的全部请求报告期原始值；报表金额单位为万元"
              className="btn !min-h-9 !px-2.5 !text-xs"
            >
              导出 CSV
            </button>
          </div>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div
          ref={tableRef}
          style={{ height: tableHeight }}
          className="h-[calc(100dvh-16rem)] min-h-[320px] overflow-auto"
          onMouseLeave={() => setHoveredPeriod(null)}
        >
          <table
            className="finance-report w-full border-separate border-spacing-0 text-sm"
            aria-label="财务报表"
          >
            <thead className="sticky top-0 z-30">
              <tr>
                <th
                  scope="col"
                  className="sticky left-0 z-40 min-w-[170px] border-b border-r border-slate-200 bg-slate-50 px-4 py-3 text-left text-xs font-medium text-slate-500 sm:min-w-[240px]"
                >
                  报表科目
                </th>
                {visibleCols.map((col, index) => (
                  <th
                    key={col.p}
                    scope="col"
                    onMouseEnter={() => setHoveredPeriod(col.p)}
                    className={`min-w-[112px] border-b border-slate-200 px-4 py-2 text-right ${index === 0 ? 'bg-blue-50 text-brand-700' : 'bg-slate-50 text-slate-700'}`}
                  >
                    <div className="font-semibold tabular-nums">{col.p.slice(0, 4)}年</div>
                    <div className="mt-1 flex items-center justify-end gap-1.5 text-[11px] font-normal">
                      <span>{col.label.slice(4)}</span>
                      {index === 0 && (
                        <span className="rounded bg-white px-1 text-[10px] text-brand-600">
                          最新
                        </span>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td
                    colSpan={visibleCols.length + 1}
                    role="status"
                    className="py-16 text-center text-sm text-slate-500"
                  >
                    正在加载财报数据…
                  </td>
                </tr>
              )}
              {!loading && err && (
                <tr>
                  <td
                    colSpan={visibleCols.length + 1}
                    role="alert"
                    className="py-12 text-center text-red-600"
                  >
                    {err}
                  </td>
                </tr>
              )}
              {!loading && !err && displayRows.length === 0 && (
                <tr>
                  <td colSpan={visibleCols.length + 1} className="py-12 text-center text-slate-500">
                    {kw ? '没有匹配的科目' : keyOnly ? '暂无匹配的关键科目' : '暂无可展示数据'}
                  </td>
                </tr>
              )}
              {!loading &&
                !err &&
                Array.from(rowGroups.entries()).map(([group, groupRows]) => {
                  const groupId = view + ':' + group,
                    collapsed = collapsedGroups.has(groupId) && !kw.trim();
                  return (
                    <Fragment key={groupId}>
                      <tr className="report-section">
                        <th
                          scope="rowgroup"
                          colSpan={visibleCols.length + 1}
                          className="border-b border-slate-200 bg-slate-100/80 px-3 py-2 text-left"
                        >
                          <button
                            onClick={() => toggleGroup(groupId)}
                            aria-expanded={!collapsed}
                            className="sticky left-3 inline-flex items-center gap-2 text-xs font-semibold text-slate-600"
                          >
                            <span aria-hidden="true" className="text-[10px] text-slate-400">
                              {collapsed ? '▸' : '▾'}
                            </span>
                            {group}
                            <span className="font-normal text-slate-400">
                              {groupRows.length} 项
                            </span>
                          </button>
                        </th>
                      </tr>
                      {!collapsed &&
                        groupRows.map((r, rowIndex) => {
                          const unit = r.meta?.unit ?? '',
                            important = isKeyRow(r.key),
                            rowOpen = expandedRows[r.key] ?? showGrowth;
                          const isFlow =
                            unit === 'wan' &&
                            (r.meta?.statement === 'profit' || r.meta?.statement === 'cashflow');
                          const bg = important
                            ? 'bg-slate-50'
                            : rowIndex % 2 === 0
                              ? 'bg-white'
                              : 'bg-slate-50/40';
                          const label = (r.meta?.label ?? r.key).replace(
                            /[(（]元[/／]股[)）]/g,
                            ''
                          );
                          const rowUnit =
                            unit === 'pct'
                              ? '%'
                              : unit === 'yuan'
                                ? /元[/／]股/.test(r.meta?.label ?? '')
                                  ? '元/股'
                                  : '元'
                                : unit === 'ratio'
                                  ? '倍'
                                  : '';
                          return (
                            <Fragment key={r.key}>
                              <tr className={`group report-value ${bg}`} data-field={r.key}>
                                <th
                                  scope="row"
                                  className={`sticky left-0 z-10 border-b border-r border-slate-200/70 px-3 py-2.5 text-left ${bg} group-hover:bg-slate-100`}
                                >
                                  <button
                                    onClick={() => toggleRow(r.key)}
                                    aria-label={`${rowOpen ? '收起' : '展开'}${label}同比`}
                                    aria-expanded={rowOpen}
                                    className="flex w-full items-start gap-2 text-left"
                                  >
                                    <span
                                      aria-hidden="true"
                                      className="mt-1 w-2.5 shrink-0 text-[10px] text-slate-400"
                                    >
                                      {rowOpen ? '▾' : '▸'}
                                    </span>
                                    <span
                                      className={`leading-5 ${important ? 'font-semibold text-slate-900' : 'font-normal text-slate-600'}`}
                                    >
                                      {label}
                                      {rowUnit && (
                                        <span className="ml-1.5 whitespace-nowrap text-[10px] font-normal text-slate-400">
                                          {rowUnit}
                                        </span>
                                      )}
                                    </span>
                                  </button>
                                </th>
                                {visibleCols.map((col, index) => {
                                  const v = primary ? valOf(primary, r.key, col.i) : null;
                                  return (
                                    <td
                                      key={col.p}
                                      onMouseEnter={() => setHoveredPeriod(col.p)}
                                      title={`${col.label} · ${label}：${v === null ? '未披露' : v.toLocaleString('zh-CN', { maximumFractionDigits: 8 }) + ' ' + (unit === 'wan' ? '万元' : rowUnit)}`}
                                      className={`whitespace-nowrap border-b border-slate-200/60 px-4 py-2.5 text-right tabular-nums ${hoveredPeriod === col.p ? 'bg-blue-100/50' : index === 0 ? 'bg-blue-50/50' : 'group-hover:bg-slate-100/60'} ${v === null ? 'text-slate-300' : v < 0 ? 'text-rose-700' : important ? 'font-semibold text-slate-900' : 'text-slate-700'}`}
                                    >
                                      {fmtVal(v, unit)}
                                    </td>
                                  );
                                })}
                              </tr>
                              {rowOpen && primary && (
                                <>
                                  <tr className="report-growth">
                                    <th
                                      scope="row"
                                      className="sticky left-0 z-10 border-b border-r border-slate-100 bg-white px-8 py-2 text-left text-[11px] font-normal text-slate-500"
                                    >
                                      {isFlow ? '累计同比' : '同比'}
                                    </th>
                                    {visibleCols.map((col, index) => {
                                      const yi = yoyIndex(col.i),
                                        v =
                                          yi >= 0
                                            ? pctChange(
                                                valOf(primary, r.key, col.i),
                                                valOf(primary, r.key, yi)
                                              )
                                            : null;
                                      return (
                                        <td
                                          key={col.p}
                                          onMouseEnter={() => setHoveredPeriod(col.p)}
                                          className={`border-b border-slate-100 px-4 py-2 text-right text-xs tabular-nums ${index === 0 ? 'bg-blue-50/40' : ''} ${pctCls(v)}`}
                                        >
                                          {growthText(v)}
                                        </td>
                                      );
                                    })}
                                  </tr>
                                  {isFlow && granularity === 'quarter' && (
                                    <tr className="report-growth">
                                      <th
                                        scope="row"
                                        className="sticky left-0 z-10 border-b border-r border-slate-100 bg-white px-8 py-2 text-left text-[11px] font-normal text-slate-500"
                                      >
                                        单季同比
                                      </th>
                                      {visibleCols.map((col, index) => {
                                        const v = sqYoy(primary, r.key, col.i);
                                        return (
                                          <td
                                            key={col.p}
                                            onMouseEnter={() => setHoveredPeriod(col.p)}
                                            className={`border-b border-slate-100 px-4 py-2 text-right text-xs tabular-nums ${index === 0 ? 'bg-blue-50/40' : ''} ${pctCls(v)}`}
                                          >
                                            {growthText(v)}
                                          </td>
                                        );
                                      })}
                                    </tr>
                                  )}
                                </>
                              )}
                            </Fragment>
                          );
                        })}
                    </Fragment>
                  );
                })}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50/50 px-3 py-2 text-[11px] text-slate-500">
          <span>
            {displayRows.length} 项科目　·　显示 {visibleCols.length} / {colsDesc.length} 期
          </span>
          <details className="max-w-3xl">
            <summary>报表口径</summary>
            <p className="py-2 leading-6">
              三大报表金额统一为亿元，每股数据及比率按行列示单位。金额为报告期累计值；同比与上年同期比较，单季同比仅用于利润表、现金流量表的金额科目。空值表示未披露。CSV
              导出当前筛选科目的全部请求报告期原始数据，金额单位为万元。绝对值不足 0.01
              亿元的金额以「&lt;0.01」显示，悬停可查看原始值。
            </p>
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
