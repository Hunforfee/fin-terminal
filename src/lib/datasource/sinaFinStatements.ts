import { fetchShareHistory, sharesAt, type ShareChange } from './sinaFinance';
/**
 * 新浪三大报表「全历史」解析（估值分母专用，单位：万元）。
 *
 * 与 `sinaStatements.ts` 的区别：那边是按年分页抓「字段目录 + 自定义报表」，
 * 这边只取估值必需的少数科目，用来还原每个报告期的
 *   - 归母净利润（利润表：归属于母公司所有者的净利润，兜底 净利润）
 *   - 总股本（资产负债表：实收资本(或股本) ÷ 面值），用于把净利润折成 EPS
 *   - 归母净资产（资产负债表：归属于母公司股东权益合计 / 所有者权益(或股东权益)合计）
 *
 * 为什么股本要从资产负债表反推，而不是取行情接口的当前股本：
 *   送转/增发后当前股本 ≠ 历史报告期股本。用当前股本折历史 EPS，
 *   会把送转股的**历史 PE 系统性放大**（例如 10 转 5 会让历史 PE 高 50%），
 *   这是与理杏仁走势对不上的主要原因之一。
 *   利润表「基本每股收益」同样不可靠（新浪口径在送转后会被重述/混用）。
 */

import { fetchStatementSourcePage } from './sinaStatements';
import { cachedMarketInput, validateDatedRows } from '../marketInputs';

