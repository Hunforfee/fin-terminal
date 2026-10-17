'use client';

import { useWatchlist } from '@/components/WatchlistProvider';
import { fmtTime, price, signed, signedPct, toneClass } from '@/lib/format';
import type { Quote } from '@/lib/datasource/types';

const KIND_TEXT: Record<string, string> = {
  stock: '股票',
  index: '指数',
  fund: '基金',
  etf: 'ETF',
  bond: '债券',
  unknown: '—',
};

/** 标的报价头部：价格、涨跌、时间戳、加自选 */
export default function QuoteHeader({ quote, extra }: { quote: Quote; extra?: React.ReactNode }) {
  const wl = useWatchlist();
  const inList = wl.has(quote.code);

  return (
    <div className="card-pad flex flex-wrap items-center justify-between gap-6">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{quote.name}</h1>
          <span className="font-mono text-sm text-slate-500">{quote.code}</span>
          <span className="chip bg-slate-100 text-slate-500">{KIND_TEXT[quote.kind] ?? '—'}</span>
          {quote.stale && (
            <span
              className="chip bg-amber-100 text-amber-700"
              title="上游数据源不可用，展示的是最近一次成功抓取的快照"
            >
              快照数据
            </span>
          )}
        </div>

        <div className="mt-5 flex flex-wrap items-baseline gap-3">
          <span
            className={`text-4xl font-semibold tracking-tight tabular ${toneClass(quote.change)}`}
          >
            {price(quote.price)}
          </span>
          <span className={`text-base tabular ${toneClass(quote.change)}`}>
            {signed(quote.change)}　{signedPct(quote.changePct)}
          </span>
        </div>

        <div className="mt-3 text-xs text-slate-500">
          {fmtTime(quote.ts)} · 数据源 {quote.source}
          {quote.market ? ` · ${quote.market}` : ''}
        </div>
      </div>

      <div className="flex items-center gap-2">
        {extra}
        <button
          onClick={() => wl.toggle(quote.code)}
          className={inList ? 'btn border-brand-300 text-brand-700' : 'btn-primary'}
          aria-pressed={inList}
          title={inList ? '从自选移除' : '加入自选'}
        >
          {inList ? '★ 已自选' : '☆ 加自选'}
        </button>
      </div>
    </div>
  );
}
