import Link from 'next/link';
import { getQuotes } from '@/lib/datasource';
import { FUNDS } from '@/lib/universe';
import { price, signedPct, toneClass } from '@/lib/format';

export const dynamic = 'force-dynamic';

/** 基金 / ETF 列表 */
export default async function FundListPage() {
  const quotes = await getQuotes(FUNDS.map((f) => f.code)).catch(() => []);
  const metaMap = new Map(FUNDS.map((f) => [f.code, f]));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">基金 / ETF</h1>
        <p className="mt-1 text-xs text-slate-500">
          场内基金二级市场行情，按代码排序。点击可查看历史走势与区间表现。
        </p>
      </div>

      <div className="card overflow-x-auto">
        <table className="min-w-full">
          <thead className="border-b border-slate-100 bg-slate-50/60">
            <tr>
              <th className="th">名称 / 代码</th>
              <th className="th">分类</th>
              <th className="th">最新价</th>
              <th className="th">涨跌幅</th>
              <th className="th">今开</th>
              <th className="th">最高</th>
              <th className="th">最低</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {quotes.length === 0 && (
              <tr>
                <td colSpan={7} className="td py-8 text-center text-slate-400">
                  暂无行情数据
                </td>
              </tr>
            )}
            {quotes.map((q) => (
              <tr key={q.symbol} className="hover:bg-slate-50/60">
                <td className="td">
                  <Link href={`/fund/${q.code}`} className="hover:text-brand-600">
                    <div className="font-medium text-slate-900">{q.name}</div>
                    <div className="font-mono text-xs text-slate-400">{q.code}</div>
                  </Link>
                </td>
                <td className="td text-xs text-slate-500">{metaMap.get(q.code)?.industry ?? '--'}</td>
                <td className={`td font-medium ${toneClass(q.change)}`}>{price(q.price)}</td>
                <td className={`td ${toneClass(q.changePct)}`}>{signedPct(q.changePct)}</td>
                <td className="td text-slate-500">{price(q.open)}</td>
                <td className="td text-slate-500">{price(q.high)}</td>
                <td className="td text-slate-500">{price(q.low)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
