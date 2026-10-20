/** Fetch public source material only; never generates or overwrites an analysis. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'src/data/analyses/_raw/coverage');
const args = process.argv.slice(2);
const watch = JSON.parse(await fs.readFile(path.join(root, 'scripts/uncovered-watchlist.json'), 'utf8'));
const files = new Set(await fs.readdir(path.join(root, 'src/data/analyses')));
const codes = args.length ? args : [...new Set(watch.map(item => item.code))].filter(code => /^\d{5}$/.test(code) && !files.has(`${code}.json`));
if (codes.some(code => !/^\d{5}$/.test(code))) throw Error('Use five-digit HK codes');
await fs.mkdir(out, { recursive: true });
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const headers = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://emweb.securities.eastmoney.com/' };
async function json(url, options = {}) {
  for (let attempt = 0; attempt < 2; attempt++) try {
    const r = await fetch(url, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(14000) });
    if (!r.ok) throw Error(`HTTP ${r.status}`); return await r.json();
  } catch (error) { if (attempt) throw error; }
}
function endpoint(reportName, code, count = '1') {
  return 'https://datacenter.eastmoney.com/securities/api/data/v1/get?' + new URLSearchParams({ reportName, columns: 'ALL', filter: `(SECUCODE="${code}.HK")`, pageSize: count, pageNumber: '1', ...(count !== '1' ? { sortColumns: 'REPORT_DATE', sortTypes: '-1' } : {}), source: 'F10', client: 'PC' });
}
async function disclosures(code) {
  const base = 'https://www.cninfo.com.cn';
  const post = (pathname, body) => json(base + pathname, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: base + '/' }, body: new URLSearchParams(body) });
  const matches = await post('/new/information/topSearch/query', { keyWord: code, maxNum: '10' });
  const issuer = Array.isArray(matches) && matches.find(item => item.code === code && item.category === '港股');
  if (!issuer) return [];
  const results = await post('/new/hisAnnouncement/query', { pageNum: '1', pageSize: '60', column: 'hke', tabName: 'fulltext', stock: `${code},${issuer.orgId}`, seDate: `${Number(date.slice(0, 4)) - 2}-01-01~${date}`, searchkey: '报告', isHLtitle: 'false', sortName: 'time', sortType: 'desc' });
  return (results.announcements || []).filter(item => item.secCode === code && /年报|年度报告|中期报告|中报|Annual Report|Interim Report/i.test(item.announcementTitle) && !/摘要|环境|环境|管治|ESG|可持续|变更|更改|通告|通知|董事|审计/i.test(item.announcementTitle) && /^finalpage\/\d{4}-\d{2}-\d{2}\/\d+\.pdf$/i.test(item.adjunctUrl))
    .slice(0, 5).map(item => ({ title: item.announcementTitle.replace(/<[^>]*>/g, ''), publishedAt: new Date(item.announcementTime).toISOString().slice(0, 10), url: `https://static.cninfo.com.cn/${item.adjunctUrl}` }));
}
let done = 0, cursor = 0;
const summary = [];
async function worker() {
  while (cursor < codes.length) {
    const code = codes[cursor++], target = path.join(out, `${code}.json`);
    let old; try { old = JSON.parse(await fs.readFile(target, 'utf8')); } catch {}
    if (old?.retrievedAt?.startsWith(date) && old.profile) { summary.push({ code, cached: true, profile: true, financials: old.financials.length, disclosures: old.disclosures.length }); done++; continue; }
    const profileUrl = endpoint('RPT_HKF10_INFO_ORGPROFILE', code), financeUrl = endpoint('RPT_HKF10_FN_MAININDICATOR', code, '6');
    const [p, f, d] = await Promise.allSettled([json(profileUrl), json(financeUrl), disclosures(code)]);
    const rawProfile = p.status === 'fulfilled' ? p.value.result?.data?.find(item => item.SECURITY_CODE === code) : null;
    const profile = rawProfile ? Object.fromEntries(['SECURITY_CODE', 'SECURITY_NAME_ABBR', 'ORG_NAME', 'BELONG_INDUSTRY', 'INDUSTRY_TYPE', 'ORG_PROFILE', 'MAIN_BUSINESS', 'ORG_WEB', 'LISTING_DATE', 'YEAR_SETTLE_DAY', 'ORG_TYPE'].map(key => [key, rawProfile[key] ?? null])) : null;
    const financials = f.status === 'fulfilled' ? (f.value.result?.data || []).filter(item => item.SECURITY_CODE === code && typeof item.REPORT_DATE === 'string' && item.REPORT_DATE.slice(0, 10) <= date) : [];
    const row = { code, retrievedAt: new Date().toISOString(), profile, financials, disclosures: d.status === 'fulfilled' ? d.value : [], urls: { profile: profileUrl, financials: financeUrl }, errors: [p.status === 'rejected' ? 'profile' : '', f.status === 'rejected' ? 'financials' : '', d.status === 'rejected' ? 'disclosures' : ''].filter(Boolean) };
    await fs.writeFile(target, JSON.stringify(row, null, 2));
    summary.push({ code, profile: !!profile, financials: financials.length, disclosures: row.disclosures.length });
    done++; if (done % 20 === 0 || done === codes.length) console.log(`Fetched ${done}/${codes.length}`);
  }
}
await Promise.all(Array.from({ length: Math.min(5, codes.length) }, worker));
await fs.writeFile(path.join(out, '_collection.json'), JSON.stringify({ date, total: codes.length, summary }, null, 2));
console.log(JSON.stringify({ total: codes.length, profiles: summary.filter(item => item.profile).length, missingProfiles: summary.filter(item => !item.profile).map(item => item.code) }));
