'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import IndustryNavigator, { type TreeL1, type IndustrySelection } from '@/components/IndustryNavigator';
import Modal from '@/components/Modal';
import WatchlistButton from '@/components/WatchlistButton';
import { useWatchlist } from '@/components/WatchlistProvider';
import { UNGROUPED } from '@/lib/watchlist';
import { personalStorage, AUTH_CHANGE } from '@/lib/personalStorage';
import { compareResearchValues } from '@/lib/researchColumns';
import { compareIndustryChildren, filterIndustryRows, sortIndustryRows, summarizeIndustry, type IndustryResearchRow, type IndustrySortKey, type IndustryProfitability } from '@/lib/industryResearch';

interface TreeResponse {
  version: string;
  stats: { l1: number; l2: number; l3: number; stocks: number };
  industries: TreeL1[];
  provenance?: { membershipAsOf?: string | null };
}
interface MembersResponse {
  node: { name: string; level: number; l1: string; l2: string | null };
  count: number;
  rows: IndustryResearchRow[];
  updatedAt?: string | null;
}
type ColumnId = 'pe' | 'pb' | 'industry' | 'totalMarketCap' | 'capShare' | 'price' | 'roeEstimate' | 'changePct' | 'turnoverRate';
const COLUMNS: { id: ColumnId; label: string; sort?: IndustrySortKey; title?: string }[] = [
  { id: 'pe', label: 'PE-TTM', sort: 'pe' },
  { id: 'pb', label: 'PB', sort: 'pb' },
  { id: 'industry', label: '细分行业' },
  { id: 'totalMarketCap', label: '总市值（亿）', sort: 'totalMarketCap' },
  { id: 'capShare', label: '市值占比', title: '占本行业已取得有效市值样本的比例。' },
  { id: 'price', label: '最新价', sort: 'price' },
  { id: 'roeEstimate', label: 'ROE（推算）', sort: 'roeEstimate', title: 'PB ÷ 正值 PE × 100，仅为行情推算，不是财报披露的 ROE。' },
  { id: 'changePct', label: '涨跌幅', sort: 'changePct' },
  { id: 'turnoverRate', label: '换手率', sort: 'turnoverRate' },
];
const DEFAULT_COLUMNS: ColumnId[] = ['pe', 'pb', 'industry', 'totalMarketCap', 'capShare'];
const COLUMN_KEY = 'fin.industry.columns.v1';
type ComparisonKey = 'name' | 'totalCount' | 'positivePeMedian' | 'positivePbMedian' | 'lossSharePct' | 'totalMarketCap' | 'top5MarketCapSharePct';
const COMPARISON_COLUMNS: { key: ComparisonKey; label: string; title?: string }[] = [
  { key: 'totalCount', label: '公司数' },
  { key: 'positivePeMedian', label: 'PE中位 · 盈利股' },
  { key: 'positivePbMedian', label: 'PB中位 · 正值' },
  { key: 'lossSharePct', label: '亏损占比', title: '负 PE 公司数 ÷ 有正、负 PE 的公司数；缺失 PE 不计入分母。' },
  { key: 'totalMarketCap', label: '总市值（亿）' },
  { key: 'top5MarketCapSharePct', label: '前5市值占比', title: '前5家公司占有效市值样本的比例，不是营收行业集中度。' },
];
const number = (v: number | null | undefined, digits = 2) => v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const percent = (v: number | null | undefined, digits = 1) => v == null || !Number.isFinite(v) ? '—' : `${number(v, digits)}%`;
const quoteTime = (value: string) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
const levelOf = (s: IndustrySelection) => s.l3 ? 3 : s.l2 ? 2 : 1;
const nameOf = (s: IndustrySelection) => s.l3 ?? s.l2 ?? s.l1;

