import { notFound } from 'next/navigation';
import Link from 'next/link';
import QuoteHeader from '@/components/QuoteHeader';
import ValuationSection from '@/components/ValuationSection';
import AiAnalysis from '@/components/AiAnalysis';
import { getQuote } from '@/lib/datasource';
import { normalizeStockCode } from '@/lib/datasource/codes';

export const dynamic = 'force-dynamic';

export default async function StockPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;

  const symbol = normalizeStockCode(code)?.symbol ?? code;
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
      <QuoteHeader quote={quote} />

      <AiAnalysis code={quote.code} name={quote.name} />

      <ValuationSection code={symbol} />
    </div>
  );
}
