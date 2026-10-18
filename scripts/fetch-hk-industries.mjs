/**
 * Refresh the Hong Kong industry snapshot from Eastmoney's stock directory and
 * F10 profiles. The stock directory is provider coverage, not an official HKEX
 * listing register. No quote availability or company-name heuristic determines
 * membership. Run from the repository root, optionally with saved raw inputs:
 * node scripts/fetch-hk-industries.mjs --universe file.json --profiles file.json
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const HK_UNIVERSE_FILTER = 'm:128+t:3,m:128+t:4';
export const HK_PROFILE_REPORT = 'RPT_HKF10_INFO_ORGPROFILE';
const DIRECTORY_URL = 'https://push2.eastmoney.com/api/qt/clist/get';
const PROFILE_URL = 'https://datacenter.eastmoney.com/securities/api/data/v1/get';
const PROFILE_FIELDS = [
  'SECUCODE', 'SECURITY_CODE', 'SECURITY_NAME_ABBR', 'BELONG_INDUSTRY',
  'LISTING_DATE', 'BELONG_MARKET', 'CURRENCY', 'INDUSTRY_TYPE',
].join(',');

const clean = (value) => typeof value === 'string' ? value.trim() : '';
const shanghaiDate = (asOf) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' })
    .format(new Date(asOf)).replaceAll('-', '');

export function buildHkIndustrySnapshot(universe, profiles, asOf) {
  if (!Number.isFinite(Date.parse(asOf))) throw Error('Invalid snapshot date');
  const byCode = new Map(profiles.filter((row) =>
    /^\d{5}$/.test(row.SECURITY_CODE) &&
    row.SECUCODE === `${row.SECURITY_CODE}.HK`,
  ).map((row) => [row.SECURITY_CODE, row]));
  const directory = new Map(universe.map((row) => [String(row.f12), row]));
  const members = [], exclusions = [];
  const today = Number(shanghaiDate(asOf));
  for (const [code, row] of directory) {
    const profile = byCode.get(code);
    let reason = null;
    if (!/^\d{5}$/.test(code) || Number(code) === 0 || row.f13 !== 128)
      reason = 'invalid-hk-code';
    // Eight-/nine-ten-thousand counters duplicate the HKD share class. GEM
    // 08xxx remains included: compare the five-digit number, not its first digit.
    else if (Number(code) >= 80000) reason = 'non-hkd-counter';
    // The provider retains removed securities with a zero listing date and
    // synthetic placeholders with 19000101. Do not reject genuine pre-1970 IPOs.
    else if (Number(row.f26) === 0 || Number(row.f26) === 19000101)
      reason = 'invalid-listing-date';
    else if (/^\d{8}$/.test(String(row.f26)) && Number(row.f26) > today)
      reason = 'not-yet-listed';
    else if (clean(profile?.CURRENCY) &&
      !['港元', '港币', 'HKD'].includes(clean(profile.CURRENCY)))
      reason = 'non-hkd-security';
    if (reason) {
      exclusions.push({ code, name: clean(row.f14), reason });
      continue;
    }
    const industryPath = clean(profile?.INDUSTRY_TYPE).split('-')
      .map((part) => part.trim()).filter(Boolean);
    members.push({
      code,
      name: clean(row.f14) || clean(profile?.SECURITY_NAME_ABBR) || code,
      industryPath: industryPath.slice(0, 3),
      industryDetail: industryPath.length > 3 ? industryPath.slice(3).join('-') : null,
      industry: clean(profile?.BELONG_INDUSTRY) || null,
      listingDate: clean(profile?.LISTING_DATE)?.slice(0, 10) || null,
      board: clean(profile?.BELONG_MARKET) || null,
    });
  }
  members.sort((a, b) => a.code.localeCompare(b.code));
  exclusions.sort((a, b) => a.code.localeCompare(b.code));
  const classifiedCount = members.filter((row) => row.industryPath.length).length;
  const excludedByReason = Object.fromEntries([...new Set(exclusions.map((row) => row.reason))]
    .sort().map((reason) => [reason, exclusions.filter((row) => row.reason === reason).length]));
  return {
    version: `eastmoney-hk-${shanghaiDate(asOf)}`,
    asOf,
    classification: 'EASTMONEY-HK',
    currency: 'HKD',
    provenance: {
      membershipSource: DIRECTORY_URL,
      membershipFilter: HK_UNIVERSE_FILTER,
      classificationSource: PROFILE_URL,
      classificationReport: HK_PROFILE_REPORT,
      classificationField: 'INDUSTRY_TYPE',
      hierarchy: 'first-three-source-levels; fourth-source-level-retained-as-detail',
      scope: 'provider-main-board-and-gem-hkd-stock-directory',
      officialListingRegister: false,
      sourceStockCount: directory.size,
      sourceProfileCount: profiles.length,
      classifiedCount,
      unclassifiedCount: members.length - classifiedCount,
      excludedCount: exclusions.length,
      excludedByReason,
    },
    members,
    exclusions,
  };
}

async function readJson(url) {
  const response = await fetch(url, {
    headers: { Referer: 'https://emweb.securities.eastmoney.com/' },
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) throw Error(`Source HTTP ${response.status}`);
  return response.json();
}

async function pages(readPage, readRows, readTotal) {
  const first = await readPage(1), rows = readRows(first), total = readTotal(first);
  if (!Array.isArray(rows) || !rows.length || !Number.isSafeInteger(total))
    throw Error('Source returned no valid directory');
  // Both sources cap requested page sizes. Derive the actual page length.
  const result = [...rows], pageCount = Math.ceil(total / rows.length);
  let next = 2;
  await Promise.all(Array.from({ length: Math.min(2, pageCount - 1) }, async () => {
    while (next <= pageCount) {
      const page = await readPage(next++), batch = readRows(page);
      if (readTotal(page) !== total || !Array.isArray(batch))
        throw Error('Source changed while paging; retry without replacing snapshot');
      result.push(...batch);
    }
  }));
  if (result.length !== total) throw Error('Incomplete directory; snapshot not replaced');
  return result;
}

async function fetchUniverse() {
  const rows = await pages((pn) => {
    const url = new URL(DIRECTORY_URL);
    url.search = new URLSearchParams({
      pn: String(pn), pz: '100', po: '0', np: '1', fltt: '2', fid: 'f12',
      fs: HK_UNIVERSE_FILTER, fields: 'f12,f13,f14,f26,f100,f124',
    });
    return readJson(url);
  }, (data) => data.data?.diff, (data) => data.data?.total);
  if (new Set(rows.map((row) => row.f12)).size !== rows.length)
    throw Error('Duplicate directory pages; snapshot not replaced');
  return rows;
}

async function fetchProfiles() {
  const rows = await pages((page) => {
    const url = new URL(PROFILE_URL);
    url.search = new URLSearchParams({
      reportName: HK_PROFILE_REPORT, columns: PROFILE_FIELDS,
      pageNumber: String(page), pageSize: '500', source: 'F10', client: 'PC',
      sortColumns: 'SECURITY_CODE', sortTypes: '1',
    });
    return readJson(url);
  }, (data) => data.result?.data, (data) => data.result?.count);
  if (new Set(rows.map((row) => row.SECUCODE)).size !== rows.length)
    throw Error('Duplicate profile pages; snapshot not replaced');
  return rows;
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : null;
  const load = async (file, fetcher) => file
    ? (JSON.parse(await fs.readFile(file, 'utf8')).rows)
    : fetcher();
  const [universe, profiles] = await Promise.all([
    load(option('--universe'), fetchUniverse),
    load(option('--profiles'), fetchProfiles),
  ]);
  if (!Array.isArray(universe) || !Array.isArray(profiles)) throw Error('Missing input rows');
  const snapshot = buildHkIndustrySnapshot(universe, profiles, option('--as-of') || new Date().toISOString());
  if (snapshot.members.length < 1000)
    throw Error('Unexpectedly small stock directory; snapshot not replaced');
  const target = path.resolve('src/lib/hk-industries.json');
  const temporary = `${target}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(snapshot)}\n`);
  await fs.rename(temporary, target);
  console.log(JSON.stringify({ version: snapshot.version, stocks: snapshot.members.length,
    ...snapshot.provenance }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
