import Link from 'next/link';
import { price, signedPct, toneClass } from '@/lib/format';
import type { Quote } from '@/lib/datasource/types';

/** 顶部指数条 */
export default function IndexBar({ indices }: { indices: Quote[] }) {
  if (indices.length === 0) return null;
  return (
    <div className="card flex flex-wrap divide-x divide-slate-100 overflow-hidden">
      {indices.map((q) => (
        <Link
          key={q.symbol}
          href={`/index/${q.code}`}
          className="min-w-[150px] flex-1 px-4 py-3 transition hover:bg-slate-50"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-xs text-slate-500">{q.name}</span>
            {q.stale && <span className="chip bg-amber-100 text-amber-700">快照</span>}
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className={`text-lg font-semibold tabular ${toneClass(q.change)}`}>{price(q.price)}</span>
            <span className={`text-xs tabular ${toneClass(q.change)}`}>{signedPct(q.changePct)}</span>
          </div>
        </Link>
      ))}
    </div>
  );
}
