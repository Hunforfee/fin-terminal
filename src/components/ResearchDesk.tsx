'use client';

import { personalStorage } from '@/lib/personalStorage';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useWatchlist } from './WatchlistProvider';
import WatchlistButton from './WatchlistButton';
import WatchlistGroups from './WatchlistGroups';
import { UNGROUPED } from '@/lib/watchlist';
import { normalizeCode } from '@/lib/datasource/codes';
import type { Quote } from '@/lib/datasource/types';
import { industryOf } from '@/lib/universe';

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
    group === 'all' || wl.groupOf(symbol) === group;
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
  const [filter, setFilter] = useState('');
  useEffect(() => {
    setSelected([]);
  }, [group, filter]);
  const [sort, setSort] = useState<'saved' | 'pe' | 'roe'>('saved');

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
  const signature = codes.join(',');
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
      if (sort === 'saved')
        return codes.indexOf(a.symbol) - codes.indexOf(b.symbol);
      const av = sort === 'pe' ? a.pe : latest(a.code, 'roe');
      const bv = sort === 'pe' ? b.pe : latest(b.code, 'roe');
      if (av == null) return bv == null ? 0 : 1;
      if (bv == null) return -1;
      return sort === 'pe' ? av - bv : bv - av;
    });
  const visibleSelected = selected.filter((symbol) =>
    rows.some((row) => row.symbol === symbol),
  );
  const filteredOtherAssets = otherAssets.filter(
    (q) =>
      codes.includes(q.symbol) &&
      inGroup(q.symbol) &&
      `${q.name}${q.code}`.toLowerCase().includes(filter.trim().toLowerCase()),
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
              value={sort}
              onChange={(e) => setSort(e.target.value as typeof sort)}
            >
              <option value="saved">关注顺序</option>
              <option value="pe">PE 从低到高</option>
              <option value="roe">ROE 从高到低</option>
            </select>
          </div>
        </div>
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
                wl.move(visibleSelected, destination);
                setSelected([]);
              }}
              className="rounded-md bg-white px-2.5 py-1.5 text-xs text-brand-700 ring-1 ring-brand-200"
            >
              移入分组
            </button>
            <button
              type="button"
              onClick={() => {
                wl.removeMany(visibleSelected);
                setSelected([]);
              }}
              className="rounded-md px-2.5 py-1.5 text-xs text-red-600 hover:bg-red-50"
            >
              删除自选
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
          <table className="w-full min-w-[960px] text-right">
            <thead>
              <tr>
                <th className="th !w-10 !pr-0">
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
                <th className="th">公司</th>
                <th className="th !text-right">PE-TTM</th>
                <th className="th !text-right">PB</th>
                <th className="th !text-right">ROE（累计）</th>
                <th className="th !text-right">净利率</th>
                <th className="th !text-right">每股经营现金流</th>
                <th className="th">报告期</th>
                <th className="th !text-right">研究</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((q) => (
                <tr
                  key={q.symbol}
                  className={`transition hover:bg-slate-50/70 ${visibleSelected.includes(q.symbol) ? 'bg-brand-50/40' : ''}`}
                >
                  <td className="td !pr-0">
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
                  </td>
                  <td className="td text-left">
                    <div className="flex items-center gap-1.5">
                      <Link
                        prefetch={false}
                        href={`/stock/${q.symbol}`}
                        className="font-medium hover:text-brand-600"
                      >
                        {q.name}
                      </Link>
                      <button
                        type="button"
                        aria-label={`删除${q.name}自选`}
                        title="删除自选"
                        onClick={() => remove(q.symbol)}
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
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      {q.code} · {industryOf(q.code) ?? q.market}
                      <span className="ml-2">
                        <WatchlistButton
                          code={q.symbol}
                          name={q.name}
                          compact
                          label={
                            wl.groups.find((g) => g.id === wl.groupOf(q.symbol))
                              ?.name ?? '未分组'
                          }
                        />
                      </span>
                    </div>
                    {q.stale && (
                      <span className="text-xs text-amber-700">行情快照</span>
                    )}
                  </td>
                  <td className="td">{value(q.pe)}</td>
                  <td className="td">{value(q.pb)}</td>
                  <td className="td font-medium">
                    {value(latest(q.code, 'roe'), '%')}
                  </td>
                  <td className="td">
                    {value(latest(q.code, 'netMargin'), '%')}
                  </td>
                  <td className="td">
                    {value(latest(q.code, 'ocfPerShare'), ' 元')}
                  </td>
                  <td className="td text-left !text-xs !text-slate-500">
                    {financialMap.get(q.code)?.periods.at(-1) ??
                      (finLoading ? '…' : '—')}
                  </td>
                  <td className="td">
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
                    colSpan={9}
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
                  <span className="ml-2 text-xs text-slate-400">{q.code}</span>
                </Link>
                <div className="flex shrink-0 items-center gap-3">
                  <WatchlistButton
                    code={q.symbol}
                    name={q.name}
                    compact
                    label={
                      wl.groups.find((g) => g.id === wl.groupOf(q.symbol))
                        ?.name ?? '未分组'
                    }
                  />
                  <button
                    className="text-xs text-slate-500 hover:text-red-600"
                    onClick={() => remove(q.symbol)}
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
