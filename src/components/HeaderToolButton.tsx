'use client';

import { useEffect, useId, useState, type ButtonHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';

/** Header utilities use a portal so the scrollable navigation never clips their labels. */
export default function HeaderToolButton({
  label,
  children,
  className = '',
  onClick,
  onFocus,
  onBlur,
  onMouseEnter,
  onMouseLeave,
  onKeyDown,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  const tooltipId = useId();
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const show = (button: HTMLButtonElement) => {
    if (props.disabled || props['aria-expanded'] === true || props['aria-expanded'] === 'true') return;
    const rect = button.getBoundingClientRect();
    const width = label.length * 12 + 16;
    setPosition({
      top: Math.min(rect.bottom + 6, window.innerHeight - 36),
      left: Math.max(8, Math.min(rect.left + (rect.width - width) / 2, window.innerWidth - width - 8)),
    });
  };
  useEffect(() => {
    if (!position) return;
    const hide = () => setPosition(null);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [position]);
  return (
    <>
      <button
        {...props}
        type="button"
        aria-label={props['aria-label'] ?? label}
        aria-describedby={position ? tooltipId : undefined}
        className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-slate-100/80 text-slate-600 transition-colors hover:bg-slate-200/80 hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
        onMouseEnter={(event) => { show(event.currentTarget); onMouseEnter?.(event); }}
        onMouseLeave={(event) => { setPosition(null); onMouseLeave?.(event); }}
        onFocus={(event) => { show(event.currentTarget); onFocus?.(event); }}
        onBlur={(event) => { setPosition(null); onBlur?.(event); }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setPosition(null);
          onKeyDown?.(event);
        }}
        onClick={(event) => { setPosition(null); onClick?.(event); }}
      >
        {children}
      </button>
      {position && createPortal(
        <span
          id={tooltipId}
          role="tooltip"
          style={position}
          className="pointer-events-none fixed z-[100] whitespace-nowrap rounded-md bg-slate-800 px-2 py-1 text-xs leading-5 text-white shadow-sm"
        >
          {label}
        </span>,
        document.body,
      )}
    </>
  );
}
