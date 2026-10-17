'use client';

import Link from 'next/link';
import QuoteTable from '@/components/QuoteTable';
import { useWatchlist } from '@/components/WatchlistProvider';

/** 自选列表：从 localStorage 读代码，再批量拉行情 */
export default function WatchlistTable({ removable = false }: { removable?: boolean }) {
  const { codes, ready } = useWatchlist();

  if (!ready) return <div className="card-pad text-sm text-slate-400">加载中…</div>;

  return (
    <QuoteTable
      codes={codes}
      removable={removable}
      emptyText={
        <span>
          自选为空。在个股页点「加自选」，或
          <Link href="/screener" className="ml-1 text-brand-600 hover:underline">
            去条件选股挑几只
          </Link>
        </span>
      }
    />
  );
}
