import { notFound } from 'next/navigation';
import Link from 'next/link';
import QuoteHeader from '@/components/QuoteHeader';
import ValuationSection from '@/components/ValuationSection';
import KLineSection from '@/components/KLineSection';
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

  if (quote.market === 'HK') {
    // 港股暂无 A 股财务与估值数据源，展示行情 + K 线 + AI 分析
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Link href="/" className="hover:text-brand-600">
            研究工作台
          </Link>
          <span>/</span>
          <span>{quote.name}</span>
          <span className="chip bg-slate-100 text-slate-500">港股</span>
        </div>
        <QuoteHeader quote={quote} />
        <KLineSection code={quote.symbol} prevClose={quote.prevClose} />
        <AiAnalysis code={quote.code} name={quote.name} />
        <p className="px-1 text-xs text-slate-400">
          港股暂不支持估值分位与财务报表分析（数据源覆盖范围不同），行情、K
          线与 AI 分析功能与 A 股一致。
        </p>
      </div>
    );
  }

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

      <AiAnalysis code={quote.code} name={quote.name} />

      <ValuationSection code={symbol} />
    </div>
  );
}
