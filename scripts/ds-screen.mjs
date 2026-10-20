/**
 * 大数投资法在用户自选股上的落地验证。
 * 齐东平《终极价值投资》：概率抽样拟合整体 + 低估值 + 长期持有。
 * 三原则：组合投资（分层抽样，单行业≤3%）、合理估值（PB<2、PE<20）、长期持有。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const DC = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// 该报表只认这几个字段，多加一个列名整条查询就失败
const COLS = ['SECURITY_CODE', 'SECURITY_NAME_ABBR', 'TRADE_DATE', 'CLOSE_PRICE',
  'TOTAL_MARKET_CAP', 'PB_MRQ', 'PE_TTM'].join(',');

async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://data.eastmoney.com/' } });
  return r.json();
}

async function load() {
  const all = [];
  for (let page = 1; page <= 14; page++) {
    const url = `${DC}?reportName=RPT_VALUEANALYSIS_DET&columns=${COLS}&pageNumber=${page}&pageSize=500&sortColumns=TRADE_DATE&sortTypes=-1&source=WEB&client=WEB`;
    const j = await fetchJson(url);
    const rows = j?.result?.data ?? [];
    if (!rows.length) break;
    all.push(...rows);
    process.stderr.write(`page ${page}: ${rows.length}\n`);
    if (rows.length < 500) break;
    await new Promise(r => setTimeout(r, 300));
  }
  return all;
}

const parsed = JSON.parse(JSON.parse(
  readFileSync('data/account-data.json', 'utf8')
).users['u8335b8a4ab2020e6b9d683b0'].data['fin-terminal.watchlist.v2']);
const mine = new Set(parsed.items.filter(i => i.symbol.startsWith('sh') || i.symbol.startsWith('sz')).map(i => i.symbol.slice(2)));

const rows = await load();
console.log(`\n全市场样本: ${rows.length} 行`);

const dates = [...new Set(rows.map(r => r.TRADE_DATE?.slice(0, 10)))].sort();
const asOf = dates[dates.length - 1];
// 分页取的是连续多个交易日，需按代码+日期去重后只留最新截面
const latest = new Map();
for (const r of rows) if (r.SECURITY_CODE) latest.set(r.SECURITY_CODE, r);
const snap = [...latest.values()];
console.log(`截面日期: ${asOf}, 样本: ${snap.length} 只`);

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const med = (arr, key) => {
  const v = arr.map(key).filter(x => x != null).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
const q = (arr, key, p) => {
  const v = arr.map(key).filter(x => x != null).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length * p)] : null;
};

console.log('\n=== 全市场估值中位数（检验 2.5 / 25 阈值是否仍适用）===');
console.log('PE-TTM  中位:', med(snap, r => num(r.PE_TTM))?.toFixed(2), ' 25分位:', q(snap, r => num(r.PE_TTM), 0.25)?.toFixed(2));
console.log('PB-MRQ  中位:', med(snap, r => num(r.PB_MRQ))?.toFixed(2), ' 25分位:', q(snap, r => num(r.PB_MRQ), 0.25)?.toFixed(2));

const mineRows = snap.filter(r => mine.has(r.SECURITY_CODE));
console.log(`\n自选股(A股)有行情: ${mineRows.length} / ${mine.size}`);

const pick = (rs, peMax, pbMax) => rs.filter(r => {
  const pe = num(r.PE_TTM), pb = num(r.PB_MRQ);
  return pe != null && pe > 0 && pe < peMax && pb != null && pb > 0 && pb < pbMax;
});
const isST = n => /(^|\*)S?ST/i.test(String(n).trim());

for (const [peMax, pbMax] of [[20, 2], [25, 2.5], [30, 3]]) {
  const all = pick(mineRows, peMax, pbMax);
  const hit = all.filter(r => !isST(r.SECURITY_NAME_ABBR));
  console.log(`\n=== PE<${peMax} 且 PB<${pbMax} ===`);
  console.log(`命中 ${all.length} 只，剔除 ST ${all.length - hit.length} 只后剩 ${hit.length}`);
  if (hit.length) {
    console.log(`  市值中位 ${(med(hit, r => num(r.TOTAL_MARKET_CAP)) / 1e8).toFixed(1)} 亿`);
    console.log(`  PE 中位 ${med(hit, r => num(r.PE_TTM)).toFixed(1)} · PB 中位 ${med(hit, r => num(r.PB_MRQ)).toFixed(2)}`);
    console.log(`  样例: ${hit.slice(0, 14).map(r => `${r.SECURITY_NAME_ABBR}(${r.SECURITY_CODE}) PE${num(r.PE_TTM).toFixed(1)} PB${num(r.PB_MRQ).toFixed(2)}`).join(' / ')}`);
  }
}

const uni = pick(snap, 20, 2).filter(r => !isST(r.SECURITY_NAME_ABBR));
console.log(`\n=== 全市场同阈值命中率 ===`);
console.log(`全市场 ${snap.length} 只命中 ${uni.length} 只 = ${(uni.length / snap.length * 100).toFixed(1)}%`);

writeFileSync('/tmp/ds.json', JSON.stringify({ asOf, hit: pick(mineRows, 20, 2), mineRows }));