function resolveSelection(tree: TreeResponse, name: string | null, level: string | null, l1: string | null, l2: string | null): IndustrySelection | null {
  for (const first of tree.industries) {
    if (l1 && l1 !== first.name) continue;
    if (first.name === name && level === '1') return { l1: first.name, l2: null, l3: null };
    for (const second of first.children) {
      if (l2 && l2 !== second.name) continue;
      if (second.name === name && level === '2') return { l1: first.name, l2: second.name, l3: null };
      if (second.children.some(third => third.name === name) && (level === '3' || !level)) return { l1: first.name, l2: second.name, l3: name };
    }
  }
  return null;
}
function downloadCsv(filename: string, rows: (string | number | null)[][]) {
  const escape = (cell: string | number | null) => {
    let v = cell == null ? '' : String(cell);
    if (typeof cell === 'string' && /^[=+@-]/.test(v)) v = `'${v}`;
    return `"${v.replaceAll('"', '""')}"`;
  };
  const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(row => row.map(escape).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function IndustryPage() {
  return <Suspense fallback={<div className="text-sm text-slate-500">正在加载行业…</div>}><IndustryMarket /></Suspense>;
}
function IndustryMarket() {
  const params = useSearchParams();
  const market = params.get('market') === 'HK' ? 'HK' : 'A';
  return <IndustryContent key={market} market={market} />;
}
function IndustryContent({ market }: { market: 'A' | 'HK' }) {
  const router = useRouter(), params = useSearchParams(), watchlist = useWatchlist();
  const isHk = market === 'HK';
  const endpoint = isHk ? '/api/hk-industry' : '/api/sw-industry';
  const columnCatalog = useMemo(() => COLUMNS.map(column => ({ ...column,
    label: column.id === 'totalMarketCap' ? isHk ? '总市值（亿港元）' : '总市值（亿元）' : column.id === 'price' ? isHk ? '最新价（港元）' : '最新价（元）' : column.label,
  })), [isHk]);
  const comparisonColumns = useMemo(() => COMPARISON_COLUMNS.map(column => ({ ...column,
    label: column.key === 'totalMarketCap' ? isHk ? '总市值（亿港元）' : '总市值（亿元）' : column.label,
  })), [isHk]);
  const linkedNode = params.get('node'), linkedLevel = params.get('level'), linkedL1 = params.get('l1'), linkedL2 = params.get('l2');
  const [tree, setTree] = useState<TreeResponse | null>(null), [treeError, setTreeError] = useState('');
  const [selection, setSelection] = useState<IndustrySelection | null>(null), [data, setData] = useState<MembersResponse | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const [treeRefresh, setTreeRefresh] = useState(0);
  const [view, setView] = useState<'members' | 'comparison'>('members');
  const [navOpen, setNavOpen] = useState(false), [navHidden, setNavHidden] = useState(false);
  const [query, setQuery] = useState(''), [profitability, setProfitability] = useState<IndustryProfitability>('all'), [onlyWatched, setOnlyWatched] = useState(false);
  const [sort, setSort] = useState<{ key: IndustrySortKey; direction: 'asc' | 'desc' }>({ key: 'totalMarketCap', direction: 'desc' });
  const [comparisonSort, setComparisonSort] = useState<{ key: ComparisonKey; direction: 'asc' | 'desc' }>({ key: 'totalMarketCap', direction: 'desc' });
  const [columns, setColumns] = useState<ColumnId[]>(DEFAULT_COLUMNS), [columnsOpen, setColumnsOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]), [groupId, setGroupId] = useState(UNGROUPED), [actionStatus, setActionStatus] = useState('');
  const [panelHeight, setPanelHeight] = useState<number | undefined>();
  const panelRef = useRef<HTMLDivElement>(null), tableRef = useRef<HTMLDivElement>(null), allRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const load = () => {
      try {
        const saved = JSON.parse(personalStorage.getItem(COLUMN_KEY) ?? 'null');
        setColumns(Array.isArray(saved) ? [...new Set(saved.filter((id): id is ColumnId => COLUMNS.some(c => c.id === id)))] : DEFAULT_COLUMNS);
      } catch { setColumns(DEFAULT_COLUMNS); }
    };
    load(); window.addEventListener(AUTH_CHANGE, load);
    return () => window.removeEventListener(AUTH_CHANGE, load);
  }, []);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
  useEffect(() => {
    const restoreIndustry = () => { setView('members'); setNavOpen(false); };
    window.addEventListener('popstate', restoreIndustry);
    return () => window.removeEventListener('popstate', restoreIndustry);
  }, []);
  useEffect(() => {
    const element = panelRef.current;
    if (!element) return;
    const measure = () => setPanelHeight(Math.max(320, window.innerHeight - element.getBoundingClientRect().top - 12));
    measure(); const observer = new ResizeObserver(measure); observer.observe(document.querySelector('header') ?? document.body);
    window.addEventListener('resize', measure); window.visualViewport?.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.visualViewport?.removeEventListener('resize', measure); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${endpoint}?tree=1`, { signal: controller.signal }).then(r => r.json()).then(j => {
      if (!j.ok) throw Error(j.error ?? '行业目录加载失败');
      if (controller.signal.aborted) return;
      const result = j.data as TreeResponse;
      setTree({ ...result, industries: result.industries.map(first => ({ ...first, children: (first.children ?? []).map(second => ({ ...second, children: second.children ?? [] })) })) });
    }).catch(e => { if (!controller.signal.aborted) setTreeError(String(e.message ?? e)); });
    return () => controller.abort();
  }, [endpoint, treeRefresh]);
  useEffect(() => {
    if (!tree) return;
    setSelection(resolveSelection(tree, linkedNode, linkedLevel, linkedL1, linkedL2) ?? (tree.industries[0] ? { l1: tree.industries[0].name, l2: null, l3: null } : null));
  }, [tree, linkedNode, linkedLevel, linkedL1, linkedL2]);
  const targetKey = selection ? [selection.l1, selection.l2 ?? '', selection.l3 ?? ''].join('|') : '';
  useEffect(() => {
    if (!selection) return;
    const controller = new AbortController();
    setLoading(true); setError(''); setData(null); setSelected([]); setActionStatus('');
    const search = new URLSearchParams({ node: nameOf(selection), level: String(levelOf(selection)), l1: selection.l1 });
    if (selection.l2) search.set('l2', selection.l2);
    fetch(`${endpoint}?${search}`, { signal: controller.signal }).then(r => r.json()).then(j => {
      if (!j.ok) throw Error(j.error ?? '行业数据获取失败'); if (!controller.signal.aborted) setData(j.data);
    }).catch(e => { if (!controller.signal.aborted) setError(String(e.message ?? e)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    if (tableRef.current) tableRef.current.scrollTop = 0;
    return () => controller.abort();
    // The full path defines a request, not selection object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, targetKey, refresh]);

  const first = tree?.industries.find(n => n.name === selection?.l1), second = first?.children.find(n => n.name === selection?.l2);
  const children = selection?.l2 ? second?.children ?? [] : first?.children ?? [];
  const childLevel: 2 | 3 = selection?.l2 ? 3 : 2;
  const selectIndustry = useCallback((next: IndustrySelection) => {
    setSelection(next); setQuery(''); setProfitability('all'); setOnlyWatched(false); setNavOpen(false);
    const search = new URLSearchParams({ node: nameOf(next), level: String(levelOf(next)), l1: next.l1 });
    if (next.l2) search.set('l2', next.l2);
    if (isHk) search.set('market', 'HK');
    router.push(`/industry?${search}`, { scroll: false });
  }, [router, isHk]);
  const openComparison = () => {
    if (selection?.l3) selectIndustry({ ...selection, l3: null });
    else if (selection?.l2 && !second?.children.length) selectIndustry({ l1: selection.l1, l2: null, l3: null });
    setView('comparison');
  };
  const summary = useMemo(() => summarizeIndustry(data?.rows ?? [], data?.count), [data]);
  const rows = useMemo(() => sortIndustryRows(filterIndustryRows(data?.rows ?? [], { query, profitability }).filter(r => !onlyWatched || watchlist.has(r.symbol ?? r.code)), sort.key, sort.direction), [data, query, profitability, onlyWatched, watchlist, sort]);
  const comparisons = useMemo(() => compareIndustryChildren(data?.rows ?? [], childLevel, children).sort((a, b) => compareResearchValues(comparisonSort.key === 'name' ? a.name : a.summary[comparisonSort.key], comparisonSort.key === 'name' ? b.name : b.summary[comparisonSort.key], comparisonSort.direction)), [data, childLevel, children, comparisonSort]);
  const activeColumns = columns.map(id => columnCatalog.find(c => c.id === id)!).filter(Boolean);
  const selectedRows = rows.filter(r => selected.includes(r.code)), selectionCount = selectedRows.length;
  const targetGroupId = watchlist.groups.some(group => group.id === groupId) ? groupId : UNGROUPED;
  useEffect(() => { setSelected([]); setActionStatus(''); }, [query, profitability, onlyWatched]);
  useEffect(() => { if (allRef.current) allRef.current.indeterminate = selectionCount > 0 && selectionCount < rows.length; }, [selectionCount, rows.length]);
  const clickSort = (key: IndustrySortKey) => setSort(p => ({ key, direction: p.key === key ? p.direction === 'asc' ? 'desc' : 'asc' : ['pe', 'pb', 'name'].includes(key) ? 'asc' : 'desc' }));
  const clickComparisonSort = (key: ComparisonKey) => setComparisonSort(p => ({ key, direction: p.key === key ? p.direction === 'asc' ? 'desc' : 'asc' : ['positivePeMedian', 'positivePbMedian', 'name'].includes(key) ? 'asc' : 'desc' }));
  const setVisibleColumns = (next: ColumnId[]) => {
    setColumns(next); try { personalStorage.setItem(COLUMN_KEY, JSON.stringify(next)); } catch {}
    if (sort.key !== 'name' && !next.some(id => COLUMNS.find(c => c.id === id)?.sort === sort.key)) setSort({ key: 'name', direction: 'asc' });
  };
  const valueFor = (r: IndustryResearchRow, id: ColumnId): string | number | null => {
    if (id === 'industry') return r.l3 ?? r.l2 ?? '未细分';
    if (id === 'capShare') return r.totalMarketCap != null && r.totalMarketCap > 0 && summary.totalMarketCap ? r.totalMarketCap / summary.totalMarketCap * 100 : null;
    return r[id] ?? null;
  };
  const exportCsv = () => {
    const date = data?.updatedAt?.slice(0, 10) ?? new Date().toISOString().slice(0, 10), name = selection ? nameOf(selection) : '行业';
    const prefix = `${isHk ? '港股' : 'A股'}-${name}`;
    if (view === 'comparison') downloadCsv(`${prefix}-细分对比-${date}.csv`, [['行业', ...comparisonColumns.map(c => c.label), '行情有效公司数'], ...comparisons.map(r => [r.name, ...comparisonColumns.map(c => c.key === 'name' ? r.name : r.summary[c.key]), r.summary.quotedCount])]);
    else downloadCsv(`${prefix}-成分公司-${date}.csv`, [['公司', '代码', ...activeColumns.map(c => c.label), '行情时间', '行情可用'], ...rows.map(r => [r.name, `\t${r.code}`, ...activeColumns.map(c => valueFor(r, c.id)), r.quoteTime ?? null, r.quoteAvailable === false ? '否' : '是'])]);
  };
  const importSelected = () => {
    const result = watchlist.importMany(selectedRows.map(r => r.symbol ?? r.code), targetGroupId);
    setActionStatus(result ? `已加入 ${result.added} 家${result.skipped ? `，组内已存在 ${result.skipped} 家` : ''}` : '分组已变化，请重新选择');
    if (result) setSelected([]);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setActionStatus(''), 4000);
  };
  const drillInto = (name: string) => { if (selection) { selectIndustry(childLevel === 2 ? { l1: selection.l1, l2: name, l3: null } : { ...selection, l3: name }); setView('members'); } };
  const sortButton = (label: string, active: boolean, direction: 'asc' | 'desc', onClick: () => void) => <button type="button" onClick={onClick} className={`inline-flex min-h-7 items-center gap-1 whitespace-nowrap font-medium ${active ? 'text-brand-700' : 'hover:text-slate-900'}`} aria-label={`按${label}排序`}>{label}<span className={active ? 'text-brand-600' : 'text-slate-300'} aria-hidden="true">{active ? direction === 'asc' ? '↑' : '↓' : '↕'}</span></button>;
  const isFiltered = !!query || profitability !== 'all' || onlyWatched;
  const clearFilters = () => { setQuery(''); setProfitability('all'); setOnlyWatched(false); };

  return <div className="w-full">
    <h1 className="sr-only">行业研究</h1>
    <div ref={panelRef} style={{ height: panelHeight ?? 'calc(100dvh - 68px)' }} className="flex min-h-[320px] overflow-hidden rounded-lg border border-slate-200 bg-white">
      {!navHidden && <aside aria-label="行业目录" className="hidden w-[190px] shrink-0 border-r border-slate-200 bg-slate-50/40 lg:block">{tree ? <IndustryNavigator industries={tree.industries} selection={selection} onSelect={next => { selectIndustry(next); setView('members'); }} /> : <p className="p-3 text-xs text-slate-500">{treeError || '加载目录…'}</p>}</aside>}
      <section className="flex min-w-0 flex-1 flex-col" aria-label="行业研究数据">
        <div className="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-slate-100 px-3 py-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <div className="segmented shrink-0 !p-0.5" role="group" aria-label="交易市场">
              <Link prefetch={false} href="/industry" aria-current={!isHk ? 'page' : undefined} className={`segment !min-h-7 !px-2.5 !text-xs ${!isHk ? 'segment-active' : ''}`}>A股</Link>
              <Link prefetch={false} href="/industry?market=HK" aria-current={isHk ? 'page' : undefined} className={`segment !min-h-7 !px-2.5 !text-xs ${isHk ? 'segment-active' : ''}`}>港股</Link>
            </div>
            <nav aria-label="当前行业路径" className="flex min-w-0 flex-wrap items-center gap-1 text-[13px] font-medium">{selection ? [selection.l1, selection.l2, selection.l3].filter(Boolean).map((name, index, path) => <span key={`${index}:${name}`} className="inline-flex items-center gap-1">{index > 0 && <span className="text-slate-300" aria-hidden="true">/</span>}<button type="button" aria-current={index === path.length - 1 ? 'page' : undefined} className={index === path.length - 1 ? 'text-slate-900' : 'text-slate-500 hover:text-brand-700'} onClick={() => { selectIndustry({ l1: selection.l1, l2: index >= 1 ? selection.l2 : null, l3: index === 2 ? selection.l3 : null }); setView('members'); }}>{name}</button></span>) : <span className="text-slate-500">{treeError || '加载行业…'}</span>}</nav>
            <span className="whitespace-nowrap text-[11px] text-slate-400">{isHk ? '东财行业' : '申万2021'}</span>
          </div>
          <div className="flex w-full items-center justify-between gap-2 sm:ml-auto sm:w-auto sm:justify-end">
            <div className="segmented shrink-0 !p-0.5" role="tablist" aria-label="行业研究视图"><button type="button" role="tab" aria-selected={view === 'members'} aria-controls="industry-members" onClick={() => setView('members')} className={`segment !min-h-7 !px-2.5 !text-xs ${view === 'members' ? 'segment-active' : ''}`}>成分公司</button><button type="button" role="tab" aria-selected={view === 'comparison'} aria-controls="industry-comparison" onClick={openComparison} className={`segment !min-h-7 !px-2.5 !text-xs ${view === 'comparison' ? 'segment-active' : ''}`}>细分对比</button></div>
            <div className="flex shrink-0 items-center gap-2 border-l border-slate-200 pl-2">
              <button type="button" onClick={() => setNavOpen(true)} className="min-h-7 whitespace-nowrap text-xs text-slate-500 hover:text-brand-700 lg:hidden">切换行业</button>
              <button type="button" onClick={() => setNavHidden(p => !p)} className="hidden min-h-7 whitespace-nowrap text-xs text-slate-500 hover:text-brand-700 lg:block">{navHidden ? '展开目录' : '收起目录'}</button>
              <button type="button" onClick={() => setRefresh(v => v + 1)} disabled={loading || !selection} className="btn !min-h-7 !px-2 !py-0.5 !text-xs">刷新</button>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-2">
          {view === 'members' ? <div className="flex min-w-0 flex-wrap items-center gap-2"><input aria-label="筛选行业成分公司" placeholder="公司 / 代码 / 细分行业" value={query} onChange={e => setQuery(e.target.value)} className="input !min-h-7 !w-44 !py-1 !text-xs sm:!w-48" /><select aria-label="盈利状态" value={profitability} onChange={e => setProfitability(e.target.value as IndustryProfitability)} className="input !min-h-7 !w-auto !py-1 !text-xs"><option value="all">全部公司</option><option value="profitable">盈利公司</option><option value="loss-making">亏损公司</option><option value="missing-pe">PE缺失</option></select><label className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-xs text-slate-600"><input type="checkbox" checked={onlyWatched} onChange={e => setOnlyWatched(e.target.checked)} className="h-3.5 w-3.5 accent-blue-600" />仅自选</label>{isFiltered && <button type="button" onClick={clearFilters} className="text-xs text-slate-400 hover:text-brand-700">重置</button>}</div> : <span className="text-xs text-slate-500">{childLevel === 2 ? '二级行业' : '三级行业'} · {comparisons.length} 个细分 · 点击名称查看公司</span>}
          <div className="ml-auto flex items-center gap-1.5">{view === 'members' && <button type="button" onClick={() => setColumnsOpen(true)} className="btn !min-h-7 !px-2 !py-1 !text-xs">列设置</button>}<button type="button" onClick={exportCsv} disabled={loading || !data || (view === 'members' ? !rows.length : !comparisons.length)} className="btn !min-h-7 !px-2 !py-1 !text-xs">导出 CSV</button></div>
        </div>
        {(selectionCount > 0 || actionStatus) && view === 'members' && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-brand-100 bg-brand-50/60 px-3 py-1.5 text-xs text-brand-800">{selectionCount > 0 && <><span>已选 {selectionCount} 家</span><button type="button" onClick={() => setSelected([])} className="text-slate-500 hover:text-slate-900">清空</button><select aria-label="批量加入分组" value={targetGroupId} onChange={e => setGroupId(e.target.value)} className="input ml-auto !min-h-7 !w-auto !py-1 !text-xs">{watchlist.groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select><button type="button" onClick={importSelected} disabled={!watchlist.ready} className="btn-primary !min-h-7 !py-1 !text-xs">加入自选</button></>}<span role="status">{actionStatus}</span></div>}
        <div ref={tableRef} className="min-h-0 flex-1 overflow-auto overscroll-contain" aria-busy={loading} id={view === 'members' ? 'industry-members' : 'industry-comparison'} role="tabpanel">
          {error || treeError ? <div role="alert" className="flex min-h-32 flex-col items-center justify-center gap-3 text-xs text-amber-700"><span>{error || treeError}</span><button className="btn" onClick={() => { if (treeError) { setTreeError(''); setTreeRefresh(v => v + 1); } else setRefresh(v => v + 1); }}>重试</button></div>
            : loading ? <div role="status" className="flex min-h-44 items-center justify-center gap-2 text-xs text-slate-500"><span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-200 border-t-brand-600 motion-reduce:animate-none" />加载{selection ? nameOf(selection) : '行业'}…</div>
              : view === 'members' ? <table className={`dense-data-table w-full ${activeColumns.length > 3 ? 'min-w-[960px]' : 'min-w-[620px]'} text-[13px]`} aria-label="行业成分公司">
                <thead className="sticky top-0 z-20 bg-slate-50"><tr className="text-xs text-slate-500"><th className="sticky left-0 z-30 w-8 min-w-8 border-b border-slate-200 px-2 py-1.5"><input ref={allRef} type="checkbox" aria-label="选择当前筛选的全部公司" checked={rows.length > 0 && selectionCount === rows.length} disabled={!rows.length} onChange={e => setSelected(e.target.checked ? rows.map(r => r.code) : [])} className="h-3.5 w-3.5 accent-blue-600" /></th><th aria-sort={sort.key === 'name' ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'} className="sticky left-8 z-30 min-w-[148px] border-b border-slate-200 px-2 py-1 text-left sm:min-w-[178px]">{sortButton('公司', sort.key === 'name', sort.direction, () => clickSort('name'))}</th>
                  {activeColumns.map(c => <th key={c.id} title={c.title} aria-sort={c.sort === sort.key ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'} className={`whitespace-nowrap border-b border-slate-200 px-3 py-1 ${c.id === 'industry' ? 'text-left' : 'text-right'}`}>{c.sort ? sortButton(c.label, sort.key === c.sort, sort.direction, () => clickSort(c.sort!)) : c.label}</th>)}<th className="min-w-[168px] whitespace-nowrap border-b border-slate-200 px-3 py-1 text-right font-medium">研究</th></tr></thead>
                <tbody>{rows.map(r => <tr key={r.code} data-code={r.code} aria-selected={selected.includes(r.code)} className="group border-b border-slate-100 bg-white"><td className="sticky left-0 z-10 bg-inherit px-2 py-1"><input type="checkbox" aria-label={`选择${r.name}`} checked={selected.includes(r.code)} onChange={e => setSelected(p => e.target.checked ? [...p, r.code] : p.filter(code => code !== r.code))} className="h-3.5 w-3.5 accent-blue-600" /></td><td className="sticky left-8 z-10 max-w-[180px] bg-inherit px-2 py-1" title={`${r.name} · ${r.code}\n${[r.l1, r.l2, r.l3].filter(Boolean).join(' / ')}${r.quoteAvailable === false ? '\n暂无行情' : ''}`}><Link href={`/stock/${r.symbol ?? r.code}`} prefetch={false} className="block truncate font-medium text-[#0b6192] hover:underline">{r.name}</Link></td>
                  {activeColumns.map(c => { const value = valueFor(r, c.id), n = typeof value === 'number' ? value : null;
                    return <td key={c.id} className={`whitespace-nowrap px-3 py-1 tabular-nums ${c.id === 'industry' ? 'text-left text-xs text-slate-500' : 'text-right'} ${n != null && n < 0 ? 'text-amber-700' : c.id === 'pe' || c.id === 'pb' ? 'text-slate-900' : 'text-slate-600'}`}>{c.id === 'industry' ? r.l3 && r.l3 !== selection?.l3 ? <button type="button" className="max-w-36 truncate hover:text-brand-700 hover:underline" onClick={() => { selectIndustry({ l1: r.l1 ?? selection!.l1, l2: r.l2, l3: r.l3 }); setView('members'); }}>{value}</button> : <span>{value}</span>
                      : c.id === 'capShare' ? <div className="ml-auto w-[82px]"><span>{percent(n)}</span><div className="mt-0.5 h-0.5 w-full rounded bg-slate-100"><div className="h-full rounded bg-brand-300" style={{ width: `${Math.min(100, Math.max(0, n ?? 0))}%` }} /></div></div>
                        : ['changePct', 'roeEstimate', 'turnoverRate'].includes(c.id) ? percent(n) : number(n, c.id === 'totalMarketCap' ? 1 : 2)}</td>;
                  })}<td className="whitespace-nowrap px-3 py-1"><div className="flex items-center justify-end gap-3 text-xs"><Link href={`/stock/${r.symbol ?? r.code}`} prefetch={false} className="text-brand-700 hover:underline">估值</Link><Link href={`/stock/${r.symbol ?? r.code}/finance`} prefetch={false} className="text-brand-700 hover:underline">财报</Link><WatchlistButton code={r.symbol ?? r.code} name={r.name} compact /></div></td></tr>)}
                  {!rows.length && <tr><td colSpan={activeColumns.length + 3} className="px-3 py-16 text-center text-xs text-slate-500">{data?.count === 0 ? '该行业暂无成分公司' : '没有符合当前筛选条件的公司'}{isFiltered && <button type="button" className="ml-2 text-brand-700" onClick={clearFilters}>清除筛选</button>}</td></tr>}
                </tbody></table>
                : <table className="dense-data-table w-full min-w-[900px] text-[13px]" aria-label="细分行业对比"><thead className="sticky top-0 z-20"><tr className="text-xs text-slate-500"><th className="sticky left-0 z-30 min-w-[160px] border-b border-slate-200 px-3 py-1 text-left" aria-sort={comparisonSort.key === 'name' ? comparisonSort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}>{sortButton('细分行业', comparisonSort.key === 'name', comparisonSort.direction, () => clickComparisonSort('name'))}</th>
                  {comparisonColumns.map(c => <th key={c.key} title={c.title} className="border-b border-slate-200 px-3 py-1 text-right" aria-sort={comparisonSort.key === c.key ? comparisonSort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}>{sortButton(c.label, comparisonSort.key === c.key, comparisonSort.direction, () => clickComparisonSort(c.key))}</th>)}<th className="border-b border-slate-200 px-3 py-1 text-right font-medium">行情覆盖</th></tr></thead><tbody>
                  {comparisons.map(r => <tr key={r.name} className="border-b border-slate-100 bg-white"><td className="sticky left-0 z-10 bg-inherit px-3 py-2 font-medium">{r.unclassified ? <span className="text-slate-500">未细分</span> : <button type="button" onClick={() => drillInto(r.name)} className="text-[#0b6192] hover:underline">{r.name}</button>}</td>{comparisonColumns.map(c => <td key={c.key} className={`whitespace-nowrap px-3 py-2 text-right tabular-nums ${c.key === 'lossSharePct' ? 'text-amber-700' : 'text-slate-700'}`}>{c.key === 'totalCount' ? r.summary.totalCount : c.key === 'lossSharePct' || c.key === 'top5MarketCapSharePct' ? percent(r.summary[c.key]) : c.key === 'name' ? r.name : number(r.summary[c.key], c.key === 'totalMarketCap' ? 1 : 2)}</td>)}<td className="px-3 py-2 text-right text-xs tabular-nums text-slate-500" title={`${r.summary.missingQuoteCount}家公司暂无行情`}>{r.summary.quotedCount}/{r.summary.totalCount}</td></tr>)}
                  {!comparisons.length && <tr><td colSpan={8} className="px-3 py-16 text-center text-xs text-slate-500">该行业暂无下级分类</td></tr>}
                </tbody></table>}
        </div>
        <div className="flex min-h-7 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-slate-200 bg-slate-50/50 px-3 py-1 text-[11px] text-slate-500"><span>{loading ? '加载中…' : view === 'members' ? `显示 ${rows.length} / ${data?.count ?? 0} 家` : `${comparisons.length} 个细分行业`}<span className="ml-3" title={`${summary.missingQuoteCount}家暂无行情`}>行情 {summary.quotedCount}/{summary.totalCount}{summary.staleQuoteCount ? ` · 缓存${summary.staleQuoteCount}家` : ''}</span></span><div className="flex items-center gap-3"><span>{data?.updatedAt ? `行情截至 ${quoteTime(data.updatedAt)}` : '行情时间 —'}</span><button type="button" onClick={() => setColumnsOpen(true)} className="text-slate-400 hover:text-brand-700">数据口径</button></div></div>
      </section>
    </div>
    <Modal open={navOpen} title="切换行业" onClose={() => setNavOpen(false)}><div className="h-[65dvh] min-h-[300px]">{tree && <IndustryNavigator industries={tree.industries} selection={selection} onSelect={next => { selectIndustry(next); setView('members'); }} />}</div></Modal>
    <Modal open={columnsOpen} title="表格列与数据口径" onClose={() => setColumnsOpen(false)}><div className="space-y-4"><div className="grid grid-cols-2 gap-2">{columnCatalog.map(c => <label key={c.id} title={c.title} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-xs ${columns.includes(c.id) ? 'border-brand-200 bg-brand-50/50 text-brand-800' : 'border-slate-200 text-slate-600'}`}><input type="checkbox" checked={columns.includes(c.id)} onChange={e => setVisibleColumns(e.target.checked ? COLUMNS.filter(item => item.id === c.id || columns.includes(item.id)).map(item => item.id) : columns.filter(id => id !== c.id))} className="h-3.5 w-3.5 accent-blue-600" />{c.label}</label>)}</div><div className="flex justify-between gap-2"><button type="button" onClick={() => setVisibleColumns(DEFAULT_COLUMNS)} className="text-xs text-slate-500 hover:text-brand-700">恢复默认列</button><button type="button" onClick={() => setColumnsOpen(false)} className="btn-primary">完成</button></div><details className="border-t border-slate-100 pt-3 text-xs leading-6 text-slate-500"><summary>分类与统计口径</summary><p className="mt-2">{isHk ? `东财F10行业层级，成分按主板和创业板股票名录快照归类，使用港元柜台。${tree?.provenance?.membershipAsOf ? `名录快照：${tree.provenance.membershipAsOf.slice(0, 10)}。` : ""}股价为港元，市值为亿港元；PB沿用个股页的港元净资产口径。` : "申万2021层级，成分按本地东方财富映射快照归类，仅纳入A股；不表示实时官方调整。股价为元，市值为亿元。"}PE中位仅取正值PE，亏损公司保留在列表；PB中位仅取正值。亏损占比的分母为有效正、负PE公司数。市值与占比基于有效行情样本，缺行情不补零。ROE推算值来自PB/PE，不是财报披露值。</p></details></div></Modal>
  </div>;
}
