'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { StockLink } from '@/components/StockLink';
import Modal from './Modal';
import DailyCompanyLearning from './DailyCompanyLearning';
import { useWatchlist } from './WatchlistProvider';
import { useResearchWorkspace } from './ResearchWorkspaceProvider';
import type { NoteCompany } from './NoteCompanyPicker';
import { normalizeStockCode } from '@/lib/datasource/codes';
import { industryStockSymbol } from '@/lib/industryResearch';
import {
  isResearchDate, researchNoteKind, researchNoteSymbol,
  type NoteKind, type ResearchNote,
} from '@/lib/researchNotes';

interface WindowEntry {
  artCode: string;
  title: string;
  date: string;
  columns: string[];
  important: boolean;
  code: string;
  symbol: string;
  name: string;
  source?: string;
}
interface FeedState {
  key: string;
  entries: WindowEntry[];
  loading: boolean;
  error: string;
}
// The existing feed returns at most 120 entries, with up to 8 per company.
const BATCH_SIZE = 15;
const NO_ENTRIES: WindowEntry[] = [];
const textAction = 'min-h-8 whitespace-nowrap rounded px-2 text-xs text-slate-500 hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-40';

function aShare(input: string) {
  const stock = normalizeStockCode(input);
  return stock && industryStockSymbol(stock.code) === stock.symbol ? stock : null;
}

function readEntries(value: unknown, symbols: string[]): WindowEntry[] {
  if (!Array.isArray(value)) throw Error('公司动态格式暂不可用');
  const allowed = new Set(symbols), entries = new Map<string, WindowEntry>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const stock = aShare(String(row.symbol || row.code || ''));
    const artCode = typeof row.artCode === 'string' ? row.artCode : '';
    const title = typeof row.title === 'string' ? row.title.trim() : '';
    const date = typeof row.date === 'string' ? row.date.slice(0, 10) : '';
    if (!stock || !allowed.has(stock.symbol) || !/^AN[\w-]+$/.test(artCode) || !title || !isResearchDate(date)) continue;
    entries.set(`${stock.symbol}:${artCode}`, {
      artCode, title, date, code: stock.code, symbol: stock.symbol,
      name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : stock.code,
      columns: Array.isArray(row.columns) ? row.columns.filter((column): column is string => typeof column === 'string') : [],
      important: row.important === true,
      ...(typeof row.source === 'string' ? { source: row.source } : {}),
    });
  }
  if (value.length && !entries.size) throw Error('本批公告暂不可读取');
  return [...entries.values()].sort((a, b) => b.date.localeCompare(a.date));
}

