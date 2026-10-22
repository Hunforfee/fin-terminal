'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { StockLink } from '@/components/StockLink';
import { useSearchParams } from 'next/navigation';
import Modal from '@/components/Modal';
import WatchlistButton from '@/components/WatchlistButton';
import StockScopeFilter from '@/components/StockScopeFilter';
import IndustryMultiSelect from '@/components/IndustryMultiSelect';
import { useWatchlist } from '@/components/WatchlistProvider';
import { normalizeStockCode } from '@/lib/datasource/codes';
import { industryStockSymbol } from '@/lib/industryResearch';
import ScreenerGroupImport from '@/components/ScreenerGroupImport';
import { personalStorage, AUTH_CHANGE } from '@/lib/personalStorage';
import { compareResearchValues } from '@/lib/researchColumns';
import {
  SCREEN_PREFERENCES_KEY, SCREEN_SCHEMES_KEY, SCREEN_COLUMNS, DEFAULT_SCREEN_COLUMNS,
  SCREEN_AUTO_PERIOD, emptyScreenerDraft, readScreenerPreferences, readScreenerSchemes,
  type ScreenerDraft, type ScreenerPreferences, type ScreenerScheme, type ScreenColumnId, type ScreenerSort,
} from '@/lib/screenerPreferences';
import type { ValueScreenCriteria, ValueScreenMeta, ValueScreenResult, ValueScreenRow } from '@/lib/valueScreen';

