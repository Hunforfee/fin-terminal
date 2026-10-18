'use client';

import {
  personalStorage,
  getStorageAccount,
  storageKey,
} from '@/lib/personalStorage';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { DEFAULT_WATCHLIST } from '@/lib/universe';
import {
  WATCHLIST_KEY,
  LEGACY_WATCHLIST_KEY,
  UNGROUPED,
  changeWatchlist,
  emptyWatchlist,
  groupNameError,
  migrateWatchlist,
  readWatchlist,
  watchSymbol,
  type WatchAction,
  type WatchState,
} from '@/lib/watchlist';

interface WatchlistCtx extends WatchState {
  codes: string[];
  ready: boolean;
  has: (code: string) => boolean;
  groupOf: (code: string) => string;
  add: (code: string, groupId?: string) => void;
  importMany: (
    codes: string[],
    groupId: string,
    moveExisting: boolean,
    newGroupName?: string,
  ) => {
    added: number;
    moved: number;
    skipped: number;
    groupId: string;
  } | null;
  remove: (code: string) => void;
  removeMany: (codes: string[]) => void;
  move: (codes: string[], groupId: string) => void;
  createGroup: (name: string) => string | null;
  renameGroup: (id: string, name: string) => boolean;
  deleteGroup: (id: string) => void;
  clear: () => void;
}
const Ctx = createContext<WatchlistCtx | null>(null);
export function WatchlistProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<WatchState>(emptyWatchlist);
  const current = useRef(state);
  const [ready, setReady] = useState(false);
  const booted = useRef(false);
  useEffect(() => {
    let next: WatchState | null = null;
    try {
      next = readWatchlist(
        JSON.parse(personalStorage.getItem(WATCHLIST_KEY) ?? 'null'),
      );
    } catch {}
    if (!next) {
      let old: unknown = getStorageAccount() ? [] : DEFAULT_WATCHLIST;
      try {
        const raw = personalStorage.getItem(LEGACY_WATCHLIST_KEY);
        if (raw !== null) old = JSON.parse(raw);
      } catch {}
      next = migrateWatchlist(old);
      try {
        personalStorage.setItem(WATCHLIST_KEY, JSON.stringify(next));
      } catch {}
    }
    current.current = next;
    setState(next);
    booted.current = true;
    setReady(true);
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea && event.storageArea !== localStorage) return;
      if (event.key !== storageKey(WATCHLIST_KEY) && event.key !== null) return;
      try {
        const incoming = event.newValue
          ? readWatchlist(JSON.parse(event.newValue))
          : emptyWatchlist();
        if (incoming) {
          current.current = incoming;
          setState(incoming);
        }
      } catch {}
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  // The ref prevents consecutive actions (create group then add) from overwriting
  // each other before React renders. Persist outside React state updaters.
  const dispatch = useCallback((action: WatchAction) => {
    if (!booted.current) return;
    const next = changeWatchlist(current.current, action);
    current.current = next;
    setState(next);
    try {
      personalStorage.setItem(WATCHLIST_KEY, JSON.stringify(next));
      personalStorage.setItem(
        LEGACY_WATCHLIST_KEY,
        JSON.stringify(next.items.map((item) => item.symbol)),
      );
    } catch {}
  }, []);
  const value = useMemo<WatchlistCtx>(
    () => ({
      ...state,
      ready,
      codes: state.items.map((item) => item.symbol),
      has: (code) =>
        state.items.some((item) => item.symbol === watchSymbol(code)),
      groupOf: (code) =>
        state.items.find((item) => item.symbol === watchSymbol(code))
          ?.groupId ?? UNGROUPED,
      add: (code, groupId = UNGROUPED) =>
        dispatch({ type: 'add', code, groupId }),
      importMany: (codes, groupId, moveExisting, newGroupName) => {
        if (!booted.current) return null;
        const before = current.current;
        if (
          newGroupName !== undefined &&
          groupNameError(newGroupName, before.groups)
        )
          return null;
        const target =
          newGroupName !== undefined ? crypto.randomUUID() : groupId;
        const action: WatchAction = {
          type: 'import',
          codes,
          groupId: target,
          moveExisting,
          ...(newGroupName !== undefined
            ? { newGroup: { id: target, name: newGroupName } }
            : {}),
        };
        const after = changeWatchlist(before, action);
        if (after === before) return null;
        const old = new Map(
          before.items.map((item) => [item.symbol, item.groupId]),
        );
        const added = after.items.length - before.items.length;
        const moved = after.items.filter(
          (item) =>
            old.has(item.symbol) && old.get(item.symbol) !== item.groupId,
        ).length;
        const total = new Set(codes.map(watchSymbol).filter(Boolean)).size;
        dispatch(action);
        return {
          added,
          moved,
          skipped: total - added - moved,
          groupId: target,
        };
      },
      remove: (code) => dispatch({ type: 'remove', codes: [code] }),
      removeMany: (codes) => dispatch({ type: 'remove', codes }),
      move: (codes, groupId) => dispatch({ type: 'move', codes, groupId }),
      createGroup: (name) => {
        if (!booted.current || groupNameError(name, current.current.groups))
          return null;
        const id = crypto.randomUUID();
        dispatch({ type: 'createGroup', id, name });
        return id;
      },
      renameGroup: (id, name) => {
        if (
          id === UNGROUPED ||
          groupNameError(name, current.current.groups, id)
        )
          return false;
        dispatch({ type: 'renameGroup', id, name });
        return true;
      },
      deleteGroup: (id) => dispatch({ type: 'deleteGroup', id }),
      clear: () => dispatch({ type: 'clear' }),
    }),
    [state, ready, dispatch],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export function useWatchlist(): WatchlistCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useWatchlist 必须在 WatchlistProvider 内使用');
  return ctx;
}
