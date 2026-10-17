import { notFound } from 'next/navigation';
import QuoteHeader from '@/components/QuoteHeader';
import MetricGrid from '@/components/MetricGrid';
import KLineSection from '@/components/KLineSection';
import ValuationBandChart from '@/components/ValuationBandChart';
import { getQuote, getKLine, getValuation, getMarketOverview } from '@/lib/datasource';
import { annualVolatility, maxDrawdown, rangeChange } from '@/lib/analytics';
import { INDICES } from '@/lib/universe';
import { pct, percentileLabel, price, signedPct, toneClass } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function IndexPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const meta = INDICES.find((i) => i.code === code);

  const [quote, kline, valuation, market] = await Promise.all([
    getQuote(code).catch(() => null),
    getKLine(code, 'day', 'none', 640).catch(() => null),
    getValuation(code, 10).catch(() => null),
    getMarketOverview().catch(() => null),
  ]);

  if (!quote) notFound();
  const candles = kline?.candles ?? [];
  const peLabel = percentileLabel(valuation?.pePercentile ?? null);

  return (
    <div className="space-y-5">
      <QuoteHeader quote={quote} />

      {meta?.desc && <p className="text-sm text-slate-500">{meta.desc}</p>}

      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-700">关键指标</h2>
        <MetricGrid
          cols={6}
          items={[
            { label: '今开', value: price(quote.open) },
            { label: '最高', value: price(quote.high), tone: 'up' },
            { label: '最低', value: price(quote.low), tone: 'down' },
            { label: '振幅', value: pct(quote.amplitude) },
            { label: '昨收', value: price(quote.prevClose) },
            { label: '52周区间', value: quote.low52w && quote.high52w ? `${price(quote.low52w)} ~ ${price(quote.high52w)}` : '--' },
          ]}
        />
      </section>

      {candles.length > 20 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-slate-700">区间表现</h2>
          <MetricGrid
            cols={5}
            items={[
              { label: '近20日', value: signedPct(rangeChange(candles, 20)), tone: (rangeChange(candles, 20) ?? 0) > 0 ? 'up' : 'down' },
              { label: '近60日', value: signedPct(rangeChange(candles, 60)), tone: (rangeChange(candles, 60) ?? 0) > 0 ? 'up' : 'down' },
              { label: '近250日', value: signedPct(rangeChange(candles, 250)), tone: (rangeChange(candles, 250) ?? 0) > 0 ? 'up' : 'down' },
              { label: '年化波动率', value: pct(annualVolatility(candles)) },
              { label: '区间最大回撤', value: pct(maxDrawdown(candles)), tone: 'down' },
            ]}
          />
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-700">历史走势</h2>
        <KLineSection code={code} isIndex prevClose={quote.prevClose} />
      </section>

      {valuation && valuation.history.length > 10 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-slate-700">指数估值</h2>
          <div className="card-pad">
            <div className="mb-3 grid gap-3 sm:grid-cols-3">
              <div>
                <div className="label">指数 PE</div>
                <div className="value">{quote.pe ? quote.pe.toFixed(2) : '--'}</div>
                <div className={`text-xs ${peLabel.cls}`}>{peLabel.text}</div>
              </div>
              <div>
                <div className="label">近250日</div>
                <div className={`value ${toneClass(rangeChange(candles, 250))}`}>{signedPct(rangeChange(candles, 250))}</div>
              </div>
              <div>
                <div className="label">数据源</div>
                <div className="value text-sm">{quote.source}</div>
              </div>
            </div>
            <ValuationBandChart
              history={valuation.history}
              pe={valuation.pe}
              pb={valuation.pb}
              pePercentile={valuation.pePercentile}
              pbPercentile={valuation.pbPercentile}
            />
            <p className="mt-3 rounded bg-slate-50 p-2.5 text-xs leading-relaxed text-slate-500">
              指数的历史 PE 由「点位 ÷ 回溯 EPS」估算，回溯增速取 0（指数 EPS 序列无法从公开行情接口获得），
              因此这里的分位反映的是<b>点位相对自身历史的估值位置</b>，请结合盈利周期一起看。
            </p>
          </div>
        </section>
      )}

      {market && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-slate-700">其他指数</h2>
          <div className="card divide-y divide-slate-50">
            {market.indices
              .filter((i) => i.code !== code)
              .map((q) => (
                <a key={q.symbol} href={`/index/${q.code}`} className="flex items-center justify-between px-3 py-2 hover:bg-slate-50">
                  <span className="text-sm text-slate-800">{q.name}</span>
                  <span className="flex items-baseline gap-3">
                    <span className={`text-sm tabular ${toneClass(q.change)}`}>{price(q.price)}</span>
                    <span className={`w-16 text-right text-xs tabular ${toneClass(q.changePct)}`}>
                      {signedPct(q.changePct)}
                    </span>
                  </span>
                </a>
              ))}
          </div>
        </section>
      )}
    </div>
  );
}
