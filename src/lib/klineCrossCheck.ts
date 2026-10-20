import type { KLineSeries } from './datasource/types';
export class MarketDataConflict extends Error {
  constructor(public readonly differences: { date: string; priceDelta: number }[]) {
    super('已结束交易日K线来源存在差异，暂停更新等待复核'); this.name = 'MarketDataConflict';
  }
}
/** A-share raw stock prices only. Do not apply these ticks/units to HK/indices/adjusted prices. */
export function crossCheckMainlandRaw(a: KLineSeries, b: KLineSeries, today: string): KLineSeries {
  if (a.symbol !== b.symbol || a.period !== b.period || a.adjust !== 'none' || b.adjust !== 'none')
    throw Error('交叉校验的证券或价格口径不一致');
  const second = new Map(b.candles.filter(c => c.date < today).map(c => [c.date, c]));
  const common = a.candles.filter(c => c.date < today && second.has(c.date));
  // Week/month bars remain mutable until their bucket closes. Do not compare them
  // against snapshots taken at a different intraday time.
  const completed = a.period === 'day' ? common : common.slice(0, -1);
  const differences = completed.flatMap(c => {
    const other = second.get(c.date)!;
    const priceDelta = Math.max(...(['open', 'high', 'low', 'close'] as const).map(k => Math.abs(c[k] - other[k])));
    return priceDelta > 0.000001 ? [{ date: c.date, priceDelta }] : [];
  });
  if (differences.length) throw new MarketDataConflict(differences);
  return completed.length ? { ...a, quality: { level: 'cross-source-sample', sources: [a.source, b.source],
    matchedBars: completed.length, checkedThrough: completed.at(-1)?.date, sampleOnly: true } } : a;
}
