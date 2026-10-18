'use client';
import { useEffect, useId, useRef } from 'react';

export default function Modal({
  open,
  title,
  onClose,
  children,
  size = 'md',
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /** md 默认窄弹窗；lg 适合长文/表格阅读 */
  size?: 'md' | 'lg';
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
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
      className={`m-auto overflow-y-auto overscroll-contain rounded-xl border border-slate-200 bg-white p-0 text-slate-800 shadow-2xl backdrop:bg-slate-900/30 ${
        size === 'lg'
          ? 'max-h-[92dvh] w-[calc(100%-1.5rem)] max-w-5xl'
          : 'max-h-[85dvh] w-[calc(100%-1.5rem)] max-w-lg'
      }`}
    >
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <h2 id={id} className="min-w-0 break-words font-semibold">
          {title}
        </h2>
        <button
          type="button"
          aria-label={`关闭${title}`}
          onClick={onClose}
          className="h-8 w-8 shrink-0 rounded text-xl text-slate-400 hover:bg-slate-100"
        >
          ×
        </button>
      </div>
      {open && <div className="p-4">{children}</div>}
    </dialog>
  );
}
