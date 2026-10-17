'use client';

import { useState } from 'react';
import FinanceExplorer from './FinanceExplorer';
import FinanceTable from './FinanceTable';

/**
 * 财务体检页视图切换：
 *   - 图表体检：理杏仁式指标卡 + 双公司对比图（原 FinanceExplorer）
 *   - 合并报表：理杏仁式财务报表表格（指标 × 报告期，数值/同比/环比，导出 CSV）
 */
export default function FinanceTabs({ code }: { code: string }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1">
        {(
          [
            ['chart', '图表体检'],
            ['table', '合并报表'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setView(k)}
            className={`rounded px-3 py-1.5 text-xs font-medium transition ${
              view === k ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {view === 'chart' ? <FinanceExplorer code={code} /> : <FinanceTable code={code} />}
    </div>
  );
}
