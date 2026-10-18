'use client';

import { useState } from 'react';
import FinanceExplorer from './FinanceExplorer';
import FinanceTable from './FinanceTable';

/**
 * 财务体检页视图切换：
 *   - 图表体检：理杏仁式指标卡 + 双公司对比图（原 FinanceExplorer）
 *   - 合并报表：理杏仁式财务报表表格（指标 × 报告期，数值/同比/环比，导出 CSV）
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
    ['chart', '📈 指标趋势'],
    ['table', '📋 合并报表'],
  ] as const;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        {heading}
        <div role="group" aria-label="财报视图" className="flex gap-1.5">
          {TABS.map(([k, label]) => (
            <button
              key={k}
              onClick={() => setView(k)}
              aria-pressed={view === k}
              className={`rounded-lg px-4 py-1.5 text-sm font-semibold shadow-sm transition ${
                view === k
                  ? 'bg-brand-600 text-white shadow-brand-600/20 ring-2 ring-brand-600 ring-offset-1'
                  : 'border border-slate-300 bg-white text-slate-600 hover:border-brand-400 hover:text-brand-600'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {view === 'chart' ? <FinanceExplorer code={code} /> : <FinanceTable code={code} />}
    </div>
  );
}
