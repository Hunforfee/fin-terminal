import type { ReactNode } from 'react';

export interface Metric {
  label: string;
  value: ReactNode;
  /** 值的颜色语义 */
  tone?: 'up' | 'down' | 'flat' | 'none';
  hint?: string;
}

/** 指标卡片网格 */
export default function MetricGrid({ items, cols = 4 }: { items: Metric[]; cols?: number }) {
  const cls: Record<number, string> = {
    2: 'grid-cols-2',
    3: 'grid-cols-2 sm:grid-cols-3',
    4: 'grid-cols-2 sm:grid-cols-4',
    5: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5',
    6: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-6',
  };
  const toneCls = { up: 'c-up', down: 'c-down', flat: 'c-flat', none: 'text-slate-900' };

  return (
    <div className={`grid gap-3 ${cls[cols] ?? cls[4]}`}>
      {items.map((m, i) => (
        <div key={`${m.label}-${i}`} className="card px-3 py-2.5">
          <div className="label" title={m.hint}>
            {m.label}
          </div>
          <div className={`mt-0.5 text-base font-semibold tabular ${toneCls[m.tone ?? 'none']}`}>{m.value}</div>
        </div>
      ))}
    </div>
  );
}
