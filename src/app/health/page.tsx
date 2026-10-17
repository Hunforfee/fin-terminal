import { health } from '@/lib/datasource';

export const dynamic = 'force-dynamic';

/** 数据源体检页：如实展示每个 Provider 的可用性与延迟 */
export default async function HealthPage() {
  const res = await health().catch(() => null);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">数据源状态</h1>
        <p className="mt-1 text-xs text-slate-500">
          本页实时探测各上游接口的连通性。数据源按优先级降级：腾讯 → 新浪 → 本地快照。
        </p>
      </div>

      <div className="card overflow-x-auto">
        <table className="min-w-full">
          <thead className="border-b border-slate-100 bg-slate-50/60">
            <tr>
              <th className="th">数据源</th>
              <th className="th">用途</th>
              <th className="th">状态</th>
              <th className="th">延迟</th>
              <th className="th">说明</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {(res?.providers ?? []).map((p) => (
              <tr key={p.name} className="hover:bg-slate-50/60">
                <td className="td font-medium text-slate-900">{p.name}</td>
                <td className="td text-xs text-slate-600">{p.label}</td>
                <td className="td">
                  {p.reserved ? (
                    <span className="chip bg-slate-100 text-slate-500">预留未启用</span>
                  ) : p.ok ? (
                    <span className="chip bg-emerald-100 text-emerald-700">可用</span>
                  ) : (
                    <span className="chip bg-red-100 text-red-700">不可用</span>
                  )}
                </td>
                <td className="td text-xs text-slate-500">{p.latencyMs !== null ? `${p.latencyMs} ms` : '--'}</td>
                <td className="td whitespace-normal text-xs text-slate-500">{p.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card-pad text-xs leading-relaxed text-slate-600">
        <h2 className="mb-1.5 text-sm font-semibold text-slate-800">关于数据口径</h2>
        <ul className="list-inside list-disc space-y-1">
          <li>
            <b>行情 / K 线</b>：腾讯财经为主，新浪财经备用，均为公开接口实时抓取，不落库。
          </li>
          <li>
            <b>搜索联想</b>：东方财富 suggest 接口 + 腾讯 smartbox，双源合并去重。
          </li>
          <li>
            <b>估值与 ROE</b>：ROE = PB ÷ PE 是严格恒等式；净利润 = 市值 ÷ PE、净资产 = 市值 ÷ PB 同理。
            这三项与行情估值精度等价，属于「真实派生」。
          </li>
          <li>
            <b>历史 PE 分位</b>：缺少历史 EPS 序列，采用「当前 TTM EPS + PE(静)/PE(动) 反解增速」回溯估算，
            页面中已明确标注，请勿用于精确回测。
          </li>
          <li>
            <b>三表财务（营收 / 毛利率 / 负债率）</b>：需同花顺 iFinD 等合规财务源。配置{' '}
            <code className="rounded bg-slate-100 px-1">IFIND_BASE_URL</code> 与{' '}
            <code className="rounded bg-slate-100 px-1">IFIND_TOKEN</code> 后自动切换为真实财报口径，
            无需改动任何业务代码。
          </li>
        </ul>
      </div>
    </div>
  );
}