function plainText(value: string): string {
  return value.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:#{1,6}\s*|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/```[^\n]*\n?/g, '').replace(/[*_`~|]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function noteTitle(note: ResearchNote): string {
  return note.title?.trim() || plainText(note.text.split('\n').find((line) => line.trim() && !line.trim().startsWith('```')) || '').slice(0, 48) || '未命名笔记';
}
function noteOrder(note: ResearchNote): number {
  for (const value of [note.updatedAt, note.entryDate, note.date?.replaceAll('/', '-')]) {
    if (!value) continue;
    const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00+08:00` : value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}
function noteDate(note: ResearchNote): string {
  if (researchNoteKind(note) === 'daily' && isResearchDate(note.entryDate)) return note.entryDate.replaceAll('-', '/');
  if (note.updatedAt && Number.isFinite(Date.parse(note.updatedAt)))
    return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(note.updatedAt));
  return note.date || '—';
}
function companyOf(note: ResearchNote): NoteCompany | null {
  const symbol = researchNoteSymbol(note), stock = normalizeStockCode(symbol);
  return stock ? { symbol: stock.symbol, code: stock.code, name: note.name || stock.code } : null;
}

function AnnouncementPreview({ entry, onClose }: { entry: WindowEntry; onClose: () => void }) {
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setSummary(null); setError('');
    fetch(`/api/announcement-content?artCode=${encodeURIComponent(entry.artCode)}`, { signal: controller.signal })
      .then(async (response) => {
        const json = await response.json();
        if (!response.ok || !json.ok || typeof json.data !== 'string') throw Error('公告摘要暂不可用');
        if (!controller.signal.aborted) setSummary(json.data);
      })
      .catch(() => { if (!controller.signal.aborted) setError('公告摘要暂不可用'); });
    return () => controller.abort();
  }, [entry.artCode, retry]);
  // Both components of this URL were validated against stock/announcement IDs.
  const original = `https://data.eastmoney.com/notices/detail/${entry.code}/${entry.artCode}.html`;
  return <Modal open title="公告摘要" size="lg" onClose={onClose}>
    <div className="space-y-3">
      <div>
        <h3 className="text-base font-semibold leading-7 text-slate-900">{entry.title}</h3>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="text-slate-500">{entry.name} · {entry.date}</span>
          <a href={original} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-8 items-center rounded px-2 text-brand-700 hover:bg-brand-50">查看原文</a>
        </div>
      </div>
      <div className="border-t border-slate-100 pt-3 text-[13px] leading-7 text-slate-700" aria-live="polite">
        {error ? <div className="flex items-center gap-2"><span role="alert" className="text-amber-800">{error}</span><button type="button" onClick={() => setRetry((value) => value + 1)} className={textAction}>重试</button></div>
          : summary === null ? <p className="py-4 text-slate-400">正在读取摘要…</p>
          : <p className="whitespace-pre-wrap break-words">{summary || '暂无可展示的摘要'}</p>}
      </div>
    </div>
  </Modal>;
}

export default function ResearchHome() {
  const watchlist = useWatchlist();
  const { notebook, openNotes, setNoteCompanies } = useResearchWorkspace();
  const [activeGroup, setActiveGroup] = useState('all');
  const group = activeGroup === 'all' || watchlist.groups.some((item) => item.id === activeGroup) ? activeGroup : 'all';
  const [batch, setBatch] = useState({ group: 'all', index: 0 });
  const [importantOnly, setImportantOnly] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [feed, setFeed] = useState<FeedState>({ key: '', entries: [], loading: false, error: '' });
  const [preview, setPreview] = useState<WindowEntry | null>(null);
  const [today, setToday] = useState({ iso: '', label: '' });
  const grid = useRef<HTMLDivElement>(null);
  const intro = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(640);
  const selectedCodes = useMemo(() => watchlist.codesIn(group), [watchlist, group]);
  const symbols = useMemo(() => [...new Set(selectedCodes.flatMap((input) => {
    const stock = aShare(input);
    return stock ? [stock.symbol] : [];
  }))], [selectedCodes]);
  const hasHongKong = useMemo(() => selectedCodes.some((input) => normalizeStockCode(input)?.market === 'HK'), [selectedCodes]);
  const batchCount = Math.max(1, Math.ceil(symbols.length / BATCH_SIZE));
  const batchIndex = batch.group === group ? Math.min(batch.index, batchCount - 1) : 0;
  const batchSymbols = useMemo(() => symbols.slice(batchIndex * BATCH_SIZE, (batchIndex + 1) * BATCH_SIZE), [symbols, batchIndex]);
  const requestKey = `${group}|${batchSymbols.join(',')}`;
  const currentFeed = feed.key === requestKey ? feed : null;
  const entries = currentFeed?.entries ?? NO_ENTRIES;
  const loading = !watchlist.ready || (batchSymbols.length > 0 && (!currentFeed || currentFeed.loading));
  const shown = useMemo(() => importantOnly ? entries.filter((entry) => entry.important) : entries, [entries, importantOnly]);
  const recentNotes = useMemo(() => {
    const sorted = notebook.notes.slice().sort((a, b) => noteOrder(b) - noteOrder(a));
    return {
      company: sorted.filter((note) => researchNoteKind(note) === 'company').slice(0, 5),
      daily: sorted.filter((note) => researchNoteKind(note) === 'daily')
        .sort((a, b) => (b.entryDate ?? '').localeCompare(a.entryDate ?? '') || noteOrder(b) - noteOrder(a))
        .slice(0, 5),
    };
  }, [notebook.notes]);
  const namedCompanies = useMemo(() => [...new Map(entries.filter((entry) =>
    entry.name !== entry.symbol && entry.name !== entry.code,
  ).map((entry) => [entry.symbol, { symbol: entry.symbol, code: entry.code, name: entry.name }])).values()], [entries]);

  useEffect(() => { setNoteCompanies(namedCompanies); }, [namedCompanies, setNoteCompanies]);
  useEffect(() => () => setNoteCompanies([]), [setNoteCompanies]);
  useEffect(() => {
    const update = () => {
      const now = new Date();
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
      const part = (kind: string) => parts.find((item) => item.type === kind)?.value || '';
      setToday({ iso: `${part('year')}-${part('month')}-${part('day')}`,
        label: new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(now) });
    };
    update(); const timer = setInterval(update, 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const measure = () => {
      if (!grid.current) return;
      const top = grid.current.getBoundingClientRect().top + window.scrollY;
      const next = Math.max(320, Math.floor(window.innerHeight - top - 12));
      setHeight((previous) => previous === next ? previous : next);
    };
    measure();
    const header = document.querySelector('header');
    const observer = new ResizeObserver(measure);
    if (header) observer.observe(header);
    if (intro.current) observer.observe(intro.current);
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.visualViewport?.removeEventListener('resize', measure); };
  }, []);
  useEffect(() => {
    if (!watchlist.ready || !batchSymbols.length) {
      setFeed({ key: requestKey, entries: [], loading: false, error: '' });
      return;
    }
    const controller = new AbortController();
    setFeed({ key: requestKey, entries: [], loading: true, error: '' });
    fetch(`/api/company-window?codes=${encodeURIComponent(batchSymbols.join(','))}`, { signal: controller.signal })
      .then(async (response) => {
        const json = await response.json();
        if (!response.ok || !json.ok) throw Error('公司动态暂不可用');
        const next = readEntries(json.data, batchSymbols);
        if (!controller.signal.aborted) setFeed({ key: requestKey, entries: next, loading: false, error: '' });
      })
      .catch(() => {
        if (!controller.signal.aborted) setFeed({ key: requestKey, entries: [], loading: false, error: '公司动态暂不可用' });
      });
    return () => controller.abort();
  }, [watchlist.ready, batchSymbols, requestKey, refresh]);

  function notesPanel(kind: NoteKind) {
    const daily = kind === 'daily', title = daily ? '每日心得' : '公司笔记';
    return <section aria-labelledby={`home-${kind}-title`} className="flex h-[260px] min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white xl:h-auto">
      <div className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-slate-100 px-3 py-1.5">
        <h2 id={`home-${kind}-title`} className={`border-l-2 pl-2 text-sm font-semibold text-slate-800 ${daily ? 'border-teal-500' : 'border-amber-400'}`}>{title}</h2>
        <div className="flex items-center gap-1">
          <button type="button" disabled={!notebook.ready} onClick={() => openNotes(null, { kind, mode: 'read' })} aria-label={`查看全部${title}`} className={textAction}>全部</button>
          <button type="button" disabled={!notebook.ready} onClick={() => openNotes(null, { kind, mode: 'create' })} className={`min-h-8 whitespace-nowrap rounded px-2 text-xs font-medium disabled:opacity-40 ${daily ? 'text-teal-700 hover:bg-teal-50' : 'text-amber-800 hover:bg-amber-50'}`}>{daily ? '写心得' : '写笔记'}</button>
        </div>
      </div>
      <div tabIndex={0} role="region" aria-label={`最近${title}`} className="min-h-0 flex-1 overflow-y-auto overscroll-contain focus-visible:outline-offset-[-2px]">
        {notebook.error ? <p role={daily ? undefined : 'alert'} className="px-3 py-8 text-center text-xs text-amber-800">{daily ? '笔记暂不可读' : notebook.error}</p>
          : !notebook.ready ? <p className="px-3 py-8 text-center text-xs text-slate-400">正在读取笔记…</p>
          : recentNotes[kind].length === 0 ? <p className="px-3 py-10 text-center text-xs text-slate-400">{daily ? '还没有每日心得' : '还没有公司笔记'}</p>
          : <ul className="divide-y divide-slate-100">{recentNotes[kind].map((note) => {
            const heading = noteTitle(note), company = daily ? null : companyOf(note);
            return <li key={note.id}><button type="button" aria-label={`查看${title}：${heading}`} onClick={() => openNotes(company, { kind, noteId: note.id, mode: 'read' })} className="block w-full min-w-0 px-3 py-2.5 text-left hover:bg-slate-50 focus-visible:outline-offset-[-2px]">
              <p className="truncate text-[13px] font-medium leading-5 text-slate-800">{heading}</p>
              <p className="mt-0.5 truncate text-xs leading-5 text-slate-500">{plainText(note.text).slice(0, 200) || '—'}</p>
              <p className="mt-1 flex min-w-0 items-center gap-2 text-[11px] text-slate-400">{!daily && <span className="truncate text-slate-500">{note.name || company?.code || '未关联公司'}</span>}<span className="shrink-0 tabular-nums">{noteDate(note)}</span></p>
            </button></li>;
          })}</ul>}
      </div>
    </section>;
  }

  return <div className="min-w-0">
    <div ref={intro}>
    <div className="flex min-h-9 items-center justify-between gap-3 pb-2">
      <h1 className="text-base font-semibold tracking-tight text-slate-900">首页</h1>
      <div className="flex items-center gap-4"><Link href="/watchlist" className="hidden text-[11px] text-slate-400 hover:text-brand-700 sm:inline">自选公司 {watchlist.ready ? watchlist.codes.length : '—'}</Link><time dateTime={today.iso || undefined} className="text-[11px] text-slate-400">{today.label}</time></div>
    </div>
    </div>
    <div ref={grid} style={{ '--home-height': `${height}px` } as CSSProperties} className="grid min-w-0 gap-3 lg:grid-cols-2 xl:h-[var(--home-height)] xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1.2fr)_minmax(240px,.8fr)]">
      <DailyCompanyLearning today={today.iso}/>
      <section aria-labelledby="home-announcements-title" className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-1.5">
          <h2 id="home-announcements-title" className="border-l-2 border-blue-500 pl-2 text-sm font-semibold text-slate-800">公司动态</h2>
          <div className="flex min-w-0 items-center gap-1.5">
            <select aria-label="公司动态分组" value={group} disabled={!watchlist.ready} onChange={(event) => { setActiveGroup(event.target.value); setBatch({ group: event.target.value, index: 0 }); }} className="min-h-8 min-w-0 max-w-[100px] rounded border border-slate-200 bg-white px-2 text-xs text-slate-600 sm:max-w-[140px]">
              <option value="all">全部自选</option>{watchlist.groups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <div role="group" aria-label="动态范围" className="inline-flex shrink-0 items-center rounded bg-slate-50 p-0.5">
              <button type="button" aria-pressed={!importantOnly} onClick={() => setImportantOnly(false)} className={`min-h-7 rounded px-2 text-xs ${importantOnly ? 'text-slate-500 hover:text-slate-800' : 'bg-white font-medium text-blue-700'}`}>全部</button>
              <button type="button" aria-pressed={importantOnly} onClick={() => setImportantOnly(true)} className={`min-h-7 rounded px-2 text-xs ${importantOnly ? 'bg-white font-medium text-blue-700' : 'text-slate-500 hover:text-slate-800'}`}>重点</button>
            </div>
            <button type="button" disabled={loading || !symbols.length} onClick={() => setRefresh((value) => value + 1)} className={textAction}>刷新</button>
          </div>
        </div>
        <div tabIndex={0} role="region" aria-label="本批公司动态" aria-busy={loading} className="max-h-[26rem] min-h-0 flex-1 overflow-y-auto overscroll-contain focus-visible:outline-offset-[-2px] lg:max-h-[40rem] xl:max-h-none">
          {loading ? <p role="status" className="px-3 py-10 text-center text-xs text-slate-400">正在读取公司动态…</p>
            : currentFeed?.error ? <div className="flex items-center justify-center gap-2 px-3 py-10"><span role="alert" className="text-xs text-amber-800">{currentFeed.error}</span><button type="button" className={textAction} onClick={() => setRefresh((value) => value + 1)}>重试</button></div>
            : !symbols.length ? <div className="space-y-2 px-3 py-10 text-center text-xs text-slate-400"><p>{hasHongKong ? '港股公司公告暂未接入' : selectedCodes.length ? '当前分组暂无 A 股公司' : '暂无自选公司'}</p>{!selectedCodes.length && <Link href="/watchlist" className="inline-flex min-h-8 items-center rounded px-2 text-brand-700 hover:bg-brand-50">前往自选公司</Link>}</div>
            : shown.length === 0 ? <p className="px-3 py-10 text-center text-xs text-slate-400">{importantOnly ? '本批暂无可用重点动态' : '本批暂无可用动态'}</p>
            : <ol className="divide-y divide-slate-100">{shown.map((entry) => <li key={`${entry.symbol}:${entry.artCode}`} className="px-3 py-2.5 transition-colors hover:bg-slate-50/70">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                <StockLink prefetch={false} href={`/stock/${entry.symbol}`} className="max-w-[180px] truncate font-medium text-slate-700 hover:text-brand-700 hover:underline">{entry.name}</StockLink>
                <time dateTime={entry.date} className="text-[11px] tabular-nums text-slate-400">{entry.date}</time>
                {entry.important && <span className="rounded bg-amber-50 px-1 text-[10px] text-amber-800">重点</span>}
              </div>
              <button type="button" aria-haspopup="dialog" onClick={() => setPreview(entry)} className="mt-1 line-clamp-2 w-full rounded text-left text-[12px] leading-5 text-slate-700 hover:text-brand-700 focus-visible:outline-offset-2">{entry.title}</button>
            </li>)}</ol>}
        </div>
        <div className="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-1 border-t border-slate-100 px-3 py-1 text-[11px] text-slate-400">
          <span aria-live="polite" className="tabular-nums">{symbols.length ? `第 ${batchIndex * BATCH_SIZE + 1}–${Math.min((batchIndex + 1) * BATCH_SIZE, symbols.length)} 家 / 共 ${symbols.length} 家 A股` : '0 家 A股'}</span>
          <div className="flex items-center gap-1">
            <button type="button" disabled={batchIndex === 0 || !symbols.length} onClick={() => setBatch({ group, index: batchIndex - 1 })} className={textAction}>上一批</button>
            <button type="button" disabled={batchIndex >= batchCount - 1 || !symbols.length} onClick={() => setBatch({ group, index: batchIndex + 1 })} className={textAction}>下一批</button>
          </div>
        </div>
      </section>
      <div className="flex min-h-0 min-w-0 flex-col gap-3 lg:col-span-2 lg:flex-row xl:col-span-1 xl:flex-col">
        {notesPanel('company')}
        {notesPanel('daily')}
      </div>
    </div>
    {preview && <AnnouncementPreview key={`${preview.symbol}:${preview.artCode}`} entry={preview} onClose={() => setPreview(null)} />}
  </div>;
}
