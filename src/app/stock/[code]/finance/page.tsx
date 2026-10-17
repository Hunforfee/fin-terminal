import Link from 'next/link';
import { nameOf } from '@/lib/universe';
import { getQuote } from '@/lib/datasource';
import FinanceTabs from '@/components/FinanceTabs';

export const dynamic = 'force-dynamic';

/** 财务体检页：真实财报指标的多维对比可视化（盈利/成长/偿债/现金流/每股） */
export default async function FinancePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const quote = await getQuote(code).catch(() => null);

  return (
    <FinanceTabs
      code={code}
      heading={
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <Link
            href={`/stock/${code}`}
            aria-label="返回估值分析"
            className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 hover:bg-slate-100"
          >
            ←
          </Link>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">
            {quote?.name ?? nameOf(code) ?? code}
          </h1>
          <span className="text-xs tabular-nums text-slate-400">{code}</span>
          <span className="text-sm text-slate-500">财务分析</span>
        </div>
      }
    />
  );
}
