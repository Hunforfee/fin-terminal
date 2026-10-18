'use client';
import { useEffect, useId, useRef, useState } from 'react';

export default function Modal({
  open,
  title,
  onClose,
  children,
  size = 'md',
  bare = false,
  maximizable = false,
  maximized: controlledMaximized,
  onMaximizedChange,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /** md 默认窄弹窗；lg 适合长文/表格阅读；full 近乎全屏，内容自行排版 */
  size?: 'md' | 'lg' | 'full';
  /** 不渲染默认标题栏，由内容自己布局（如全屏双栏面板） */
  bare?: boolean;
  /** 允许最大化：右上角全屏按钮 + 双击标题栏切换 */
  maximizable?: boolean;
  /** 受控的最大化状态（内容区自带标题栏时使用） */
  maximized?: boolean;
  onMaximizedChange?: (next: boolean) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [innerMaximized, setInnerMaximized] = useState(false);
  const maximized = controlledMaximized ?? innerMaximized;
  const setMaximized = (next: boolean | ((prev: boolean) => boolean)) => {
    const value = typeof next === 'function' ? next(maximized) : next;
    if (controlledMaximized === undefined) setInnerMaximized(value);
    onMaximizedChange?.(value);
  };
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!open) {
      if (dialog.open) dialog.close();
      return;
    }
    dialog.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
      if (dialog.open) dialog.close();
    };
  }, [open]);
  // 关闭后重置最大化状态，下次打开回到默认尺寸
  useEffect(() => {
    if (!open) setMaximized(false);
  }, [open]);
  const maximizedClass = '!h-screen !max-h-screen !w-screen !max-w-none !rounded-none !border-0';
  return (
    <dialog
      ref={ref}
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const r = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < r.left ||
          event.clientX > r.right ||
          event.clientY < r.top ||
          event.clientY > r.bottom
        )
          onClose();
      }}
      className={`m-auto overscroll-contain bg-white p-0 text-slate-800 shadow-2xl backdrop:bg-slate-900/30 ${
        maximized
          ? maximizedClass
          : `rounded-xl border border-slate-200 ${
              size === 'full'
                ? 'h-[96dvh] max-h-[96dvh] w-[calc(100%-1.5rem)] max-w-[1600px]'
                : size === 'lg'
                  ? 'max-h-[92dvh] w-[calc(100%-1.5rem)] max-w-5xl'
                  : 'max-h-[85dvh] w-[calc(100%-1.5rem)] max-w-lg'
            }`
      } ${bare || maximizable ? 'flex flex-col overflow-hidden' : 'overflow-y-auto'}`}
    >
      {!bare && (
        <div
          className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-100 px-4 py-3"
          onDoubleClick={maximizable ? () => setMaximized((v) => !v) : undefined}
        >
          <h2 id={id} className="min-w-0 break-words font-semibold">
            {title}
          </h2>
          <div className="flex shrink-0 items-center gap-1">
            {maximizable && (
              <button
                type="button"
                aria-label={maximized ? '退出最大化' : '最大化'}
                title={maximized ? '退出最大化' : '最大化'}
                onClick={() => setMaximized((v) => !v)}
                className="inline-flex h-8 w-8 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  {maximized ? (
                    <path d="M9 3H5a2 2 0 0 0-2 2v4M15 3h4a2 2 0 0 1 2 2v4M9 21H5a2 2 0 0 1-2-2v-4M15 21h4a2 2 0 0 0 2-2v-4" />
                  ) : (
                    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
                  )}
                </svg>
              </button>
            )}
            <button
              type="button"
              aria-label={`关闭${title}`}
              onClick={onClose}
              className="h-8 w-8 rounded text-xl text-slate-400 hover:bg-slate-100"
            >
              ×
            </button>
          </div>
        </div>
      )}
      {open && (
        <div className={`min-h-0 ${bare ? 'h-full' : 'p-4'} ${maximizable ? 'flex-1' : ''}`}>
          {children}
        </div>
      )}
    </dialog>
  );
}
