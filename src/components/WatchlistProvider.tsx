'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { DEFAULT_WATCHLIST } from '@/lib/universe';

interface WatchlistCtx {
  codes: string[];
  has: (code: string) => boolean;
  toggle: (code: string) => void;
  add: (code: string) => void;
  remove: (code: string) => void;
  clear: () => void;
  ready: boolean;
}

const Ctx = createContext<WatchlistCtx | null>(null);
const KEY = 'fin-terminal.watchlist.v1';

/**
 * 自选列表：默认存 localStorage，零后端依赖、刷新与多标签页同步。
 * 若要改成服务端持久化，只需把 read/write 换成 /api/watchlist 调用，
 * 组件层完全不用动。
 */
export function WatchlistProvider({ children }: { children: React.ReactNode }) {
  const [codes, setCodes] = useState<string[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      setCodes(raw ? (JSON.parse(raw) as string[]) : DEFAULT_WATCHLIST);
    } catch {
      setCodes(DEFAULT_WATCHLIST);
    }
    setReady(true);
  }, []);

  // 多标签页同步
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== KEY) return;
      try {
        setCodes(e.newValue ? (JSON.parse(e.newValue) as string[]) : []);
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const write = useCallback((next: string[]) => {
    setCodes(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* 隐私模式下写入失败，仅保留内存态 */
    }
  }, []);

  const value = useMemo<WatchlistCtx>(
    () => ({
      codes,
      ready,
      has: (c) => codes.includes(c),
      add: (c) => (codes.includes(c) ? undefined : write([...codes, c])),
      remove: (c) => write(codes.filter((x) => x !== c)),
      toggle: (c) => write(codes.includes(c) ? codes.filter((x) => x !== c) : [...codes, c]),
      clear: () => write([]),
    }),
    [codes, ready, write],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWatchlist(): WatchlistCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useWatchlist 必须在 WatchlistProvider 内使用');
  return ctx;
}
