'use client';

import { personalStorage } from '@/lib/personalStorage';
import { useResearchWorkspace } from './ResearchWorkspaceProvider';
import { researchNoteSymbol } from '@/lib/researchNotes';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useWatchlist } from './WatchlistProvider';
import WatchlistButton from './WatchlistButton';
import WatchlistGroups from './WatchlistGroups';
import MarketUpdateButton from './MarketUpdateButton';
import StockName from './StockName';
import XueqiuLink from './XueqiuLink';
import ResearchColumns from './ResearchColumns';
import {
  RESEARCH_COLUMNS,
  RESEARCH_TABLE_KEY,
  RESEARCH_TABLE_VERSION,
  defaultResearchTable,
  readResearchTable,
  compareResearchValues,
  type ResearchTablePreferences,
  type ResearchSort,
} from '@/lib/researchColumns';
import { UNGROUPED } from '@/lib/watchlist';
import { normalizeCode } from '@/lib/datasource/codes';
import { xueqiuUrl } from '@/lib/xueqiu';
import type { Quote } from '@/lib/datasource/types';

interface Financial {
  code: string;
  name: string;
  periods: string[];
  series: Record<string, (number | null)[]>;
}
const value = (v: number | null | undefined, suffix = '') =>
  v == null || !Number.isFinite(v) ? '—' : v.toFixed(2) + suffix;

