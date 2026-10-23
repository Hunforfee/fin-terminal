import { HISTORY_YEARS } from '@/lib/marketHistoryPlan';
import type { NextRequest } from 'next/server';
import { after } from 'next/server';
import { marketOk, fail, sp } from '@/lib/api';
import { getValuation } from '@/lib/datasource';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/valuation?code=600519&years=12&method=disclosure
 *   估值指标 + 真实历史序列 + 分位（默认 12 年）
 *   method=disclosure（默认，当日披露即纳入，理杏仁公司估值口径）
 *         =cutoff    （法定披露截止日次日统一切换，中证/国证指数口径）
 */
export async function GET(request: NextRequest) {
  const p = sp(request);
  const code = p.get('code');
  if (!code) return fail('缺少 code 参数', 400);
  // 默认显示 10 年；12 年仍为上可选上限（HISTORY_YEARS），存储保留策略不变
  const years = Math.min(Math.max(Number(p.get('years') ?? 10) || 10, 1), HISTORY_YEARS);
  const method = p.get('method') === 'cutoff' ? 'cutoff' : 'disclosure';
  try {
    return await marketOk(() => getValuation(code, years, method, {schedule:work=>after(work)}));
  } catch (e) {
    return fail(e instanceof Error ? e.message : '估值计算失败', 502, e);
  }
}