type NumericField = Exclude<keyof ScreenerDraft, 'scope' | 'industries' | 'period' | 'cashflowPositive' | 'deductedProfitPositive' | 'excludeST' | 'excludeLoss'>;
const NUMERIC_FIELDS: NumericField[] = ['peMin', 'peMax', 'pbMin', 'pbMax', 'roeMin', 'netMarginMin', 'revenueGrowthMin', 'profitGrowthMin', 'deductedGrowthMin', 'debtRatioMax', 'marketCapMin', 'marketCapMax', 'ocfMin', 'ocfToProfitMin'];
const PRESETS: { name: string; title: string; values: Partial<ScreenerDraft> }[] = [
  { name: '低估值', title: '0 < PE ≤ 20，0 < PB ≤ 2', values: { peMin: '0', peMax: '20', pbMin: '0', pbMax: '2' } },
  { name: '盈利质量', title: 'ROE ≥ 15%，净利率 ≥ 10%，负债率 ≤ 60%，经营现金流为正', values: { roeMin: '15', netMarginMin: '10', debtRatioMax: '60', cashflowPositive: true } },
  { name: '持续成长', title: '营收同比 ≥ 10%，扣非净利同比 ≥ 10%，扣非利润为正', values: { revenueGrowthMin: '10', deductedGrowthMin: '10', deductedProfitPositive: true } },
  { name: '现金流', title: '经营现金流为正，且不低于同期净利润', values: { cashflowPositive: true, ocfToProfitMin: '100' } },
];
const number = (value: unknown, digits = 2) => typeof value !== 'number' || !Number.isFinite(value) ? '—' : value.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const periodLabel = (period: string) => period === SCREEN_AUTO_PERIOD ? '最新披露财报' : period;
const toneClass = { valuation: 'text-blue-700', quality: 'text-teal-800', growth: 'text-teal-700', cash: 'text-cyan-800', risk: 'text-amber-800', neutral: 'text-slate-500' };
function draftError(draft: ScreenerDraft): string | null {
  if (!draft.industries.length) return '请选择至少一个行业';
  for (const key of NUMERIC_FIELDS) if (draft[key].trim() && !Number.isFinite(Number(draft[key]))) return '条件需填写有效数字';
  for (const [low, high, label] of [['peMin', 'peMax', 'PE'], ['pbMin', 'pbMax', 'PB'], ['marketCapMin', 'marketCapMax', '总市值']] as const)
    if (draft[low].trim() && draft[high].trim() && Number(draft[low]) > Number(draft[high])) return `${label}下限不能大于上限`;
  return null;
}
function activeConditions(draft: ScreenerDraft): string[] {
  const labels: Record<NumericField, string> = { peMin: 'PE ≥', peMax: 'PE ≤', pbMin: 'PB ≥', pbMax: 'PB ≤', roeMin: 'ROE ≥', netMarginMin: '净利率 ≥', revenueGrowthMin: '营收同比 ≥', profitGrowthMin: '净利同比 ≥', deductedGrowthMin: '扣非同比 ≥', debtRatioMax: '负债率 ≤', marketCapMin: '市值 ≥', marketCapMax: '市值 ≤', ocfMin: '经营现金流 ≥', ocfToProfitMin: '现金净利比 ≥' };
  const units: Partial<Record<NumericField, string>> = { peMin: '', peMax: '', pbMin: '', pbMax: '', marketCapMin: '亿', marketCapMax: '亿', ocfMin: '亿' };
  const industryTags = (list: string[], label: string) => list.length ? [`${label} ${list.slice(0, 2).join('、')}${list.length > 2 ? ` 等${list.length}个` : ''}`] : [];
  return [
    ...NUMERIC_FIELDS.filter(key => draft[key].trim()).map(key => `${labels[key]} ${draft[key]}${units[key] ?? '%'}`),
    ...(draft.cashflowPositive ? ['经营现金流为正'] : []),
    ...(draft.deductedProfitPositive ? ['扣非利润为正'] : []),
    ...industryTags(draft.industries, '行业'),
    ...(draft.excludeST ? ['排除 ST'] : []), ...(draft.excludeLoss ? ['排除亏损'] : []),
  ];
}
function NumericInput({ label, value, onChange, suffix = '%', operator = '≥', title }: { label: string; value: string; onChange: (value: string) => void; suffix?: string; operator?: string; title?: string }) {
  return <label className="block min-w-0 text-[11px] text-slate-500" title={title}><span className="mb-0.5 block whitespace-nowrap">{label}</span><span className="flex h-7 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-1.5 focus-within:border-brand-300 focus-within:ring-2 focus-within:ring-brand-100"><span className="text-xs text-slate-400" aria-hidden="true">{operator}</span><input type="number" step="any" aria-label={label} value={value} onChange={event => onChange(event.target.value)} placeholder="不限" className="min-w-0 flex-1 bg-transparent text-xs tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none text-slate-800 outline-none placeholder:text-slate-300" /><span className="text-[11px] text-slate-400">{suffix}</span></span></label>;
}
function RangeInput({ label, min, max, onMin, onMax, suffix = '' }: { label: string; min: string; max: string; onMin: (value: string) => void; onMax: (value: string) => void; suffix?: string }) {
  return <div className="min-w-0 text-[11px] text-slate-500"><span className="mb-0.5 block">{label}{suffix && `（${suffix}）`}</span><div className="flex h-7 min-w-0 items-center gap-1 rounded-md border border-slate-200 bg-white px-1.5 focus-within:border-brand-300 focus-within:ring-2 focus-within:ring-brand-100"><input type="number" step="any" aria-label={`${label}下限`} value={min} onChange={event => onMin(event.target.value)} placeholder="最低" className="w-0 min-w-0 flex-1 bg-transparent text-xs tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none text-slate-800 outline-none placeholder:text-slate-300" /><span aria-hidden="true" className="text-slate-300">至</span><input type="number" step="any" aria-label={`${label}上限`} value={max} onChange={event => onMax(event.target.value)} placeholder="最高" className="w-0 min-w-0 flex-1 bg-transparent text-right text-xs tabular-nums text-slate-800 outline-none placeholder:text-slate-300" /></div></div>;
}
const downloadCsv = (rows: ValueScreenRow[], columns: ScreenColumnId[], period: string) => {
  const catalog = columns.map(id => SCREEN_COLUMNS.find(column => column.id === id)!);
  const escape = (value: unknown) => { let text = value == null ? '' : String(value); if (typeof value === 'string' && /^[=+@-]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; };
  const data = [['公司', '代码', '行业', ...catalog.map(column => `${column.label}${column.kind === 'percent' ? '（%）' : ''}`), '公告日', '行情时间'], ...rows.map(row => [row.name, `\t${row.code}`, row.industry, ...catalog.map(column => row[column.id]), row.noticeDate, row.quoteTime])];
  const url = URL.createObjectURL(new Blob(['\uFEFF' + data.map(row => row.map(escape).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `基本面选股-${period === SCREEN_AUTO_PERIOD ? '最新数据' : period}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
export default function ScreenerPage() {
  return <Suspense fallback={<p className="text-xs text-slate-500">加载选股条件…</p>}><ScreenerContent /></Suspense>;
}
function ScreenerContent() {
  const params = useSearchParams(), watchlist = useWatchlist();
  const [meta, setMeta] = useState<ValueScreenMeta | null>(null), [draft, setDraft] = useState(() => emptyScreenerDraft(SCREEN_AUTO_PERIOD));
  const [applied, setApplied] = useState<ScreenerDraft | null>(null), [result, setResult] = useState<ValueScreenResult | null>(null);
  const [appliedScopeKey, setAppliedScopeKey] = useState('');
  const [preferences, setPreferences] = useState<ScreenerPreferences>(() => readScreenerPreferences(null));
  const [preferencesReady, setPreferencesReady] = useState(false), [schemes, setSchemes] = useState<ScreenerScheme[]>([]), [schemeId, setSchemeId] = useState('');
  const [schemeOpen, setSchemeOpen] = useState(false), [schemeName, setSchemeName] = useState(''), [schemeError, setSchemeError] = useState('');
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('');
  const [selected, setSelected] = useState<string[]>([]), [groupImportOpen, setGroupImportOpen] = useState(false);
  const [page, setPage] = useState(1), [pageSize, setPageSize] = useState(20), [jump, setJump] = useState(''), [height, setHeight] = useState<number | undefined>();
  const rootRef = useRef<HTMLDivElement>(null), tableRef = useRef<HTMLDivElement>(null), checkboxRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef<AbortController | null>(null), statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const metaRef = useRef(meta); metaRef.current = meta;
  const initialIndustry = useRef(params.get('industry') ?? '');
  const scopeCodes = (scope: string) => {
    const codes = scope.startsWith('group:') ? watchlist.codesIn(scope.slice(6)) : watchlist.codes;
    return [...new Set(codes.flatMap(code => { const stock = normalizeStockCode(code); return stock && industryStockSymbol(stock.code) === stock.symbol ? [stock.symbol] : []; }))].sort();
  };
  const setValue = <K extends keyof ScreenerDraft>(key: K, value: ScreenerDraft[K]) => setDraft(previous => ({ ...previous, [key]: value }));
  const performScreen = async (next: ScreenerDraft) => {
    const invalid = draftError(next); if (invalid) { setError(invalid); return; }
    const payload: ValueScreenCriteria = { period: SCREEN_AUTO_PERIOD, excludeST: next.excludeST, excludeLoss: next.excludeLoss, scope: next.scope === 'all' ? 'all' : 'watchlist', cashflowPositive: next.cashflowPositive, deductedProfitPositive: next.deductedProfitPositive };
    if (next.industries.length) payload.industries = next.industries;
    for (const key of NUMERIC_FIELDS) if (next[key].trim()) payload[key] = Number(next[key]);
    if (next.scope !== 'all') payload.codes = scopeCodes(next.scope);
    const scopeKey = next.scope === 'all' ? 'all' : payload.codes!.join(',');
    requestRef.current?.abort(); const controller = new AbortController(); requestRef.current = controller;
    setLoading(true); setGroupImportOpen(false); setError(''); setStatus('');
    try {
      const response = await fetch('/api/screen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal }); const json = await response.json();
      if (!json.ok) throw Error(json.error ?? '筛选失败'); if (controller.signal.aborted) return;
      setResult(json.data); setApplied({ ...next }); setAppliedScopeKey(scopeKey); setSelected([]); setPage(1); setJump('');
    } catch (issue) { if (!controller.signal.aborted) setError(issue instanceof Error ? issue.message : '筛选失败'); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  };
  useEffect(() => {
    const loadPersonal = (reset = false) => {
      try { setPreferences({ ...readScreenerPreferences(JSON.parse(personalStorage.getItem(SCREEN_PREFERENCES_KEY) ?? 'null')), filtersCollapsed: false }); } catch { setPreferences(readScreenerPreferences(null)); }
      try { setSchemes(readScreenerSchemes(JSON.parse(personalStorage.getItem(SCREEN_SCHEMES_KEY) ?? 'null'), SCREEN_AUTO_PERIOD)); } catch { setSchemes([]); }
      setPreferencesReady(true); setSchemeId('');
      if (reset) { requestRef.current?.abort(); setResult(null); setApplied(null); setGroupImportOpen(false); setSelected([]); setStatus(''); setError(''); if (metaRef.current) { setDraft({ ...emptyScreenerDraft(SCREEN_AUTO_PERIOD), industries: metaRef.current.industries.map(item => item.name) }); setLoading(false); } }
    };
    loadPersonal(); const onAccount = () => loadPersonal(true); window.addEventListener(AUTH_CHANGE, onAccount);
    return () => { window.removeEventListener(AUTH_CHANGE, onAccount); requestRef.current?.abort(); if (statusTimer.current) clearTimeout(statusTimer.current); };
  }, []);
  useEffect(() => { if (preferencesReady) { try { personalStorage.setItem(SCREEN_PREFERENCES_KEY, JSON.stringify(preferences)); } catch {} } }, [preferences, preferencesReady]);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/screen?meta=1', { signal: controller.signal }).then(response => response.json()).then(json => {
      if (!json.ok) throw Error(json.error ?? '选股目录加载失败'); if (controller.signal.aborted) return;
      const nextMeta = json.data as ValueScreenMeta; setMeta(nextMeta); metaRef.current = nextMeta;
      const requested = initialIndustry.current;
      const next = { ...emptyScreenerDraft(SCREEN_AUTO_PERIOD), industries: requested && nextMeta.industries.some(industry => industry.name === requested) ? [requested] : nextMeta.industries.map(item => item.name) };
      setDraft(next);
    }).catch(issue => { if (!controller.signal.aborted) { setError(issue.message ?? '选股目录加载失败'); setLoading(false); } });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const measure = () => { if (rootRef.current) setHeight(Math.max(420, window.innerHeight - rootRef.current.getBoundingClientRect().top - 12)); };
    measure(); const observer = new ResizeObserver(measure); observer.observe(document.querySelector('header') ?? document.body); window.addEventListener('resize', measure); window.visualViewport?.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.visualViewport?.removeEventListener('resize', measure); };
  }, []);
  useEffect(() => {
    const element = tableRef.current; if (!element) return;
    const measure = () => { const heading = element.querySelector('thead')?.getBoundingClientRect().height ?? 32; const row = element.querySelector('tr[data-code]')?.getBoundingClientRect().height ?? 34; setPageSize(Math.max(4, Math.floor((element.clientHeight - heading) / Math.max(28, row)))); };
    measure(); const observer = new ResizeObserver(measure); observer.observe(element); return () => observer.disconnect();
  }, [result?.rows.length, preferences.columns.length]);
  const sorted = useMemo(() => [...(result?.rows ?? [])].sort((left, right) => compareResearchValues(left[preferences.sort.key], right[preferences.sort.key], preferences.sort.direction)), [result, preferences.sort]);
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize)), visibleRows = sorted.slice((page - 1) * pageSize, page * pageSize);
  const pageSelected = visibleRows.filter(row => selected.includes(row.symbol)).length, allSelected = visibleRows.length > 0 && pageSelected === visibleRows.length;
  const currentScopeKey = draft.scope === 'all' ? 'all' : scopeCodes(draft.scope).join(',');
  const dirty = !applied || JSON.stringify(draft) !== JSON.stringify(applied) || currentScopeKey !== appliedScopeKey, conditions = activeConditions(draft);
  useEffect(() => { setPage(previous => Math.min(previous, pageCount)); }, [pageCount]);
  useEffect(() => { if (checkboxRef.current) checkboxRef.current.indeterminate = pageSelected > 0 && pageSelected < visibleRows.length; }, [pageSelected, visibleRows.length]);
  const updateSort = (key: ScreenerSort['key']) => { setPreferences(previous => ({ ...previous, sort: { key, direction: previous.sort.key === key ? previous.sort.direction === 'asc' ? 'desc' : 'asc' : key === 'name' || key === 'industry' || key === 'pe' || key === 'pb' ? 'asc' : 'desc' } })); setPage(1); };
  const updateColumns = (columns: ScreenColumnId[]) => setPreferences(previous => readScreenerPreferences({ ...previous, columns }));
  const applyPreset = (values: Partial<ScreenerDraft>) => { setDraft(previous => ({ ...emptyScreenerDraft(previous.period), scope: previous.scope, industries: previous.industries, ...values })); setSchemeId(''); };
  const applyScheme = (id: string) => { setSchemeId(id); const scheme = schemes.find(item => item.id === id); if (!scheme) return; setDraft({ ...scheme.criteria, period: SCREEN_AUTO_PERIOD, industries: scheme.criteria.industries.length ? scheme.criteria.industries : (meta?.industries ?? []).map(item => item.name) }); setPreferences(previous => readScreenerPreferences({ ...previous, columns: scheme.columns, sort: scheme.sort })); };
  const saveSchemes = (next: ScreenerScheme[]): boolean => {
    try { personalStorage.setItem(SCREEN_SCHEMES_KEY, JSON.stringify(next)); setSchemes(next); return true; }
    catch { setSchemeError('保存失败，请检查浏览器存储'); return false; }
  };
  const saveScheme = () => {
    const name = schemeName.trim(), invalid = draftError(draft);
    if (!name) { setSchemeError('填写方案名称'); return; } if (invalid) { setSchemeError(invalid); return; }
    const current = schemes.find(item => item.id === schemeId), sameName = schemes.find(item => item.name === name);
    if (current && sameName && current.id !== sameName.id) { setSchemeError('已有同名方案'); return; }
    const existing = current ?? sameName; if (!existing && schemes.length >= 12) { setSchemeError('最多保存12个方案'); return; }
    const next: ScreenerScheme = { id: existing?.id ?? crypto.randomUUID(), name, criteria: { ...draft }, columns: preferences.columns, sort: preferences.sort };
    const updated = readScreenerSchemes([...schemes.filter(item => item.id !== next.id), next], SCREEN_AUTO_PERIOD);
    if (!updated.some(item => item.id === next.id)) { setSchemeError('方案中的条件无效'); return; }
    if (saveSchemes(updated)) { setSchemeId(next.id); setSchemeOpen(false); }
  };
  const onGroupImported = (message: string) => {
    setStatus(message); setSelected([]); setGroupImportOpen(false);
    if (statusTimer.current) clearTimeout(statusTimer.current); statusTimer.current = setTimeout(() => setStatus(''), 6000);
  };
  const movePage = (next: number) => { setPage(Math.max(1, Math.min(pageCount, next))); if (tableRef.current) tableRef.current.scrollTop = 0; };
  const head = (key: ScreenerSort['key'], label: string, tone = 'text-slate-500') => <button type="button" onClick={() => updateSort(key)} aria-label={`按${label}排序`} className={`inline-flex min-h-7 items-center gap-1 whitespace-nowrap font-medium ${preferences.sort.key === key ? 'text-brand-700' : tone}`}>{label}<span aria-hidden="true" className={preferences.sort.key === key ? 'text-brand-600' : 'text-slate-300'}>{preferences.sort.key === key ? preferences.sort.direction === 'asc' ? '↑' : '↓' : '↕'}</span></button>;
  const sortAria = (key: ScreenerSort['key']) => preferences.sort.key === key ? preferences.sort.direction === 'asc' ? 'ascending' as const : 'descending' as const : 'none' as const;
  const columns = preferences.columns.map(id => SCREEN_COLUMNS.find(column => column.id === id)!);
  const selectedScopeMissing = draft.scope.startsWith('group:') && !watchlist.groups.some(group => `group:${group.id}` === draft.scope);
  return <div ref={rootRef} style={{ height: height ?? 'calc(100dvh - 68px)' }} className="flex min-h-[420px] flex-col overflow-hidden rounded-lg border border-slate-200 bg-white">
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h1 className="mr-1 text-base font-semibold text-slate-900">条件选股</h1>
        <StockScopeFilter value={{ onlyWatched: draft.scope !== 'all', excludeST: draft.excludeST, excludeLoss: draft.excludeLoss }} onChange={value => setDraft(previous => ({ ...previous, scope: value.onlyWatched ? previous.scope === 'all' ? 'watchlist' : previous.scope : 'all', excludeST: value.excludeST, excludeLoss: value.excludeLoss }))} />
        {draft.scope !== 'all' && <select aria-label="自选范围" value={draft.scope} onChange={event => setValue('scope', event.target.value)} className="input !min-h-8 !w-auto !max-w-40 !py-1 !text-xs"><option value="watchlist">全部自选</option>{watchlist.groups.map(group => <option key={group.id} value={`group:${group.id}`}>{group.name}</option>)}{selectedScopeMissing && <option value={draft.scope}>原分组已删除</option>}</select>}
        <IndustryMultiSelect options={meta?.industries ?? []} included={draft.industries} onIncludedChange={value => setValue('industries', value)} />
      </div>
      <div className="ml-auto flex items-center gap-2">
        <select aria-label="我的选股方案" value={schemeId} onChange={event => applyScheme(event.target.value)} className="input !min-h-8 !w-auto !max-w-36 !py-1 !text-xs"><option value="">我的方案</option>{schemes.map(scheme => <option key={scheme.id} value={scheme.id}>{scheme.name}</option>)}</select>
        <button type="button" onClick={() => { setSchemeName(schemes.find(scheme => scheme.id === schemeId)?.name ?? ''); setSchemeError(''); setSchemeOpen(true); }} disabled={!draft.period} className="btn !min-h-8 !px-2 !py-1 !text-xs">保存方案</button>
        <button type="button" onClick={() => setPreferences(previous => ({ ...previous, filtersCollapsed: !previous.filtersCollapsed }))} className="min-h-8 whitespace-nowrap text-xs text-slate-500 hover:text-brand-700">{preferences.filtersCollapsed ? '展开条件' : '收起条件'}</button>
      </div>
    </div>
    <form onSubmit={event => { event.preventDefault(); void performScreen(draft); }} className="shrink-0 border-b border-slate-200/70 bg-slate-50/40 px-3 py-2">
      {!preferences.filtersCollapsed && <>
        <div className="overflow-x-auto pb-1"><div className="grid min-w-[1140px] grid-cols-[repeat(11,minmax(0,1fr))] gap-1.5">
          <RangeInput label="PE-TTM" min={draft.peMin} max={draft.peMax} onMin={value => setValue('peMin', value)} onMax={value => setValue('peMax', value)} />
          <RangeInput label="PB" min={draft.pbMin} max={draft.pbMax} onMin={value => setValue('pbMin', value)} onMax={value => setValue('pbMax', value)} />
          <NumericInput label="加权ROE" value={draft.roeMin} onChange={value => setValue('roeMin', value)} title="最新报告期披露的加权净资产收益率" />
          <NumericInput label="营收同比" value={draft.revenueGrowthMin} onChange={value => setValue('revenueGrowthMin', value)} />
          <NumericInput label="扣非净利同比" value={draft.deductedGrowthMin} onChange={value => setValue('deductedGrowthMin', value)} />
          <NumericInput label="资产负债率" value={draft.debtRatioMax} onChange={value => setValue('debtRatioMax', value)} operator="≤" />

          <NumericInput label="销售净利率" value={draft.netMarginMin} onChange={value => setValue('netMarginMin', value)} />
          <NumericInput label="归母净利同比" value={draft.profitGrowthMin} onChange={value => setValue('profitGrowthMin', value)} />
          <RangeInput label="总市值" suffix="亿元" min={draft.marketCapMin} max={draft.marketCapMax} onMin={value => setValue('marketCapMin', value)} onMax={value => setValue('marketCapMax', value)} />
          <NumericInput label="经营现金流" value={draft.ocfMin} onChange={value => setValue('ocfMin', value)} suffix="亿" />
          <NumericInput label="现金净利比" value={draft.ocfToProfitMin} onChange={value => setValue('ocfToProfitMin', value)} title="同期经营现金流 / 全体净利润 × 100；100%为1倍，净利润非正时留空" />
        </div></div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-slate-600">
          <label className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap"><input type="checkbox" checked={draft.cashflowPositive} onChange={event => setValue('cashflowPositive', event.target.checked)} className="h-3.5 w-3.5 accent-blue-600" />经营现金流为正</label>
          <label className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap"><input type="checkbox" checked={draft.deductedProfitPositive} onChange={event => setValue('deductedProfitPositive', event.target.checked)} className="h-3.5 w-3.5 accent-blue-600" />扣非利润为正</label>
        </div>
      </>}
      <div className={`flex flex-wrap items-center justify-between gap-2 ${preferences.filtersCollapsed ? '' : 'mt-2'}`}>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">{preferences.filtersCollapsed ? conditions.map(condition => <button key={condition} type="button" onClick={() => setPreferences(previous => ({ ...previous, filtersCollapsed: false }))} className="rounded border border-brand-100 bg-brand-50/60 px-2 py-1 text-[11px] text-brand-800">{condition}</button>) : PRESETS.map(preset => <button key={preset.name} type="button" title={preset.title} onClick={() => applyPreset(preset.values)} className="rounded border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600 hover:border-brand-200 hover:text-brand-700">{preset.name}</button>)}</div>
        <div className="ml-auto flex items-center gap-3">
          {dirty && result && <span className="text-[11px] text-amber-700">条件未应用</span>}
          <button type="button" onClick={() => { setDraft(previous => ({ ...emptyScreenerDraft(previous.period), scope: previous.scope, industries: previous.industries })); setSchemeId(''); setError(''); }} className="text-xs text-slate-500 hover:text-slate-900">清空条件</button>
          <button type="submit" disabled={loading || !meta} className="btn-primary !min-h-8 !px-4 !py-1 !text-xs">{loading ? '筛选中…' : '筛选'}</button>
        </div>
      </div>
    </form>
    {error && <div role="alert" className="flex shrink-0 items-center justify-between gap-2 border-b border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-800"><span>{error}{result ? '，保留上次结果' : ''}</span><button type="button" onClick={() => meta ? void performScreen(draft) : window.location.reload()} className="shrink-0 underline">重试</button></div>}
    <div className="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-slate-100 px-3 py-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-2 text-slate-500">
        <strong className="font-semibold text-slate-800">{result ? `匹配 ${result.total.toLocaleString()} 家` : loading ? '读取财报与行情…' : '尚未筛选'}</strong>
        {selected.length > 0 && <><span className="text-brand-700">已选 {selected.length} 家</span><button type="button" onClick={() => setSelected([])}>清空</button><button type="button" onClick={() => setSelected(sorted.map(row => row.symbol))} className="text-brand-700">全选结果</button></>}
        <button type="button" onClick={() => setGroupImportOpen(true)} disabled={!watchlist.ready || !sorted.length || loading} className="btn-primary !min-h-7 !px-2 !py-0.5 !text-xs">一键添加到分组</button>
        <span role="status" className="text-teal-700">{status}</span>
      </div>
      <div className="ml-auto flex items-center gap-1.5"><button type="button" onClick={() => setColumnsOpen(true)} className="btn !min-h-7 !px-2 !py-0.5 !text-xs">列设置</button><button type="button" disabled={!sorted.length || loading} onClick={() => downloadCsv(sorted, preferences.columns, result!.period)} className="btn !min-h-7 !px-2 !py-0.5 !text-xs">导出 CSV</button></div>
    </div>
    <div ref={tableRef} className="min-h-0 flex-1 overflow-auto overscroll-contain" aria-busy={loading}>
      <table aria-label="基本面选股结果" className="dense-data-table w-full min-w-[1040px] text-[13px]">
        <thead className="sticky top-0 z-20 bg-slate-50"><tr className="text-xs">
          <th className="sticky left-0 z-30 w-8 min-w-8 border-b border-slate-200 px-2 py-1"><input ref={checkboxRef} type="checkbox" aria-label="选择本页公司" checked={allSelected} disabled={!visibleRows.length || loading} onChange={event => setSelected(previous => event.target.checked ? [...new Set([...previous, ...visibleRows.map(row => row.symbol)])] : previous.filter(symbol => !visibleRows.some(row => row.symbol === symbol)))} className="h-3.5 w-3.5 accent-blue-600" /></th>
          <th aria-sort={sortAria('name')} className="sticky left-8 z-30 min-w-[126px] border-b border-slate-200 px-2 py-1 text-left">{head('name', '公司')}</th>
          <th aria-sort={sortAria('industry')} className="whitespace-nowrap border-b border-slate-200 px-2 py-1 text-left">{head('industry', '行业')}</th>
          {columns.map(column => <th key={column.id} aria-sort={sortAria(column.id)} className="whitespace-nowrap border-b border-slate-200 px-2 py-1 text-right">{head(column.id, column.label, toneClass[column.tone])}</th>)}
          <th className="min-w-[148px] border-b border-slate-200 px-3 py-1 text-right font-medium text-slate-500">研究</th>
        </tr></thead>
        <tbody>{visibleRows.map(row => <tr key={row.symbol} data-code={row.code} aria-selected={selected.includes(row.symbol)} className="border-b border-slate-100 bg-white">
          <td className="sticky left-0 z-10 bg-inherit px-2 py-1"><input type="checkbox" aria-label={`选择${row.name}`} checked={selected.includes(row.symbol)} disabled={loading} onChange={event => setSelected(previous => event.target.checked ? [...previous, row.symbol] : previous.filter(symbol => symbol !== row.symbol))} className="h-3.5 w-3.5 accent-blue-600" /></td>
          <td className="sticky left-8 z-10 max-w-[160px] bg-inherit px-2 py-1" title={`${row.name} · ${row.code}\n${row.industry}\n${row.noticeDate ? `公告 ${row.noticeDate}` : '该期财报未取得'}`}><StockLink href={`/stock/${row.symbol}`} prefetch={false} className="block truncate font-medium text-[#0b6192] hover:underline">{row.name}</StockLink></td>
          <td className="whitespace-nowrap px-2 py-1 text-xs text-slate-500">{row.industry}</td>
          {columns.map(column => {
            const value = row[column.id], missing = value == null || typeof value === 'number' && !Number.isFinite(value), numeric = typeof value === 'number' ? value : null;
            return <td key={column.id} className={`whitespace-nowrap px-2 py-1 text-right tabular-nums ${missing ? 'text-slate-300' : numeric != null && numeric < 0 ? 'text-amber-700' : column.id === 'roe' ? 'font-semibold text-teal-800' : column.tone === 'growth' && numeric != null && numeric > 0 ? 'text-teal-700' : 'text-slate-700'}`} title={column.id === 'period' && row.noticeDate ? `公告日期：${row.noticeDate}` : undefined}>{missing ? '—' : column.kind === 'date' ? String(value).slice(0, 10) : column.kind === 'percent' ? `${number(value)}%` : number(value)}</td>;
          })}
          <td className="whitespace-nowrap px-3 py-1"><div className="flex items-center justify-end gap-3 text-xs"><StockLink href={`/stock/${row.symbol}`} prefetch={false} className="text-brand-700 hover:underline">估值</StockLink><StockLink href={`/stock/${row.symbol}/finance`} prefetch={false} className="text-brand-700 hover:underline">财报</StockLink><WatchlistButton compact code={row.symbol} name={row.name} /></div></td>
        </tr>)}
        {!visibleRows.length && <tr><td colSpan={columns.length + 4} className="px-3 py-16 text-center text-xs text-slate-500">{loading ? '读取最新财报与行情…' : error ? '数据暂未取得' : !result ? '设置条件后，点击筛选' : result.universeCount === 0 ? '当前范围没有 A 股公司' : '没有符合条件的公司'}</td></tr>}
        </tbody>
      </table>
    </div>
    <div className="flex min-h-8 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-slate-200 bg-slate-50/50 px-3 py-1 text-[11px] text-slate-500">
      <span>{result ? <>{periodLabel(result.period)} · 财报 {result.financialCount}/{result.universeCount} 家 · 行情 {result.quoteCount}/{result.scannedCount} 家{result.requestedPeriod === SCREEN_AUTO_PERIOD && !!result.fallbackCount && <span className="ml-2 text-amber-700">{result.fallbackCount} 家使用较早报告期</span>}</> : '—'}{!!result?.unknownConditionCount && <span className="ml-2 text-amber-700">条件缺值 {result.unknownConditionCount} 家</span>}<button type="button" onClick={() => setColumnsOpen(true)} className="ml-3 text-slate-400 hover:text-brand-700">数据口径</button></span>
      <div className="ml-auto flex items-center gap-2"><span>{page}/{pageCount} 页 · 每页 {pageSize} 家</span><button type="button" disabled={page <= 1} onClick={() => movePage(page - 1)} className="btn !min-h-6 !px-2 !py-0 !text-[11px]">上一页</button><button type="button" disabled={page >= pageCount} onClick={() => movePage(page + 1)} className="btn !min-h-6 !px-2 !py-0 !text-[11px]">下一页</button><input type="number" min={1} max={pageCount} aria-label="跳转页码" value={jump} onChange={event => setJump(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && jump && Number.isInteger(Number(jump))) movePage(Number(jump)); }} placeholder="页码" className="h-6 w-12 rounded border border-slate-200 bg-white px-1 text-center text-[11px] tabular-nums outline-none focus:border-brand-300" /></div>
    </div>
    {groupImportOpen && <ScreenerGroupImport symbols={sorted.map(row => row.symbol)} selected={selected} onClose={() => setGroupImportOpen(false)} onImported={onGroupImported} />}
    <Modal open={columnsOpen} title="显示列" onClose={() => setColumnsOpen(false)}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{SCREEN_COLUMNS.map(column => <label key={column.id} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-xs ${preferences.columns.includes(column.id) ? 'border-brand-200 bg-brand-50/40' : 'border-slate-200'} ${toneClass[column.tone]}`}><input type="checkbox" checked={preferences.columns.includes(column.id)} onChange={event => updateColumns(event.target.checked ? SCREEN_COLUMNS.filter(item => item.id === column.id || preferences.columns.includes(item.id)).map(item => item.id) : preferences.columns.filter(id => id !== column.id))} className="h-3.5 w-3.5 accent-blue-600" />{column.label}</label>)}</div>
      <div className="mt-4 flex items-center justify-between"><button type="button" onClick={() => updateColumns([...DEFAULT_SCREEN_COLUMNS])} className="text-xs text-slate-500">恢复默认列</button><button type="button" onClick={() => setColumnsOpen(false)} className="btn-primary">完成</button></div>
      <details className="mt-4 border-t border-slate-100 pt-3 text-xs leading-6 text-slate-500"><summary>指标与数据口径</summary><p className="mt-2">股票范围为本地申万分类中的A股。行业支持多选，仅筛选勾选的行业；使用同一个按钮切换全选和取消全选，至少选择一个行业后再开始筛选。</p><p className="mt-2">财务条件采用截至当天已披露的最新报告，报告期逐公司选择并在结果中显示。ROE为披露的累计加权ROE，不自行年化；增长率为累计同比。经营现金流和市值以亿元计，现金净利比使用同一报告期的经营现金流和全体净利润，净利润非正时不计算。</p><p className="mt-2">PE-TTM、PB和市值来自当前行情，不使用PB÷PE推算财报ROE。未取得的数据留空，已启用条件的缺失值不会通过筛选。表尾分别列出财报与行情覆盖数量。</p></details>
    </Modal>
    <Modal open={schemeOpen} title="保存选股方案" onClose={() => setSchemeOpen(false)}>
      <form onSubmit={event => { event.preventDefault(); saveScheme(); }}>
        <input autoFocus aria-label="方案名称" maxLength={24} value={schemeName} onChange={event => { setSchemeName(event.target.value); setSchemeError(''); }} placeholder="方案名称" className="input" />
        {schemeError && <p role="alert" className="mt-2 text-xs text-amber-700">{schemeError}</p>}
        <div className="mt-4 flex items-center justify-between gap-2">{schemeId ? <button type="button" onClick={() => { if (saveSchemes(schemes.filter(scheme => scheme.id !== schemeId))) { setSchemeId(''); setSchemeOpen(false); } }} className="text-xs text-red-600">删除此方案</button> : <span />}<div className="flex items-center gap-2"><button type="button" onClick={() => setSchemeOpen(false)} className="btn">取消</button><button type="submit" className="btn-primary">保存</button></div></div>
      </form>
    </Modal>
  </div>;
}
