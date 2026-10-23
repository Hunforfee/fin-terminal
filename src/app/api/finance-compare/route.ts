import { HISTORY_YEARS } from '@/lib/marketHistoryPlan';
import type { NextRequest } from 'next/server';
import { marketOk, fail, sp } from '@/lib/api';
import { getFinancialCompare, getCustomFinancialCompare } from '@/lib/datasource';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/finance-compare?codes=600519,000858&years=6&granularity=semi
 *     /api/finance-compare?codes=...&fields=bs_%E8%B4%A7%E5%B8%81%E8%B5%84%E9%87%91,roe
 * 不带 fields 时返回 21 项精选财务指标；带 fields 时按自定义字段（三大报表 + 指标）返回。
 */
async function readComparison(p: URLSearchParams) {
  const codes = p.get('codes');
  if (!codes) return fail('缺少 codes 参数，如 codes=600519,000858', 400);

  const list = codes.split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return fail('codes 为空', 400);
  if (list.length > 4) return fail('最多支持四家公司对比', 400);

  // 默认显示 10 年；12 年仍为上可选上限（HISTORY_YEARS），存储保留策略不变
  const years = Math.min(Math.max(Number(p.get('years') ?? 10) || 10, 1), HISTORY_YEARS);
  const gRaw = p.get('granularity');
  const granularity: 'annual' | 'semi' | 'quarter' =
    gRaw === 'annual' ? 'annual' : gRaw === 'quarter' ? 'quarter' : 'semi';

  const fieldsParam = p.get('fields');
  const fields = (fieldsParam ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (fields.length > 512) return fail('最多支持 512 个原始字段', 400);

  try {
    if (fields.length > 0) {
      return await marketOk(() => getCustomFinancialCompare(list, fields, years, granularity));
    }
    return await marketOk(() => getFinancialCompare(list, years, granularity));
  } catch (e) {
    return fail(e instanceof Error ? e.message : '财务对比数据获取失败', 502, e);
  }
}


export async function GET(request: NextRequest) { return readComparison(sp(request)); }

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object') return fail('请求体必须为 JSON 对象', 400);
    const join = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === 'string') ? v.join(',') : typeof v === 'string' ? v : '';
    return readComparison(new URLSearchParams({ codes: join(body.codes), fields: join(body.fields),
      years: String(body.years ?? 10), granularity: String(body.granularity ?? 'semi') }));
  } catch { return fail('无效的 JSON 请求', 400); }
}
