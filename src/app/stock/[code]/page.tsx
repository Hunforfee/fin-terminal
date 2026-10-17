import { notFound } from 'next/navigation';
import Link from 'next/link';
import QuoteHeader from '@/components/QuoteHeader';
import ValuationSection from '@/components/ValuationSection';
import { getQuote } from '@/lib/datasource';

export const dynamic = 'force-dynamic';

export default async function StockPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;

  const quote = await getQuote(code).catch(() => null);
  if (!quote) notFound();

  return (
    <div className="space-y-5">
      <QuoteHeader
        quote={quote}
        extra={
          <Link href={`/stock/${code}/finance`} className="btn border-brand-300 text-brand-700">
            财务体检 →
          </Link>
        }
      />

      <ValuationSection code={code} />
    </div>
  );
}
