'use client';

import { useEffect, useRef, useState } from 'react';
import { useAccount } from './AccountProvider';
import Modal from './Modal';

/** 大陆手机号：11 位、1 开头。 */
const PHONE_RE = /^1\d{10}$/;

export default function AccountButton() {
  const account = useAccount();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'phone' | 'workbuddy'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [retryAfter, setRetryAfter] = useState(0);
  const [countdown, setCountdown] = useState(0);
  const menu = useRef<HTMLDetailsElement>(null);
  const validPhone = PHONE_RE.test(phone);
  const validCode = /^\d{4,8}$/.test(code);
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
  useEffect(() => {
    if (retryAfter <= 0) return;
    const id = setInterval(() => setRetryAfter((v) => Math.max(0, v - 1)), 1000);
    return () => clearInterval(id);
  }, [retryAfter]);
  useEffect(() => {
    if (countdown <= 0) return;
    const id = setInterval(() => setCountdown((v) => Math.max(0, v - 1)), 1000);
    return () => clearInterval(id);
  }, [countdown]);
  async function handleSendCode() {
    if (!validPhone || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await account.sendPhoneCode(phone);
      setCodeSent(true);
      setRetryAfter(60);
      setCountdown(60);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '发送失败');
    } finally {
      setSubmitting(false);
    }
  }
  async function handleVerify() {
    if (!validPhone || !validCode || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await account.verifyPhoneCode(phone, code);
      setOpen(false);
      setCode('');
      setCodeSent(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '验证失败');
    } finally {
      setSubmitting(false);
    }
  }
  async function handleWorkBuddy() {
    setSubmitting(true);
    setError('');
    try {
      await account.signInWithWorkBuddy();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '登录失败');
      setSubmitting(false);
    }
  }
  const syncText =
    {
      loading: '正在同步',
      saving: '正在保存',
      synced: '已同步',
      local: '本机已保存',
      conflict: '同步冲突',
    }[account.status] ?? '';
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
                  type="button"
                  className="w-full rounded-md bg-brand-50 px-2 py-2 text-left text-xs text-brand-700"
                  onClick={() => account.resolveConflict('cloud')}
                >
                  使用云端版本
                </button>
                <button
                  type="button"
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
        <div className="space-y-4">
          <div className="flex gap-1.5" role="tablist" aria-label="登录方式">
            {(
              [
                ['phone', '手机号登录'],
                ['workbuddy', 'WorkBuddy 登录'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={tab === k}
                onClick={() => {
                  setTab(k);
                  setError('');
                }}
                className={`min-h-8 flex-1 rounded-lg px-3 text-xs font-medium transition ${
                  tab === k
                    ? 'bg-brand-600 text-white'
                    : 'border border-slate-200 bg-white text-slate-600 hover:border-brand-300'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === 'phone' ? (
            <div className="space-y-3">
              <label className="block">
                <span className="mb-2 block text-xs text-slate-500">手机号</span>
                <input
                  aria-label="手机号"
                  inputMode="numeric"
                  autoComplete="tel"
                  value={phone}
                  maxLength={11}
                  onChange={(e) => {
                    setPhone(e.target.value.replace(/\D/g, '').slice(0, 11));
                    setError('');
                    setCodeSent(false);
                  }}
                  placeholder="请输入 11 位手机号"
                  className="input min-h-11 w-full"
                />
              </label>
              <label className="block">
                <span className="mb-2 block text-xs text-slate-500">验证码</span>
                <div className="flex gap-2">
                  <input
                    aria-label="验证码"
                    inputMode="numeric"
                    value={code}
                    maxLength={8}
                    onChange={(e) => {
                      setCode(e.target.value.replace(/\D/g, ''));
                      setError('');
                    }}
                    placeholder="6 位短信验证码"
                    className="input min-h-11 w-full"
                  />
                  <button
                    type="button"
                    onClick={handleSendCode}
                    disabled={!validPhone || submitting || countdown > 0}
                    className="shrink-0 rounded-lg border border-slate-200 px-3 text-xs text-slate-600 hover:border-brand-300 hover:text-brand-700 disabled:opacity-50"
                  >
                    {countdown > 0 ? `${countdown}s` : '获取验证码'}
                  </button>
                </div>
              </label>
              {error && (
                <p role="alert" className="text-xs text-red-600">
                  {error}
                </p>
              )}
              <button
                type="button"
                onClick={handleVerify}
                disabled={!validPhone || !validCode || submitting}
                className="btn-primary w-full"
              >
                {submitting ? '验证中…' : '登录 / 注册'}
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {error && (
                <p role="alert" className="text-xs text-red-600">
                  {error}
                </p>
              )}
              <button
                type="button"
                onClick={handleWorkBuddy}
                disabled={submitting}
                className="btn-primary w-full"
              >
                {submitting ? '跳转中…' : '使用 WorkBuddy 登录'}
              </button>
              <p className="text-center text-[11px] leading-4 text-slate-400">
                将跳转到 WorkBuddy 统一登录，授权后返回本应用。
              </p>
            </div>
          )}

          <p className="text-center text-[11px] leading-4 text-slate-400">
            登录后自选分组、研究笔记、财务配置与 AI 分析历史随账号保存在云端。
          </p>
        </div>
      </Modal>
    </>
  );
}
