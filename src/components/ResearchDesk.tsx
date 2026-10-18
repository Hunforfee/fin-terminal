'use client';

import { personalStorage } from '@/lib/personalStorage';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useWatchlist } from './WatchlistProvider';
import WatchlistGroups from './WatchlistGroups';
import OrderButtons from './OrderButtons';
import StockName from './StockName';
import ResearchColumns from './ResearchColumns';
import {
  RESEARCH_COLUMNS,
  RESEARCH_TABLE_KEY,
  defaultResearchTable,
  readResearchTable,
  compareResearchValues,
  type ResearchTablePreferences,
  type ResearchSort,
} from '@/lib/researchColumns';
import { UNGROUPED } from '@/lib/watchlist';
import Modal from './Modal';
import { normalizeCode } from '@/lib/datasource/codes';
import type { Quote } from '@/lib/datasource/types';

interface Financial {
  code: string;
  name: string;
  periods: string[];
  series: Record<string, (number | null)[]>;
}
interface Note {
  id: string;
  code: string;
  name: string;
  text: string;
  date: string;
}
const NOTE_KEY = 'fin.research.notes.v1';
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
  const [selected, setSelected] = useState<string[]>([]);
  const [moveTarget, setMoveTarget] = useState(UNGROUPED);
  const group =
    activeGroup === 'all' || wl.groups.some((g) => g.id === activeGroup)
      ? activeGroup
      : 'all';
  const inGroup = (symbol: string) =>
    group === 'all' || wl.groupsOf(symbol).includes(group);
  const savedCodes = wl.codesIn(group);
  const groupNames = (symbol: string) =>
    wl.groups
      .filter((g) => wl.groupsOf(symbol).includes(g.id))
      .map((g) => g.name);
  const removeFromView = (symbol: string) => remove(symbol, group);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [otherAssets, setOtherAssets] = useState<Quote[]>([]);
  const [financials, setFinancials] = useState<Financial[]>([]);
  const [loading, setLoading] = useState(true);
  const [finLoading, setFinLoading] = useState(false);
  const [error, setError] = useState('');
  const [finErrors, setFinErrors] = useState<string[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [noteError, setNoteError] = useState('');
  const [noteCode, setNoteCode] = useState('');
  const [draft, setDraft] = useState('');
  const [noteView, setNoteView] = useState<{ code: string; name: string } | null>(
    null,
  );
  const [noteDraft, setNoteDraft] = useState('');
  const notesFor = (code: string) => notes.filter((n) => n.code === code);
  const addNoteFor = (code: string, name: string, text: string) => {
    if (!text.trim()) return false;
    return saveNotes([
      {
        id: crypto.randomUUID(),
        code,
        name,
        text: text.trim(),
        date: new Date().toLocaleDateString('zh-CN', {
          timeZone: 'Asia/Shanghai',
        }),
      },
      ...notes,
    ]);
  };
  const [filter, setFilter] = useState('');
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
  const columns = table.columns.map((id) =>
    RESEARCH_COLUMNS.find((c) => c.id === id)!,
  );
  function saveTable(next: ResearchTablePreferences) {
    setTable(next);
    try {
      personalStorage.setItem(RESEARCH_TABLE_KEY, JSON.stringify(next));
      setPreferenceError('');
    } catch {
      setPreferenceError('表头设置未保存，浏览器存储不可用');
    }
  }
  function sortBy(column: ResearchSort['column']) {
    saveTable({
      ...table,
      sort: {
        column,
        direction:
          sort?.column === column && sort.direction === 'asc' ? 'desc' : 'asc',
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
  useEffect(() => {
    try {
      const n = JSON.parse(personalStorage.getItem(NOTE_KEY) ?? '[]');
      if (Array.isArray(n))
        setNotes(
          n.filter(
            (x) => x && typeof x.text === 'string' && typeof x.id === 'string',
          ),
        );
    } catch {}
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
              setFinErrors((prev) => [...prev, ...batch.map((r) => r.name)]);
          }
        }
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
    if (['roe', 'netMargin', 'ocfPerShare', 'debtRatio'].includes(column))
      return latest(quote.code, column);
    const val =
      quote[column as 'pe' | 'pb' | 'price' | 'changePct' | 'totalMarketCap'];
    return val != null && Number.isFinite(val) ? val : null;
  };
  const rows = quotes
    .filter(
      (q) =>
        codes.includes(q.symbol) &&
        inGroup(q.symbol) &&
        `${q.name}${q.code}`
          .toLowerCase()
          .includes(filter.trim().toLowerCase()),
    )
    .sort((a, b) => {
      const manual =
        savedCodes.indexOf(a.symbol) - savedCodes.indexOf(b.symbol);
      return sort
        ? compareResearchValues(
            columnValue(a, sort.column),
            columnValue(b, sort.column),
            sort.direction,
          ) || manual
        : manual;
    });
  const visibleSelected = selected.filter((symbol) =>
    rows.some((row) => row.symbol === symbol),
  );
  const filteredOtherAssets = otherAssets
    .filter(
      (q) =>
        codes.includes(q.symbol) &&
        inGroup(q.symbol) &&
        `${q.name}${q.code}`
          .toLowerCase()
          .includes(filter.trim().toLowerCase()),
    )
    .sort(
      (a, b) => savedCodes.indexOf(a.symbol) - savedCodes.indexOf(b.symbol),
    );
  const destination = wl.groups.some((g) => g.id === moveTarget)
    ? moveTarget
    : UNGROUPED;
  const reports = [...financials]
    .filter((f) => f.periods.length)
    .sort((a, b) => b.periods.at(-1)!.localeCompare(a.periods.at(-1)!));
  const saveNotes = (next: Note[]) => {
    try {
      personalStorage.setItem(NOTE_KEY, JSON.stringify(next));
      setNotes(next);
      setNoteError('');
      return true;
    } catch {
      setNoteError('笔记未保存，浏览器存储空间不足或不可用。');
      return false;
    }
  };
  const addNote = () => {
    const company = quotes.find(
      (q) => q.code === (noteCode || quotes[0]?.code),
    );
    if (!draft.trim() || !company) return;
    if (
      saveNotes([
        {
          id: crypto.randomUUID(),
          code: company.code,
          name: company.name,
          text: draft.trim(),
          date: new Date().toLocaleDateString('zh-CN', {
            timeZone: 'Asia/Shanghai',
          }),
        },
        ...notes,
      ])
    )
      setDraft('');
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="page-title">{management ? '关注公司' : '研究工作台'}</h1>
        <div className="flex gap-2">
          <Link href="/industry" className="btn">
            行业研究
          </Link>
          <Link href="/screener" className="btn-primary">
            筛选公司
          </Link>
        </div>
      </div>
      {!management && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ['关注公司', loading ? '—' : quotes.length, '家'],
            [
              '财报覆盖',
              finLoading
                ? '…'
                : financials.filter((f) => f.periods.length > 0).length,
              '家',
            ],
            ['最近报告期', reports[0]?.periods.at(-1) ?? '—', ''],
            ['研究笔记', notes.length, '条'],
          ].map(([label, count, unit]) => (
            <div key={label} className="card px-5 py-5">
              <div className="text-xs text-slate-500">{label}</div>
              <div
                className={`mt-3 font-semibold tabular-nums tracking-tight text-slate-900 ${label === '最近报告期' ? 'text-xl' : 'text-3xl'}`}
              >
                {count}
                <span className="ml-1.5 text-xs font-normal text-slate-500">
                  {unit}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      <section className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-3">
            <h2 className="section-title">基本面跟踪</h2>
            <span className="text-xs text-slate-500">
              {`${rows.length} 家公司`}
              {finLoading ? ' · 财报加载中…' : ''}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              aria-label="筛选关注公司"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="公司名称 / 代码"
              className="input !w-40"
            />
            <select
              aria-label="公司排序"
              className="input !w-32"
              value={sort ? `${sort.column}:${sort.direction}` : 'saved'}
              onChange={(e) => {
                const [column, direction] = e.target.value.split(':');
                saveTable({
                  ...table,
                  sort:
                    column === 'saved'
                      ? null
                      : {
                          column: column as ResearchSort['column'],
                          direction: direction as 'asc' | 'desc',
                        },
                });
              }}
            >
              <option value="saved">手动顺序</option>
              {[{ id: 'name', label: '公司' }, ...columns].flatMap((c) =>
                ['asc', 'desc'].map((direction) => (
                  <option
                    key={`${c.id}:${direction}`}
                    value={`${c.id}:${direction}`}
                  >
                    {c.label} {direction === 'asc' ? '升序' : '降序'}
                  </option>
                )),
              )}
            </select>
            <button
              type="button"
              className="btn !text-xs"
              onClick={() => setColumnsOpen(true)}
            >
              自定义表头
            </button>
          </div>
        </div>
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
        <WatchlistGroups active={group} onChange={setActiveGroup} />
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
        <div className="overflow-x-auto">
          <table
            aria-label="基本面股票列表"
            className="w-full text-right"
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
                      rows.length > 0 && visibleSelected.length === rows.length
                    }
                    ref={(el) => {
                      if (el)
                        el.indeterminate =
                          visibleSelected.length > 0 &&
                          visibleSelected.length < rows.length;
                    }}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked ? rows.map((q) => q.symbol) : [],
                      )
                    }
                    className="h-3.5 w-3.5 accent-blue-600"
                  />
                </th>
                <th
                  className="th"
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
                <th className="th !text-right">研究</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((q, index) => (
                <tr
                  key={q.symbol}
                  data-symbol={q.symbol}
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
                  <td className="td !py-1.5 !pr-0">
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        aria-label={`拖动调整${q.name}顺序`}
                        title={
                          sort
                            ? '选择手动顺序后可拖动'
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
                          const target =
                            rows[index + (e.key === 'ArrowUp' ? -1 : 1)];
                          if (target)
                            wl.reorderStock(q.symbol, target.symbol, group);
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
                  <td className="td !py-1.5 text-left">
                    <div className="flex items-center gap-1.5">
                      <StockName
                        quote={q}
                        groups={groupNames(q.symbol)}
                        href={`/stock/${q.symbol}`}
                      />
                      <button
                        type="button"
                        aria-label={`${q.name}笔记`}
                        title={
                          notesFor(q.code).length
                            ? `笔记 ${notesFor(q.code).length} 条`
                            : '添加笔记'
                        }
                        onClick={() => {
                          setNoteDraft('');
                          setNoteView({ code: q.code, name: q.name });
                        }}
                        className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-opacity hover:bg-amber-50 focus-visible:text-amber-600 [@media(hover:none)]:opacity-100 ${
                          notesFor(q.code).length
                            ? 'text-amber-500'
                            : 'text-slate-400 hover:text-amber-600 opacity-0 group-hover/stock:opacity-100 focus-within:opacity-100'
                        }`}
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
                      <span className="flex items-center opacity-0 transition-opacity group-hover/stock:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
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
                        {!sort && (
                          <OrderButtons
                            name={q.name}
                            first={index === 0}
                            last={index === rows.length - 1}
                            onMove={(delta) =>
                              wl.reorderStock(
                                q.symbol,
                                rows[index + delta].symbol,
                                group,
                              )
                            }
                          />
                        )}
                      </span>
                    </div>
                  </td>
                  {columns.map((c) => {
                    const v = columnValue(q, c.id);
                    return (
                      <td
                        key={c.id}
                        className={`td !py-1.5 ${c.id === 'roe' ? 'font-medium' : ''} ${c.id === 'period' ? '!text-xs !text-slate-500' : ''}`}
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
                  <td className="td !py-1.5">
                    <div className="flex justify-end gap-4">
                      <Link
                        prefetch={false}
                        href={`/stock/${q.symbol}`}
                        className="text-brand-600"
                      >
                        估值
                      </Link>
                      <Link
                        prefetch={false}
                        href={`/stock/${q.symbol}/finance`}
                        className="text-brand-600"
                      >
                        财报
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td
                    colSpan={columns.length + 3}
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

        <div className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
          PE / PB：行情口径　·　财务指标：各公司所列报告期累计口径
          {finErrors.length > 0 && (
            <span className="ml-3 text-amber-700">
              财报暂不可用：{finErrors.join('、')}
            </span>
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
      {noteError && (
        <p role="alert" className="text-sm text-red-600">
          {noteError}
        </p>
      )}
      <Modal
        open={!!noteView}
        title={noteView ? `${noteView.name} · 笔记` : '笔记'}
        onClose={() => setNoteView(null)}
      >
        {noteView && (
          <div className="space-y-4">
            <div className="max-h-64 space-y-2 overflow-y-auto">
              {notesFor(noteView.code).length === 0 ? (
                <p className="text-sm text-slate-400">暂无笔记</p>
              ) : (
                notesFor(noteView.code).map((n) => (
                  <div
                    key={n.id}
                    className="rounded-lg border border-slate-100 bg-slate-50 p-3"
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="text-xs text-slate-400">{n.date}</span>
                      <button
                        type="button"
                        aria-label="删除笔记"
                        className="text-xs text-slate-400 hover:text-red-600"
                        onClick={() =>
                          saveNotes(notes.filter((x) => x.id !== n.id))
                        }
                      >
                        删除
                      </button>
                    </div>
                    <p className="whitespace-pre-wrap text-sm text-slate-700">
                      {n.text}
                    </p>
                  </div>
                ))
              )}
            </div>
            <textarea
              aria-label="新增笔记"
              className="input min-h-24 w-full resize-y"
              placeholder="记录研究观点、买卖逻辑…"
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <button type="button" className="btn" onClick={() => setNoteView(null)}>
                关闭
              </button>
              <button
                type="button"
                className="btn bg-brand-600 text-white hover:bg-brand-700"
                disabled={!noteDraft.trim()}
                onClick={() => {
                  if (addNoteFor(noteView.code, noteView.name, noteDraft))
                    setNoteDraft('');
                }}
              >
                保存笔记
              </button>
            </div>
          </div>
        )}
      </Modal>
      {!management && (
        <div className="grid items-start gap-5 lg:grid-cols-[1fr_360px]">
          <section className="card p-5">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="section-title">研究笔记</h2>
              <span className="text-xs text-slate-500">{notes.length} 条</span>
            </div>
            <div className="flex flex-col gap-3">
              <select
                aria-label="笔记所属公司"
                className="input !w-48"
                value={noteCode || quotes[0]?.code || ''}
                onChange={(e) => setNoteCode(e.target.value)}
              >
                {quotes.map((q) => (
                  <option key={q.code} value={q.code}>
                    {q.name} · {q.code}
                  </option>
                ))}
              </select>
              <textarea
                aria-label="研究笔记"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="投资逻辑、估值假设、待验证问题"
                rows={3}
                className="input resize-y"
              />
              <div className="flex justify-end">
                <button
                  disabled={!draft.trim() || !quotes.length}
                  onClick={addNote}
                  className="btn-primary"
                >
                  保存笔记
                </button>
              </div>
            </div>
            <div className="mt-5 divide-y divide-slate-100">
              {notes.length ? (
                notes.map((n) => (
                  <article key={n.id} className="py-4">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <Link
                        href={`/stock/${n.code}`}
                        className="text-sm font-medium text-slate-800"
                      >
                        {n.name}
                      </Link>
                      <div className="flex items-center gap-4 text-xs text-slate-500">
                        <time>{n.date}</time>
                        <button
                          aria-label={`删除${n.name}笔记`}
                          onClick={() =>
                            saveNotes(notes.filter((x) => x.id !== n.id))
                          }
                        >
                          删除
                        </button>
                      </div>
                    </div>
                    <p className="whitespace-pre-wrap break-words text-sm leading-7 text-slate-600">
                      {n.text}
                    </p>
                  </article>
                ))
              ) : (
                <p className="py-4 text-sm text-slate-400">暂无研究记录</p>
              )}
            </div>
          </section>
          <section className="card p-5">
            <h2 className="section-title">财报索引</h2>
            <div className="mt-4 divide-y divide-slate-100">
              {reports.slice(0, 6).map((f) => (
                <Link
                  prefetch={false}
                  key={f.code}
                  href={`/stock/${f.code}/finance`}
                  className="flex items-center justify-between gap-3 py-4"
                >
                  <div>
                    <div className="text-sm font-medium text-slate-800">
                      {f.name}
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      报告期 {f.periods.at(-1)}
                    </div>
                  </div>
                  <span className="text-slate-400" aria-hidden="true">
                    ↗
                  </span>
                </Link>
              ))}
              {!reports.length && (
                <p className="py-8 text-sm text-slate-400">
                  {finLoading ? '财报加载中…' : '暂无财报'}
                </p>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
