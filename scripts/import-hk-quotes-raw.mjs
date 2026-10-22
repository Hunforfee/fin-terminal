// 一次性导入：港股行情原始数据包 raw/<symbol>/page_*.json (腾讯日线) -> canonical 键
// 仅处理 decoded_sina 中缺失的标的（避免覆盖已入库 sina 数据）。
// 用法: node scripts/import-hk-quotes-raw.mjs <hkfull解压根目录>
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { load } from './tests/load-modules.mjs';

const root = process.argv[2] || '/tmp/hkfull';
const decodedDir = join(root, 'decoded_sina');
const rawDir = join(root, 'raw');
const now = Date.now();

const marketStore = await load('marketStore');
const importedBars = await load('marketImportedBars');
const retention = await load('marketRetention');
const store = marketStore.getMarketStore();
if (!store) { console.error('getMarketStore() 返回 null'); process.exit(2); }

const cutoff = retention.marketCutoff(now);
const today = new Date(now + 8 * 3600e3).toISOString().slice(0, 10);
console.log(`截断窗口=${cutoff} 今日=${today}`);

const have = new Set(readdirSync(decodedDir).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')));
const targets = readdirSync(rawDir).filter(s => !have.has(s)).sort();
console.log(`decoded_sina 已有=${have.size}  raw 待处理(缺清洗版)=${targets.length}`);

function parseRow(r) {
  // 腾讯日线顺序: [date, open, close, high, low, volume]
  const date = String(r[0]).slice(0, 10);
  const open = Number(r[1]), close = Number(r[2]), high = Number(r[3]), low = Number(r[4]);
  return { date, open, high, low, close, ok:
    /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= cutoff && date <= today &&
    [open, high, low, close].every(Number.isFinite) &&
    low > 0 && low <= Math.min(open, close) && high >= Math.max(open, close) && high >= low };
}

let ok = 0, skipped = 0, failed = 0; const failList = [];
for (const symbol of targets) {
  const symDir = join(rawDir, symbol);
  const pages = readdirSync(symDir).filter(f => /^page_.*\.json$/.test(f)).sort().map(f => join(symDir, f));
  if (!pages.length) { skipped++; console.log(`  跳过 ${symbol}: 无 page 文件`); continue; }
  const candles = [];
  try {
    for (const pf of pages) {
      const d = JSON.parse(readFileSync(pf, 'utf8'));
      const data = d?.payload?.data ?? d?.data ?? {};
      const node = data[symbol] ?? Object.values(data)[0];
      if (!node) continue;
      const rows = node.day ?? node.qfqday ?? [];
      for (const r of rows) { const c = parseRow(r); if (c.ok) candles.push({ date: c.date, open: c.open, high: c.high, low: c.low, close: c.close }); }
    }
  } catch (e) { failed++; failList.push(`${symbol}: 解析出错 ${e.message}`); console.log(`  失败 ${symbol}: ${e.message}`); continue; }
  if (candles.length < 2) { skipped++; console.log(`  跳过 ${symbol}: 有效K线仅 ${candles.length}`); continue; }
  candles.sort((a, b) => a.date.localeCompare(b.date));
  const uniq = []; let prev = '';
  for (const c of candles) { if (c.date > prev) { uniq.push(c); prev = c.date; } }
  const code = symbol.slice(2);
  const payload = {
    symbol, code, period: 'day', adjust: 'none', candles: uniq,
    source: 'canonical', stale: false, complete: true, listingDate: uniq[0].date,
    origins: [{ source: 'upload:hk-quotes-raw:tencent-page', from: uniq[0].date, to: uniq.at(-1).date, acquiredAt: new Date(now).toISOString() }],
  };
  try {
    const key = importedBars.importedBarsKey(symbol);
    const old = await store.read(key);
    const record = marketStore.marketRecord(key, 'kline', 'upload:hk-quotes-raw', payload, 60e3, now);
    const written = await store.write(record, old?.digest ?? null);
    if (!written) { failed++; failList.push(`${symbol}: 版本冲突`); console.log(`  冲突 ${symbol}`); continue; }
    ok++;
    if (ok % 10 === 0 || ok === 1) console.log(`  [${ok}/${targets.length}] ${symbol} bars=${uniq.length} ${uniq[0].date}..${uniq.at(-1).date}`);
  } catch (e) { failed++; failList.push(`${symbol}: ${e.message}`); console.log(`  失败 ${symbol}: ${e.message}`); }
}
console.log(`\n完成: 成功=${ok} 跳过=${skipped} 失败=${failed}`);
if (failList.length) console.log('失败明细:\n' + failList.join('\n'));
process.exit(failed ? 1 : 0);
