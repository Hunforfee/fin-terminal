'use client';

import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useRouter } from 'next/navigation';
import type { AccountUser } from '@/lib/auth/session';
import {
  applySnapshot,
  AUTH_CHANGE,
  isCloudKey,
  mergeGuestData,
  mergeSnapshots,
  PERSONAL_CHANGE,
  setStorageAccount,
  snapshotFor,
  snapshotsEqual,
  storageKey,
  validateSnapshot,
  type PersonalSnapshot,
} from '@/lib/personalStorage';
import { migrateWatchlist } from '@/lib/watchlist';

type SyncStatus = 'loading' | 'synced' | 'saving' | 'local' | 'conflict';
interface Remote {
  revision: number;
  data: PersonalSnapshot;
}
interface AccountContext {
  user: AccountUser | null;
  phoneLoginReady: boolean;
  status: SyncStatus;
  conflict: boolean;
  login: (phone: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  sync: () => Promise<void>;
  importGuest: () => void;
  resolveConflict: (choice: 'cloud' | 'local') => void;
}
const Ctx = createContext<AccountContext | null>(null);
const metaKey = (id: string) => 'fin.sync-meta:' + encodeURIComponent(id);
const checkRemote = (value: unknown): Remote | null => {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Remote,
    data = validateSnapshot(entry.data);
  return data && Number.isSafeInteger(entry.revision) && entry.revision >= 0
    ? { revision: entry.revision, data }
    : null;
};
export default function AccountProvider({
  initialUser,
  children,
}: {
  initialUser: AccountUser | null;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [user, setUser] = useState(initialUser);
  const userRef = useRef(user);
  userRef.current = user;
  const [phoneLoginReady, setPhoneLoginReady] = useState(false);
  const [hydrating, setHydrating] = useState(!!initialUser);
  const [status, setStatus] = useState<SyncStatus>(
    initialUser ? 'loading' : 'local',
  );
  const [conflict, setConflict] = useState<Remote | null>(null);
  const [cloudReady, setCloudReady] = useState(false);
  const [saveTick, setSaveTick] = useState(0);
  const [reload, setReload] = useState(0);
  const meta = useRef<Remote>({ revision: 0, data: {} });
  const saving = useRef(false);
  const saveFn = useRef<() => Promise<void>>(async () => {});
  if (typeof window !== 'undefined') setStorageAccount(user?.id ?? null);

  function changeUser(next: AccountUser | null) {
    if (userRef.current?.id === next?.id) return;
    userRef.current = next;
    setStorageAccount(next?.id ?? null);
    setHydrating(!!next);
    setCloudReady(false);
    setConflict(null);
    setUser(next);
    setStatus(next ? 'loading' : 'local');
  }
  async function refreshSession() {
    try {
      const json = await fetch('/api/auth/session', { cache: 'no-store' }).then(
        (r) => r.json(),
      );
      if (!json.ok) return;
      setPhoneLoginReady(json.data.phoneLoginReady === true);
      changeUser(json.data.user);
    } catch {}
  }
  function remember(id: string, record: Remote) {
    meta.current = record;
    try {
      localStorage.setItem(metaKey(id), JSON.stringify(record));
    } catch {}
  }
  async function loadCloud(id: string, signal?: AbortSignal) {
    try {
      const response = await fetch('/api/account/data', {
        cache: 'no-store',
        signal,
      });
      const json = await response.json();
      if (signal?.aborted || userRef.current?.id !== id) return;
      if (response.status === 401) {
        await refreshSession();
        return;
      }
      const remote = checkRemote(json.data);
      if (!response.ok || !json.ok || !remote) throw new Error('同步不可用');
      let previous: Remote | null = null;
      try {
        previous = checkRemote(
          JSON.parse(localStorage.getItem(metaKey(id)) ?? 'null'),
        );
      } catch {}
      const merged = mergeSnapshots(
        previous?.data ?? {},
        snapshotFor(id),
        remote.data,
      );
      if (merged.conflicts.length) {
        setConflict(remote);
        setStatus('conflict');
      } else {
        applySnapshot(id, merged.data);
        remember(id, remote);
        setStatus(
          snapshotsEqual(merged.data, remote.data) ? 'synced' : 'local',
        );
        setSaveTick((value) => value + 1);
      }
      setCloudReady(true);
    } catch {
      if (!signal?.aborted && userRef.current?.id === id) {
        setStatus('local');
        setCloudReady(false);
      }
    } finally {
      if (!signal?.aborted && userRef.current?.id === id) {
        setHydrating(false);
        setReload((value) => value + 1);
      }
    }
  }
  useEffect(() => {
    if (!user?.id) {
      setHydrating(false);
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    void loadCloud(user.id, controller.signal).finally(() => {
      clearTimeout(timeout);
      if (userRef.current?.id === user.id) {
        setHydrating(false);
        if (controller.signal.aborted) setStatus('local');
      }
    });
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
    // Account identity, rather than incidental renders, controls hydration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  async function sync() {
    const id = userRef.current?.id;
    if (!id || saving.current || conflict) return;
    if (!cloudReady) {
      setStatus('loading');
      await loadCloud(id);
      return;
    }
    const data = snapshotFor(id);
    if (snapshotsEqual(data, meta.current.data)) {
      setStatus('synced');
      return;
    }
    saving.current = true;
    setStatus('saving');
    try {
      const response = await fetch('/api/account/data', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-fin-csrf': '1' },
        body: JSON.stringify({ revision: meta.current.revision, data }),
      });
      const json = await response.json();
      if (userRef.current?.id !== id) return;
      if (response.status === 401) {
        await refreshSession();
        return;
      }
      const remote = checkRemote(json.data);
      if (response.status === 409 && remote) {
        const merged = mergeSnapshots(
          meta.current.data,
          snapshotFor(id),
          remote.data,
        );
        if (merged.conflicts.length) {
          setConflict(remote);
          setStatus('conflict');
        } else {
          applySnapshot(id, merged.data);
          remember(id, remote);
          setStatus('local');
          setReload((value) => value + 1);
          setSaveTick((value) => value + 1);
        }
        return;
      }
      if (!response.ok || !json.ok || !remote) throw new Error('保存失败');
      remember(id, remote);
      setStatus('synced');
      if (!snapshotsEqual(snapshotFor(id), remote.data))
        setSaveTick((value) => value + 1);
    } catch {
      if (userRef.current?.id === id) setStatus('local');
    } finally {
      saving.current = false;
      if (userRef.current?.id && userRef.current.id !== id)
        setSaveTick((value) => value + 1);
    }
  }
  saveFn.current = sync;
  useEffect(() => {
    if (!user || !cloudReady || conflict) return;
    const timer = setTimeout(() => {
      void saveFn.current();
    }, 800);
    return () => clearTimeout(timer);
  }, [user, cloudReady, conflict, saveTick]);
  useEffect(() => {
    const changed = () => {
      if (userRef.current) {
        setStatus((previous) => (previous === 'conflict' ? previous : 'local'));
        setSaveTick((value) => value + 1);
      }
    };
    const stored = (event: StorageEvent) => {
      if (event.key === AUTH_CHANGE) {
        void refreshSession();
        return;
      }
      const id = userRef.current?.id;
      if (!id || !event.key) return;
      const prefix = storageKey('', id);
      if (
        event.key.startsWith(prefix) &&
        isCloudKey(event.key.slice(prefix.length))
      )
        changed();
    };
    const focus = () => {
      void refreshSession();
    };
    window.addEventListener(PERSONAL_CHANGE, changed);
    window.addEventListener('storage', stored);
    window.addEventListener('focus', focus);
    const timer = setInterval(focus, 300000);
    void refreshSession();
    return () => {
      clearInterval(timer);
      window.removeEventListener(PERSONAL_CHANGE, changed);
      window.removeEventListener('storage', stored);
      window.removeEventListener('focus', focus);
    };
    // Event handlers read the current identity through userRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function announceAuth() {
    try {
      localStorage.setItem(AUTH_CHANGE, crypto.randomUUID());
    } catch {}
    router.refresh();
  }
  async function login(phone: string, code: string) {
    const response = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-fin-csrf': '1' },
      body: JSON.stringify({ phone, code }),
    });
    const json = await response.json();
    if (!response.ok || !json.ok) throw new Error(json.error ?? '登录失败');
    changeUser(json.data.user);
    announceAuth();
  }
  async function logout() {
    await sync();
    const response = await fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'x-fin-csrf': '1' },
    });
    if (!response.ok) throw new Error('退出失败，请重试');
    changeUser(null);
    announceAuth();
  }
  function importGuest() {
    if (!user) return;
    const guest = snapshotFor(null);
    if (!guest['fin-terminal.watchlist.v2']) {
      try {
        const old = JSON.parse(
          localStorage.getItem('fin-terminal.watchlist.v1') ?? '[]',
        );
        guest['fin-terminal.watchlist.v2'] = JSON.stringify(
          migrateWatchlist(old),
        );
      } catch {}
    }
    const merged = mergeGuestData(snapshotFor(user.id), guest);
    applySnapshot(user.id, merged);
    setReload((value) => value + 1);
    setSaveTick((value) => value + 1);
    setStatus('local');
  }
  function resolveConflict(choice: 'cloud' | 'local') {
    if (!user || !conflict) return;
    if (choice === 'cloud') applySnapshot(user.id, conflict.data);
    remember(user.id, conflict);
    setConflict(null);
    setStatus(choice === 'cloud' ? 'synced' : 'local');
    setReload((value) => value + 1);
    setSaveTick((value) => value + 1);
  }
  return (
    <Ctx.Provider
      value={{
        user,
        phoneLoginReady,
        status,
        conflict: !!conflict,
        login,
        logout,
        sync,
        importGuest,
        resolveConflict,
      }}
    >
      {hydrating ? (
        <div className="flex min-h-[60vh] items-center justify-center text-sm text-slate-500">
          正在加载个人数据…
        </div>
      ) : (
        <Fragment key={`${user?.id ?? 'guest'}:${reload}`}>{children}</Fragment>
      )}
    </Ctx.Provider>
  );
}
export function useAccount(): AccountContext {
  const context = useContext(Ctx);
  if (!context) throw new Error('缺少 AccountProvider');
  return context;
}
