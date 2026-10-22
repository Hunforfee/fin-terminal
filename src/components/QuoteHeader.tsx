'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import AiAnalysisPanel from '@/components/AiAnalysisPanel';
import StockFillButton from '@/components/StockFillButton';
import WatchlistButton from '@/components/WatchlistButton';
import XueqiuLink from '@/components/XueqiuLink';
import { fmtTime, price, signed, signedPct, toneClass } from '@/lib/format';
import { xueqiuUrl } from '@/lib/xueqiu';
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

/** 公司资料单项，按内容宽度排列并允许长名称换行。 */
function ProfileItem({
  label,
  value,
  title,
  href,
}: {
  label: string;
  value: string;
  title?: string;
  href?: string;
}) {
  return (
    <div className="min-w-0 max-w-full sm:max-w-[24rem]">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div
        className="mt-0.5 break-words text-[13px] font-medium leading-5 text-slate-700"
        title={title}
      >
        {href ? (
          <Link
            href={href}
            className="text-brand-700 underline decoration-brand-200 underline-offset-4 hover:decoration-brand-600"
          >
            {value} <span aria-hidden="true">↗</span>
          </Link>
        ) : (
          value
        )}
      </div>
    </div>
  );
}

/** 标的报价头部：名称与操作按钮，下方靠左排列报价和公司资料。 */
export default function QuoteHeader({ quote }: { quote: Quote }) {
  const [profile, setProfile] = useState<Profile | null>(null);

  const isStock = quote.kind === 'stock';
  const xueqiu = xueqiuUrl(quote.symbol, quote.market, quote.kind);
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
    cap == null
      ? '--'
      : cap >= 10000
        ? `${(cap / 10000).toFixed(2)} 万亿`
        : `${cap.toFixed(cap >= 100 ? 0 : 2)} 亿`;

  return (
    <div className="card-pad space-y-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">
            {quote.name}
          </h1>
          <span className="font-mono text-sm text-slate-500">{quote.code}</span>
          <span className="chip bg-slate-100 text-slate-500">
            {KIND_TEXT[quote.kind] ?? '—'}
          </span>
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
              {xueqiu && (
                <XueqiuLink key={quote.symbol} url={xueqiu} name={quote.name} />
              )}
              <AiAnalysisPanel
                key={quote.symbol}
                name={quote.name}
                code={quote.code}
                market={quote.market === 'HK' ? 'HK' : 'A'}
              />
              <Link
                href={`/stock/${quote.market === 'HK' ? quote.symbol : quote.code}/finance`}
                className="chip min-h-10 border border-brand-300 bg-white text-brand-700 hover:bg-brand-50 sm:min-h-8"
              >
                财务体检
              </Link>
              <StockFillButton code={quote.symbol} name={quote.name} />
              <WatchlistButton code={quote.symbol} name={quote.name} />
            </>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="w-full shrink-0 sm:w-52">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span
              className={`text-[32px] font-semibold tracking-tight tabular ${toneClass(quote.change)}`}
            >
              {price(quote.price)}
            </span>
            <span className="text-xs text-slate-500">{quote.kind === 'index' ? '点' : quote.market === 'HK' ? '港元' : '元'}</span>
            <span className={`text-sm tabular ${toneClass(quote.change)}`}>
              {signed(quote.change)}　{signedPct(quote.changePct)}
            </span>
          </div>

          <div className="mt-1 text-[11px] text-slate-500">
            {fmtTime(quote.ts)} · 数据源 {quote.source}
            {quote.market ? ` · ${quote.market}` : ''}
          </div>
        </div>

        {isStock && (
          <div className="flex min-w-0 flex-1 flex-wrap justify-start gap-x-6 gap-y-3">
            <ProfileItem label={quote.market === 'HK' ? '总市值（港元）' : '总市值（人民币）'} value={capText} />
            <ProfileItem
              label="控股股东"
              value={profile?.holder ?? '--'}

              title={
                profile?.holder && profile?.holderRatio != null
                  ? `${profile.holder}（持股 ${profile.holderRatio.toFixed(2)}%）`
                  : undefined
              }
            />
            <ProfileItem
              label="实控人"
              value={profile?.controller ?? '--'}
              title={profile?.controller ?? undefined}
            />
            <ProfileItem
              label={quote.market === 'HK' ? '所属行业' : '所属三级行业'}
              value={profile?.industry ?? '--'}
              title={profile?.industryPath ?? undefined}
              href={
                quote.market !== 'HK' && profile?.industry
                  ? `/industry?level=3&node=${encodeURIComponent(profile.industry)}`
                  : undefined
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}
