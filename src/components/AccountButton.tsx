'use client';

import { useEffect, useRef, useState } from 'react';
import { useAccount } from './AccountProvider';
import Modal from './Modal';

export default function AccountButton() {
  const account = useAccount();
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [sentPhone, setSentPhone] = useState('');
  const menu = useRef<HTMLDetailsElement>(null);
  const validPhone = /^1[3-9]\d{9}$/.test(phone);
  useEffect(() => {
    if (!remaining) return;
    const timer = setTimeout(
      () => setRemaining((value) => Math.max(0, value - 1)),
      1000,
    );
    return () => clearTimeout(timer);
  }, [remaining]);
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
  async function send() {
    if (!account.phoneLoginReady || !validPhone || sending || remaining) return;
    setSending(true);
    setError('');
    try {
      const response = await fetch('/api/auth/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-fin-csrf': '1' },
        body: JSON.stringify({ phone }),
      });
      const json = await response.json();
      if (!response.ok || !json.ok) throw new Error(json.error ?? '发送失败');
      setSentPhone(phone);
      setRemaining(
        Math.max(1, Math.min(120, Number(json.data?.retryAfter) || 60)),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '发送失败');
    } finally {
      setSending(false);
    }
  }
  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    if (
      !account.phoneLoginReady ||
      !validPhone ||
      !/^\d{4,8}$/.test(code) ||
      submitting
    )
      return;
    setSubmitting(true);
    setError('');
    try {
      await account.login(phone, code);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '登录失败');
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
      <Modal open={open} title="手机号登录" onClose={() => setOpen(false)}>
        <form onSubmit={signIn} className="space-y-4">
          <label className="block">
            <span className="mb-2 block text-xs text-slate-500">手机号</span>
            <div className="flex items-center rounded-lg border border-slate-200 focus-within:border-brand-500">
              <span className="border-r border-slate-100 px-3 text-sm text-slate-400">
                +86
              </span>
              <input
                aria-label="登录手机号"
                autoComplete="tel-national"
                inputMode="tel"
                type="tel"
                value={phone}
                maxLength={11}
                onChange={(e) => {
                  setPhone(e.target.value.replace(/\D/g, '').slice(0, 11));
                  setCode('');
                  setError('');
                }}
                placeholder="请输入手机号"
                className="min-h-11 min-w-0 flex-1 rounded-lg px-3 text-sm outline-none"
              />
            </div>
          </label>
          <label className="block">
            <span className="mb-2 block text-xs text-slate-500">
              短信验证码
            </span>
            <div className="flex gap-2">
              <input
                aria-label="短信验证码"
                autoComplete="one-time-code"
                inputMode="numeric"
                value={code}
                maxLength={8}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                className="input min-w-0 flex-1"
                placeholder="请输入验证码"
              />
              <button
                type="button"
                disabled={
                  !account.phoneLoginReady ||
                  !validPhone ||
                  sending ||
                  remaining > 0
                }
                onClick={() => {
                  void send();
                }}
                className="btn shrink-0 !px-3 !text-xs"
              >
                {sending
                  ? '发送中…'
                  : remaining
                    ? `${remaining}s 后重发`
                    : '获取验证码'}
              </button>
            </div>
          </label>
          {!account.phoneLoginReady && (
            <p className="text-xs text-slate-500">
              短信登录服务待 WorkBuddy 接入，当前可继续使用访客模式。
            </p>
          )}
          {sentPhone === phone && remaining > 0 && (
            <p role="status" className="text-xs text-slate-500">
              验证码已发送至 {phone.slice(0, 3)}****{phone.slice(-4)}
            </p>
          )}
          {error && (
            <p role="alert" className="text-xs text-red-600">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={
              !account.phoneLoginReady ||
              !validPhone ||
              !/^\d{4,8}$/.test(code) ||
              submitting
            }
            className="btn-primary w-full"
          >
            {submitting ? '登录中…' : '登录 / 注册'}
          </button>
        </form>
      </Modal>
    </>
  );
}
