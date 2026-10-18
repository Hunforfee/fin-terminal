import { notFound } from 'next/navigation';
import QuoteHeader from '@/components/QuoteHeader';
import ValuationSection from '@/components/ValuationSection';
import { getQuote } from '@/lib/datasource';
import { normalizeStockCode } from '@/lib/datasource/codes';

export const dynamic = 'force-dynamic';

export default async function StockPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;

  const symbol = normalizeStockCode(code)?.symbol ?? code;
  const quote = await getQuote(symbol).catch(() => null);
  if (!quote) notFound();

  return (
    <div className="space-y-6">
      <QuoteHeader quote={quote} />

      <ValuationSection code={symbol} />
    </div>
  );
}