export default function ResearchDesk({
  management = false,
}: {
  management?: boolean;
}) {
  const wl = useWatchlist();
  const { codes, ready, remove } = wl;
  const [activeGroup, setActiveGroup] = useState('all');
  const [updateVersion, setUpdateVersion] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [moveTarget, setMoveTarget] = useState(UNGROUPED);
  const group =
    activeGroup === 'all' || wl.groups.some((g) => g.id === activeGroup)
      ? activeGroup
      : 'all';
  const codeSet = useMemo(() => new Set(codes), [codes]);
  const groupInfo = useMemo(() => {
    const memberships = new Map<string, Set<string>>();
    const names = new Map<string, string[]>();
    for (const item of wl.items) {
      if (!memberships.has(item.symbol))
        memberships.set(item.symbol, new Set());
      memberships.get(item.symbol)!.add(item.groupId);
    }
    for (const g of wl.groups)
      for (const item of wl.items) {
        if (item.groupId !== g.id) continue;
        if (!names.has(item.symbol)) names.set(item.symbol, []);
        names.get(item.symbol)!.push(g.name);
      }
    return { memberships, names };
  }, [wl.items, wl.groups]);
  const inGroup = (symbol: string) =>
    group === 'all' || groupInfo.memberships.get(symbol)?.has(group);
  const savedCodes = useMemo(() => wl.codesIn(group), [wl, group]);
  const savedPositions = useMemo(
    () => new Map(savedCodes.map((symbol, index) => [symbol, index])),
    [savedCodes],
  );
  const groupNames = (symbol: string) => groupInfo.names.get(symbol) ?? [];
  const removeFromView = (symbol: string) => remove(symbol, group);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [otherAssets, setOtherAssets] = useState<Quote[]>([]);
  const [financials, setFinancials] = useState<Financial[]>([]);
  /** 股息率 %：A股预期、港股完整财年静态；null 表示数据不可用。 */
  const [dividendYields, setDividendYields] = useState<
    Map<string, number | null>
  >(() => new Map());
  /** 扣非 PE-TTM（symbol → 值，null 表示数据不足或净利润为负） */
  const [deductedPes, setDeductedPes] = useState<Map<string, number | null>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState(true);
  const [finLoading, setFinLoading] = useState(false);
  const [error, setError] = useState('');
  const [finErrors, setFinErrors] = useState<string[]>([]);
  const { notebook, openNotes, setNoteCompanies } = useResearchWorkspace();
  const noteCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const note of notebook.notes) {
      const symbol = researchNoteSymbol(note);
      if (!symbol) continue;
      counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    }
    return counts;
  }, [notebook.notes]);
  const noteCompanies = useMemo(
    () => quotes.map((q) => ({ symbol: q.symbol, code: q.code, name: q.name })),
    [quotes],
  );
  useEffect(() => {
    setNoteCompanies(noteCompanies);
    return () => setNoteCompanies([]);
  }, [noteCompanies, setNoteCompanies]);
  const [filter, setFilter] = useState('');
  const tableRef = useRef<HTMLDivElement>(null);
  const rowHeightRef = useRef<number | null>(null);
  const [jumpTo, setJumpTo] = useState('');
  /**
   * 每页行数按视口高度逐行自适应，尽量填满一屏。
   */
  const [pageSize, setPageSize] = useState(20);
  /** 当前页的起始行索引：缩放重排时按首行换算页码，不会把用户看的行跳走 */
  const [pageStart, setPageStart] = useState(0);
  useEffect(() => {
    /**
     * 一屏一页：用真实布局测量，而不是估算常量——
     * 表格顶部到视口底部的空间，去掉表头行和分页栏，再除以实际行高。
     */
    const measure = () => {
      const el = tableRef.current;
      if (!el) return;
      const vh = window.visualViewport?.height ?? window.innerHeight;
      const top = el.getBoundingClientRect().top + window.scrollY;
      const thead =
        el.querySelector('thead')?.getBoundingClientRect().height ?? 38;
      const tableElement = el.querySelector('table');
      const scale = tableElement?.offsetWidth
        ? tableElement.getBoundingClientRect().width / tableElement.offsetWidth
        : 1;
      // 合并边框使首尾行少半条线；取前三行最大值，并让短末页沿用完整行高。
      // 缓存未缩放的高度，缩放后再按实际比例换算，避免末页来回改变页长。
      const measuredRows = [...el.querySelectorAll('tr[data-symbol]')].slice(
        0,
        3,
      );
      if (measuredRows.length) {
        const rowHeight =
          Math.max(
            ...measuredRows.map((row) => row.getBoundingClientRect().height),
          ) / scale;
        rowHeightRef.current =
          measuredRows.length >= 3
            ? rowHeight
            : Math.max(rowHeightRef.current ?? rowHeight, rowHeight);
      }
      const ROW = (rowHeightRef.current ?? 38) * scale;
      const footer =
        el.nextElementSibling?.getBoundingClientRect().height ?? 47;
      const scrollbar = Math.max(
        0,
        el.getBoundingClientRect().height -
          (tableElement?.getBoundingClientRect().height ?? 0),
      );
      const usable = vh - top - thead - footer - scrollbar - 16;
      const fit = Math.floor(usable / ROW);
      const next = Math.max(1, fit);
      setPageSize((prev) => (prev === next ? prev : next));
    };
    // 首帧布局与字体度量可能未稳定，测两次
    measure();
    const raf = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    const observer = new ResizeObserver(measure);
    if (tableRef.current?.parentElement)
      observer.observe(tableRef.current.parentElement);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
      observer.disconnect();
    };
  }, [group, filter]);
  useEffect(() => {
    setSelected([]);
  }, [group, filter]);
  const [table, setTable] =
    useState<ResearchTablePreferences>(defaultResearchTable);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [draggingStock, setDraggingStock] = useState<string | null>(null);
  const [dropStock, setDropStock] = useState<string | null>(null);
  const [preferenceError, setPreferenceError] = useState('');
  const sort = table.sort;
  // 筛选/分组/排序变化时回到第一页
  useEffect(() => {
    setPageStart(0);
  }, [group, filter, sort]);
  const columns = table.columns.map((id) =>
    RESEARCH_COLUMNS.find((c) => c.id === id)!,
  );
  function saveTable(next: ResearchTablePreferences) {
    const saved = { ...next, version: RESEARCH_TABLE_VERSION };
    setTable(saved);
    try {
      personalStorage.setItem(RESEARCH_TABLE_KEY, JSON.stringify(saved));
      setPreferenceError('');
    } catch {
      setPreferenceError('表头设置未保存，浏览器存储不可用');
    }
  }
  function sortBy(column: ResearchSort['column']) {
    saveTable({
      ...table,
      sort:
        sort?.column === column && sort.direction === 'desc'
          ? null
          : {
              column,
              direction:
                sort?.column === column && sort.direction === 'asc'
                  ? 'desc'
                  : 'asc',
            },
    });
  }

  useEffect(() => {
    try {
      setTable(
        readResearchTable(
          JSON.parse(personalStorage.getItem(RESEARCH_TABLE_KEY) ?? 'null'),
        ),
      );
    } catch {}
    const stored = (event: StorageEvent) => {
      if (event.key?.endsWith(RESEARCH_TABLE_KEY) || event.key === null) {
        try {
          setTable(
            readResearchTable(
              JSON.parse(personalStorage.getItem(RESEARCH_TABLE_KEY) ?? 'null'),
            ),
          );
        } catch {}
      }
    };
    window.addEventListener('storage', stored);
    return () => window.removeEventListener('storage', stored);
  }, []);
  // Sorting and group edits do not refetch unchanged market/financial data.
  const signature = [...codes].sort().join(',');
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    setQuotes((prev) => prev.filter((q) => codes.includes(q.symbol)));
    setOtherAssets((prev) => prev.filter((q) => codes.includes(q.symbol)));
    setFinancials((prev) =>
      prev.filter((f) =>
        codes.some((code) => normalizeCode(code)?.code === f.code),
      ),
    );
    setError('');
    setFinErrors([]);
    setLoading(true);
    setFinLoading(false);
    async function load() {
      if (!codes.length) {
        setLoading(false);
        return;
      }
      try {
        const all: Quote[] = [];
        // Imports can exceed the quote API's 200-symbol request limit.
        for (let offset = 0; offset < codes.length && alive; offset += 100) {
          const batch = codes.slice(offset, offset + 100);
          const q = await fetch(
            `/api/quote?codes=${encodeURIComponent(batch.join(','))}`,
          ).then((r) => r.json());
          if (!alive) return;
          if (!q.ok || !Array.isArray(q.data))
            throw Error(q.error ?? '行情获取失败');
          all.push(...q.data);
          setQuotes(all.filter((x) => x.kind === 'stock'));
          setOtherAssets(all.filter((x) => x.kind !== 'stock'));
        }
        const rows = all.filter((x) => x.kind === 'stock');
        setLoading(false);
        setFinLoading(rows.length > 0);
        async function loadFinancials() {
          try {
            // Sequential batches keep first paint fast without flooding the financial source.
            for (let i = 0; i < rows.length && alive; i += 4) {
              const batch = rows.slice(i, i + 4);
              try {
                const j = await fetch('/api/finance-compare', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    codes: batch.map((r) => r.symbol),
                    years: 2,
                    granularity: 'quarter',
                    fields: ['roe', 'netMargin', 'ocfPerShare', 'debtRatio'],
                  }),
                }).then((r) => r.json());
                if (!alive) return;
                if (!j.ok) throw Error(j.error ?? '财报获取失败');
                setFinancials((prev) => [
                  ...prev.filter(
                    (f) =>
                      !j.data.companies.some(
                        (next: Financial) => next.code === f.code,
                      ),
                  ),
                  ...j.data.companies,
                ]);
              } catch {
                if (alive)
                  setFinErrors((prev) => [
                    ...prev,
                    ...batch.map((r) => r.name),
                  ]);
              }
            }
          } finally {
            if (alive) setFinLoading(false);
          }
        }
        async function loadDividendYields() {
          // 与估值分析共用算法；A股预期、港股完整财年静态，失败留空。
          for (let i = 0; i < rows.length && alive; i += 20) {
            const batch = rows.slice(i, i + 20);
            try {
              const j = await fetch(
                `/api/dividend-yield?codes=${encodeURIComponent(batch.map((r) => r.symbol).join(','))}`,
              ).then((r) => r.json());
              if (!alive) return;
              if (j.ok && Array.isArray(j.data)) {
                setDividendYields((prev) => {
                  const next = new Map(prev);
                  for (const row of j.data as {
                    symbol: string;
                    dy: number | null;
                  }[])
                    next.set(row.symbol, row.dy);
                  return next;
                });
              }
            } catch {
              /* 预期股息率不可用时该列显示「—」 */
            }
          }
        }
        async function loadDeductedPe() {
          // 扣非 PE 需要四个季度扣非净利润，单独批量取；失败只置空
          for (let i = 0; i < rows.length && alive; i += 20) {
            const batch = rows.slice(i, i + 20);
            try {
              const j = await fetch(
                `/api/deducted-pe?codes=${encodeURIComponent(batch.map((r) => r.symbol).join(','))}`,
              ).then((r) => r.json());
              if (!alive) return;
              if (j.ok && Array.isArray(j.data)) {
                setDeductedPes((prev) => {
                  const next = new Map(prev);
                  for (const row of j.data as { symbol: string; pe: number | null }[])
                    next.set(row.symbol, row.pe);
                  return next;
                });
              }
            } catch {
              /* 扣非 PE 不可用时该列显示「—」 */
            }
          }
        }
        await Promise.all([loadFinancials(), loadDividendYields(), loadDeductedPe()]);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : '数据获取失败');
      } finally {
        if (alive) {
          setLoading(false);
          setFinLoading(false);
        }
      }
    }
    load();
    return () => {
      alive = false;
    };
  }, [signature, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  const financialMap = useMemo(
    () => new Map(financials.map((f) => [f.code, f])),
    [financials],
  );
  const latest = (code: string, field: string) => {
    const f = financialMap.get(code);
    // An unavailable latest period stays empty; never substitute an older report.
    return f?.series[field]?.[f.periods.length - 1] ?? null;
  };
  const columnValue = (
    quote: Quote,
    column: ResearchSort['column'],
  ): string | number | null => {
    if (column === 'name') return quote.name;
    if (column === 'period')
      return financialMap.get(quote.code)?.periods.at(-1) ?? null;
    if (column === 'peDeducted') {
      const pe = deductedPes.get(quote.symbol);
      return pe != null && Number.isFinite(pe) ? pe : null;
    }
    if (column === 'dy') {
      const dy = dividendYields.get(quote.symbol);
      return dy != null && Number.isFinite(dy) ? dy : null;
    }
    if (['roe', 'netMargin', 'ocfPerShare', 'debtRatio'].includes(column))
      return latest(quote.code, column);
    const val =
      quote[column as 'pe' | 'pb' | 'price' | 'changePct' | 'totalMarketCap'];
    return val != null && Number.isFinite(val) ? val : null;
  };
  const rows = quotes
    .filter(
      (q) =>
        codeSet.has(q.symbol) &&
        inGroup(q.symbol) &&
        `${q.name}${q.code}`
          .toLowerCase()
          .includes(filter.trim().toLowerCase()),
    )
    .sort((a, b) => {
      const manual =
        (savedPositions.get(a.symbol) ?? 0) -
        (savedPositions.get(b.symbol) ?? 0);
      return sort
        ? compareResearchValues(
            columnValue(a, sort.column),
            columnValue(b, sort.column),
            sort.direction,
          ) || manual
        : manual;
    });
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  // 以起始索引为准：窗口缩放导致每页行数变化时，当前首行仍留在视野内
  // 取包含「当前首行」的那一页的页首索引：pageStart 在新 pageSize 下可能不对齐，
  // 必须向下取整到它所在的页，否则当前行会被推到上一页之外。
  const start = Math.min(
    Math.floor(pageStart / pageSize) * pageSize,
    Math.max(0, (pageCount - 1) * pageSize),
  );
  const safePage = Math.floor(start / pageSize) + 1;
  const pageRows = rows.slice(start, start + pageSize);
  const visibleSignature = pageRows.map(q => q.symbol).join(',');
  useEffect(() => {
    if (!updateVersion || !visibleSignature) return;
    const controller = new AbortController();
    const symbols = visibleSignature.split(',');
    const read = (url: string, init?: RequestInit) => fetch(url, { ...init, signal: controller.signal }).then(r => r.json());
    // Completion refreshes only the visible page. Do not restart the full
    // watchlist loader or interrupt its existing sequential requests.
    void (async () => {
      try {
        const q = await read(`/api/quote?codes=${encodeURIComponent(visibleSignature)}`);
        if (q.ok && Array.isArray(q.data)) {
          const fresh = new Map<string, Quote>(q.data.map((v: Quote) => [v.symbol, v]));
          setQuotes(prev => prev.map(v => fresh.get(v.symbol) ?? v));
        }
        for (let i = 0; i < symbols.length && !controller.signal.aborted; i += 4) {
          const f = await read('/api/finance-compare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codes: symbols.slice(i, i + 4), years: 2, granularity: 'quarter', fields: ['roe', 'netMargin', 'ocfPerShare', 'debtRatio'] }) });
          if (f.ok && Array.isArray(f.data?.companies)) setFinancials(prev => [...prev.filter(v => !f.data.companies.some((n: Financial) => n.code === v.code)), ...f.data.companies]);
        }
        if (controller.signal.aborted) return;
        const dividends = await read(`/api/dividend-yield?codes=${encodeURIComponent(visibleSignature)}`);
        if (dividends.ok && Array.isArray(dividends.data)) setDividendYields(prev => {
          const next = new Map(prev); for (const row of dividends.data) next.set(row.symbol, row.dy); return next;
        });
        if (controller.signal.aborted) return;
        const deducted = await read(`/api/deducted-pe?codes=${encodeURIComponent(visibleSignature)}`);
        if (deducted.ok && Array.isArray(deducted.data)) setDeductedPes(prev => {
          const next = new Map(prev); for (const row of deducted.data) next.set(row.symbol, row.pe); return next;
        });
      } catch { /* Keep dated prior rows if a display-only refresh is unavailable. */ }
    })();
    return () => controller.abort();
  }, [updateVersion, visibleSignature]);
  // 翻页后列表不再有内部滚动条，把整个表格滚回视口顶部
  const goToPage = (p: number) => {
    // 用绝对行位置换算（不能用「页码 × 每页行数」以外的旧值，缩放后 pageSize 已改变）
    const clamped = Math.min(Math.max(1, p), pageCount);
    setPageStart((clamped - 1) * pageSize);
    requestAnimationFrame(() => {
      const top = tableRef.current?.getBoundingClientRect().top ?? 0;
      const offset =
        (document.querySelector('header')?.getBoundingClientRect().height ??
          44) + 8;
      if (top < offset)
        window.scrollTo({
          top: window.scrollY + top - offset,
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)')
            .matches
            ? 'instant'
            : 'smooth',
        });
    });
  };
  const visibleSelected = selected.filter((symbol) =>
    rows.some((row) => row.symbol === symbol),
  );
  const filteredOtherAssets = otherAssets
    .filter(
      (q) =>
        codeSet.has(q.symbol) &&
        inGroup(q.symbol) &&
        `${q.name}${q.code}`
          .toLowerCase()
          .includes(filter.trim().toLowerCase()),
    )
    .sort(
      (a, b) =>
        (savedPositions.get(a.symbol) ?? 0) -
        (savedPositions.get(b.symbol) ?? 0),
    );
  const destination = wl.groups.some((g) => g.id === moveTarget)
    ? moveTarget
    : UNGROUPED;
  return (
    <div className="space-y-3">
      <section
        id="research-stocks"
        tabIndex={-1}
        aria-labelledby="research-stocks-title"
        className="card scroll-mt-24"
      >
        <h2 id="research-stocks-title" className="sr-only">
          基本面股票列表
        </h2>
        {columnsOpen && (
          <ResearchColumns
            columns={table.columns}
            onClose={() => setColumnsOpen(false)}
            onSave={(next) =>
              saveTable({
                columns: next,
                sort:
                  sort && sort.column !== 'name' && !next.includes(sort.column)
                    ? null
                    : sort,
              })
            }
          />
        )}
        {preferenceError && (
          <p role="alert" className="px-5 py-2 text-xs text-red-600">
            {preferenceError}
          </p>
        )}
        <WatchlistGroups
          active={group}
          onChange={setActiveGroup}
          onConfigureColumns={() => setColumnsOpen(true)}
          toolbar={
            <>
            <MarketUpdateButton codes={savedCodes} groupId={group} onComplete={() => setUpdateVersion(v => v + 1)} />
            <input
              type="search"
              aria-label="筛选关注公司"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="筛选自选"
              className="h-8 w-28 min-w-0 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 outline-none placeholder:text-slate-400 focus:border-brand-400 focus:ring-2 focus:ring-brand-100 sm:w-40"
            />
            </>
          }
        />
        {visibleSelected.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-brand-100 bg-brand-50/50 px-3 py-2 sm:px-5">
            <span className="mr-1 text-xs font-medium text-brand-700">
              已选 {visibleSelected.length} 家
            </span>
            <select
              aria-label="批量移入分组"
              value={destination}
              onChange={(e) => setMoveTarget(e.target.value)}
              className="min-h-8 max-w-full rounded-md border border-slate-200 bg-white px-2 text-xs"
            >
              {wl.groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => {
                wl.copy(visibleSelected, destination);
                setSelected([]);
              }}
              className="rounded-md bg-white px-2.5 py-1.5 text-xs text-brand-700 ring-1 ring-brand-200"
            >
              加入分组
            </button>
            {group !== 'all' && (
              <button
                type="button"
                onClick={() => {
                  wl.move(visibleSelected, destination, group);
                  setSelected([]);
                }}
                className="rounded-md bg-white px-2.5 py-1.5 text-xs text-slate-600 ring-1 ring-slate-200"
              >
                移至分组
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                wl.removeMany(visibleSelected, group);
                setSelected([]);
              }}
              className="rounded-md px-2.5 py-1.5 text-xs text-red-600 hover:bg-red-50"
            >
              {group === 'all' || group === UNGROUPED ? '删除自选' : '移出分组'}
            </button>
            <button
              type="button"
              onClick={() => setSelected([])}
              className="ml-auto text-xs text-slate-500"
            >
              取消选择
            </button>
          </div>
        )}
        {error && (
          <p role="alert" className="px-5 py-4 text-sm text-red-600">
            {error}
          </p>
        )}
        <div ref={tableRef} className="overflow-x-auto">
          <table
            aria-label="基本面股票列表"
            className="dense-data-table w-full text-right"
            style={{ minWidth: 440 + columns.length * 105 }}
          >
            <thead>
              <tr>
                <th className="th !w-16 !pr-0">
                  <input
                    type="checkbox"
                    aria-label="选择当前列表全部公司"
                    disabled={!rows.length}
                    checked={
                      pageRows.length > 0 &&
                      pageRows.every((q) => visibleSelected.includes(q.symbol))
                    }
                    ref={(el) => {
                      if (el)
                        el.indeterminate =
                          pageRows.some((q) =>
                            visibleSelected.includes(q.symbol),
                          ) &&
                          !pageRows.every((q) =>
                            visibleSelected.includes(q.symbol),
                          );
                    }}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [
                              ...selected,
                              ...pageRows
                                .map((q) => q.symbol)
                                .filter((s) => !selected.includes(s)),
                            ]
                          : selected.filter(
                              (s) => !pageRows.some((q) => q.symbol === s),
                            ),
                      )
                    }
                    className="h-3.5 w-3.5 accent-blue-600"
                  />
                </th>
                <th
                  className="th !w-[360px] !min-w-[360px] !max-w-[360px]"
                  aria-sort={
                    sort?.column === 'name'
                      ? sort.direction === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                >
                  <button
                    type="button"
                    aria-label="按公司排序"
                    onClick={() => sortBy('name')}
                    className="inline-flex items-center gap-1 hover:text-brand-700"
                  >
                    公司
                    <span
                      className={
                        sort?.column === 'name'
                          ? 'text-brand-600'
                          : 'text-slate-400'
                      }
                      aria-hidden="true"
                    >
                      {sort?.column === 'name'
                        ? sort.direction === 'asc'
                          ? '↑'
                          : '↓'
                        : '↕'}
                    </span>
                  </button>
                </th>
                {columns.map((c) => (
                  <th
                    key={c.id}
                    className="th !text-right"
                    aria-sort={
                      sort?.column === c.id
                        ? sort.direction === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                    }
                  >
                    <button
                      type="button"
                      aria-label={`按${c.label}排序`}
                      onClick={() => sortBy(c.id)}
                      className="inline-flex items-center gap-1 hover:text-brand-700"
                    >
                      {c.label}
                      <span
                        className={
                          sort?.column === c.id
                            ? 'text-brand-600'
                            : 'text-slate-400'
                        }
                        aria-hidden="true"
                      >
                        {sort?.column === c.id
                          ? sort.direction === 'asc'
                            ? '↑'
                            : '↓'
                          : '↕'}
                      </span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pageRows.map((q, index) => (
                <tr
                  key={q.symbol}
                  data-symbol={q.symbol}
                  aria-selected={visibleSelected.includes(q.symbol)}
                  onDragOver={(e) => {
                    if (
                      sort ||
                      !e.dataTransfer.types.includes('application/x-fin-stock')
                    )
                      return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    setDropStock(q.symbol);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const source = e.dataTransfer.getData(
                      'application/x-fin-stock',
                    );
                    if (!sort && source)
                      wl.reorderStock(source, q.symbol, group);
                    setDraggingStock(null);
                    setDropStock(null);
                  }}
                  className={`group/stock transition hover:bg-slate-50/70 ${visibleSelected.includes(q.symbol) ? 'bg-brand-50/40' : ''} ${draggingStock === q.symbol ? 'opacity-40' : ''} ${dropStock === q.symbol && draggingStock !== q.symbol ? 'outline outline-1 -outline-offset-1 outline-brand-300 bg-brand-50/50' : ''}`}
                >
                  <td className="td !py-1 !pr-0">
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        aria-label={`拖动调整${q.name}顺序`}
                        title={
                          sort
                            ? '取消表头排序后可拖动'
                            : '拖动调整顺序，或按 Alt + 上下方向键'
                        }
                        disabled={!!sort}
                        draggable={!sort}
                        onDragStart={(e) => {
                          setDraggingStock(q.symbol);
                          e.dataTransfer.effectAllowed = 'move';
                          e.dataTransfer.setData(
                            'application/x-fin-stock',
                            q.symbol,
                          );
                        }}
                        onDragEnd={() => {
                          setDraggingStock(null);
                          setDropStock(null);
                        }}
                        onKeyDown={(e) => {
                          if (
                            !e.altKey ||
                            !['ArrowUp', 'ArrowDown'].includes(e.key)
                          )
                            return;
                          e.preventDefault();
                          const targetIndex =
                            start + index + (e.key === 'ArrowUp' ? -1 : 1);
                          const target = rows[targetIndex];
                          if (target) {
                            wl.reorderStock(q.symbol, target.symbol, group);
                            setPageStart(
                              Math.floor(targetIndex / pageSize) * pageSize,
                            );
                            requestAnimationFrame(() => {
                              [
                                ...document.querySelectorAll<HTMLTableRowElement>(
                                  'tr[data-symbol]',
                                ),
                              ]
                                .find((row) => row.dataset.symbol === q.symbol)
                                ?.querySelector<HTMLButtonElement>(
                                  'button[draggable]',
                                )
                                ?.focus();
                            });
                          }
                        }}
                        className="grid h-7 w-4 shrink-0 cursor-grab place-items-center rounded text-slate-400 hover:text-brand-600 active:cursor-grabbing disabled:cursor-default disabled:opacity-20"
                      >
                        <svg
                          width="10"
                          height="14"
                          viewBox="0 0 10 14"
                          fill="currentColor"
                          aria-hidden="true"
                        >
                          <path d="M2 1h2v2H2zm4 0h2v2H6zM2 6h2v2H2zm4 0h2v2H6zM2 11h2v2H2zm4 0h2v2H6z" />
                        </svg>
                      </button>
                      <input
                        type="checkbox"
                        aria-label={`选择${q.name}`}
                        checked={visibleSelected.includes(q.symbol)}
                        onChange={(e) =>
                          setSelected((prev) =>
                            e.target.checked
                              ? [...prev, q.symbol]
                              : prev.filter((s) => s !== q.symbol),
                          )
                        }
                        className="h-3.5 w-3.5 accent-blue-600"
                      />
                    </div>
                  </td>
                  <td className="td max-w-[360px] !py-1 text-left">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <StockName
                        quote={q}
                        groups={groupNames(q.symbol)}
                        href={`/stock/${q.symbol}`}
                      />
                      {xueqiuUrl(q.symbol, q.market, q.kind) && (
                        <span className="flex shrink-0 items-center">
                          <XueqiuLink
                            url={xueqiuUrl(q.symbol, q.market, q.kind)!}
                            name={q.name}
                          />
                        </span>
                      )}
                      <button
                        type="button"
                        aria-label={`${q.name}笔记`}
                        title={
                          noteCounts.get(q.symbol)
                            ? `笔记 ${noteCounts.get(q.symbol)} 条`
                            : '添加笔记'
                        }
                        disabled={!notebook.ready}
                        onClick={() => {
                          openNotes({
                            symbol: q.symbol,
                            code: q.code,
                            name: q.name,
                          });
                        }}
                        className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-amber-50 focus-visible:text-amber-600 ${noteCounts.get(q.symbol) ? 'text-amber-500' : 'text-slate-400 hover:text-amber-600'}`}
                      >
                        <svg
                          aria-hidden="true"
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.6"
                        >
                          <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                        </svg>
                      </button>
                      <span className="flex shrink-0 items-center">
                        <button
                          type="button"
                          aria-label={
                            group === 'all' || group === UNGROUPED
                              ? `删除${q.name}自选`
                              : `将${q.name}移出当前分组`
                          }
                          title={
                            group === 'all' || group === UNGROUPED
                              ? '删除自选'
                              : '移出当前分组'
                          }
                          onClick={() => removeFromView(q.symbol)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600 focus-visible:text-red-600"
                        >
                          <svg
                            aria-hidden="true"
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.6"
                          >
                            <path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6" />
                          </svg>
                        </button>
                      </span>
                      <a
                        href={`/stock/${q.symbol}#valuation`}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`查看${q.name}估值分析`}
                        title="估值分析"
                        className="inline-flex h-7 shrink-0 items-center rounded-md bg-slate-100 px-2 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-200 hover:text-slate-700"
                      >
                        估值
                      </a>
                      <a
                        href={`/stock/${q.symbol}/finance`}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`查看${q.name}财务体检`}
                        title="财务体检"
                        className="inline-flex h-7 shrink-0 items-center rounded-md bg-slate-100 px-2 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-200 hover:text-slate-700"
                      >
                        财报
                      </a>
                    </div>
                  </td>
                  {columns.map((c) => {
                    const v = columnValue(q, c.id);
                    return (
                      <td
                        key={c.id}
                        title={c.id === 'dy'
                          ? q.dividendYieldMethod === 'hk-static'
                            ? `${q.dividendFiscalYear ?? '暂无完整'}财年静态股息率；每股现金股息 ${value(q.dividendPerShare?.total)} 港元（普通 ${value(q.dividendPerShare?.ordinary)}，特别 ${value(q.dividendPerShare?.special)}），按当前港元股价计算。`
                            : '预期股息率：按已公告方案估计未来一年的税前现金股息。'
                          : c.id === 'pb' && q.market === 'HK'
                            ? '港元股价 ÷ 同币种每股净资产，使用最新已披露财报。'
                            : undefined}
                        className={`td !py-1 ${c.id === 'roe' ? 'font-semibold' : ''} ${c.id === 'dy' ? '!text-teal-700' : ''} ${typeof v === 'number' && v < 0 ? '!text-amber-700' : ''} ${c.id === 'period' ? '!text-xs !text-slate-500' : ''}`}
                      >
                        {c.id === 'period'
                          ? (v ?? (finLoading ? '…' : '—'))
                          : value(
                              typeof v === 'number' ? v : null,
                              'suffix' in c ? c.suffix : '',
                            )}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td
                    colSpan={columns.length + 2}
                    className="py-14 text-center text-sm text-slate-500"
                  >
                    {loading || !ready
                      ? '加载中…'
                      : filter.trim()
                        ? '没有匹配的公司'
                        : group !== 'all'
                          ? '该分组暂无公司'
                          : '暂无关注公司'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-2 border-t border-slate-100 px-3 py-2 text-xs text-slate-500">
          {finLoading && <span role="status">财报加载中…</span>}
          {finErrors.length > 0 && (
            <span className="text-amber-700" title={finErrors.join('、')}>
              财报暂不可用：{finErrors.length} 家公司
            </span>
          )}
          {rows.length > pageSize ? (
            <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
              <span className="tabular">
                第 {safePage} / {pageCount} 页 · 共 {rows.length} 家
              </span>
              <button
                type="button"
                aria-label="上一页"
                disabled={safePage <= 1}
                onClick={() => goToPage(safePage - 1)}
                className="rounded-md border border-slate-200 px-2 py-1 text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                上一页
              </button>
              <button
                type="button"
                aria-label="下一页"
                disabled={safePage >= pageCount}
                onClick={() => goToPage(safePage + 1)}
                className="rounded-md border border-slate-200 px-2 py-1 text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                下一页
              </button>
              {pageCount > 2 && (
                <span className="flex items-center gap-1">
                  <span>跳至</span>
                  <input
                    type="number"
                    min={1}
                    max={pageCount}
                    value={jumpTo}
                    placeholder={String(safePage)}
                    aria-label="跳转到指定页"
                    onChange={(e) => setJumpTo(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const n = Number(jumpTo);
                        if (Number.isInteger(n) && n >= 1) {
                          goToPage(n);
                          setJumpTo('');
                        }
                      }
                    }}
                    className="w-14 rounded-md border border-slate-200 px-1.5 py-1 text-right tabular focus:border-brand-400 focus:outline-none"
                  />
                  <span>页</span>
                  <button
                    type="button"
                    onClick={() => {
                      const n = Number(jumpTo);
                      if (Number.isInteger(n) && n >= 1) {
                        goToPage(n);
                        setJumpTo('');
                      }
                    }}
                    className="rounded-md border border-slate-200 px-2 py-1 text-slate-600 hover:bg-slate-50"
                  >
                    跳转
                  </button>
                </span>
              )}
            </div>
          ) : (
            <span className="ml-auto tabular">共 {rows.length} 家</span>
          )}
        </div>
      </section>

      {management && filteredOtherAssets.length > 0 && (
        <details className="card px-5 py-4">
          <summary className="text-sm font-medium text-slate-600">
            其他关注标的 · {filteredOtherAssets.length}
          </summary>
          <div className="mt-3 divide-y divide-slate-100">
            {filteredOtherAssets.map((q) => (
              <div
                key={q.symbol}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <Link
                  href={`/${q.kind === 'index' ? 'index' : 'fund'}/${q.symbol}`}
                  className="text-sm text-slate-700"
                >
                  {q.name}{' '}
                </Link>
                <div className="flex shrink-0 items-center gap-3">
                  <WatchlistButton
                    code={q.symbol}
                    name={q.name}
                    compact
                    label={'分组'}
                  />
                  <button
                    className="text-xs text-slate-500 hover:text-red-600"
                    onClick={() => removeFromView(q.symbol)}
                  >
                    移除
                  </button>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
