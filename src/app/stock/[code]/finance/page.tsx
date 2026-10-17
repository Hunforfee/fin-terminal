import Link from 'next/link';
import FinanceTabs from '@/components/FinanceTabs';

export const dynamic = 'force-dynamic';

/** 财务体检页：真实财报指标的多维对比可视化（盈利/成长/偿债/现金流/每股） */
export default async function FinancePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-slate-900">财务体检</h1>
          <span className="chip bg-emerald-100 text-emerald-700">真实财报口径</span>
        </div>
        <p className="mt-1 text-xs text-slate-500">
          盈利能力 · 成长性 · 偿债能力 · 现金流 · 每股指标，共 21 项披露指标，支持双公司对比与理杏仁式合并报表（指标 × 报告期、同比/环比、多公司并列、导出 CSV）。
        </p>
      </div>

      <FinanceTabs code={code} />
    </div>
  );
}
