import type { NextRequest } from 'next/server';
import { ok, fail, sp } from '@/lib/api';
import { getIndustryQuotes } from '@/lib/datasource';
import type { Quote } from '@/lib/datasource/types';
import { summarizeIndustry, type IndustryResearchRow } from '@/lib/industryResearch';
import {
  HK_INDUSTRIES, hkIndustryTree, hkStats, hkIndustrySymbol,
  hkIndustryMember, findHkIndustryNode, resolveHkIndustry,
  type HkIndustryNode,
} from '@/lib/hkIndustries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface HkConstituentRow extends IndustryResearchRow {
  symbol: string;
  l1: string;
  l2: string | null;
  l3: string | null;
  industryDetail: string | null;
  quoteAvailable: boolean;
  quoteTime: string | null;
  stale: boolean;
  roe: null;
}
const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const treeNode = (node: HkIndustryNode): object => ({
  name: node.name, count: node.count, declared: node.count,
  children: (node.children ?? []).map(treeNode),
});
const nodeInfo = (node: NonNullable<ReturnType<typeof findHkIndustryNode>>) => ({
  name: node.name, code: node.code, level: node.level,
  l1: node.l1, l2: node.l2 ?? null, l3: node.level === 3 ? node.name : null,
});

export async function GET(request: NextRequest) {
  const params = sp(request);
  const stats = {
    ...hkStats(), declaredStocks: HK_INDUSTRIES.provenance.sourceStockCount,
    excludedCount: HK_INDUSTRIES.provenance.excludedCount,
  };
  const provenance = {
    ...HK_INDUSTRIES.provenance,
    classification: 'EASTMONEY-HK', classificationLabel: '东财行业',
    membershipAsOf: HK_INDUSTRIES.asOf,
    market: 'HK', currency: 'HKD', marketCapUnit: 'HKD-100million',
    roeMethod: 'pb-over-pe-estimate',
  };
  if (params.get('tree') === '1') return ok({
    version: HK_INDUSTRIES.version, stats, provenance,
    industries: hkIndustryTree().map(treeNode),
  });
  const alias = params.get('industry');
  if (alias) {
    const resolved = resolveHkIndustry(alias);
    return ok({ industry: alias, node: resolved ? nodeInfo(resolved) : null, provenance });
  }
  const name = params.get('node');
  if (!name) return ok({
    version: HK_INDUSTRIES.version, stats, provenance,
    industries: hkIndustryTree().map((node) => ({
      name: node.name, count: node.count, declared: node.count,
    })),
  });
  const level = params.get('level');
  if (level !== null && !['1', '2', '3'].includes(level))
    return fail('行业层级需为 1、2 或 3', 400);
  const node = findHkIndustryNode(name, level ? Number(level) as 1 | 2 | 3 : undefined,
    params.get('l1'), params.get('l2'));
  if (!node) return fail(`未找到唯一的港股行业「${name}」`, 404);
  const codes = [...new Set(node.stocks)].filter((code) => hkIndustrySymbol(code));
  const chunks: string[][] = [];
  for (let start = 0; start < codes.length; start += 40)
    chunks.push(codes.slice(start, start + 40).map((code) => hkIndustrySymbol(code)!));
  const quotes: Quote[] = [];
  let next = 0, failedChunks = 0;
  await Promise.all(Array.from({ length: Math.min(4, chunks.length) }, async () => {
    while (next < chunks.length) {
      const chunk = chunks[next++];
      try { quotes.push(...await getIndustryQuotes(chunk)); }
      catch { failedChunks++; }
    }
  }));
  const allowed = new Set(codes.map((code) => hkIndustrySymbol(code)!));
  const bySymbol = new Map(quotes.filter((quote) =>
    allowed.has(quote.symbol) && quote.kind === 'stock' && quote.market === 'HK',
  ).map((quote) => [quote.symbol, quote]));
  const rows: HkConstituentRow[] = codes.map((code) => {
    const member = hkIndustryMember(code)!, symbol = hkIndustrySymbol(code)!;
    const quote = bySymbol.get(symbol);
    const available = finite(quote?.price) !== null && quote!.price! > 0;
    const pe = available ? finite(quote?.pe) : null, pb = available ? finite(quote?.pb) : null;
    return {
      code, symbol, name: quote?.name || member.name,
      l1: member.industryPath[0] || '未分类',
      l2: member.industryPath[1] || null, l3: member.industryPath[2] || null,
      industryDetail: member.industryDetail,
      price: available ? finite(quote?.price) : null,
      changePct: available ? finite(quote?.changePct) : null,
      pe, pb, roe: null,
      roeEstimate: pe !== null && pe > 0 && pb !== null && pb > 0 ? pb / pe * 100 : null,
      totalMarketCap: available && finite(quote?.totalMarketCap) !== null && quote!.totalMarketCap! > 0
        ? quote!.totalMarketCap : null,
      turnoverRate: available ? finite(quote?.turnoverRate) : null,
      quoteAvailable: available, quoteTime: available ? quote?.ts ?? null : null,
      stale: available && quote?.stale === true,
    };
  });
  const summary = summarizeIndustry(rows, codes.length);
  const times = rows.map((row) => row.quoteTime ? Date.parse(row.quoteTime) : NaN).filter(Number.isFinite);
  return ok({
    node: nodeInfo(node), count: codes.length, declared: node.count, excludedCount: 0,
    quotedCount: summary.quotedCount, missingQuoteCount: summary.missingQuoteCount,
    failedChunks, partial: summary.missingQuoteCount > 0,
    updatedAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
    quoteTimeFrom: times.length ? new Date(Math.min(...times)).toISOString() : null,
    rows, summary, provenance,
  });
}
