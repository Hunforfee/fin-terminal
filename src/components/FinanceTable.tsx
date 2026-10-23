'use client';
import MarketDataNotice, { type MarketReadResult } from '@/components/MarketDataNotice';

import { personalStorage } from '@/lib/personalStorage';
import { fetchJson } from '@/lib/fetchJson';

/** 单公司财报：自选指标与完整三表，支持报告期切换、搜索和 CSV 导出。 */

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import FieldPicker, { allFieldMetas, type PickerCatalog } from '@/components/FieldPicker';
import { INDICATORS } from '@/lib/datasource/financeIndicators';
import { financeStorageKey, sanitizeFields, takeLegacyHkMergeFields } from '@/lib/financePreferences';
import type { FinancialReportLink } from '@/lib/financialReportLinks';
import {
  financialUnitText,
  formatFinancialValue as fmtVal,
  showSingleQuarterChange,
} from '@/lib/financeFieldSemantics';

interface CompanyFinancials {
  fieldCurrencies?: Record<string, string>;
  periodKinds?: Record<string,string>;
  currency?: string;
  code: string;
  name: string;
  periods: string[];
  periodLabels: string[];
  series: Record<string, (number | null)[]>;
  source: string;
}
type CustomData = MarketReadResult & { companies: CompanyFinancials[] };

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

function loadFields(storageKey = LS_FIELDS): string[] {
  try {
    const raw = personalStorage.getItem(storageKey);
    const arr = raw ? JSON.parse(raw) : null;
    if (Array.isArray(arr) && arr.length > 0) return arr.slice(0, 60);
  } catch {
    /* ignore */
  }
  return DEFAULT_FIELDS;
}

function loadShowAll(): boolean {
  try {
    return personalStorage.getItem('fin.mergeTable.showAll') === '1';
  } catch {
    return false;
  }
}

/** 百分比变动（同比/环比），null 安全 */
function pctChange(cur: number | null, prev: number | null): number | null {
  if (cur === null || prev === null || !Number.isFinite(cur) || !Number.isFinite(prev)) return null;
  if (prev === 0) return null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}

function pctCls(v: number | null): string {
  if (v === null) return 'text-slate-400';
  if (v > 0) return 'text-slate-600';
  if (v < 0) return 'font-medium text-slate-700';
  return 'text-slate-500';
}

type ReportKind = 'q1' | 'semi' | 'q3' | 'annual';
function reportKindOf(period: string, kinds?: Record<string, string>): ReportKind | null {
  if (kinds) {
    const kind = kinds[period];
    return ['q1', 'semi', 'q3', 'annual'].includes(kind) ? kind as ReportKind : null;
  }
  return ({ '03-31': 'q1', '06-30': 'semi', '09-30': 'q3', '12-31': 'annual' } as Record<string, ReportKind>)[period.slice(5, 10)] ?? null;
}

