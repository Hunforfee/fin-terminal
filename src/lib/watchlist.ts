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
  items: WatchItem[];
}
export const watchSymbol = (code: string) =>
  normalizeCode(code)?.symbol ?? null;
export function emptyWatchlist(): WatchState {
  return { version: 2, groups: [{ id: UNGROUPED, name: '未分组' }], items: [] };
}
export function migrateWatchlist(codes: unknown): WatchState {
  const state = emptyWatchlist();
  const seen = new Set<string>();
  for (const code of Array.isArray(codes) ? codes : []) {
    const symbol = typeof code === 'string' ? watchSymbol(code) : null;
    if (symbol && !seen.has(symbol)) {
      seen.add(symbol);
      state.items.push({ symbol, groupId: UNGROUPED });
    }
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
  for (const group of value.groups) {
    if (
      group &&
      typeof group.id === 'string' &&
      group.id &&
      typeof group.name === 'string' &&
      !state.groups.some((g) => g.id === group.id) &&
      !groupNameError(group.name, state.groups)
    )
      state.groups.push({ id: group.id, name: group.name.trim() });
  }
  const seen = new Set<string>();
  for (const item of value.items) {
    const symbol =
      item && typeof item.symbol === 'string' ? watchSymbol(item.symbol) : null;
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    state.items.push({
      symbol,
      groupId: state.groups.some((g) => g.id === item.groupId)
        ? item.groupId
        : UNGROUPED,
    });
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
  | { type: 'remove'; codes: string[] }
  | { type: 'move'; codes: string[]; groupId: string }
  | { type: 'createGroup'; id: string; name: string }
  | { type: 'renameGroup'; id: string; name: string }
  | { type: 'deleteGroup'; id: string }
  | { type: 'clear' };
export function changeWatchlist(
  state: WatchState,
  action: WatchAction,
): WatchState {
  if (action.type === 'import') {
    const group = action.newGroup;
    if (
      group &&
      (!group.id ||
        group.id !== action.groupId ||
        state.groups.some((g) => g.id === group.id) ||
        groupNameError(group.name, state.groups))
    )
      return state;
    if (!group && !state.groups.some((g) => g.id === action.groupId))
      return state;
    const symbols = [
      ...new Set(action.codes.map(watchSymbol).filter((s): s is string => !!s)),
    ];
    if (!symbols.length) return state;
    const selected = new Set(symbols),
      existing = new Set(state.items.map((item) => item.symbol));
    const items = state.items.map((item) =>
      action.moveExisting && selected.has(item.symbol)
        ? { ...item, groupId: action.groupId }
        : item,
    );
    for (const symbol of symbols)
      if (!existing.has(symbol))
        items.push({ symbol, groupId: action.groupId });
    return {
      ...state,
      groups: group
        ? [...state.groups, { ...group, name: group.name.trim() }]
        : state.groups,
      items,
    };
  }
  if (action.type === 'clear') return { ...state, items: [] };
  if (action.type === 'add') {
    const symbol = watchSymbol(action.code);
    if (!symbol || !state.groups.some((g) => g.id === action.groupId))
      return state;
    const found = state.items.some((item) => item.symbol === symbol);
    return {
      ...state,
      items: found
        ? state.items.map((item) =>
            item.symbol === symbol
              ? { ...item, groupId: action.groupId }
              : item,
          )
        : [...state.items, { symbol, groupId: action.groupId }],
    };
  }
  if (action.type === 'move' || action.type === 'remove') {
    if (
      action.type === 'move' &&
      !state.groups.some((g) => g.id === action.groupId)
    )
      return state;
    const selected = new Set(action.codes.map(watchSymbol));
    return {
      ...state,
      items:
        action.type === 'remove'
          ? state.items.filter((item) => !selected.has(item.symbol))
          : state.items.map((item) =>
              selected.has(item.symbol)
                ? { ...item, groupId: action.groupId }
                : item,
            ),
    };
  }
  if (action.type === 'createGroup') {
    if (
      !action.id ||
      state.groups.some((g) => g.id === action.id) ||
      groupNameError(action.name, state.groups)
    )
      return state;
    return {
      ...state,
      groups: [...state.groups, { id: action.id, name: action.name.trim() }],
    };
  }
  if (action.id === UNGROUPED) return state;
  if (action.type === 'renameGroup') {
    if (groupNameError(action.name, state.groups, action.id)) return state;
    return {
      ...state,
      groups: state.groups.map((g) =>
        g.id === action.id ? { ...g, name: action.name.trim() } : g,
      ),
    };
  }
  return {
    ...state,
    groups: state.groups.filter((g) => g.id !== action.id),
    items: state.items.map((item) =>
      item.groupId === action.id ? { ...item, groupId: UNGROUPED } : item,
    ),
  };
}
