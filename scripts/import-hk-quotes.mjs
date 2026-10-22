// 一次性导入：港股行情原始数据包 -> 市场库 canonical 日线键
// 用法: node scripts/import-hk-quotes.mjs <decoded_sina目录>
// 写入 kline:v2:<symbol>:day:none:canonical:prices-only，整段覆盖既有 bars。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from './tests/load-modules.mjs';

const decodedDir = process.argv[2] || '/tmp/hkraw/decoded_sina';
const now = Date.now();

const marketStore = await load('marketStore');
const importedBars = await load('marketImportedBars');
const retention = await load('marketRetention');

const store = marketStore.getMarketStore();
if (!store) { console.error('getMarketStore() 返回 null，请确认 MARKET_DATABASE_URL 已设置且 MARKET_DATA_STORE!=off'); process.exit(2); }

const cutoff = retention.marketCutoff(now);
const today = new Date(now + 8 * 3600e3).toISOString().slice(0, 10);
console.log(`截断窗口=${cutoff}  今日=${today}`);

function toCandle(r) {
  const date = String(r.date).slice(0, 10);
  const open = Number(r.open), high = Number(r.high), low = Number(r.low), close = Number(r.close);
  return { date, open, high, low, close, _ok:
    /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= cutoff && date <= today &&
    [open, high, low, close].every(Number.isFinite) &&
    low > 0 && low <= Math.min(open, close) && high >= Math.max(open, close) && high >= low };
}

const files = readdirSync(decodedDir).filter(f => f.endsWith('.json')).sort();
console.log(`待导入文件: ${files.length}`);

let ok = 0, skipped = 0, failed = 0;
const failList = [];
for (const file of files) {
  const symbol = file.replace(/\.json$/, '');
  try {
    const raw = JSON.parse(readFileSync(join(decodedDir, file), 'utf8'));
    const recs = Array.isArray(raw.records) ? raw.records : [];
    const mapped = [];
    for (const r of recs) {
      const c = toCandle(r);
      if (c._ok) mapped.push({ date: c.date, open: c.open, high: c.high, low: c.low, close: c.close });
    }
    if (mapped.length < 2) { skipped++; console.log(`  跳过 ${symbol}: 有效K线仅 ${mapped.length} 根`); continue; }
    // 升序、去重、严格递增
    mapped.sort((a, b) => a.date.localeCompare(b.date));
    const candlesNew = []; let prev = '';
    for (const c of mapped) { if (c.date > prev) { candlesNew.push(c); prev = c.date; } }
    const code = symbol.slice(2);
    const key = importedBars.importedBarsKey(symbol);
    const old = await store.read(key);
    let candles = candlesNew;
    if (old?.payload?.candles?.length) {
      // 保护已入库数据：重叠日期价格必须一致（按 float32 等价判定），冲突则保留原记录；
      // 并集合并，避免覆盖比本包更长的历史。
      const prior = new Map(old.payload.candles.map(c => [c.date, c]));
      const conflicts = [];
      for (const c of candles) {
        const p = prior.get(c.date);
        if (p && ['open', 'high', 'low', 'close'].some(f => !importedBars.equivalentRawPrice(p[f], c[f]))) conflicts.push(c.date);
      }
      if (conflicts.length) { skipped++; console.log(`  跳过 ${symbol}: 与已入库不复权价格冲突 ${conflicts.length} 天（如 ${conflicts[0]}），保留原记录`); continue; }
      const union = new Map(prior);
      for (const c of candles) union.set(c.date, c);
      candles = [...union.values()].sort((a, b) => a.date.localeCompare(b.date));
    }
    const payload = {
      symbol, code, period: 'day', adjust: 'none',
      candles, source: 'canonical', stale: false, complete: true,
      listingDate: old?.payload?.listingDate && old.payload.listingDate < candles[0].date ? old.payload.listingDate : candles[0].date,
      origins: [...(old?.payload?.origins ?? []), { source: 'upload:hk-quotes-raw:decoded-sina', from: candlesNew[0].date, to: candlesNew.at(-1).date, acquiredAt: new Date(now).toISOString() }],
    };
    const record = marketStore.marketRecord(key, 'kline', 'upload:hk-quotes-raw', payload, 60e3, now);
    const written = await store.write(record, old?.digest ?? null);
    if (!written) { failed++; failList.push(`${symbol}: 版本冲突未写入`); console.log(`  冲突 ${symbol}`); continue; }
    ok++;
    if (ok % 25 === 0 || ok === 1) console.log(`  [${ok}/${files.length}] ${symbol} bars=${candles.length} ${candles[0].date}..${candles.at(-1).date}`);
  } catch (e) {
    failed++; failList.push(`${symbol}: ${e.message}`); console.log(`  失败 ${symbol}: ${e.message}`);
  }
}

console.log(`\n完成: 成功=${ok} 跳过=${skipped} 失败=${failed}`);
if (failList.length) console.log('失败明细:\n' + failList.join('\n'));
process.exit(failed ? 1 : 0);
