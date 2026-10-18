'use client';
import { memo, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { industryOf } from '@/lib/universe';
import type { Quote } from '@/lib/datasource/types';

const industryRequests = new Map<string, Promise<string | null>>();
function requestIndustry(symbol: string) {
  let request = industryRequests.get(symbol);
  if (!request) {
    request = fetch(`/api/company-profile?code=${encodeURIComponent(symbol)}`)
      .then(async (response) => {
        const json = await response.json();
        if (!response.ok || !json.ok) throw new Error('公司资料暂不可用');
        return typeof json.data?.industry === 'string'
          ? json.data.industry
          : null;
      })
      .catch((error) => {
        industryRequests.delete(symbol);
        throw error;
      });
    industryRequests.set(symbol, request);
  }
  return request;
}

function StockName({
  quote,
  groups,
  href,
}: {
  quote: Quote;
  groups: string[];
  href: string;
}) {
  const id = useId();
  const [industry, setIndustry] = useState<string | null>(
    industryOf(quote.code),
  );
  const [position, setPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const open = position !== null;
  useEffect(() => {
    if (!open || industry || quote.kind !== 'stock') return;
    let active = true;
    requestIndustry(quote.symbol)
      .then((value) => {
        if (active) setIndustry(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [open, industry, quote.symbol, quote.kind]);
  useEffect(() => {
    if (!position) return;
    const close = () => setPosition(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [position]);
  function show(element: HTMLElement) {
    const rect = element.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 288)),
      top:
        rect.bottom + 130 < window.innerHeight
          ? rect.bottom + 8
          : Math.max(8, rect.top - 124),
    });
  }
  return (
    <>
      <Link
        prefetch={false}
        href={href}
        aria-describedby={position ? id : undefined}
        onMouseEnter={(e) => show(e.currentTarget)}
        onMouseLeave={() => setPosition(null)}
        onFocus={(e) => show(e.currentTarget)}
        onBlur={() => setPosition(null)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setPosition(null);
        }}
        className="w-[5.5em] min-w-0 flex-none truncate font-medium text-[#0b7ec4] hover:underline focus-visible:underline"
      >
        {quote.name}
      </Link>
      {position &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            style={position}
            className="pointer-events-none fixed z-[100] w-[280px] max-w-[calc(100vw-16px)] rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs leading-6 text-slate-600 shadow-lg"
          >
            <div className="font-semibold text-slate-900">
              {quote.name}{' '}
              <span className="ml-1 font-normal text-slate-500">
                {quote.code} · {quote.market}
              </span>
            </div>
            <div>行业：{industry ?? '—'}</div>
            <div className="break-words">
              分组：{groups.join('、') || '未分组'}
            </div>
            {quote.stale && <div className="text-amber-700">行情快照</div>}
          </div>,
          document.body,
        )}
    </>
  );
}
export default memo(StockName);
