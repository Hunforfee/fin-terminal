#!/usr/bin/env node
/**
 * 将 tdx_fetch.py 产出的 bundle 写入行情库 (canonical 源)。
 * 复用应用自带的 importDailyPrices —— digest / 分表格式与读取逻辑零偏差。
 * 用法:
 *   node scripts/import-tdx.mjs <bundle.json> [--verify] [--force]
 * 必须环境变量 MARKET_DATABASE_URL (从 .env.local 注入)。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Pool } from 'pg';

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const { postgresMarketStore } = await import(`${ROOT}/.market-importer/marketStore.mjs`);
const { importDailyPrices, importedBarsKey } = await import(`${ROOT}/.market-importer/marketImportedBars.mjs`);

const bundlePath = process.argv[2];
if (!bundlePath) { console.error('用法: node import-tdx.mjs <bundle.json> [--verify]'); process.exit(1); }
const verify = process.argv.includes('--verify');
const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));

const env = readFileSync(`${ROOT}/.env.local`, 'utf8');
const kv = Object.fromEntries(env.split('\n').filter(Boolean).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
const url = kv.MARKET_DATABASE_URL || kv.DATABASE_URL;
if (!url) { console.error('缺少 MARKET_DATABASE_URL'); process.exit(1); }

const store = postgresMarketStore(url, () => Promise.resolve(new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 3000 })));

let ok = 0, skip = 0, fail = 0;
console.log(`\n========== 导入 tdx bundle: ${bundlePath} (${bundle.records.length} 只) ==========\n`);
for (const rec of bundle.records) {
  try {
    const r = await importDailyPrices(store, { symbol: rec.symbol, candles: rec.candles, source: 'qmt' });
    ok++;
    console.log(`  ✓ ${rec.symbol}: ${r.count} 根 (${r.from}~${r.to})`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${rec.symbol}: ${e.message}`);
  }
}

if (verify) {
  console.log(`\n--- 回读校验 (从库读取 canonical 并比对) ---`);
  const pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 3000 });
  for (const rec of bundle.records) {
    const key = importedBarsKey(rec.symbol);
    const r = await pool.query(
      `SELECT (SELECT count(*) FROM fin_market_bars b WHERE b.key=$1) bars,
              (SELECT body->'payload'->>'source' FROM fin_market_records WHERE key=$1) src,
              (SELECT min(b.date) FROM fin_market_bars b WHERE b.key=$1) f,
              (SELECT max(b.date) FROM fin_market_bars b WHERE b.key=$1) t`,
      [key]);
    const row = r.rows[0];
    const match = Number(row.bars) === rec.candles.length;
    console.log(`  ${match ? '✓' : '✗'} ${rec.symbol}: 库 ${row.bars} 根 (期望 ${rec.candles.length}) source=${row.src} ${row.f}~${row.t}`);
    if (!match) fail++;
  }
  await pool.end().catch(()=>{});
}

console.log(`\n========== 汇总: 成功 ${ok} / 失败 ${fail} / 跳过 ${skip} ==========\n`);
await store.close?.();
process.exit(fail ? 1 : 0);
