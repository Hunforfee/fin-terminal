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
  watchCodes,
  groupsFor,
  type WatchAction,
  type WatchState,
} from '@/lib/watchlist';

interface WatchlistCtx extends WatchState {
  codes: string[];
  ready: boolean;
  has: (code: string) => boolean;
  groupOf: (code: string) => string;
  groupsOf: (code: string) => string[];
  codesIn: (groupId: string) => string[];
  setGroups: (
    code: string,
    groupIds: string[],
    newGroupName?: string,
  ) => boolean;
  reorderGroup: (id: string, targetId: string) => void;
  reorderStock: (code: string, targetCode: string, groupId: string) => void;
  add: (code: string, groupId?: string) => void;
  importMany: (
    codes: string[],
    groupId: string,
    newGroupName?: string,
  ) => {
    added: number;
    skipped: number;
    groupId: string;
  } | null;
  remove: (code: string, groupId?: string) => void;
  removeMany: (codes: string[], groupId?: string) => void;
  move: (codes: string[], groupId: string, fromGroupId?: string) => void;
  copy: (codes: string[], groupId: string) => void;
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
        JSON.stringify(watchCodes(next)),
      );
    } catch {}
  }, []);
  const value = useMemo<WatchlistCtx>(
    () => ({
      ...state,
      ready,
      codes: watchCodes(state),
      has: (code) =>
        state.items.some((item) => item.symbol === watchSymbol(code)),
      groupOf: (code) =>
        state.items.find((item) => item.symbol === watchSymbol(code))
          ?.groupId ?? UNGROUPED,
      groupsOf: (code) => groupsFor(state, code),
      codesIn: (groupId) => watchCodes(state, groupId),
      setGroups: (code, groupIds, newGroupName) => {
        if (
          !booted.current ||
          (newGroupName !== undefined &&
            groupNameError(newGroupName, current.current.groups))
        )
          return false;
        const newGroup =
          newGroupName !== undefined
            ? { id: crypto.randomUUID(), name: newGroupName }
            : undefined;
        const action: WatchAction = {
          type: 'setGroups',
          code,
          groupIds: [...groupIds, ...(newGroup ? [newGroup.id] : [])],
          newGroup,
        };
        if (changeWatchlist(current.current, action) === current.current)
          return false;
        dispatch(action);
        return true;
      },
      reorderGroup: (id, targetId) =>
        dispatch({ type: 'reorderGroups', id, targetId }),
      reorderStock: (code, targetCode, groupId) =>
        dispatch({ type: 'reorderStocks', code, targetCode, groupId }),
      add: (code, groupId = UNGROUPED) =>
        dispatch({ type: 'add', code, groupId }),
      importMany: (codes, groupId, newGroupName) => {
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
          moveExisting: false,
          ...(newGroupName !== undefined
            ? { newGroup: { id: target, name: newGroupName } }
            : {}),
        };
        const after = changeWatchlist(before, action);
        if (after === before) return null;
        const old = new Set(watchCodes(before, target));
        const added = watchCodes(after, target).filter(
          (symbol) => !old.has(symbol),
        ).length;
        const total = new Set(codes.map(watchSymbol).filter(Boolean)).size;
        dispatch(action);
        return {
          added,
          skipped: total - added,
          groupId: target,
        };
      },
      remove: (code, groupId) =>
        dispatch({ type: 'remove', codes: [code], groupId }),
      removeMany: (codes, groupId) =>
        dispatch({ type: 'remove', codes, groupId }),
      move: (codes, groupId, fromGroupId) =>
        dispatch({ type: 'move', codes, groupId, fromGroupId }),
      copy: (codes, groupId) =>
        dispatch({ type: 'move', codes, groupId, copy: true }),
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
