import type { NextRequest } from 'next/server';
import { ok, fail, sp } from '@/lib/api';
import { getFinancialCompare, getCustomFinancialCompare } from '@/lib/datasource';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/finance-compare?codes=600519,000858&years=6&granularity=semi
 *     /api/finance-compare?codes=...&fields=bs_%E8%B4%A7%E5%B8%81%E8%B5%84%E9%87%91,roe
 * 不带 fields 时返回 21 项精选财务指标；带 fields 时按自定义字段（三大报表 + 指标）返回。
 */
export async function GET(request: NextRequest) {
  const p = sp(request);
  const codes = p.get('codes');
  if (!codes) return fail('缺少 codes 参数，如 codes=600519,000858', 400);

  const list = codes.split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return fail('codes 为空', 400);
  if (list.length > 2) return fail('最多支持两家公司对比', 400);

  const years = Math.min(Math.max(Number(p.get('years') ?? 10) || 10, 1), 10);
  const gRaw = p.get('granularity');
  const granularity: 'annual' | 'semi' | 'quarter' =
    gRaw === 'annual' ? 'annual' : gRaw === 'quarter' ? 'quarter' : 'semi';

  const fieldsParam = p.get('fields');
  const fields = (fieldsParam ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 36);

  try {
    if (fields.length > 0) {
      return ok(await getCustomFinancialCompare(list, fields, years, granularity));
    }
    return ok(await getFinancialCompare(list, years, granularity));
  } catch (e) {
    return fail(e instanceof Error ? e.message : '财务对比数据获取失败', 502, e);
  }
}
