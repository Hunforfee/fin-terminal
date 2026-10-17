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
    <div className="space-y-6">
      <Link
        href={`/stock/${code}`}
        className="inline-flex min-h-10 items-center text-sm text-slate-500 hover:text-brand-600"
      >
        ← 返回估值分析 · {code}
      </Link>
      <div>
        <div className="flex items-center gap-2">
          <h1 className="page-title">
            {quote?.name ?? nameOf(code) ?? code}
            <span className="ml-3 text-base font-normal text-slate-500">财务分析</span>
          </h1>
        </div>
      </div>

      <FinanceTabs code={code} />
    </div>
  );
}
