#!/usr/bin/env node
/**
 * 生成兜底快照：用真实公开接口抓一轮行情与 K 线，落盘为 src/data/snapshots/market.json。
 *
 * 用途：当上游全部不可达时，页面仍能展示「最近一次真实抓取」的结果，而不是空白。
 * 用法：npm run seed
 *
 * 注意：这是真实数据的历史切片，不是模拟数据。建议定期（如每日收盘后）重新生成。
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src', 'data', 'snapshots', 'market.json');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/* --------------------------------------------------- 标的清单（与 src/lib/universe.ts 对齐） */

const INDICES = [
  ['000001', 'sh000001'], ['000300', 'sh000300'], ['000016', 'sh000016'],
  ['000905', 'sh000905'], ['000852', 'sh000852'], ['000688', 'sh000688'],
  ['399001', 'sz399001'], ['399006', 'sz399006'], ['899050', 'bj899050'],
];

const FUNDS = ['510300', '510500', '510050', '159915', '588000', '518880', '512880', '512480', '512690', '515790', '516160', '512170'];

// 行业龙头（与 universe.ts 中 STOCKS 的代码保持一致）
const STOCKS = [
  '601398','601288','601939','601988','600036','601166','600000','002142',
  '601318','601601','601628','600030','601688','000776',
  '600519','000858','000568','600809','002304','000596','600887','603288',
  '600276','300760','603259','300015','600436','000538','600196',
  '002415','000725','002475','002371','688981','603501',
  '300750','601012','600438','300124','002129',
  '600570','002230','688111','300454','600845',
  '000063','600050','601728',
  '002594','600104','601633','000625','601238',
  '000333','000651','600690','002508','002050',
  '600031','601766','300450','002472',
  '600309','600426','002648',
  '601899','600111','603993','600547',
  '000002','600048','001979',
  '601668','601390','601186',
  '600900','601985','600025',
  '601919','600009','002352','601006',
  '601888','600655',
  '601088','601225','600188',
  '601857','600028','600938',
  '600019','000898',
  '002714','300498','600298',
  '600893','600760','002179',
  '002027','300413',
  '600585','002271',
  '603605','600398',
];

/** 需要缓存 K 线的标的：全部指数 + 基金 + 成交额靠前的龙头 */
const KLINE_TARGETS = [
  ...INDICES.map(([, s]) => s),
  ...FUNDS.map(toSymbol),
  ...['600519','000858','300750','601318','600036','000651','002594','601899','600276','002415','000333','601088','600900','601857','000002','601398','603288','688981'].map(toSymbol),
];

function toSymbol(code) {
  if (code.startsWith('6') || code.startsWith('5')) return `sh${code}`;
  if (code.startsWith('0') || code.startsWith('3') || code.startsWith('1')) return `sz${code}`;
  if (code.startsWith('4') || code.startsWith('8')) return `bj${code}`;
  return `sh${code}`;
}

/* ------------------------------------------------------------------- 抓取 */

async function getText(url, encoding = 'utf-8') {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return encoding === 'gbk' ? new TextDecoder('gbk').decode(buf) : buf.toString('utf-8');
  } finally {
    clearTimeout(t);
  }
}

function num(v) {
  if (v === '' || v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseQuote(symbol, body) {
  const f = body.split('~');
  if (f.length < 50) return null;
  const code = f[2];
  const market = symbol.startsWith('sh') ? 'SH' : symbol.startsWith('bj') ? 'BJ' : 'SZ';
  const price = num(f[3]);
  if (!price) return null;
  const tsRaw = f[30] || '';
  const m = tsRaw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  return {
    code, symbol, name: f[1].replace(/\s+/g, ''), market,
    kind: INDICES.some(([, s]) => s === symbol) ? 'index' : FUNDS.includes(code) ? 'etf' : 'stock',
    price,
    prevClose: num(f[4]), open: num(f[5]),
    high: num(f[33]), low: num(f[34]),
    change: num(f[31]), changePct: num(f[32]),
    volume: num(f[36]) ?? num(f[6]),
    amount: (num(f[37]) ?? 0) * 1e4,
    turnoverRate: num(f[38]), volumeRatio: num(f[49]), amplitude: num(f[43]),
    pe: num(f[39]), peForward: num(f[52]), peStatic: num(f[53]), pb: num(f[46]),
    totalMarketCap: num(f[45]), floatMarketCap: num(f[44]),
    high52w: num(f[67]), low52w: num(f[68]),
    ts: m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00` : null,
    source: 'tencent', stale: true,
  };
}

async function fetchQuotes(symbols) {
  const out = [];
  for (let i = 0; i < symbols.length; i += 50) {
    const chunk = symbols.slice(i, i + 50);
    const text = await getText(`https://qt.gtimg.cn/q=${chunk.join(',')}`, 'gbk');
    const re = /v_([a-z]{2}\d{6})="([^"]*)"/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const q = parseQuote(m[1], m[2]);
      if (q) out.push(q);
    }
  }
  return out;
}

async function fetchKLine(symbol, count = 320) {
  const url = `https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,${count},qfq`;
  const j = JSON.parse(await getText(url));
  const node = j?.data?.[symbol];
  const raw = node?.qfqday ?? node?.day;
  if (!raw) return null;
  return raw.map((r) => {
    const open = Number(r[1]), close = Number(r[2]), high = Number(r[3]), low = Number(r[4]);
    return {
      date: String(r[0]), open, close,
      high: Math.max(high, open, close), low: Math.min(low, open, close),
      volume: Number(r[5]) || 0,
    };
  });
}

/** 简易并发池 */
async function pool(items, size, fn) {
  const out = new Array(items.length);
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (idx < items.length) {
        const i = idx++;
        try {
          out[i] = await fn(items[i], i);
        } catch (e) {
          out[i] = null;
          console.warn(`  ! ${items[i]} 失败: ${e.message}`);
        }
      }
    }),
  );
  return out;
}

/* -------------------------------------------------------------------- main */

async function main() {
  console.log('FinTerminal 快照生成\n');

  const allCodes = [...INDICES.map(([c]) => c), ...STOCKS, ...FUNDS];
  const symbols = [...INDICES.map(([, symbol]) => symbol), ...STOCKS.map(toSymbol), ...FUNDS.map(toSymbol)];
  console.log(`行情：${symbols.length} 个标的`);

  const quotes = await fetchQuotes(symbols);
  console.log(`  ✓ 抓到 ${quotes.length} 条行情`);

  console.log(`\nK 线：${KLINE_TARGETS.length} 个标的（并发 6）`);
  const klines = {};
  const results = await pool(KLINE_TARGETS, 6, async (s) => fetchKLine(s));
  let okCount = 0;
  KLINE_TARGETS.forEach((s, i) => {
    if (results[i] && results[i].length > 0) {
      klines[`${s}:day`] = { period: 'day', candles: results[i] };
      okCount++;
    }
  });
  console.log(`  ✓ 抓到 ${okCount} 条日线`);

  const payload = {
    generatedAt: new Date().toISOString(),
    note: '由 scripts/fetch-snapshots.mjs 通过腾讯财经公开接口抓取的真实数据切片，仅作为上游不可用时的兜底展示',
    quotes,
    klines,
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload), 'utf-8');
  console.log(`\n已写入 ${OUT}`);
  console.log(`  行情 ${quotes.length} 条 · K 线 ${okCount} 条 · 大小约 ${(JSON.stringify(payload).length / 1024 / 1024).toFixed(2)} MB`);
}

main().catch((e) => {
  console.error('生成失败：', e);
  process.exit(1);
});

