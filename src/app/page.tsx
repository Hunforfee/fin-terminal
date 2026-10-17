import Link from 'next/link';
import IndexBar from '@/components/IndexBar';
import WatchlistTable from '@/components/WatchlistTable';
import { getMarketOverview, getQuotes } from '@/lib/datasource';
import { INDUSTRIES, STOCKS } from '@/lib/universe';
import { price, signedPct, toneClass } from '@/lib/format';
import type { Quote } from '@/lib/datasource/types';

export const dynamic = 'force-dynamic';

/** 首页：大盘概览 + 涨跌幅榜 + 行业板块 + 自选 */
export default async function HomePage() {
  const [market, hotQuotes] = await Promise.all([
    getMarketOverview().catch(() => null),
    getQuotes(STOCKS.map((s) => s.code)).catch(() => [] as Quote[]),
  ]);

  const valid = hotQuotes.filter((q) => q.changePct !== null);
  const gainers = [...valid].sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0)).slice(0, 8);
  const losers = [...valid].sort((a, b) => (a.changePct ?? 0) - (b.changePct ?? 0)).slice(0, 8);

  // 行业板块：按行业聚合平均涨跌幅
  const industryMap = new Map(STOCKS.map((s) => [s.code, s.industry]));
  const bucket = new Map<string, number[]>();
  for (const q of valid) {
    const ind = industryMap.get(q.code);
    if (!ind) continue;
    const arr = bucket.get(ind) ?? [];
    arr.push(q.changePct ?? 0);
    bucket.set(ind, arr);
  }
  const sectors = Array.from(bucket.entries())
    .map(([ind, arr]) => ({ industry: ind, avg: arr.reduce((a, b) => a + b, 0) / arr.length, count: arr.length }))
    .sort((a, b) => b.avg - a.avg);

  return (
    <div className="space-y-5">
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700">大盘指数</h2>
          {market?.updatedAt && (
            <span className="text-xs text-slate-400">
              更新于 {new Date(market.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
            </span>
          )}
        </div>
        {market ? (
          <IndexBar indices={market.indices} />
        ) : (
          <div className="card-pad text-sm text-amber-700">
            暂时无法获取大盘数据，请检查网络或前往「数据源」页查看各接口状态。
          </div>
        )}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <RankList title="涨幅榜" quotes={gainers} />
        <RankList title="跌幅榜" quotes={losers} />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-700">行业板块（按平均涨跌幅）</h2>
        <div className="card grid grid-cols-2 gap-px overflow-hidden bg-slate-100 sm:grid-cols-3 lg:grid-cols-5">
          {sectors.length === 0 && <div className="col-span-full bg-white p-4 text-sm text-slate-400">暂无数据</div>}
          {sectors.map((s) => (
            <Link
              key={s.industry}
              href={`/screener?industry=${encodeURIComponent(s.industry)}`}
              className="bg-white px-3 py-2.5 transition hover:bg-slate-50"
            >
              <div className="truncate text-xs text-slate-500">{s.industry}</div>
              <div className={`mt-0.5 text-sm font-semibold tabular ${toneClass(s.avg)}`}>{signedPct(s.avg)}</div>
              <div className="text-[10px] text-slate-400">{s.count} 只样本</div>
            </Link>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-slate-400">样本为各行业龙头股（共 {STOCKS.length} 只），非全市场统计。</p>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700">我的自选</h2>
          <Link href="/watchlist" className="text-xs text-brand-600 hover:underline">
            管理自选 →
          </Link>
        </div>
        <WatchlistTable />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-700">按行业筛选</h2>
        <div className="flex flex-wrap gap-1.5">
          {INDUSTRIES.map((i) => (
            <Link
              key={i}
              href={`/screener?industry=${encodeURIComponent(i)}`}
              className="rounded border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 transition hover:border-brand-300 hover:text-brand-600"
            >
              {i}
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}

function RankList({ title, quotes }: { title: string; quotes: Quote[] }) {
  return (
    <div>
      <h2 className="mb-2 text-sm font-semibold text-slate-700">{title}</h2>
      <div className="card divide-y divide-slate-50">
        {quotes.length === 0 && <div className="p-4 text-sm text-slate-400">暂无数据</div>}
        {quotes.map((q) => (
          <Link
            key={q.symbol}
            href={`/stock/${q.code}`}
            className="flex items-center justify-between px-3 py-2 transition hover:bg-slate-50"
          >
            <div className="min-w-0">
              <div className="truncate text-sm text-slate-800">{q.name}</div>
              <div className="font-mono text-xs text-slate-400">{q.code}</div>
            </div>
            <div className="text-right">
              <div className={`text-sm font-medium tabular ${toneClass(q.change)}`}>{price(q.price)}</div>
              <div className={`text-xs tabular ${toneClass(q.changePct)}`}>{signedPct(q.changePct)}</div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
