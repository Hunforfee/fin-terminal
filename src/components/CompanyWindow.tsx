'use client';

/**
 * 公司窗口：自选公司公告的朋友圈式时间线。
 *
 * - 入口按钮显示「未读重要公告数」（红字提醒）或公告总数
 * - 弹窗内按时间倒序展示：公司头像块 + 日期 + 标题（重要红字/红标）+ 摘要
 * - 已读游标存 localStorage（fin.company-window.readAt），按时间戳判断未读
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Modal from './Modal';
import HeaderToolButton from './HeaderToolButton';
import { personalStorage } from '@/lib/personalStorage';

interface Entry {
  artCode: string;
  title: string;
  date: string;
  columns: string[];
  important: boolean;
  code: string;
  symbol: string;
  name: string;
}

const READ_KEY = 'fin.company-window.readAt';

const readCursor = (): number => {
  try {
    return Number(personalStorage.getItem(READ_KEY)) || 0;
  } catch {
    return 0;
  }
};

/** 取公司名首个词做头像字（贵州茅台→贵） */
const avatarChar = (name: string) => [...name.trim()][0] ?? '?';

const AVATAR_COLORS = [
  'bg-rose-100 text-rose-700',
  'bg-amber-100 text-amber-700',
  'bg-emerald-100 text-emerald-700',
  'bg-sky-100 text-sky-700',
  'bg-violet-100 text-violet-700',
  'bg-slate-200 text-slate-700',
];
const avatarColor = (code: string) =>
  AVATAR_COLORS[
    [...code].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) %
      AVATAR_COLORS.length
  ];

const fmtDate = (date: string) => {
  const [, m, d] = date.split('-');
  return `${Number(m)}月${Number(d)}日`;
};

