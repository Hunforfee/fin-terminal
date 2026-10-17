import type { NextRequest } from 'next/server';
import { ok, fail, sp } from '@/lib/api';
import { getQuotes } from '@/lib/datasource';
import { findSwNode, swStats, SW2021 } from '@/lib/sw2021';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 行业节点 + 实时行情后的成分股 */
export interface ConstituentRow {
  code: string;
  name: string;
  price: number | null;
  changePct: number | null;
  pe: number | null;
  pb: number | null;
  roe: number | null;
  totalMarketCap: number | null;
  turnoverRate: number | null;
}

/** 6 位代码 → 带市场前缀的 symbol（沪 6/9 开头，深 0/3 开头，北 4/8/9 开头） */
function toSymbol(code: string): string {
  if (/^[69]/.test(code)) return `sh${code}`;
  if (/^[48]/.test(code)) return `bj${code}`;
  return `sz${code}`;
}

/**
 * GET /api/sw-industry
 *   ?node=白酒Ⅱ&level=3      —— 指定行业节点，返回其成分股（含实时行情）
 *   ?tree=1                    —— 只返回三层分类树（无行情，轻量）
 *
 * 说明：不剔除亏损股，PE 为负照常返回。
 */
export async function GET(request: NextRequest) {
  const p = sp(request);

  if (p.get('tree') === '1') {
    return ok({
      version: SW2021.version,
      stats: swStats(),
      industries: SW2021.industries.map((l1) => ({
        name: l1.name,
        count: l1.count,
        children: (l1.children ?? []).map((l2) => ({
          name: l2.name,
          count: l2.count,
          children: (l2.children ?? []).map((l3) => ({ name: l3.name, count: l3.count })),
        })),
      })),
    });
  }

  const name = p.get('node');
  if (!name) {
    // 无参数：返回一级行业列表 + 各自成分股数量
    return ok({
      version: SW2021.version,
      stats: swStats(),
      industries: SW2021.industries.map((n) => ({ name: n.name, count: n.count })),
    });
  }

  const lvRaw = Number(p.get('level'));
  const level = lvRaw === 2 ? 2 : lvRaw === 3 ? 3 : 1;
  const node = findSwNode(name, level as 1 | 2 | 3) ?? findSwNode(name);
  if (!node) return fail(`未找到行业「${name}」`, 404);

  const codes = node.stocks;
  if (codes.length === 0) {
    return ok({
      node: { name: node.name, level: node.level, l1: node.l1, l2: node.l2 ?? null },
      count: 0,
      rows: [] as ConstituentRow[],
      note: '该行业在数据源侧无独立成分股（申万二级银行细分与「银行Ⅱ」合并），可查看同一级下的其他行业。',
    });
  }

  try {
    // 必须带市场前缀：000001 既可能是上证指数（sh000001）也可能是平安银行（sz000001），
    // 只传裸代码会被指数白名单抢先解析，导致行业里混入指数行情。
    const symbols = codes.map(toSymbol);
    const quotes = await getQuotes(symbols);
    const rows: ConstituentRow[] = quotes
      .filter((q) => q.kind !== 'index')
      .map((q) => ({
        code: q.code,
        name: q.name,
        price: q.price,
        changePct: q.changePct,
        pe: q.pe,
        pb: q.pb,
        // ROE 由 PB/PE 恒等式派生；亏损股 PE 为负 → ROE 无法由该式还原，置空
        roe: q.pe !== null && q.pb !== null && q.pe > 0 && q.pb > 0 ? (q.pb / q.pe) * 100 : null,
        totalMarketCap: q.totalMarketCap,
        turnoverRate: q.turnoverRate,
      }))
      .sort((a, b) => (b.totalMarketCap ?? 0) - (a.totalMarketCap ?? 0));

    return ok({
      node: { name: node.name, level: node.level, l1: node.l1, l2: node.l2 ?? null },
      count: rows.length,
      declared: node.count,
      rows,
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : '成分股行情获取失败', 502, e);
  }
}
