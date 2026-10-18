import { personalStorage } from './personalStorage';
/**
 * 全局搜索历史（localStorage）。
 *
 * 存放最近搜索过的标的，供搜索框在聚焦时直接展示。
 * 只存代码/名称/类型，最多 8 条，按最近访问倒序，同代码去重。
 */

export interface HistoryItem {
  code: string;
  name: string;
  kind: string;
  market: string;
  board: string;
}

const KEY = 'ft.searchHistory.v1';
export const MAX_HISTORY = 8;

function safeParse(raw: string | null): HistoryItem[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is HistoryItem => !!x && typeof x.code === 'string' && typeof x.name === 'string')
      .slice(0, MAX_HISTORY);
  } catch {
    return [];
  }
}

export function readHistory(): HistoryItem[] {
  if (typeof window === 'undefined') return [];
  try {
    return safeParse(personalStorage.getItem(KEY));
  } catch {
    return [];
  }
}

function write(list: HistoryItem[]): void {
  try {
    personalStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_HISTORY)));
  } catch {
    /* 隐私模式/配额满时静默失败，不影响搜索 */
  }
}

/** 记录一次搜索（同代码上移去重） */
export function pushHistory(item: HistoryItem): HistoryItem[] {
  const list = readHistory().filter((x) => x.code !== item.code);
  const next = [item, ...list].slice(0, MAX_HISTORY);
  write(next);
  return next;
}

export function removeHistory(code: string): HistoryItem[] {
  const next = readHistory().filter((x) => x.code !== code);
  write(next);
  return next;
}

export function clearHistory(): void {
  try {
    personalStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

