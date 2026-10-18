import {
  migrateWatchlist,
  readWatchlist,
  UNGROUPED,
  readWatchlist as normalizeWatchlist,
  type WatchState,
} from './watchlist';

export type PersonalSnapshot = Record<string, string>;
export const snapshotsEqual = (a: PersonalSnapshot, b: PersonalSnapshot) =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.keys(a).every((key) => a[key] === b[key]);
let account: string | null = null;
export const PERSONAL_CHANGE = 'fin:personal-change';
export const AUTH_CHANGE = 'fin.auth.changed';
export const setStorageAccount = (id: string | null) => {
  account = id;
};
export const getStorageAccount = () => account;
export function storageKey(key: string, id: string | null = account): string {
  return id ? `fin.account.${encodeURIComponent(id)}:${key}` : key;
}
export function isCloudKey(key: string): boolean {
  return (
    key === 'fin-terminal.watchlist.v2' ||
    key === 'fin.research.notes.v1' ||
    key === 'fin.research.table.v1' ||
    /^fin\.(?:financeModules|mergeTable|financeFormulas)(?:\.[\w-]+)*$/.test(
      key,
    ) ||
    key === 'fin.ai.prompt' ||
    /^fin\.ai\.history\.[\w.-]+$/.test(key)
  );
}
export const personalStorage = {
  getItem(key: string) {
    return typeof window === 'undefined'
      ? null
      : window.localStorage.getItem(storageKey(key));
  },
  setItem(key: string, value: string) {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(storageKey(key), value);
    if (isCloudKey(key)) window.dispatchEvent(new Event(PERSONAL_CHANGE));
  },
  removeItem(key: string) {
    if (typeof window === 'undefined') return;
    window.localStorage.removeItem(storageKey(key));
    if (isCloudKey(key)) window.dispatchEvent(new Event(PERSONAL_CHANGE));
  },
};
export function snapshotFor(id: string | null): PersonalSnapshot {
  const data: PersonalSnapshot = {};
  if (typeof window === 'undefined') return data;
  const prefix = id ? `fin.account.${encodeURIComponent(id)}:` : '';
  for (let i = 0; i < window.localStorage.length; i++) {
    const raw = window.localStorage.key(i);
    if (!raw || (prefix && !raw.startsWith(prefix))) continue;
    const key = prefix ? raw.slice(prefix.length) : raw;
    if (isCloudKey(key)) {
      const value = window.localStorage.getItem(raw);
      if (value !== null) data[key] = value;
    }
  }
  return data;
}
export function applySnapshot(id: string, data: PersonalSnapshot): void {
  const existing = snapshotFor(id);
  for (const key of Object.keys(existing))
    if (!(key in data)) window.localStorage.removeItem(storageKey(key, id));
  for (const [key, value] of Object.entries(data))
    if (isCloudKey(key))
      window.localStorage.setItem(storageKey(key, id), value);
}
export function mergeSnapshots(
  base: PersonalSnapshot,
  local: PersonalSnapshot,
  remote: PersonalSnapshot,
): { data: PersonalSnapshot; conflicts: string[] } {
  const data: PersonalSnapshot = {},
    conflicts: string[] = [];
  for (const key of new Set([
    ...Object.keys(base),
    ...Object.keys(local),
    ...Object.keys(remote),
  ])) {
    if (!isCloudKey(key)) continue;
    const changedHere = local[key] !== base[key],
      changedThere = remote[key] !== base[key];
    if (changedHere && changedThere && local[key] !== remote[key])
      conflicts.push(key);
    const value = changedHere ? local[key] : remote[key];
    if (value !== undefined) data[key] = value;
  }
  return { data, conflicts };
}
export function validateSnapshot(value: unknown): PersonalSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > 300) return null;
  let size = 0;
  for (const [key, content] of entries) {
    if (!isCloudKey(key) || typeof content !== 'string') return null;
    size += key.length + content.length;
    if (size > 500000) return null;
    if (
      key !== 'fin.ai.prompt' &&
      key !== 'fin.financeModules.active' &&
      !key.startsWith('fin.financeModules.active.') &&
      key !== 'fin.mergeTable.showAll'
    ) {
      try {
        const parsed = JSON.parse(content);
        if (key === 'fin-terminal.watchlist.v2' && !readWatchlist(parsed))
          return null;
      } catch {
        return null;
      }
    }
  }
  return Object.fromEntries(entries);
}
/** Explicit guest import merges holdings/notes; it never copies API keys. */
export function mergeGuestData(
  local: PersonalSnapshot,
  guest: PersonalSnapshot,
): PersonalSnapshot {
  const result = { ...local };
  for (const [key, value] of Object.entries(guest))
    if (isCloudKey(key) && !(key in result)) result[key] = value;
  const readWatch = (data: PersonalSnapshot): WatchState | null => {
    try {
      return readWatchlist(
        JSON.parse(data['fin-terminal.watchlist.v2'] ?? 'null'),
      );
    } catch {
      return null;
    }
  };
  const incoming = readWatch(guest),
    destination = readWatch(local) ?? migrateWatchlist([]);
  if (incoming) {
    const groups = [...destination.groups],
      mapping = new Map<string, string>([[UNGROUPED, UNGROUPED]]);
    for (const group of incoming.groups.filter((g) => g.id !== UNGROUPED)) {
      const sameName = groups.find(
        (g) => g.name.toLowerCase() === group.name.toLowerCase(),
      );
      const id = sameName?.id ?? `import-${crypto.randomUUID()}`;
      if (!sameName) groups.push({ id, name: group.name });
      mapping.set(group.id, id);
    }
    const seen = new Set(
      destination.items.map((item) => `${item.symbol}:${item.groupId}`),
    );
    const items = [...destination.items];
    for (const item of incoming.items) {
      const groupId = mapping.get(item.groupId) ?? UNGROUPED;
      const key = `${item.symbol}:${groupId}`;
      if (!seen.has(key)) {
        seen.add(key);
        items.push({
          ...item,
          groupId,
        });
      }
    }
    result['fin-terminal.watchlist.v2'] = JSON.stringify(
      normalizeWatchlist({
        version: 2,
        groups,
        items,
        order: [
          ...(destination.order ?? destination.items.map((i) => i.symbol)),
          ...(incoming.order ?? incoming.items.map((i) => i.symbol)),
        ],
      }),
    );
  }
  const notes = (raw: string | undefined): { id: string; text: string }[] => {
    try {
      const value = JSON.parse(raw ?? '[]');
      return Array.isArray(value)
        ? value.filter(
            (n) => n && typeof n.id === 'string' && typeof n.text === 'string',
          )
        : [];
    } catch {
      return [];
    }
  };
  const existing = notes(local['fin.research.notes.v1']),
    seen = new Set(existing.map((n) => n.id));
  const added = notes(guest['fin.research.notes.v1']).filter((n) => {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    return true;
  });
  if (existing.length || added.length)
    result['fin.research.notes.v1'] = JSON.stringify([...existing, ...added]);
  return result;
}
