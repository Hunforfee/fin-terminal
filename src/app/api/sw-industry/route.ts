import type { NextRequest } from 'next/server';
import { ok, fail, sp } from '@/lib/api';
import { getQuotes } from '@/lib/datasource';
import { swAllNodes, swStats, SW2021, type SwNode } from '@/lib/sw2021';
import type { Quote } from '@/lib/datasource/types';
import {
  industryStockSymbol,
  summarizeIndustry,
  type IndustryResearchRow,
} from '@/lib/industryResearch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface ConstituentRow extends IndustryResearchRow {
  symbol: string;
  l1: string;
  l2: string | null;
  l3: string | null;
  quoteAvailable: boolean;
  quoteTime: string | null;
  stale: boolean;
  /** Legacy field retained empty: reported ROE is not part of this quote API. */
  roe: null;
}

const aCodes = (node: SwNode): string[] =>
  [...new Set(node.stocks)].filter(
    (code) => industryStockSymbol(code) !== null,
  );
const finite = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

interface IndustryTreeNode {
  name: string;
  count: number;
  declared: number;
  children?: IndustryTreeNode[];
}
function treeNode(node: SwNode): IndustryTreeNode {
  return {
    name: node.name,
    count: aCodes(node).length,
    declared: node.count,
    ...(node.children ? { children: node.children.map(treeNode) } : {}),
  };
}

function classification() {
  const byCode = new Map<
    string,
    { l1: string; l2: string | null; l3: string | null }
  >();
  for (const first of SW2021.industries) {
    for (const code of aCodes(first))
      byCode.set(code, { l1: first.name, l2: null, l3: null });
    for (const second of first.children ?? []) {
      for (const code of aCodes(second))
        byCode.set(code, { l1: first.name, l2: second.name, l3: null });
      for (const third of second.children ?? []) {
        for (const code of aCodes(third))
          byCode.set(code, { l1: first.name, l2: second.name, l3: third.name });
      }
    }
  }
  return byCode;
}
const paths = classification();

/** Fetch only this industry's A shares. A failed chunk never hides other chunks. */
export async function GET(request: NextRequest) {
  const params = sp(request);
  const allDeclared = new Set(SW2021.industries.flatMap((node) => node.stocks));
  const stockCount = [...allDeclared].filter(
    (code) => industryStockSymbol(code) !== null,
  ).length;
  const stats = {
    ...swStats(),
    stocks: stockCount,
    declaredStocks: allDeclared.size,
    excludedCount: allDeclared.size - stockCount,
  };
  const provenance = {
    classification: 'SW2021',
    membershipSource: 'bundled-eastmoney-f10-mapping',
    membershipAsOf: null,
    market: 'A',
    roeMethod: 'pb-over-pe-estimate',
  };

  if (params.get('tree') === '1')
    return ok({
      version: SW2021.version,
      stats,
      provenance,
      industries: SW2021.industries.map(treeNode),
    });
  const name = params.get('node');
  if (!name)
    return ok({
      version: SW2021.version,
      stats,
      provenance,
      industries: SW2021.industries.map((node) => ({
        name: node.name,
        count: aCodes(node).length,
        declared: node.count,
      })),
    });
  const requestedLevel = params.get('level');
  if (requestedLevel !== null && !['1', '2', '3'].includes(requestedLevel))
    return fail('行业层级需为 1、2 或 3', 400);
  const l1 = params.get('l1'),
    l2 = params.get('l2');
  const node = swAllNodes().find(
    (candidate) =>
      candidate.name === name &&
      (!requestedLevel || candidate.level === Number(requestedLevel)) &&
      (!l1 || candidate.l1 === l1) &&
      (!l2 || candidate.l2 === l2),
  );
  if (!node) return fail(`未找到行业「${name}」`, 404);

  const codes = aCodes(node),
    declaredCodes = new Set(node.stocks);
  const nodeInfo = {
    name: node.name,
    code: node.code,
    level: node.level,
    l1: node.l1,
    l2: node.l2 ?? null,
    l3: node.level === 3 ? node.name : null,
  };
  const chunks: string[][] = [];
  for (let start = 0; start < codes.length; start += 40)
    chunks.push(
      codes.slice(start, start + 40).map((code) => industryStockSymbol(code)!),
    );
  const quotes: Quote[] = [];
  let next = 0,
    failedChunks = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, chunks.length) }, async () => {
      while (next < chunks.length) {
        const chunk = chunks[next++];
        try {
          quotes.push(...(await getQuotes(chunk)));
        } catch {
          failedChunks++;
        }
      }
    }),
  );
  const allowed = new Set(codes.map((code) => industryStockSymbol(code)!));
  const bySymbol = new Map(
    quotes
      .filter((quote) => allowed.has(quote.symbol) && quote.kind === 'stock')
      .map((quote) => [quote.symbol, quote]),
  );
  const rows: ConstituentRow[] = codes.map((code) => {
    const symbol = industryStockSymbol(code)!;
    const quote = bySymbol.get(symbol);
    const available =
      quote !== undefined && finite(quote.price) !== null && quote.price! > 0;
    const pe = available ? finite(quote?.pe) : null,
      pb = available ? finite(quote?.pb) : null;
    return {
      code,
      symbol,
      name: quote?.name || code,
      ...(paths.get(code) ?? {
        l1: node.l1,
        l2: node.l2 ?? null,
        l3: node.level === 3 ? node.name : null,
      }),
      price: available ? finite(quote?.price) : null,
      changePct: available ? finite(quote?.changePct) : null,
      pe,
      pb,
      roe: null,
      roeEstimate:
        pe !== null && pe > 0 && pb !== null && pb > 0 ? (pb / pe) * 100 : null,
      totalMarketCap:
        available &&
        finite(quote?.totalMarketCap) !== null &&
        quote!.totalMarketCap! > 0
          ? quote!.totalMarketCap
          : null,
      turnoverRate: available ? finite(quote?.turnoverRate) : null,
      quoteAvailable: available,
      quoteTime: available ? (quote?.ts ?? null) : null,
      stale: available && quote?.stale === true,
    };
  });
  const summary = summarizeIndustry(rows, codes.length);
  const times = rows
    .map((row) => (row.quoteTime ? Date.parse(row.quoteTime) : NaN))
    .filter(Number.isFinite);
  const updatedAt = times.length
    ? new Date(Math.max(...times)).toISOString()
    : null;
  return ok({
    node: nodeInfo,
    count: codes.length,
    declared: node.count,
    excludedCount: declaredCodes.size - codes.length,
    quotedCount: summary.quotedCount,
    missingQuoteCount: summary.missingQuoteCount,
    failedChunks,
    partial: summary.missingQuoteCount > 0,
    updatedAt,
    quoteTimeFrom: times.length
      ? new Date(Math.min(...times)).toISOString()
      : null,
    rows,
    summary,
    provenance,
    ...(codes.length === 0 ? { note: '该分类暂无收录的 A 股成分。' } : {}),
  });
}
