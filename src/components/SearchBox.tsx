'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { SearchHit } from '@/lib/datasource/types';
import { searchResultPath as pathOf } from '@/lib/searchRouting';
import { normalizeCode } from '@/lib/datasource/codes';
import { pushHistory, readHistory, removeHistory, clearHistory, type HistoryItem } from '@/lib/searchHistory';

const KIND_LABEL: Record<string, string> = {
  stock: '股票',
  index: '指数',
  fund: '基金',
  etf: 'ETF',
  bond: '债券',
  unknown: '其他',
};

/**
 * 全局搜索框：输入即联想，支持代码 / 中文名 / 拼音首字母。
 * 聚焦且未输入时展示**本地搜索历史**（最近 8 条，localStorage 持久化），点选直接填入并跳转；
 * 键盘 ↑↓ 选择、Enter 跳转、Esc 关闭。
 */
export default function SearchBox({ placeholder = '搜索股票 / 指数 / 基金，如 600519、茅台、gzmt' }: { placeholder?: string }) {
  const router = useRouter();
  const [kw, setKw] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const seqRef = useRef(0);
  const submittingRef = useRef(false);

  // 挂载后读取历史（避免 SSR 与首帧不一致）
  useEffect(() => {
    setHistory(readHistory());
  }, []);

  // 输入防抖
  useEffect(() => {
    const q = kw.trim();
    const mySeq = ++seqRef.current;
    if (!q) {
      setHits([]);
      setLoading(false);
      return;
    }
    setHits([]);
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const json = await res.json();
        if (mySeq !== seqRef.current) return; // 丢弃过期响应
        const list: SearchHit[] = json.ok ? json.data : [];
        setHits(list);
        setActive(0);
        setOpen(list.length > 0 && document.activeElement === inputRef.current);
      } catch {
        if (mySeq === seqRef.current) setHits([]);
      } finally {
        if (mySeq === seqRef.current) setLoading(false);
      }
    }, 220);
    return () => clearTimeout(timer);
  }, [kw]);

  // 输入被清空时：若仍聚焦，退回展示历史
  useEffect(() => {
    if (kw.trim() !== '') return;
    if (document.activeElement === inputRef.current) {
      setHistory(readHistory());
      setOpen(readHistory().length > 0);
      setActive(0);
    }
  }, [kw]);

  // 点击外部关闭
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const go = (hit: { kind: string; code: string; name: string; market?: string; board?: string }) => {
    ++seqRef.current;
    pushHistory({ code: hit.code, name: hit.name, kind: hit.kind, market: hit.market ?? '', board: hit.board ?? '' });
    setHistory(readHistory());
    setOpen(false);
    setKw('');
    router.push(pathOf(hit));
  };

  const onFocus = () => {
    if (kw.trim() === '') {
      const h = readHistory();
      setHistory(h);
      setOpen(h.length > 0);
      setActive(0);
    } else if (hits.length > 0) {
      setOpen(true);
    }
  };

  const onRemoveHistory = useCallback((e: React.MouseEvent, code: string) => {
    e.preventDefault();
    e.stopPropagation();
    setHistory(removeHistory(code));
  }, []);

  const onClearHistory = useCallback(() => {
    clearHistory();
    setHistory([]);
    setOpen(false);
    inputRef.current?.focus();
  }, []);

  const showingHistory = open && kw.trim() === '' && history.length > 0;
  const showingHits = open && hits.length > 0;

  const onKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const list: { kind: string; code: string; name: string; market?: string; board?: string }[] = showingHistory
      ? history
      : showingHits
        ? hits
        : [];
    if (list.length === 0) {
      if (e.key === 'Enter' && kw.trim()) {
        e.preventDefault();
        if (submittingRef.current) return;
        submittingRef.current = true;
        const query = kw.trim();
        setLoading(true);
        try {
          const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
          const json = await res.json();
          if (inputRef.current?.value.trim() !== query) return;
          if (json.ok && json.data?.length) go(json.data[0]);
          else {
            const n = normalizeCode(query);
            if (n) router.push(pathOf(n));
          }
        } catch {
          const n = normalizeCode(query);
          if (inputRef.current?.value.trim() === query && n) router.push(pathOf(n));
        } finally { submittingRef.current = false; setLoading(false); }
      }
      if (e.key === 'Escape') setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % list.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i - 1 + list.length) % list.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = list[Math.min(active, list.length - 1)];
      if (showingHistory) {
        // 历史项：回填输入框并跳转
        setKw(item.name);
        go(item);
      } else {
        go(item);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  return (
    <div ref={boxRef} className="relative w-full">
      <div className="relative">
        <input
          ref={inputRef}
          value={kw}
          onChange={(e) => { ++seqRef.current; setHits([]); setKw(e.target.value); }}
          onFocus={onFocus}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className="input pr-20"
          aria-label="搜索标的"
          autoComplete="off"
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">
          {loading ? '搜索中…' : '⌕'}
        </span>
      </div>

      {/* 搜索历史：聚焦空输入框时直接展示，方便一键填入 */}
      {showingHistory && (
        <div className="absolute z-50 mt-1 w-full overflow-hidden rounded-md border border-slate-200 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-slate-100 px-3 py-1.5">
            <span className="text-[11px] font-medium text-slate-400">最近搜索</span>
            <button
              onClick={onClearHistory}
              className="text-[11px] text-slate-400 transition hover:text-red-500"
            >
              清空
            </button>
          </div>
          <ul className="max-h-72 overflow-auto py-0.5">
            {history.map((h, i) => (
              <li key={`${h.market}${h.code}`}>
                <div
                  className={`group flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition ${
                    i === active ? 'bg-brand-50' : 'hover:bg-slate-50'
                  }`}
                >
                  <button
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(h)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <span className="w-16 shrink-0 font-mono text-xs text-slate-500">{h.code}</span>
                    <span className="flex-1 truncate text-slate-800">{h.name}</span>
                    <span className="chip bg-slate-100 text-slate-500">{KIND_LABEL[h.kind] ?? '其他'}</span>
                  </button>
                  <button
                    onClick={(e) => onRemoveHistory(e, h.code)}
                    aria-label={`删除 ${h.name}`}
                    className="shrink-0 rounded px-1 text-xs text-slate-300 transition hover:bg-slate-100 hover:text-slate-600"
                  >
                    ✕
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {showingHits && (
        <ul className="absolute z-50 mt-1 max-h-80 w-full overflow-auto rounded-md border border-slate-200 bg-white shadow-lg">
          {hits.map((h, i) => (
            <li key={`${h.market}${h.code}`}>
              <button
                onMouseEnter={() => setActive(i)}
                onClick={() => go(h)}
                className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition ${
                  i === active ? 'bg-brand-50' : 'hover:bg-slate-50'
                }`}
              >
                <span className="w-16 shrink-0 font-mono text-xs text-slate-500">{h.code}</span>
                <span className="flex-1 truncate text-slate-800">{h.name}</span>
                <span className="chip bg-slate-100 text-slate-500">{KIND_LABEL[h.kind] ?? '其他'}</span>
                {h.board && <span className="hidden text-xs text-slate-400 sm:inline">{h.board}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

