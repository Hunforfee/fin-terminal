/**
 * 把 _raw/{code}.mcp.json + _raw/{code}.json 整理成「撰写简报」。
 * 输出 src/data/analyses/_raw/{code}.brief.md —— 供写作子代理直接读取的小体积素材。
 *
 * 用法：node scripts/build-brief.mjs [code1 code2 ...]（不传则处理全部 raw）
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'src/data/analyses/_raw');

const yi = (n) => (n == null ? '—' : `${(n / 1e8).toFixed(2)}亿`);
const pct = (x, d = 1) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);

/** 从 MCP overview 提取关键字段 */
function parseOverview(ov) {
  const t = ov?.response?.transformed;
  if (!t) return null;
  const pick = (name) => t.tables?.find((x) => x.name === name)?.rows?.[0];
  return {
    meta: pick('metadata'),
    basic: pick('basic_overview'),
    biz: pick('business_overview'),
    fin: pick('financial_highlights'),
    val: pick('valuation_metrics'),
    themes: (t.tables?.find((x) => x.name === 'related_themes')?.rows || []).map((r) => r['关联主题']),
    tags: (t.tables?.find((x) => x.name === 'tags')?.rows || []).map((r) => r.tag),
  };
}

/** 从研报数组提取精简条目 */
function parseReports(rep) {
  const rows = rep?.data;
  if (!Array.isArray(rows) || rows.length < 2) return [];
  return rows.slice(1).map((r) => ({
    title: r[0],
    date: r[1],
    org: r[3],
    abstract: (r[4] || '').replace(/\s+/g, ' ').slice(0, 900),
  }));
}

async function buildBrief(code) {
  let mcp = null, f10 = null;
  try { mcp = JSON.parse(await readFile(join(RAW, `${code}.mcp.json`), 'utf8')); } catch { /* 无 */ }
  try { f10 = JSON.parse(await readFile(join(RAW, `${code}.json`), 'utf8')); } catch { /* 无 */ }
  if (!mcp && !f10) return null;

  const ov = mcp ? parseOverview(mcp.overview) : null;
  const reports = mcp ? parseReports(mcp.reports) : [];
  const lines = [];

  lines.push(`# ${code} ${mcp?.name || f10?.name || ''} 素材简报\n`);

  if (ov?.basic) {
    lines.push(`## 公司地位（F10）\n${ov.basic['公司地位'] || '—'}\n`);
  }
  if (ov?.biz) {
    lines.push(`## 主营与行业\n- 主营业务：${ov.biz['主营业务'] || '—'}`);
    lines.push(`- 行业：${ov.biz['一级行业'] || '—'} / ${ov.biz['二级行业'] || '—'}`);
    lines.push(`- 证监会行业：${ov.meta?.['证监会行业'] || '—'}\n`);
  }
  if (ov?.fin) {
    const f = ov.fin;
    lines.push(`## 财务亮点（报告期 ${f['报告期'] || '—'}）`);
    lines.push(`- 营业收入：${yi(f['营业收入(元)'])}，同比 ${f['营业收入同比增长率(%)']?.toFixed(2)}%`);
    lines.push(`- 归母净利：${yi(f['归母净利润(元)'])}，同比 ${f['归母净利润同比增长率(%)']?.toFixed(2)}%；扣非净利 ${yi(f['扣非净利润(元)'])}，同比 ${f['扣非净利润同比增长率(%)']?.toFixed(2)}%`);
    lines.push(`- 毛利率：${f['毛利率(%)']?.toFixed(2)}%；ROE(加权)：${f['加权净资产收益率(%)']?.toFixed(2)}%；资产负债率：${f['资产负债率(%)']?.toFixed(2)}%`);
    lines.push(`- EPS：${f['每股收益(元)']}；每股净资产：${f['每股净资产(元)']}；每股经营现金流：${f['每股经营现金流(元)']}\n`);
  }
  if (ov?.val) {
    const v = ov.val;
    lines.push(`## 估值\n- PE(TTM)：${v['市盈率(TTM)']?.toFixed(2)}；PE(LYR)：${v['市盈率(LYR)']?.toFixed(2)}；PB：${v['市净率']?.toFixed(2)}`);
    lines.push(`- 总市值：${yi(v['总市值(元)'])}\n`);
  }
  if (ov?.themes?.length) lines.push(`## 关联主题\n${ov.themes.join('、')}\n`);
  if (ov?.tags?.length) lines.push(`## 标签\n${ov.tags.join('、')}\n`);

  // 主营构成（来自东财 F10 raw）
  if (f10?.groups?.length) {
    lines.push(`## 主营构成`);
    for (const g of f10.groups) {
      lines.push(`### ${g.label}（${g.date || '—'}）`);
      for (const it of g.items.slice(0, 8)) {
        lines.push(`- ${it.name}：收入 ${yi(it.income)}，占比 ${pct(it.incomeRatio)}，毛利率 ${pct(it.grossMargin)}`);
      }
    }
    lines.push('');
  }
  if (f10?.review) {
    lines.push(`## 经营评述原文（节选 2200 字）\n${f10.review.slice(0, 2200)}\n`);
  }

  if (reports.length) {
    lines.push(`## 券商研报（${reports.length} 篇）`);
    for (const r of reports) {
      lines.push(`\n### ${r.org}（${r.date}）${r.title}`);
      lines.push(r.abstract);
    }
  } else {
    lines.push(`## 券商研报\n未检索到 2026 年内研报。\n`);
  }

  const text = lines.join('\n');
  await writeFile(join(RAW, `${code}.brief.md`), text, 'utf8');
  return { code, reports: reports.length, size: text.length };
}

const args = process.argv.slice(2);
let codes = args;
if (codes.length === 0) {
  const files = await readdir(RAW);
  codes = [...new Set(files.map((f) => f.match(/^(\d{6})\./)?.[1]).filter(Boolean))];
}

let ok = 0;
for (const c of codes) {
  const r = await buildBrief(c);
  if (r) {
    ok++;
    console.log(`${r.code}: 简报 ${r.size} 字符，研报 ${r.reports} 篇`);
  } else {
    console.log(`${c}: 无 raw 数据，跳过`);
  }
}
console.log(`\n完成 ${ok}/${codes.length}`);
