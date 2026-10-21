'use client';

import { useEffect, useRef, useState } from 'react';
import { useAccount } from './AccountProvider';
import Modal from './Modal';

const USERNAME_RE = /^[\w\u4e00-\u9fa5-]{3,24}$/;

export default function AccountButton() {
  const account = useAccount();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);
  const validUsername =
    USERNAME_RE.test(username) && !/^\d{11}$/.test(username);
  const validPassword = password.length >= 8;
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node))
        menu.current.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && menu.current) menu.current.open = false;
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape);
    };
  }, []);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!validUsername || !validPassword || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      if (mode === 'register') {
        await account.register(username, password);
      } else {
        await account.login(username, password);
      }
      setOpen(false);
      setPassword('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败');
    } finally {
      setSubmitting(false);
    }
  }
  const syncText = {
    loading: '正在同步',
    saving: '正在保存',
    synced: '已同步',
    local: '本机已保存',
    conflict: '同步冲突',
  }[account.status];
  return (
    <>
      {account.user ? (
        <details ref={menu} className="relative shrink-0">
          <summary
            aria-label="账号菜单"
            className="flex min-h-9 list-none items-center gap-1.5 rounded-lg px-2 text-xs text-slate-600 hover:bg-slate-100 [&::-webkit-details-marker]:hidden"
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${account.status === 'synced' ? 'bg-emerald-500' : account.conflict ? 'bg-amber-500' : 'bg-slate-300'}`}
            />
            <span>{account.user.phone}</span>
            <span aria-hidden="true">⌄</span>
          </summary>
          <div className="absolute right-0 z-50 mt-2 w-64 max-w-[calc(100vw-1.5rem)] rounded-xl border border-slate-200 bg-white p-3 shadow-xl">
            <div className="mb-2 border-b border-slate-100 pb-3">
              <div className="text-sm font-medium text-slate-800">
                {account.user.phone}
              </div>
              <div role="status" className="mt-1 text-xs text-slate-400">
                {syncText}
              </div>
            </div>
            {account.conflict ? (
              <div className="space-y-2 pb-2">
                <div className="text-xs leading-5 text-slate-500">
                  本机与云端都有修改，请选择保留的版本。
                </div>
                <button
                  className="w-full rounded-md bg-brand-50 px-2 py-2 text-left text-xs text-brand-700"
                  onClick={() => account.resolveConflict('cloud')}
                >
                  使用云端版本
                </button>
                <button
                  className="w-full rounded-md px-2 py-2 text-left text-xs text-slate-600 hover:bg-slate-50"
                  onClick={() => account.resolveConflict('local')}
                >
                  保留本机版本并同步
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  void account.sync();
                }}
                className="w-full rounded-md px-2 py-2 text-left text-xs text-slate-600 hover:bg-slate-50"
              >
                立即同步
              </button>
            )}
            <button
              type="button"
              onClick={() => account.importGuest()}
              className="w-full rounded-md px-2 py-2 text-left text-xs text-slate-600 hover:bg-slate-50"
            >
              导入本机原有自选和笔记
            </button>
            <button
              type="button"
              onClick={() => {
                setError('');
                void account.logout().catch((cause) => setError(cause.message));
              }}
              className="mt-1 w-full rounded-md border-t border-slate-100 px-2 py-2 text-left text-xs text-slate-500 hover:bg-slate-50"
            >
              退出登录
            </button>
            {error && (
              <p role="alert" className="mt-1 text-xs text-red-600">
                {error}
              </p>
            )}
          </div>
        </details>
      ) : (
        <button
          type="button"
          onClick={() => {
            setError('');
            setOpen(true);
          }}
          className="shrink-0 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:border-brand-300 hover:text-brand-700"
        >
          登录
        </button>
      )}
      <Modal open={open} title="账号登录" onClose={() => setOpen(false)}>
        <form onSubmit={submit} className="space-y-4">
          <div className="flex gap-1.5" role="tablist" aria-label="登录或注册">
            {(
              [
                ['login', '登录'],
                ['register', '注册新账号'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={mode === k}
                onClick={() => {
                  setMode(k);
                  setError('');
                }}
                className={`min-h-8 flex-1 rounded-lg px-3 text-xs font-medium transition ${
                  mode === k
                    ? 'bg-brand-600 text-white'
                    : 'border border-slate-200 bg-white text-slate-600 hover:border-brand-300'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="block">
            <span className="mb-2 block text-xs text-slate-500">用户名</span>
            <input
              aria-label="用户名"
              autoComplete="username"
              value={username}
              maxLength={24}
              onChange={(e) => {
                setUsername(e.target.value.trim());
                setPassword('');
                setError('');
              }}
              placeholder="3-24 位字母、数字、下划线或中文"
              className="input min-h-11 w-full"
            />
          </label>
          <label className="block">
            <span className="mb-2 block text-xs text-slate-500">密码</span>
            <input
              aria-label="密码"
              autoComplete={
                mode === 'register' ? 'new-password' : 'current-password'
              }
              type="password"
              value={password}
              maxLength={128}
              onChange={(e) => {
                setPassword(e.target.value);
                setError('');
              }}
              placeholder="至少 8 位"
              className="input min-h-11 w-full"
            />
          </label>
          {error && (
            <p role="alert" className="text-xs text-red-600">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={!validUsername || !validPassword || submitting}
            className="btn-primary w-full"
          >
            {submitting
              ? '提交中…'
              : mode === 'register'
                ? '注册并登录'
                : '登录'}
          </button>
          <p className="text-center text-[11px] leading-4 text-slate-400">
            登录后自选分组、研究笔记、财务配置与 AI 分析历史随账号保存。
          </p>
        </form>
      </Modal>
    </>
  );
}
