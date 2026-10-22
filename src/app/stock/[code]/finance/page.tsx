import { nameOf } from '@/lib/universe';
import { StockLink } from '@/components/StockLink';
import { getQuote } from '@/lib/datasource';
import { normalizeStockCode } from '@/lib/datasource/codes';
import FinanceTabs from '@/components/FinanceTabs';

export const dynamic = 'force-dynamic';

/** 财务体检页：真实财报指标的多维对比可视化（盈利/成长/偿债/现金流/每股） */
export default async function FinancePage({ params, searchParams }: { params: Promise<{ code: string }>; searchParams: Promise<{ view?: string }> }) {
  const [{ code }, query] = await Promise.all([params, searchParams]);
  const symbol = normalizeStockCode(code)?.symbol ?? code;
  const quote = await getQuote(symbol).catch(() => null);

  return (
    <FinanceTabs
      code={code}
      initialView={query.view === 'table' ? 'table' : 'chart'}
      heading={
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <StockLink
            href={`/stock/${symbol}`}
            aria-label="返回估值分析"
            className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 hover:bg-slate-100"
          >
            ←
          </StockLink>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">
            {quote?.name ?? nameOf(code) ?? code}
          </h1>
          <span className="text-xs tabular-nums text-slate-400">{code}</span>
        </div>
      }
    />
  );
}
