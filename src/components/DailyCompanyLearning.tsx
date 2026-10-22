'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { StockLink } from '@/components/StockLink';
import Modal from './Modal';
import WatchlistButton from './WatchlistButton';
import CompanyLearningReport, { type LearningReadingContext } from './CompanyLearningReport';
import { useWatchlist } from './WatchlistProvider';
import { useResearchWorkspace } from './ResearchWorkspaceProvider';
import useCompanyLearning from './useCompanyLearning';
import useLearningDocument from './useLearningDocument';
import { normalizeStockCode } from '@/lib/datasource/codes';
import type { LearningBrief } from '@/lib/datasource/companyLearning';
import type { LearningCandidate } from '@/lib/companyLearning';

const action = 'inline-flex min-h-8 items-center justify-center whitespace-nowrap rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-600 hover:border-brand-200 hover:bg-brand-50 hover:text-brand-700 disabled:opacity-40';
const plain = 'inline-flex min-h-8 items-center rounded px-2 text-xs text-slate-400 hover:bg-slate-50 hover:text-slate-800 disabled:opacity-40';
const primary = 'inline-flex min-h-9 items-center justify-center whitespace-nowrap rounded-md bg-brand-600 px-4 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-40';

export default function DailyCompanyLearning({ today }: { today: string }) {
  const watchlist = useWatchlist();
  const learning = useCompanyLearning(watchlist.codes, watchlist.ready, today);
  const selected = learning.selected;
  const brief = useLearningDocument<LearningBrief>(selected?.symbol || '', today, 'brief', learning.ready && !!selected);
  const [open, setOpen] = useState(false), [mode, setMode] = useState<'read' | 'history'>('read');
  const [reading, setReading] = useState<(LearningCandidate & { date: string }) | null>(null);
  const [digest, setDigest] = useState<LearningReadingContext | null>(null);
  const { openNotes, notebook } = useResearchWorkspace();
  const openedFromUrl = useRef(false);
  const company = brief.data && selected ? { ...selected, name: brief.data.name, industry: brief.data.industry || selected.industry } : selected;
  const readCompany = useCallback((value: LearningCandidate & { date: string }) => {
    setReading(value); setDigest(null); setMode('read'); setOpen(true);
  }, []);
  useEffect(() => {
    if (!today || !learning.ready || openedFromUrl.current) return;
    openedFromUrl.current = true;
    const stock = normalizeStockCode(new URLSearchParams(window.location.search).get('learn') || '');
    if (stock?.kind === 'stock') readCompany({ symbol: stock.symbol, code: stock.code, name: stock.code, industry: '', origin: 'universe', date: today });
  }, [today, learning.ready, readCompany]);

  const active = reading ? (digest ? { ...reading, name: digest.name, industry: digest.industry || reading.industry } : reading) : null;
  const completed = !!active && learning.state.completed.some(item => item.symbol === active.symbol);
  const marked = !!selected && learning.state.completed.some(item => item.symbol === selected.symbol);
  const research = brief.data?.research;
  const introduction = research?.introduction || brief.data?.business?.summary;
  const clues = research ? [
    { label: '经营线索', text: research.advantages[0]?.detail || research.paragraphs[1], tone: 'border-blue-200 text-blue-700' },
    { label: '同行观察', text: research.competitors[0]?.note, tone: 'border-slate-200 text-slate-600' },
    { label: research.viewBasis === 'research_hypotheses' ? '正向假设' : '主流看好', text: research.bull[0]?.detail, tone: 'border-teal-200 text-teal-700' },
    { label: '主要分歧', text: research.bear[0]?.detail, tone: 'border-amber-200 text-amber-700' },
  ] : [];

  function createNote() {
    if (!active) return;
    const questions = digest?.questions.length ? digest.questions : ['业务的盈利来源和竞争优势是什么？', '哪些事实会推翻目前的判断？'];
    const text = `## 公司研究\n公司：${active.name}（${active.code}）\n日期：${today}\n\n## 业务与赚钱方式\n\n## 竞争优势与同行\n\n## 财务与估值\n\n## 待验证的问题\n${questions.map(item => `- ${item}`).join('\n')}\n\n## 我的判断\n\n## 资料来源\n${digest?.sources.map(item => `- [${item.label}](${item.url})`).join('\n') || ''}`;
    setOpen(false);
    openNotes({ symbol: active.symbol, code: active.code, name: active.name }, { kind: 'company', mode: 'create', initialText: text, initialTitle: `${active.name} · 公司研究` });
  }

  return <>
    <section aria-label="每天了解一家公司" className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-brand-100 bg-white xl:h-full">
      <header className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-slate-100 px-4 py-1.5">
        <h2 className="text-[13px] font-semibold text-brand-700">每天了解一家公司</h2>
        <div className="flex items-center gap-0.5"><button type="button" disabled={!learning.ready || !company} onClick={learning.swap} className={plain}>换一家</button><button type="button" className={plain} disabled={!learning.ready} onClick={() => { setMode('history'); setOpen(true); }}>学习记录</button></div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5 pt-5 sm:px-5 xl:overscroll-contain">
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1"><h3 className="text-[26px] font-semibold tracking-tight text-slate-900">{company?.name || '今日公司'}</h3>{marked && <span className="rounded bg-teal-50 px-1.5 py-0.5 text-[10px] text-teal-700">已了解</span>}</div>
        <p className="text-[11px] text-slate-400">{company ? `${company.code} · ${company.industry || '行业待取得'}` : today}</p>
        {learning.error || brief.error ? <p role="alert" className="mt-5 text-xs leading-6 text-amber-700">{learning.error || brief.error}</p> : !learning.ready || brief.loading ? <p className="py-10 text-xs text-slate-400">正在准备今日公司…</p> : <>
          <p className="mt-5 text-[15px] font-medium leading-7 text-slate-800">{introduction || '从业务、竞争格局与盈利质量认识这家公司。'}</p>
          {research && <p className="mt-3 hidden text-xs leading-6 text-slate-500 xl:line-clamp-4">{research.paragraphs[0]}</p>}
          <div className="mt-5 space-y-4">{clues.filter(item => item.text).map(item => <div key={item.label} className={`border-l-2 pl-3 ${item.tone}`}><h4 className="text-[11px] font-medium">{item.label}</h4><p className="mt-1.5 line-clamp-3 text-[12px] leading-6 text-slate-500">{item.text}</p></div>)}</div>
        </>}
      </div>
      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/50 px-4 py-3 sm:px-5">
        <div className="text-[10px] leading-5 text-slate-400"><p>已了解 <span className="font-medium tabular-nums text-slate-600">{learning.state.completed.length}</span> 家公司</p><p>{research ? `研究资料 ${research.date}` : '公司披露资料'}</p></div>
        {learning.error ? <button type="button" onClick={learning.retry} className={action}>重试</button> : <button type="button" disabled={!learning.ready || !company} onClick={() => company && readCompany(company)} className={primary}>开始了解</button>}
      </footer>
    </section>

    <Modal open={open} title="每日公司速读" size="lg" bare onClose={() => setOpen(false)}>
      <div className="flex h-[90dvh] max-h-[1100px] min-h-0 flex-col">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 sm:px-6"><div className="min-w-0"><h2 className="truncate text-base font-semibold text-slate-900">{mode === 'history' ? '学习记录' : `${active?.name || '公司研究'} · 深度了解`}</h2>{active && mode === 'read' && <p className="mt-1 text-[11px] text-slate-400">{active.code} · {active.industry || '行业待取得'} · {reading?.date}</p>}</div><div className="flex shrink-0 items-center gap-1">{mode === 'read' ? <button type="button" className={plain} onClick={() => setMode('history')}>学习记录 {learning.state.completed.length}</button> : <button type="button" className={plain} disabled={!company} onClick={() => company && readCompany(company)}>回到今日</button>}<button type="button" aria-label="关闭每日公司速读" className={action} onClick={() => setOpen(false)}>关闭</button></div></header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-white">
          {mode === 'history' ? <div className="space-y-2 p-4">{learning.state.completed.length === 0 ? <p className="py-20 text-center text-xs text-slate-400">还没有已了解的公司</p> : learning.state.completed.map(item => <button type="button" key={item.symbol} onClick={() => readCompany(item)} className="flex w-full items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-3 text-left hover:border-brand-200"><div><span className="text-sm font-medium text-slate-800">{item.name}</span><span className="ml-3 text-xs text-slate-400">{item.code} · {item.industry}</span></div><time className="shrink-0 text-xs tabular-nums text-slate-400">{item.date}</time></button>)}</div> : reading && <CompanyLearningReport key={`${reading.symbol}:${reading.date}`} company={reading} date={reading.date} onReady={setDigest}/>}
        </div>
        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-white px-4 py-2.5 sm:px-6"><div className="flex items-center gap-3">{active && <><StockLink href={`/stock/${active.symbol}`} onClick={() => setOpen(false)} className="inline-flex min-h-8 items-center text-xs text-slate-400 hover:text-brand-700">个股页面</StockLink><StockLink href={`/stock/${active.symbol}/finance`} onClick={() => setOpen(false)} className="inline-flex min-h-8 items-center text-xs text-slate-400 hover:text-brand-700">财务报表</StockLink></>}</div><div className="flex flex-wrap items-center gap-2">{active && mode === 'read' && <><button type="button" disabled={!learning.ready} onClick={() => learning.mark(active)} aria-pressed={completed} title={completed ? '点击取消已了解' : undefined} className={`${action} ${completed ? '!border-teal-200 !bg-teal-50 !text-teal-700' : ''}`}>{completed ? '已了解' : '标记已了解'}</button><WatchlistButton code={active.symbol} name={active.name} compact/><button type="button" disabled={!notebook.ready || !digest} onClick={createNote} className={primary}>记笔记</button></>}</div>{learning.error && <p role="alert" className="w-full text-xs text-amber-700">{learning.error}</p>}</footer>
      </div>
    </Modal>
  </>;
}
