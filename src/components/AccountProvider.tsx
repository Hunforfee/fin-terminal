'use client';

/**
 * 账号与「个人数据云同步」的客户端提供者。
 *
 * 接入 WorkBuddy 云服务后：
 *  - 身份来自 Cloud Auth（`cloud.auth`，手机验证码 / WorkBuddy 账号登录），
 *    不再使用本地文件账号库与自定义会话 Cookie。
 *  - 个人数据快照（自选分组 / 研究笔记 / 财务配置 / AI 历史）写入 Cloud Database
 *    表 `fin_account_data`，按云账号（auth.uid()）隔离，行级安全（RLS）保证互不可见。
 *  - 客户端 localStorage 仍作为本机缓存与离线兜底，登录后通过本文件与云端做
 *    乐观合并（CAS + 冲突提示），逻辑与接入云服务前保持一致。
 */

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
import { getCloud } from '@/lib/cloud';
import type { CloudUser } from '@tencent-ai/workbuddy-cloud-sdk';

type SyncStatus = 'loading' | 'synced' | 'saving' | 'local' | 'conflict';
interface Remote {
  revision: number;
  data: PersonalSnapshot;
}
interface AccountContext {
  user: AccountUser | null;
  status: SyncStatus;
  conflict: boolean;
  sendPhoneCode: (phone: string) => Promise<void>;
  verifyPhoneCode: (phone: string, code: string) => Promise<void>;
  signInWithWorkBuddy: () => Promise<void>;
  logout: () => Promise<void>;
  sync: () => Promise<void>;
  importGuest: () => void;
  resolveConflict: (choice: 'cloud' | 'local') => void;
}
const Ctx = createContext<AccountContext | null>(null);
const metaKey = (id: string) => 'fin.sync-meta:' + encodeURIComponent(id);
const checkRemote = (value: unknown): Remote | null => {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Remote;
  const data = validateSnapshot(entry.data);
  return data && Number.isSafeInteger(entry.revision) && entry.revision >= 0
    ? { revision: entry.revision, data }
    : null;
};
/** 把云账号用户映射成应用内展示身份；手机号做脱敏，不暴露明文。 */
const toAccountUser = (user: CloudUser): AccountUser => {
  const phone = user.phone ?? '';
  const masked =
    phone.length === 11
      ? phone.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2')
      : phone;
  const display = user.name || masked || '已登录用户';
  return { id: user.id, phone: display };
};
export default function AccountProvider({
  initialUser,
  children,
}: {
  initialUser: AccountUser | null;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [user, setUser] = useState<AccountUser | null>(initialUser);
  const userRef = useRef(user);
  userRef.current = user;
  const authVersion = useRef(0);
  const sessionRequest = useRef(0);
  const authPending = useRef(false);
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
  const pendingOtp = useRef<{
    phone: string;
    verificationId: string;
    isExistingUser: boolean;
  } | null>(null);
  if (typeof window !== 'undefined') setStorageAccount(user?.id ?? null);

  function changeUser(next: AccountUser | null) {
    if (userRef.current?.id === next?.id) {
      // 同一用户只刷新一次 hydrating 状态
      if (next && hydrating) setHydrating(false);
      return;
    }
    userRef.current = next;
    setStorageAccount(next?.id ?? null);
    setHydrating(!!next);
    setCloudReady(false);
    setConflict(null);
    setUser(next);
    setStatus(next ? 'loading' : 'local');
  }

  function remember(id: string, record: Remote) {
    meta.current = record;
    try {
      localStorage.setItem(metaKey(id), JSON.stringify(record));
    } catch {}
  }

  /** 启动 / OAuth 回调后恢复会话；普通访问走 getSession，WorkBuddy 回调走 handleWorkBuddyCallback。 */
  async function restoreSession() {
    if (typeof window !== 'undefined') {
      const url = new URL(location.href);
      if (
        url.searchParams.has('code') &&
        url.searchParams.get('provider') === 'workbuddy'
      ) {
        const { data: session, error } = await getCloud().auth.handleWorkBuddyCallback();
        if (!error && session?.user) {
          for (const k of ['code', 'state', 'provider']) url.searchParams.delete(k);
          history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
          changeUser(toAccountUser(session.user));
          return;
        }
      }
    }
    const { data: session, error } = await getCloud().auth.getSession();
    if (error) return;
    changeUser(session?.user ? toAccountUser(session.user) : null);
  }

  function announceAuth() {
    router.refresh();
  }

  async function loadCloud(id: string, signal?: AbortSignal) {
    try {
      // 无 schema 泛型时 PostgREST 门面把行推断为 never；运行期返回的是真实对象，
      // 这里按文档「untyped rows are any」的约定断言为 any。
      const db = getCloud().database as any;
      const { data, error } = await db
        .from('fin_account_data')
        .select('revision, data')
        .maybeSingle();
      if (signal?.aborted || userRef.current?.id !== id) return;
      if (error) throw error;
      const remote: Remote = data
        ? {
            revision: Number((data as { revision?: unknown }).revision ?? 0),
            data: validateSnapshot((data as { data?: unknown }).data) ?? {},
          }
        : { revision: 0, data: {} };
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
    // 身份变化驱动拉取，而非 incidental renders
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
      const db = getCloud().database as any;
      const { data: existing, error: readErr } = await db
        .from('fin_account_data')
        .select('revision')
        .maybeSingle();
      if (readErr) throw readErr;
      let saved: Remote | null = null;
      if (!existing) {
        const { data: inserted, error } = await db
          .from('fin_account_data')
          .insert({ data, revision: 0 })
          .select('revision, data')
          .maybeSingle();
        if (error) throw error;
        if (!inserted) throw new Error('保存失败');
        saved = {
          revision: Number((inserted as { revision?: unknown }).revision ?? 0),
          data: validateSnapshot((inserted as { data?: unknown }).data) ?? {},
        };
      } else {
        const rev = Number((existing as { revision?: unknown }).revision ?? 0);
        const { data: updated, error } = await db
          .from('fin_account_data')
          .update({ data, revision: rev + 1 })
          .eq('revision', rev)
          .select('revision, data')
          .maybeSingle();
        if (error) throw error;
        if (!updated) {
          // CAS 失败：远端已被别的设备更新，拉取最新并提示冲突
          const { data: remoteData, error: rErr } = await db
            .from('fin_account_data')
            .select('revision, data')
            .maybeSingle();
          if (!rErr && remoteData)
            setConflict({
              revision: Number((remoteData as { revision?: unknown }).revision ?? 0),
              data: validateSnapshot((remoteData as { data?: unknown }).data) ?? {},
            });
          setStatus('conflict');
          return;
        }
        saved = {
          revision: Number((updated as { revision?: unknown }).revision ?? 0),
          data: validateSnapshot((updated as { data?: unknown }).data) ?? {},
        };
      }
      if (saved) {
        remember(id, saved);
        setStatus('synced');
        if (!snapshotsEqual(snapshotFor(id), saved.data))
          setSaveTick((value) => value + 1);
      }
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
        setStatus((previous) =>
          previous === 'conflict' ? previous : 'local',
        );
        setSaveTick((value) => value + 1);
      }
    };
    const stored = (event: StorageEvent) => {
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
      void restoreSession();
    };
    window.addEventListener(PERSONAL_CHANGE, changed);
    window.addEventListener('storage', stored);
    window.addEventListener('focus', focus);
    const unsubscribe = getCloud().auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        changeUser(null);
        return;
      }
      const next = session?.user ? toAccountUser(session.user) : null;
      changeUser(next);
    });
    void restoreSession();
    return () => {
      window.removeEventListener(PERSONAL_CHANGE, changed);
      window.removeEventListener('storage', stored);
      window.removeEventListener('focus', focus);
      unsubscribe?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function sendPhoneCode(phone: string) {
    const { data, error } = await getCloud().auth.sendOtp({ phone });
    if (error) throw new Error(error.message);
    pendingOtp.current = {
      phone,
      verificationId: data.verificationId,
      isExistingUser: data.isExistingUser,
    };
  }
  async function verifyPhoneCode(phone: string, code: string) {
    const pending = pendingOtp.current;
    if (!pending || pending.phone !== phone)
      throw new Error('请先获取验证码');
    const { data: session, error } = await getCloud().auth.verifyOtp({
      phone: pending.phone,
      verificationId: pending.verificationId,
      isExistingUser: pending.isExistingUser,
      token: code,
    });
    if (error) throw new Error(error.message);
    pendingOtp.current = null;
    if (session?.user) changeUser(toAccountUser(session.user));
  }
  async function signInWithWorkBuddy() {
    const back = new URL(
      typeof location !== 'undefined'
        ? location.href
        : 'https://a-share-fin-terminal.app.workbuddy.host/',
    );
    back.pathname = '/';
    for (const key of ['code', 'state', 'provider']) back.searchParams.delete(key);
    const { data, error } = await getCloud().auth.signInWithOAuth({
      provider: 'workbuddy',
      redirectTo: back.toString(),
    });
    if (error) throw new Error(error.message);
    location.assign(data.url);
  }
  async function logout() {
    const version = ++authVersion.current;
    authPending.current = true;
    try {
      await sync();
      await getCloud().auth.signOut();
      if (version !== authVersion.current) return;
      changeUser(null);
      announceAuth();
    } finally {
      if (version === authVersion.current) {
        authPending.current = false;
        authVersion.current++;
      }
    }
  }
  function importGuest() {
    if (!user) return;
    const guest = snapshotFor(null);
    if (!guest['fin-terminal.watchlist.v2']) {
      try {
        const old = JSON.parse(
          localStorage.getItem('fin-terminal.watchlist.v1') ?? '[]',
        );
        guest['fin-terminal.watchlist.v2'] = JSON.stringify(migrateWatchlist(old));
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
        status,
        conflict: !!conflict,
        sendPhoneCode,
        verifyPhoneCode,
        signInWithWorkBuddy,
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
