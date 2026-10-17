'use client';

import WatchlistTable from '@/components/WatchlistTable';
import { useWatchlist } from '@/components/WatchlistProvider';

export default function WatchlistPage() {
  const { codes, ready, clear } = useWatchlist();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">我的自选</h1>
          <p className="mt-1 text-xs text-slate-500">
            自选保存在本地浏览器（localStorage），无需登录。共 {ready ? codes.length : '-'} 个标的。
          </p>
        </div>
        {ready && codes.length > 0 && (
          <button onClick={clear} className="btn">
            清空自选
          </button>
        )}
      </div>

      <WatchlistTable removable />

      <p className="text-xs text-slate-400">
        提示：在个股 / 指数详情页点「加自选」，或在条件选股结果中点「☆ 自选」即可加入本列表。
      </p>
    </div>
  );
}
