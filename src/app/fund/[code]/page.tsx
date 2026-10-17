import { notFound } from 'next/navigation';
import QuoteHeader from '@/components/QuoteHeader';
import MetricGrid from '@/components/MetricGrid';
import KLineSection from '@/components/KLineSection';
import { getQuote, getKLine } from '@/lib/datasource';
import { maxDrawdown, rangeChange } from '@/lib/analytics';
import { FUNDS } from '@/lib/universe';
import { pct, price, signedPct, toneClass } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function FundPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const meta = FUNDS.find((f) => f.code === code);

  const [quote, kline] = await Promise.all([
    getQuote(code).catch(() => null),
    getKLine(code, 'day', 'qfq', 320).catch(() => null),
  ]);

  if (!quote) notFound();
  const candles = kline?.candles ?? [];

  return (
    <div className="space-y-5">
      <QuoteHeader quote={quote} />

      {meta && (
        <p className="text-sm text-slate-500">
          {meta.name} · {meta.industry} · {meta.board}
        </p>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-700">关键指标</h2>
        <MetricGrid
          cols={5}
          items={[
            { label: '今开', value: price(quote.open) },
            { label: '最高', value: price(quote.high), tone: 'up' },
            { label: '最低', value: price(quote.low), tone: 'down' },
            { label: '振幅', value: pct(quote.amplitude) },
            { label: '昨收', value: price(quote.prevClose) },
          ]}
        />
      </section>

      {candles.length > 20 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-slate-700">区间表现</h2>
          <MetricGrid
            cols={4}
            items={[
              { label: '近20日', value: signedPct(rangeChange(candles, 20)), tone: (rangeChange(candles, 20) ?? 0) > 0 ? 'up' : 'down' },
              { label: '近60日', value: signedPct(rangeChange(candles, 60)), tone: (rangeChange(candles, 60) ?? 0) > 0 ? 'up' : 'down' },
              { label: '近250日', value: signedPct(rangeChange(candles, 250)), tone: (rangeChange(candles, 250) ?? 0) > 0 ? 'up' : 'down' },
              { label: '区间最大回撤', value: pct(maxDrawdown(candles)), tone: 'down' },
            ]}
          />
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-700">历史走势</h2>
        <KLineSection code={code} prevClose={quote.prevClose} />
      </section>

      <p className="rounded bg-slate-50 p-3 text-xs leading-relaxed text-slate-500">
        场内基金（ETF/LOF）的净值与溢价率、持仓明细、跟踪误差等指标需要基金公司或专业数据商接口，
        当前版本仅展示二级市场行情与走势。接入同花顺 iFinD 后可补齐净值与持仓数据。
      </p>
    </div>
  );
}