export default function FinanceTable({ code }: { code: string }) {
  const fieldsKey = financeStorageKey(LS_FIELDS, code);
  const [loadedFieldsKey, setLoadedFieldsKey] = useState('');
  const [granularity, setGranularity] = useState<'annual' | 'semi' | 'quarter'>('quarter');
  const [years, setYears] = useState<number>(10);
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
  const [selectedReportKind, setSelectedReportKind] = useState<ReportKind | null>(null);
  const [originals, setOriginals] = useState<{ key: string; items: FinancialReportLink[]; failed: boolean }>({ key: '', items: [], failed: false });
  const [originalRetry, setOriginalRetry] = useState(0);
  const bootedRef = useRef(false);
  const tableRef = useRef<HTMLDivElement>(null);
  const [tableHeight, setTableHeight] = useState<number>();
  const activeReportRef = useRef<string | null>(null);
  const activeReportCells = useRef<HTMLElement[]>([]);

  function highlightReport(target: EventTarget | null) {
    const report = target instanceof Element
      ? target.closest<HTMLElement>('[data-report]')?.dataset.report ?? null
      : null;
    if (report === activeReportRef.current) return;
    for (const cell of activeReportCells.current) cell.removeAttribute('data-active-report');
    activeReportRef.current = report;
    activeReportCells.current = report
      ? [...(tableRef.current?.querySelectorAll<HTMLElement>('[data-report]') ?? [])]
          .filter((cell) => cell.dataset.report === report)
      : [];
    for (const cell of activeReportCells.current) cell.setAttribute('data-active-report', '');
  }

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
    const isHk = fieldsKey.endsWith('.hk');
    let loaded = loadFields(fieldsKey);
    if (isHk && !personalStorage.getItem(fieldsKey)) {
      // 旧全局键里可能存有港股配置，搬迁过来
      const legacy = takeLegacyHkMergeFields(LS_FIELDS);
      if (legacy) loaded = legacy;
    } else {
      // 清洗残留的异市场科目 key（旧全局键污染）
      loaded = sanitizeFields(loaded, isHk);
    }
    setFields(loaded);
    setShowAll(loadShowAll());
    bootedRef.current = true;
    setLoadedFieldsKey(fieldsKey);
  }, [fieldsKey]);

  useEffect(() => {
    if (!bootedRef.current || loadedFieldsKey !== fieldsKey) return;
    try {
      personalStorage.setItem(fieldsKey, JSON.stringify(fields));
      personalStorage.setItem('fin.mergeTable.showAll', showAll ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [fields, showAll, loadedFieldsKey, fieldsKey]);

  useEffect(() => {
    let alive = true;
    setCatalog(null);
    fetchJson(`/api/finance-fields?code=${code}`)
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

  /** 港股等非 A 股目录：用户本地保存的 A 股科目 key 全部失配时，改用服务端推荐的默认字段 */
  useEffect(() => {
    if (!catalog) return;
    const dft = (catalog as { defaultFields?: string[] }).defaultFields;
    if (!dft || dft.length === 0) return;
    const hasStatementField = fields.some((k) => /^(bs|pl|cf)_/.test(k) && fieldMetas.has(k));
    if (!hasStatementField) setFields(dft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    fetchJson('/api/finance-compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        codes: codesSig,
        years,
        granularity,
        fields: fieldsSig.split(','),
      }),
    })
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
  const isHk = fieldsKey.endsWith('.hk');
  const annualPeriods = periodsAsc.filter(period => reportKindOf(period, primary?.periodKinds) === 'annual');
  const calendarYear = annualPeriods.length > 0 && annualPeriods.every(period => period.endsWith('-12-31'));
  const originalKey = `${code}:${isHk ? calendarYear : false}`;
  const canLookupOriginals = !isHk || !!primary;
  useEffect(() => {
    if (!canLookupOriginals) return;
    const controller = new AbortController();
    setOriginals({ key: originalKey, items: [], failed: false });
    fetchJson(`/api/financial-reports?${new URLSearchParams({ code, calendarYear: isHk && calendarYear ? '1' : '0' })}`, { signal: controller.signal })
      .then((result) => {
        if (!result.ok || !Array.isArray(result.data)) throw Error('原文目录加载失败');
        if (!controller.signal.aborted) setOriginals({ key: originalKey, items: result.data, failed: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setOriginals({ key: originalKey, items: [], failed: true });
      });
    return () => controller.abort();
  }, [code, originalKey, canLookupOriginals, originalRetry]);
  const originalOf = (period: string, kind: ReportKind | null) => originals.key === originalKey
    ? originals.items.find(item => item.period === period && item.kind === kind) : undefined;
  /** 列标题按当前粒度口径改写：年报视图的 12-31 显示「年报」，中报视图显示「中报」 */
  const labelOf = (period: string, raw: string): string => {
    if (primary?.periodKinds) return raw;
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
      kind: reportKindOf(p, primary?.periodKinds),
      i,
    }));
    return idx.reverse();
  }, [periodsAsc.join(','), labelsAsc.join(','), granularity, JSON.stringify(primary?.periodKinds)]);

  useEffect(() => {
    setSelectedReportKind(null);
  }, [code, granularity]);

  useEffect(() => {
    for (const cell of activeReportCells.current) cell.removeAttribute('data-active-report');
    activeReportRef.current = null;
    activeReportCells.current = [];
  }, [data, view, granularity, years, kw, onlyHasData]);

  const reportProps = (period: string, index: number) => ({
    'data-report': period,
    'data-matching-report': selectedReportKind !== null && colsDesc[index]?.kind === selectedReportKind ? '' : undefined,
    'data-year-boundary': index > 0 && period.slice(0, 4) !== colsDesc[index - 1].p.slice(0, 4) ? '' : undefined,
  });

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
      const kind = primary?.periodKinds?.[p];
      if (kind) return ({q1:1,semi:2,q3:3,annual:4} as Record<string,number>)[kind] ?? 0;
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
      const prevQDate = new Date(Date.UTC(Number(y), Number(p.slice(5,7)) - 3, 0)).toISOString().slice(0,10);
      const pi = periodsAsc.indexOf(prevQDate);
      const pv = pi >= 0 ? s[pi] : null;
      if (pv === null || pv === undefined || !Number.isFinite(pv)) return null;
      curQ = v - pv;
    }
    // 上年同期单季
    const prevYearDate = p.slice(5);
    const yi = periodsAsc.indexOf(`${Number(p.slice(0, 4)) - 1}-${prevYearDate}`);
    if (yi < 0) return null;
    const yv = s[yi];
    if (yv === null || yv === undefined || !Number.isFinite(yv)) return null;
    let prevQ: number | null = yv;
    if (qOfMonth(p) > 1) {
      const py = String(Number(p.slice(0, 4)) - 1);
      const prevQDate = new Date(Date.UTC(Number(py), Number(p.slice(5,7)) - 3, 0)).toISOString().slice(0,10);
      const pi2 = periodsAsc.indexOf(prevQDate);
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
      const unit = financialUnitText(r.meta?.unit ?? '', r.meta?.label ?? r.key, true);
      for (const c of companies) {
        const name = companies.length > 1 ? `${c.name}(${c.code})` : '';
        const cells = colsDesc.map((col) => {
          const v = valOf(c, r.key, col.i);
          return v === null ? '' : String(v);
        });
        lines.push(
          [name || (r.meta?.label ?? r.key), `${unit}${['wan', 'yuan'].includes(r.meta?.unit ?? '') && c.fieldCurrencies?.[r.key] ? ` · ${c.fieldCurrencies[r.key]}` : ''}`, ...cells].map((x) => `"${x}"`).join(',')
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
      <MarketDataNotice value={data} />
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-1.5">
          <div className="flex max-w-full gap-1 overflow-x-auto" role="group" aria-label="报表视图">
            {(
              [
                ['indicators', '自定义财报'],
                ['pl', '利润表'],
                ['bs', '资产负债表'],
                ['cf', '现金流量表'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setView(key)}
                aria-pressed={view === key}
                className={`min-h-8 shrink-0 rounded-md px-2.5 text-xs font-medium transition ${view === key ? 'bg-brand-50 text-brand-700' : 'text-slate-500 hover:bg-slate-50'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3 text-xs text-slate-500">
            {originals.key === originalKey && originals.failed && (
              <button type="button" onClick={() => setOriginalRetry(value => value + 1)} className="text-slate-500 hover:text-brand-700" title="重新加载近两年财报原文目录">
                原文暂不可用 · 重试
              </button>
            )}
            <span className="hidden font-medium sm:block">{primary?.name ?? code}{primary?.currency ? ` · ${primary.currency}` : ''}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
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
        <div
          ref={tableRef}
          style={{ height: tableHeight }}
          onPointerOver={(event) => {
            if (event.pointerType !== 'touch') highlightReport(event.target);
          }}
          onPointerLeave={() => highlightReport(null)}
          className="h-[calc(100dvh-21rem)] min-h-[320px] overflow-auto sm:h-[calc(100dvh-16rem)]"
        >
          <table aria-label="财务报表" className="finance-data-table w-full border-collapse text-xs">
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
                {colsDesc.map((c, index) => {
                  const original = originalOf(c.p, c.kind);
                  return (
                  <th
                    key={c.p}
                    scope="col"
                    {...reportProps(c.p, index)}
                    className="min-w-[92px] border-b border-l border-slate-200 bg-slate-50 px-2.5 py-2 text-center font-semibold text-slate-700"
                  >
                    <div className="flex items-center justify-center gap-1">
                    <button
                      type="button"
                      disabled={c.kind === null}
                      aria-pressed={c.kind !== null && selectedReportKind === c.kind}
                      onClick={() => setSelectedReportKind((current) => current === c.kind ? null : c.kind)}
                      className="rounded-sm text-center hover:text-brand-700 disabled:cursor-default disabled:hover:text-inherit"
                    >
                      {c.label}
                    </button>
                    {original && (
                      <a
                        href={original.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`查看${original.title}原文`}
                        title={`${original.title}${original.revised ? ' · 修订版' : ''}\n披露日期：${original.publishedAt} · ${original.source}\n新标签页打开 PDF`}
                        onClick={event => event.stopPropagation()}
                        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-400 transition hover:bg-brand-100 hover:text-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600"
                      >
                        <svg aria-hidden="true" width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M11.5 3.5h5v5m0-5-8 8M8 4.5H4.5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V12" />
                        </svg>
                      </a>
                    )}
                    </div>
                  </th>
                  );
                })}
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
                const unitText = financialUnitText(unit, r.meta?.label ?? r.key);
                return (
                  <tbody key={r.key} className="finance-metric border-b-2 border-slate-200">
                    {companies.map((c, ci) => {
                      const showYoY = companies.length === 1;
                      // 仅季报中的可加减利润/现金流总额显示单季同比。
                      // 比率、存量和每股金额不满足累计相减条件。
                      const isStock = r.key.startsWith('bs_') || ['bps', 'undistPerShare'].includes(r.key);
                      const isRatio = unit === 'pct' || unit === 'ratio';
                      const hasSingle = showYoY && showSingleQuarterChange(r.key, unit, granularity);
                      return (
                        <Fragment key={c.code}>
                          {/* 数值行 */}
                          <tr key={`${r.key}-${c.code}-v`} className="finance-value-row">
                            <td
                              className={`sticky left-0 z-10 bg-white px-3 pb-1 ${ci === 0 ? 'pt-2.5' : 'pl-6 pt-2.5'}`}
                            >
                              {ci === 0 && (
                                <div className="flex items-baseline gap-1.5">
                                  <span className="font-medium text-slate-800">
                                    {r.meta?.label ?? r.key}
                                  </span>
                                  <span className="text-[11px] font-normal text-slate-500">{unitText}{['wan', 'yuan'].includes(unit) && c.fieldCurrencies?.[r.key] ? ` · ${c.fieldCurrencies[r.key]}` : ''}</span>
                                </div>
                              )}
                              {ci > 0 && (
                                <span className="text-[11px] text-orange-600">{c.name}</span>
                              )}
                            </td>
                            {colsDesc.map((col, index) => (
                              <td
                                key={col.p}
                                {...reportProps(col.p, index)}
                                data-missing={valOf(c, r.key, col.i) === null ? '' : undefined}
                                className="finance-main-value border-l border-slate-100 px-2.5 pb-1 pt-2.5 text-right tabular-nums text-slate-900"
                              >
                                {fmtVal(valOf(c, r.key, col.i), unit)}
                              </td>
                            ))}
                          </tr>
                          {/* 同比 / 环比（仅单公司时展开；与理杏仁一致：上行同比、下行环比） */}
                          {showYoY && (
                            <>
                              <tr className="finance-change-row text-[11px]">
                                <td className="sticky left-0 z-10 bg-white px-3 py-0.5 text-[11px] text-slate-500">
                                  {isStock || isRatio ? '同比' : '累计同比'}
                                </td>
                                {colsDesc.map((col, index) => {
                                  const yi = yoyIndex(col.i);
                                  const v =
                                    yi >= 0
                                      ? pctChange(valOf(c, r.key, col.i), valOf(c, r.key, yi))
                                      : null;
                                  return (
                                    <td
                                      key={col.p}
                                      {...reportProps(col.p, index)}
                                      data-missing={v === null ? '' : undefined}
                                      className={`border-l border-slate-100 px-2.5 py-0.5 text-right tabular-nums ${pctCls(v)}`}
                                    >
                                      {v === null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`}
                                    </td>
                                  );
                                })}
                              </tr>
                              {hasSingle && (
                                <tr className="finance-change-row text-[11px]">
                                  <td className="sticky left-0 z-10 bg-white px-3 pb-2 pt-0.5 text-[11px] text-slate-500">
                                    单季同比
                                  </td>
                                  {colsDesc.map((col, index) => {
                                    const v = sqYoy(c, r.key, col.i);
                                    return (
                                      <td
                                        key={col.p}
                                        {...reportProps(col.p, index)}
                                        data-missing={v === null ? '' : undefined}
                                        className={`border-l border-slate-100 px-2.5 py-0.5 text-right tabular-nums ${pctCls(v)}`}
                                      >
                                        {v === null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`}
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
                  </tbody>
                );
              })}
          </table>
        </div>
        <div className="border-t border-slate-100 px-4 py-3 text-xs leading-6 text-slate-500">
          <details>
            <summary>报表口径</summary>
            口径：三大报表总额按万元获取并折算为亿元展示，每股金额和比率按各行单位展示；财务指标（ROE
            等）来自新浪财务指标页。 累积 = 与上一年同期累计值相比；单季 = 单季值（当期累计 −
            同年上一报告期累计）与上年同期单季相比，仅季报视图提供；null 表示当期未披露。
            资产负债表科目为时点数、比率和每股指标不作累计相减，故不显示单季行。
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
