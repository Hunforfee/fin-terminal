import { normalizeCode } from './datasource/codes';

export const WATCHLIST_KEY = 'fin-terminal.watchlist.v2';
export const LEGACY_WATCHLIST_KEY = 'fin-terminal.watchlist.v1';
export const UNGROUPED = 'ungrouped';
export interface WatchGroup {
  id: string;
  name: string;
}
export interface WatchItem {
  symbol: string;
  groupId: string;
}
export interface WatchState {
  version: 2;
  groups: WatchGroup[];
  // Membership pairs are ordered independently within each group.
  items: WatchItem[];
  order?: string[];
}
export const watchSymbol = (code: string) =>
  normalizeCode(code)?.symbol ?? null;
export function emptyWatchlist(): WatchState {
  return { version: 2, groups: [{ id: UNGROUPED, name: '未分组' }], items: [] };
}
export function migrateWatchlist(codes: unknown): WatchState {
  const state = emptyWatchlist();
  for (const code of Array.isArray(codes) ? codes : []) {
    const symbol = typeof code === 'string' ? watchSymbol(code) : null;
    if (symbol && !state.items.some((item) => item.symbol === symbol))
      state.items.push({ symbol, groupId: UNGROUPED });
  }
  return state;
}
export function groupNameError(
  name: string,
  groups: WatchGroup[],
  exceptId?: string,
): string | null {
  const clean = name.trim();
  if (!clean) return '请输入分组名称';
  if (clean.length > 20) return '分组名称最多 20 个字';
  if (
    ['全部自选', '全部公司', '未分组'].includes(clean) ||
    groups.some(
      (g) => g.id !== exceptId && g.name.toLowerCase() === clean.toLowerCase(),
    )
  )
    return '分组名称已存在';
  return null;
}
export function watchCodes(state: WatchState, groupId = 'all'): string[] {
  const members = [
    ...new Set(
      state.items
        .filter((item) => groupId === 'all' || item.groupId === groupId)
        .map((item) => item.symbol),
    ),
  ];
  if (groupId !== 'all') return members;
  return [
    ...new Set([
      ...(state.order ?? []).filter((symbol) => members.includes(symbol)),
      ...members,
    ]),
  ];
}
export function groupsFor(state: WatchState, code: string): string[] {
  const symbol = watchSymbol(code);
  return state.groups
    .filter((g) =>
      state.items.some((i) => i.symbol === symbol && i.groupId === g.id),
    )
    .map((g) => g.id);
}
function normalizeItems(items: WatchItem[]): WatchItem[] {
  const named = new Set(
    items.filter((i) => i.groupId !== UNGROUPED).map((i) => i.symbol),
  );
  const seen = new Set<string>();
  return items.filter((i) => {
    if (i.groupId === UNGROUPED && named.has(i.symbol)) return false;
    const key = `${i.symbol}:${i.groupId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
export function readWatchlist(raw: unknown): WatchState | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<WatchState>;
  if (
    value.version !== 2 ||
    !Array.isArray(value.groups) ||
    !Array.isArray(value.items)
  )
    return null;
  const state = emptyWatchlist();
  state.groups = [];
  for (const group of value.groups) {
    if (
      !group ||
      typeof group.id !== 'string' ||
      !group.id ||
      typeof group.name !== 'string' ||
      state.groups.some((g) => g.id === group.id)
    )
      continue;
    if (group.id === UNGROUPED)
      state.groups.push({ id: UNGROUPED, name: '未分组' });
    else if (group.id !== 'all' && !groupNameError(group.name, state.groups))
      state.groups.push({ id: group.id, name: group.name.trim() });
  }
  if (!state.groups.some((g) => g.id === UNGROUPED))
    state.groups.unshift({ id: UNGROUPED, name: '未分组' });
  for (const item of value.items) {
    const symbol =
      item && typeof item.symbol === 'string' ? watchSymbol(item.symbol) : null;
    if (symbol)
      state.items.push({
        symbol,
        groupId: state.groups.some((g) => g.id === item.groupId)
          ? item.groupId
          : UNGROUPED,
      });
  }
  state.items = normalizeItems(state.items);
  if (Array.isArray(value.order)) {
    state.order = [
      ...new Set(
        value.order
          .filter((s): s is string => typeof s === 'string')
          .map(watchSymbol)
          .filter((s): s is string => !!s),
      ),
    ];
    state.order = watchCodes(state);
  }
  return state;
}
export type WatchAction =
  | {
      type: 'import';
      codes: string[];
      groupId: string;
      moveExisting: boolean;
      newGroup?: WatchGroup;
    }
  | { type: 'add'; code: string; groupId: string }
  | {
      type: 'setGroups';
      code: string;
      groupIds: string[];
      newGroup?: WatchGroup;
    }
  | { type: 'remove'; codes: string[]; groupId?: string }
  | {
      type: 'move';
      codes: string[];
      groupId: string;
      fromGroupId?: string;
      copy?: boolean;
    }
  | { type: 'reorderGroups'; id: string; targetId: string }
  | { type: 'reorderStocks'; code: string; targetCode: string; groupId: string }
  | { type: 'createGroup'; id: string; name: string }
  | { type: 'renameGroup'; id: string; name: string }
  | { type: 'deleteGroup'; id: string }
  | { type: 'clear' };
function moveTo<T>(list: T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from === to) return list;
  const next = [...list];
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next;
}
export function changeWatchlist(
  state: WatchState,
  action: WatchAction,
): WatchState {
  const original = state;
  const finish = (items: WatchItem[], groups = state.groups): WatchState => {
    const next = { ...state, groups, items: normalizeItems(items) };
    next.order = watchCodes({ ...next, order: watchCodes(state) });
    return next;
  };
  if (action.type === 'clear') return { ...state, items: [], order: [] };
  if (action.type === 'reorderGroups') {
    const groups = moveTo(
      state.groups,
      state.groups.findIndex((g) => g.id === action.id),
      state.groups.findIndex((g) => g.id === action.targetId),
    );
    return groups === state.groups ? state : { ...state, groups };
  }
  if (action.type === 'reorderStocks') {
    const codes = watchCodes(state, action.groupId);
    const reordered = moveTo(
      codes,
      codes.indexOf(watchSymbol(action.code) ?? ''),
      codes.indexOf(watchSymbol(action.targetCode) ?? ''),
    );
    if (reordered === codes) return state;
    if (action.groupId === 'all') return { ...state, order: reordered };
    let n = 0;
    return {
      ...state,
      order: watchCodes(state),
      items: state.items.map((item) =>
        item.groupId === action.groupId
          ? { ...item, symbol: reordered[n++] }
          : item,
      ),
    };
  }
  if (action.type === 'createGroup' || action.type === 'renameGroup') {
    if (
      !action.id ||
      action.id === UNGROUPED ||
      action.id === 'all' ||
      groupNameError(
        action.name,
        state.groups,
        action.type === 'renameGroup' ? action.id : undefined,
      )
    )
      return state;
    if (action.type === 'createGroup')
      return state.groups.some((g) => g.id === action.id)
        ? state
        : {
            ...state,
            groups: [
              ...state.groups,
              { id: action.id, name: action.name.trim() },
            ],
          };
    return {
      ...state,
      groups: state.groups.map((g) =>
        g.id === action.id ? { ...g, name: action.name.trim() } : g,
      ),
    };
  }
  if (action.type === 'deleteGroup') {
    if (
      action.id === UNGROUPED ||
      !state.groups.some((g) => g.id === action.id)
    )
      return state;
    return finish(
      state.items.map((item) =>
        item.groupId === action.id ? { ...item, groupId: UNGROUPED } : item,
      ),
      state.groups.filter((g) => g.id !== action.id),
    );
  }
  if (action.type === 'import' || action.type === 'setGroups') {
    const group = action.newGroup;
    if (
      group &&
      (!group.id ||
        group.id === 'all' ||
        group.id === UNGROUPED ||
        state.groups.some((g) => g.id === group.id) ||
        groupNameError(group.name, state.groups))
    )
      return state;
    if (action.type === 'import' && group && group.id !== action.groupId)
      return state;
    if (group)
      state = {
        ...state,
        groups: [...state.groups, { ...group, name: group.name.trim() }],
      };
  }
  if (action.type === 'setGroups') {
    const symbol = watchSymbol(action.code);
    if (
      !symbol ||
      action.groupIds.some((id) => !state.groups.some((g) => g.id === id))
    )
      return original;
    const ids = [...new Set(action.groupIds.filter((id) => id !== UNGROUPED))];
    if (!ids.length) ids.push(UNGROUPED);
    const next = state.items.filter(
      (item) => item.symbol !== symbol || ids.includes(item.groupId),
    );
    for (const groupId of ids)
      if (
        !next.some((item) => item.symbol === symbol && item.groupId === groupId)
      )
        next.push({ symbol, groupId });
    return finish(next);
  }
  if (action.type === 'remove') {
    const selected = new Set(action.codes.map(watchSymbol));
    const items = state.items.filter(
      (item) =>
        !selected.has(item.symbol) ||
        (action.groupId &&
          action.groupId !== 'all' &&
          item.groupId !== action.groupId),
    );
    if (
      action.groupId &&
      action.groupId !== 'all' &&
      action.groupId !== UNGROUPED
    ) {
      for (const symbol of watchCodes(state))
        if (
          selected.has(symbol) &&
          !items.some((item) => item.symbol === symbol)
        )
          items.push({ symbol, groupId: UNGROUPED });
    }
    return finish(items);
  }
  if (!state.groups.some((g) => g.id === action.groupId)) return original;
  const symbols =
    action.type === 'add'
      ? [watchSymbol(action.code)].filter((s): s is string => !!s)
      : [
          ...new Set(
            action.codes.map(watchSymbol).filter((s): s is string => !!s),
          ),
        ];
  if (!symbols.length) return original;
  if (action.type === 'move' && action.fromGroupId === action.groupId)
    return original;
  const selected = new Set(symbols);
  let items = [...state.items];
  if (action.type === 'move' && !action.copy)
    items = items.filter(
      (item) =>
        !selected.has(item.symbol) ||
        (action.fromGroupId &&
          action.fromGroupId !== 'all' &&
          item.groupId !== action.fromGroupId),
    );
  // Ungrouped is exclusive; adding to a named group preserves other memberships.
  if (action.groupId === UNGROUPED && action.type === 'move' && !action.copy)
    items = items.filter((item) => !selected.has(item.symbol));
  for (const symbol of symbols) {
    if (
      action.groupId === UNGROUPED &&
      items.some((item) => item.symbol === symbol && item.groupId !== UNGROUPED)
    )
      continue;
    if (
      !items.some(
        (item) => item.symbol === symbol && item.groupId === action.groupId,
      )
    )
      items.push({ symbol, groupId: action.groupId });
  }
  return finish(items);
}
