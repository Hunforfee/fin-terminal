import { notFound } from 'next/navigation';
import Link from 'next/link';
import QuoteHeader from '@/components/QuoteHeader';
import ValuationSection from '@/components/ValuationSection';
import AiAnalysis from '@/components/AiAnalysis';
import { getQuote } from '@/lib/datasource';

export const dynamic = 'force-dynamic';

export default async function StockPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;

  // 港股：hk00700 / 00700 / 0700.hk；A 股：6 位数字
  const isHk = /^(hk)?\d{1,5}(\.hk)?$/i.test(code) && !/^\d{6}$/.test(code);
  const symbol = isHk
    ? `hk${(/(\d{1,5})(?:\.hk)?$/i.exec(code)?.[1] ?? code).padStart(5, '0')}`
    : /^\d{6}$/.test(code)
      ? `${/^[03]/.test(code) ? 'sz' : /^[48]/.test(code) ? 'bj' : 'sh'}${code}`
      : code;
  const quote = await getQuote(symbol).catch(() => null);
  if (!quote) notFound();

  const isHkQuote = quote.market === 'HK';

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <Link href="/" className="hover:text-brand-600">
          研究工作台
        </Link>
        <span>/</span>
        <span>{quote.name}</span>
        {isHkQuote && <span className="chip bg-slate-100 text-slate-500">港股</span>}
      </div>
      <QuoteHeader
        quote={quote}
        extra={
          <Link
            href={`/stock/${isHkQuote ? quote.symbol : quote.code}/finance`}
            className="btn border-brand-300 text-brand-700"
          >
            财务体检 →
          </Link>
        }
      />

      <AiAnalysis code={quote.code} name={quote.name} />

      <ValuationSection code={symbol} />
    </div>
  );
}
