import { notFound } from 'next/navigation';
import Link from 'next/link';
import QuoteHeader from '@/components/QuoteHeader';
import ValuationSection from '@/components/ValuationSection';
import { getQuote } from '@/lib/datasource';

export const dynamic = 'force-dynamic';

export default async function StockPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;

  const symbol = /^\d{6}$/.test(code)
    ? `${/^[03]/.test(code) ? 'sz' : /^[48]/.test(code) ? 'bj' : 'sh'}${code}`
    : code;
  const quote = await getQuote(symbol).catch(() => null);
  if (!quote) notFound();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <Link href="/" className="hover:text-brand-600">
          研究工作台
        </Link>
        <span>/</span>
        <span>{quote.name}</span>
      </div>
      <QuoteHeader
        quote={quote}
        extra={
          <Link
            href={`/stock/${quote.code}/finance`}
            className="btn border-brand-300 text-brand-700"
          >
            财务体检 →
          </Link>
        }
      />

      <ValuationSection code={symbol} />
    </div>
  );
}