export interface FinStatementPoint {
  /** 报告期 YYYY-MM-DD */
  date: string;
  /** 归母净利润（元，累计） */
  npParent: number | null;
  /** 净利润含少数股东（元，累计，兜底用） */
  npTotal: number | null;
  /** 期末总股本（亿股，由实收资本 ÷ 面值还原） */
  sharesYi: number | null;
  /** 归母净资产（元） */
  equityParent: number | null;
  /** 所有者权益合计（元，兜底用） */
  equityTotal: number | null;
  /** Ordinary shareholders equity, excluding other equity instruments. */
  equityCommon?: number | null;
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function toNum(s: string | null | undefined): number | null {
  if (!s || s === '--' || s === '') return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** 解析报表页：报告期列表 + 科目名 → 各期原始字符串 */
export function parseStatementRows(html: string): { dates: string[]; rows: Map<string, string[]> } {
  const dates: string[] = [];
  const rows = new Map<string, string[]>();

  const s = html.indexOf('报表日期');
  if (s < 0) return { dates, rows };
  const e = html.indexOf('</tbody>', s);
  const seg = html.slice(s, e === -1 ? s + 80000 : e);

  // 表头报告期
  const head = seg.slice(0, 800);
  for (const d of head.matchAll(/(\d{4}-\d{2}-\d{2})/g)) dates.push(d[1]);

  for (const tr of seg.split('<tr>').slice(1)) {
    const nm =
      (tr.match(/>([^<>]{2,40})<\/a>/) || tr.match(/<strong>([^<]{2,40})<\/strong>/) || [])[1] ?? '';
    const name = stripTags(nm);
    if (!name) continue;
    const cells = Array.from(tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)).map((m) => stripTags(m[1]));
    if (cells.length < 2) continue;
    if (!rows.has(name)) rows.set(name, cells.slice(1));
  }
  return { dates, rows };
}

/** 按候选科目名顺序取第一条命中的行 */
function pickRow(rows: Map<string, string[]>, names: string[]): string[] | null {
  for (const n of names) {
    const v = rows.get(n);
    if (v) return v;
  }
  return null;
}

const PL_NP_PARENT = ['归属于母公司所有者的净利润', '归属于母公司股东的净利润', '归属于母公司的净利润'];
const PL_NP_TOTAL = ['五、净利润', '净利润'];
const BS_SHARE = ['实收资本(或股本)', '实收资本（或股本）', '股本'];
const BS_EQ_PARENT = [
  '归属于母公司股东权益合计',
  '归属于母公司所有者权益合计',
  '归属于母公司股东权益总计',
  '归属于母公司所有者权益总计',
  '归属于母公司股东的权益',
];
const BS_EQ_TOTAL = [
  '所有者权益(或股东权益)合计',
  '所有者权益（或股东权益）合计',
  '股东权益合计',
];

/**
 * 抓取单年利润表 + 资产负债表的关键科目并合并。
 * 金额单位统一换算为「元」（页面为万元）。
 */
export async function fetchYearStatement(code: string, year: number, shareHistory: ShareChange[] = []): Promise<FinStatementPoint[]> {
  const [plPage, bsPage] = await Promise.all([
    fetchStatementSourcePage(code,'profit',year).catch(() => null),
    fetchStatementSourcePage(code,'balance',year).catch(() => null),
  ]);
  const convert = (page: typeof plPage) => ({dates:page?.dates ?? [],rows:new Map((page?.rows ?? []).filter(r=>r.kind==='field').map(r=>[r.name,r.vals]))});
  const pl = convert(plPage), bs = convert(bsPage);
  if (pl.dates.length === 0 && bs.dates.length === 0) return [];

  const dates = Array.from(new Set([...pl.dates, ...bs.dates])).sort();

  // 同一科目在不同年份页面的列顺序一致（按报告期倒序），逐期按下标对齐
  const plOrder = [...pl.dates];
  const bsOrder = [...bs.dates];
  const idxOf = (order: string[], d: string) => order.indexOf(d);

  const npRows = plOrder.length ? pickRow(pl.rows, PL_NP_PARENT) : null;
  const npTotalRows = plOrder.length ? pickRow(pl.rows, PL_NP_TOTAL) : null;
  const shareRows = bsOrder.length ? pickRow(bs.rows, BS_SHARE) : null;
  const eqRows = bsOrder.length ? pickRow(bs.rows, BS_EQ_PARENT) : null;
  const eqTotalRows = bsOrder.length ? pickRow(bs.rows, BS_EQ_TOTAL) : null;

  // 面值：优先「每股面值」，否则按 1 元
  const parRow = bsOrder.length ? pickRow(bs.rows, ['每股面值']) : null;
  const otherEquity = pickRow(bs.rows, ['其他权益工具']);

  const out: FinStatementPoint[] = [];
  for (const d of dates) {
    const pi = idxOf(plOrder, d);
    const bi = idxOf(bsOrder, d);
    const wanToYuan = (v: number | null) => (v === null ? null : v * 1e4);

    const npWan = pi >= 0 ? toNum(npRows?.[pi]) : null;
    const npTotalWan = pi >= 0 ? toNum(npTotalRows?.[pi]) : null;
    const shareWan = bi >= 0 ? toNum(shareRows?.[bi]) : null;
    const eqWan = bi >= 0 ? toNum(eqRows?.[bi]) : null;
    const eqTotalWan = bi >= 0 ? toNum(eqTotalRows?.[bi]) : null;
    const par = bi >= 0 ? toNum(parRow?.[bi]) : null;

    // 实收资本单位=万元，面值=元/股 → 亿股 = 万元 / 面值 / 1e4 * 1e4 = 万元/面值/1e4（万股→亿股）
    const actualWan = sharesAt(shareHistory, d);
    const sharesYi = actualWan !== null ? actualWan / 1e4
      : shareWan !== null && shareWan > 0 && par !== null && par > 0 ? shareWan / par / 1e4 : null;

    out.push({
      date: d,
      npParent: wanToYuan(npWan),
      npTotal: wanToYuan(npTotalWan),
      sharesYi,
      equityParent: wanToYuan(eqWan),
      equityCommon: eqWan !== null ? wanToYuan(eqWan - (bi >= 0 ? toNum(otherEquity?.[bi]) ?? 0 : 0)) : null,
      equityTotal: wanToYuan(eqTotalWan),
    });
  }
  return out;
}

/** 并发抓取近 N 年（含当前年 +1 缓冲）的报表关键科目，按报告期去重合并 */
export async function fetchStatementHistory(code: string, years = 12): Promise<FinStatementPoint[]> {
  const thisYear = new Date().getFullYear();
  const yearList: number[] = [];
  for (let y = thisYear; yearList.length < Math.min(10,Math.max(1,years)) + 1 && y >= 1998; y--) yearList.push(y);

  const shareHistory = await cachedMarketInput(`shares-v3:${code}`,'share-events','sina-shares:10000shares',1800e3,
    ()=>fetchShareHistory(code),rows=>validateDatedRows(rows as unknown as Record<string,unknown>[],'date',['sharesWan']));
  const pages = await Promise.all(yearList.map((y) => fetchYearStatement(code, y, shareHistory).catch(() => [] as FinStatementPoint[])));

  const byDate = new Map<string, FinStatementPoint>();
  for (const p of pages) {
    for (const pt of p) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(pt.date)) continue;
      const prev = byDate.get(pt.date);
      if (!prev) {
        byDate.set(pt.date, pt);
        continue;
      }
      // 同一报告期可能被两页覆盖（年末页/次年页），取字段更完整的
      byDate.set(pt.date, {
        date: pt.date,
        npParent: pt.npParent ?? prev.npParent,
        npTotal: pt.npTotal ?? prev.npTotal,
        sharesYi: pt.sharesYi ?? prev.sharesYi,
        equityParent: pt.equityParent ?? prev.equityParent,
        equityTotal: pt.equityTotal ?? prev.equityTotal,
        equityCommon: pt.equityCommon ?? prev.equityCommon,
      });
    }
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