export default function CompanyWindow({
  codes,
  variant = 'default',
}: {
  codes: string[];
  variant?: 'default' | 'nav';
}) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState('');
  const [readAt, setReadAt] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [maximized, setMaximized] = useState(false);
  const requestRef = useRef(0);
  const requestController = useRef<AbortController | null>(null);

  useEffect(() => {
    setReadAt(readCursor());
  }, []);

  const codesKey = codes.slice(0, 40).join(',');

  const load = useCallback(() => {
    const request = ++requestRef.current;
    requestController.current?.abort();
    setError('');
    if (!codesKey) {
      setEntries([]);
      return;
    }
    const controller = new AbortController();
    requestController.current = controller;
    setEntries(null);
    fetch(`/api/company-window?codes=${encodeURIComponent(codesKey)}`, {
      signal: controller.signal,
    })
      .then((r) => r.json())
      .then((j) => {
        if (request !== requestRef.current) return;
        if (j?.ok && Array.isArray(j.data)) setEntries(j.data as Entry[]);
        else setError(j?.error || '公告获取失败');
      })
      .catch(() => {
        if (request === requestRef.current && !controller.signal.aborted)
          setError('公告获取失败，请稍后重试');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codesKey]);

  const unreadImportant = useMemo(
    () =>
      (entries ?? []).filter(
        (e) =>
          e.important &&
          new Date(`${e.date}T23:59:59+08:00`).getTime() > readAt,
      ).length,
    [entries, readAt],
  );

  const openWindow = () => {
    setOpen(true);
  };

  // The icon utility needs no counts before the window is opened.
  // The default entry keeps its initial unread-count request.
  const shouldLoad = variant === 'default' || open;
  useEffect(() => {
    if (!shouldLoad) return;
    load();
    return () => {
      ++requestRef.current;
      requestController.current?.abort();
    };
  }, [load, shouldLoad]);

  const markAllRead = () => {
    const now = Date.now();
    try {
      personalStorage.setItem(READ_KEY, String(now));
    } catch {}
    setReadAt(now);
  };

  // 打开弹窗 1.5s 后自动记为已读（用户已看到红字提醒的列表）
  useEffect(() => {
    if (!open || unreadImportant === 0) return;
    const timer = setTimeout(markAllRead, 1500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, unreadImportant === 0]);

  return (
    <>
      {variant === 'nav' ? (
        <HeaderToolButton
          label="公司窗口"
          aria-label="打开公司窗口"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={openWindow}
        >
          <svg aria-hidden="true" focusable="false" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M3 9h18M8 13h8M8 16h6" />
          </svg>
        </HeaderToolButton>
      ) : (
      <button
        type="button"
        onClick={openWindow}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={
          unreadImportant > 0
              ? `打开公司窗口，${unreadImportant}条重要公告`
              : `打开公司窗口${entries ? `，${entries.length}条动态` : ''}`
        }
        className="inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-md border border-brand-100 bg-brand-50 px-2.5 text-[13px] font-medium text-brand-700 transition-colors hover:bg-brand-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 [@media(pointer:coarse)]:min-h-10"
        title="查看自选公司公告与重大事项"
      >
        <span>公司窗口</span>
        {unreadImportant > 0 ? (
            <span className="text-xs font-medium tabular-nums text-red-600">
              {unreadImportant} 条重要公告
            </span>
          ) : (
            <span className="text-xs font-normal tabular-nums text-slate-500">
              {entries ? entries.length : '—'} 条动态
            </span>
          )}
      </button>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="公司窗口"
        size="lg"
        maximizable
        maximized={maximized}
        onMaximizedChange={setMaximized}
      >
        <div className="space-y-3">
          {unreadImportant > 0 && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
              有 {unreadImportant} 条未读重要公告，红字标出，请留意。
            </p>
          )}
          {error ? (
            <div className="space-y-3 py-10 text-center">
              <p className="text-sm text-red-600">{error}</p>
              <button type="button" className="btn" onClick={load}>
                重试
              </button>
            </div>
          ) : entries === null ? (
            <p className="py-10 text-center text-sm text-slate-400">
              正在加载公司动态…
            </p>
          ) : entries.length === 0 ? (
            <p className="py-10 text-center text-sm text-slate-400">
              暂无公告动态（港股公司暂不支持公告抓取）
            </p>
          ) : (
            <ol className="relative space-y-4 before:absolute before:bottom-2 before:left-[19px] before:top-2 before:w-px before:bg-slate-200">
              {entries.map((e) => {
                const unreadImportantOne =
                  e.important &&
                  new Date(`${e.date}T23:59:59+08:00`).getTime() > readAt;
                return (
                  <li key={e.artCode} className="relative flex gap-3">
                    <div
                      className={`z-10 grid h-10 w-10 shrink-0 place-items-center rounded-full text-base font-semibold ${avatarColor(e.code)}`}
                      aria-hidden="true"
                    >
                      {avatarChar(e.name)}
                    </div>
                    <div className="min-w-0 flex-1 rounded-xl border border-slate-100 bg-slate-50/70 p-3">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <a
                          href={`/stock/${e.symbol}`}
                          className="text-sm font-medium text-slate-800 hover:text-brand-700"
                        >
                          {e.name}
                        </a>
                        <span className="text-[11px] text-slate-400">
                          {fmtDate(e.date)}
                        </span>
                        {e.important && (
                          <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-600">
                            重要
                          </span>
                        )}
                        {e.columns[0] && (
                          <span className="text-[11px] text-slate-400">
                            {e.columns[0]}
                          </span>
                        )}
                      </div>
                      <p
                        className={`mt-1 break-words text-sm leading-6 ${
                          unreadImportantOne
                            ? 'font-medium text-red-600'
                            : 'text-slate-700'
                        }`}
                      >
                        {e.title}
                      </p>
                      {expanded === e.artCode ? (
                        <ArticleBody artCode={e.artCode} />
                      ) : (
                        <button
                          type="button"
                          className="mt-1 text-xs text-brand-600 hover:text-brand-700"
                          onClick={() => setExpanded(e.artCode)}
                        >
                          展开详情
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </Modal>
    </>
  );
}

/** 展开时懒加载公告正文 */
function ArticleBody({ artCode }: { artCode: string }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch(`/api/announcement-content?artCode=${encodeURIComponent(artCode)}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (j?.ok) setText(String(j.data ?? ''));
        else setFailed(true);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [artCode]);
  if (failed)
    return <p className="mt-1 text-xs text-slate-400">正文加载失败</p>;
  if (text === null)
    return <p className="mt-1 text-xs text-slate-400">正文加载中…</p>;
  return (
    <div className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg bg-white p-3 text-[13px] leading-6 text-slate-600">
      {text || '（无正文内容，可查看公告 PDF）'}
    </div>
  );
}
