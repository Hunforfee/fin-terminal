'use client';

import { useState } from 'react';
import FinanceExplorer from './FinanceExplorer';
import FinanceTable from './FinanceTable';

/**
 * 财务体检页视图切换：
 *   - 图表体检：理杏仁式指标卡 + 双公司对比图（原 FinanceExplorer）
 *   - 账务报表：理杏仁式财务报表表格（指标 × 报告期，数值/同比/环比，导出 CSV）
 */
export default function FinanceTabs({
  code,
  heading,
}: {
  code: string;
  heading?: React.ReactNode;
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart');

  const TABS = [
    ['chart', '指标趋势'],
    ['table', '账务报表'],
  ] as const;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        {heading}
        <div
          role="group"
          aria-label="财报视图"
          className="flex items-center gap-1.5"
        >
          {TABS.map(([k, label]) => (
            <button
              key={k}
              onClick={() => setView(k)}
              aria-pressed={view === k}
              className={`min-h-9 rounded-md border px-3.5 py-1.5 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 ${
                view === k
                  ? 'border-brand-200 bg-brand-100 text-brand-700'
                  : 'border-slate-200 bg-white text-slate-700 hover:border-brand-200 hover:bg-brand-50 hover:text-brand-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {view === 'chart' ? (
        <FinanceExplorer code={code} />
      ) : (
        <FinanceTable code={code} />
      )}
    </div>
  );
}
