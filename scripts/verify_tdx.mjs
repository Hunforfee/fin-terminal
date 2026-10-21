#!/usr/bin/env node
/**
 * 验证 tdx 抓取 bundle 的准确性：
 *  1) 内部自洽: OHLC 数学约束 / 日期升序 / 无重复 / 交易日连续性
 *  2) 跨源交叉: tdx 不复权收盘价 vs 库内 tencent/sina 同源重叠日期
 * 用法: node scripts/verify_tdx.mjs <bundle.json>
 */
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { createHash } from 'node:crypto';

const bundlePath = process.argv[2];
if (!bundlePath) { console.error('用法: node verify_tdx.mjs <bundle.json>'); process.exit(1); }
const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));

const env = readFileSync('.env.local', 'utf8');
const kv = Object.fromEntries(env.split('\n').filter(Boolean).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
const pool = new Pool({ connectionString: kv.MARKET_DATABASE_URL, max: 2, connectionTimeoutMillis: 3000 });

const WD = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function internalChecks(rec) {
  const errs = [];
  const seen = new Set();
  let prev = '';
  let gaps = 0, weekendGaps = 0;
  for (let i = 0; i < rec.candles.length; i++) {
    const c = rec.candles[i];
    const d = c.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { errs.push(`行${i} 日期格式异常 ${d}`); continue; }
    if (seen.has(d)) errs.push(`重复日期 ${d}`); seen.add(d);
    if (prev && d <= prev) errs.push(`日期非升序 ${prev}->${d}`);
    if (![c.open,c.high,c.low,c.close].every(Number.isFinite)) errs.push(`行${i} 价格非数值`);
    if (c.low <= 0) errs.push(`行${i} low<=0`);
    if (c.low > Math.min(c.open, c.close) + 1e-6) errs.push(`行${i} low>${Math.min(c.open,c.close)}`);
    if (c.high < Math.max(c.open, c.close) - 1e-6) errs.push(`行${i} high<${Math.max(c.open,c.close)}`);
    if (c.high < c.low - 1e-6) errs.push(`行${i} high<low`);
    if (prev) {
      const pd = new Date(prev), nd = new Date(d);
      const diff = (nd - pd) / 864e5;
      const wd = WD[nd.getUTCDay()];
      if (diff > 4) { gaps++; if (wd === 'Sat' || wd === 'Sun' || WD[pd.getUTCDay()] === 'Fri') weekendGaps++; }
    }
    prev = d;
  }
  return { errs, gaps, weekendGaps };
}

async function crossCheck(symbol) {
  const out = {};
  for (const src of ['tencent', 'sina']) {
    const key = `kline:v2:${symbol}:day:none:${src}:prices-only`;
    const r = await pool.query(
      `SELECT b.date, (b.body->>'close')::float c FROM fin_market_bars b JOIN fin_market_records r ON r.key=b.key WHERE r.key=$1 ORDER BY b.date`,
      [key]);
    if (!r.rows.length) { out[src] = { n: 0 }; continue; }
    out[src] = { n: r.rows.length, map: new Map(r.rows.map(x => [x.date, x.c])) };
  }
  return out;
}

console.log(`\n========== TDX 数据准确性验证 (bundle: ${bundlePath}, source=${bundle.source}) ==========\n`);
let totalBars = 0, totalErr = 0, totalRef = 0;
for (const rec of bundle.records) {
  totalBars += rec.candles.length;
  const ic = internalChecks(rec);
  const xc = await crossCheck(rec.symbol);
  // 跨源比对
  let matchN = 0, maxAbs = 0, maxRel = 0, sumRel = 0;
  const ref = xc.tencent.n ? xc.tencent : xc.sina;
  const refName = xc.tencent.n ? 'tencent' : (xc.sina.n ? 'sina' : null);
  if (refName) {
    for (const c of rec.candles) {
      const rc = ref.map.get(c.date);
      if (rc === undefined) continue;
      const abs = Math.abs(rc - c.close);
      const rel = abs / (Math.abs(rc) || 1);
      matchN++; maxAbs = Math.max(maxAbs, abs); maxRel = Math.max(maxRel, rel); sumRel += rel;
    }
    totalRef += matchN;
  }
  totalErr += ic.errs.length;
  const icOK = ic.errs.length === 0;
  console.log(`■ ${rec.symbol}  ${rec.candles.length} 根 ${rec.candles[0].date}~${rec.candles.at(-1).date}`);
  console.log(`   内部自洽: ${icOK ? '✓ 通过' : '✗ '+ic.errs.length+' 处'}  (非周末长空隙 ${ic.gaps-ic.weekendGaps} 处, 周末空隙 ${ic.weekendGaps} 处)`);
  if (ic.errs.length) ic.errs.slice(0,5).forEach(e => console.log(`     - ${e}`));
  if (refName)
    console.log(`   跨源比对(${refName}): 重叠 ${matchN} 日 | 最大价差 ${maxAbs.toFixed(4)} | 最大相对偏差 ${(maxRel*100).toFixed(4)}% | 平均相对偏差 ${(matchN?(sumRel/matchN*100):0).toFixed(4)}%`);
  else
    console.log(`   跨源比对: 库内无 tencent/sina 同源数据可作参照`);
  if (ic.errs.length) console.log('');
}
console.log(`\n========== 汇总 ==========`);
console.log(`  样本: ${bundle.records.length} 只, 共 ${totalBars} 根 K 线`);
console.log(`  内部自洽错误: ${totalErr} 处`);
console.log(`  跨源重叠比对: ${totalRef} 日`);
console.log(totalErr === 0 ? `  结论: 内部自洽全部通过 ✓` : `  结论: 存在自洽错误，需排查 ✗`);

await pool.end().catch(()=>{});
