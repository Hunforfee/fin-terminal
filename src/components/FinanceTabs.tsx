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

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {heading}
        <div role="group" aria-label="财报视图" className="segmented">
          {(
            [
              ['chart', '指标趋势'],
              ['table', '合并报表'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setView(k)}
              aria-pressed={view === k}
              className={`segment ${view === k ? 'segment-active' : ''}`}
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
