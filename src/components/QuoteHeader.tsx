'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
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

interface Profile {
  holder: string | null;
  holderRatio: number | null;
  controller: string | null;
  industry: string | null;
  industryPath: string | null;
}

/** 右侧资料区单项 */
function ProfileItem({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className="mt-0.5 truncate text-sm font-medium text-slate-700" title={title}>
        {value}
      </div>
    </div>
  );
}

/** 标的报价头部：左侧名称/价格/操作按钮，右侧公司资料 */
export default function QuoteHeader({ quote }: { quote: Quote }) {
  const wl = useWatchlist();
  const inList = wl.has(quote.code);
  const [profile, setProfile] = useState<Profile | null>(null);

  const isStock = quote.kind === 'stock';
  useEffect(() => {
    setProfile(null);
    if (!isStock) return;
    let alive = true;
    fetch(`/api/company-profile?code=${encodeURIComponent(quote.symbol)}`)
      .then((r) => r.json())
      .then((j) => {
        if (alive && j?.data) setProfile(j.data as Profile);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [isStock, quote.symbol]);

  const cap = quote.totalMarketCap;
  const capText =
    cap == null ? '--' : cap >= 10000 ? `${(cap / 10000).toFixed(2)} 万亿` : `${cap.toFixed(cap >= 100 ? 0 : 2)} 亿`;

  return (
    <div className="card-pad flex flex-wrap items-start justify-between gap-6">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
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
          {isStock && (
            <>
              <Link
                href={`/stock/${quote.market === 'HK' ? quote.symbol : quote.code}/finance`}
                className="chip border border-brand-300 bg-white text-brand-700 hover:bg-brand-50"
              >
                财务体检 →
              </Link>
              <button
                onClick={() => wl.toggle(quote.code)}
                className={`chip border ${inList ? 'border-brand-300 bg-brand-50 text-brand-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
                aria-pressed={inList}
                title={inList ? '从自选移除' : '加入自选'}
              >
                {inList ? '★ 已自选' : '☆ 加自选'}
              </button>
            </>
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

      {isStock && (
        <div className="grid w-full grid-cols-2 gap-x-8 gap-y-4 sm:w-auto sm:grid-cols-4 sm:min-w-[360px]">
          <ProfileItem label="总市值" value={capText} />
          <ProfileItem
            label="控股股东"
            value={profile?.holder ?? '--'}
            title={
              profile?.holder && profile?.holderRatio != null
                ? `${profile.holder}（持股 ${profile.holderRatio.toFixed(2)}%）`
                : undefined
            }
          />
          <ProfileItem label="实控人" value={profile?.controller ?? '--'} title={profile?.controller ?? undefined} />
          <ProfileItem
            label={quote.market === 'HK' ? '所属行业' : '所属三级行业'}
            value={profile?.industry ?? '--'}
            title={profile?.industryPath ?? undefined}
          />
        </div>
      )}
    </div>
  );
}
