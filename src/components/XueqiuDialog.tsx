'use client';

import { useEffect, useId, useRef, useState } from 'react';

/**
 * 雪球全屏弹窗。
 *
 * 为什么用 iframe 而不是直接跳新标签：
 * - 用户要求「点击后在站内以全屏弹窗进入该股票的雪球板块」；
 * - 雪球个股页不返回 X-Frame-Options / CSP frame-ancestors，浏览器层面允许内嵌；
 * - iframe 的 cookie 属于 xueqiu.com 域，用户在本机浏览器登录过雪球后，
 *   弹窗里就是同一个登录态 —— 本站不接触、也不存储任何雪球账号信息。
 *
 * 已知限制（做了对应兜底）：
 * - 雪球对可疑来源弹阿里云 WAF 滑块/405，iframe 里可能停在验证页或空白；
 *   标题栏常驻「新标签打开」按钮，任何情况下都有一条确定可走的路。
 * - iframe 内会显示「首次打开可能需要登录/验证，若空白请用新标签打开」的提示，
 *   用户过一次验证后 cookie 会记住，后续弹窗通常直接放行。
 */
export default function XueqiuDialog({
  url,
  name,
  code,
}: {
  url: string;
  name: string;
  code: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [opened, setOpened] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const titleId = useId();

  useEffect(() => {
    if (!opened) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [opened]);

  const close = () => dialog.current?.close();

  return (
    <>
      <button
        type="button"
        aria-label={`在雪球查看${name}`}
        title="雪球"
        aria-haspopup="dialog"
        onClick={() => {
          setLoaded(false);
          dialog.current?.showModal();
          setOpened(true);
        }}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-[#eaf3fe] hover:text-[#1f6feb] focus-visible:text-[#1f6feb] [@media(hover:none)]:text-[#1f6feb]"
      >
        <XueqiuMark className="h-4 w-4" />
      </button>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        className="m-auto h-[100dvh] max-h-[100dvh] w-screen max-w-none overflow-hidden border-0 bg-white p-0 text-slate-800 shadow-2xl backdrop:bg-slate-900/50"
        onClose={() => setOpened(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        <div className="flex h-full flex-col">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-white px-3 py-2 sm:px-4">
            <h2
              id={titleId}
              className="flex min-w-0 items-center gap-2 text-sm font-semibold sm:text-base"
            >
              <XueqiuMark className="h-4 w-4 shrink-0 text-[#1f6feb]" />
              <span className="truncate">{name}</span>
              <span className="shrink-0 font-mono text-xs font-normal text-slate-500">
                {code}
              </span>
              <span className="hidden shrink-0 text-xs font-normal text-slate-400 sm:inline">
                雪球讨论
              </span>
            </h2>
            <div className="flex shrink-0 items-center gap-1">
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-800"
              >
                <svg
                  aria-hidden="true"
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M14 4h6v6M20 4l-8 8M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
                </svg>
                <span className="hidden sm:inline">新标签打开</span>
              </a>
              <button
                type="button"
                aria-label="关闭雪球弹窗"
                onClick={close}
                className="flex h-8 w-8 items-center justify-center rounded-md text-xl leading-none text-slate-500 hover:bg-slate-100 hover:text-slate-800"
              >
                ×
              </button>
            </div>
          </div>
          <div className="relative min-h-0 flex-1 bg-white">
            {opened && (
              <iframe
                key={url}
                title={`${name} 雪球讨论`}
                src={url}
                onLoad={() => setLoaded(true)}
                referrerPolicy="no-referrer-when-downgrade"
                className="h-full w-full border-0"
              />
            )}
            {!loaded && (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white text-sm text-slate-500">
                <span className="h-6 w-6 animate-spin rounded-full border-2 border-slate-200 border-t-[#1f6feb]" />
                正在加载雪球页面…
                <span className="max-w-xs text-center text-xs text-slate-400">
                  首次打开可能需要先在弹窗内登录雪球；若长时间空白，请点右上角
                  「新标签打开」。
                </span>
              </div>
            )}
          </div>
        </div>
      </dialog>
    </>
  );
}

/** 雪球字标：用官方蓝的圆角方块 + 白色「雪」字形轮廓，避免引入外部图片资源。 */
export function XueqiuMark({ className = '' }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9.2" />
      <path d="M8.4 9.3h7.2M9.1 12.4h5.8M12 7.4v9.2M9.3 16.6h5.4" />
    </svg>
  );
}
