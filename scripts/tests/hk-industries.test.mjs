import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHkIndustrySnapshot, HK_UNIVERSE_FILTER } from '../fetch-hk-industries.mjs';
import { load } from './load-modules.mjs';
const lib = await load('hkIndustries');
const directory = (code, extra = {}) => ({
  f12: code, f13: 128, f14: `公司${code}`, f26: 20040101, ...extra,
});
const profile = (code, extra = {}) => ({
  SECUCODE: `${code}.HK`, SECURITY_CODE: code, CURRENCY: '港元',
  INDUSTRY_TYPE: '金融-银行-商业银行-综合性银行', BELONG_INDUSTRY: '银行',
  LISTING_DATE: '2004-01-01 00:00:00', BELONG_MARKET: '香港主板', ...extra,
});
const asOf = '2026-10-18T16:49:50.576Z';

test('provider membership excludes product/counter contamination without dropping old IPOs or unclassified members', () => {
  assert.equal(HK_UNIVERSE_FILTER, 'm:128+t:3,m:128+t:4');
  const raw = [
    directory('00004', { f26: 19210101 }),
    directory('08001'), directory('00700'), directory('09999'),
    directory('80700'), directory('04621'), directory('03333', { f26: 0 }),
    directory('01015', { f26: 19000101 }),
    directory('06157', { f26: 20261020 }),
    directory('123456'), directory('00001', { f13: 1 }),
  ];
  const data = buildHkIndustrySnapshot(raw, [
    profile('00004'), profile('08001'), profile('00700', { INDUSTRY_TYPE: null }),
    profile('04621', { CURRENCY: '美元' }),
    // A CMU instrument must never become a stock's profile through code matching.
    profile('09999', { SECUCODE: '09999.CMU' }),
  ], asOf);
  assert.deepEqual(data.members.map((row) => row.code), ['00004', '00700', '08001', '09999']);
  assert.equal(data.provenance.sourceStockCount, raw.length);
  assert.equal(data.provenance.officialListingRegister, false);
  assert.equal(data.provenance.unclassifiedCount, 2);
  assert.deepEqual(data.members.find((row) => row.code === '09999').industryPath, []);
  assert.equal(data.version, 'eastmoney-hk-20261019');
  assert.equal(data.exclusions.find((row) => row.code === '06157').reason, 'not-yet-listed');
  assert.equal(data.exclusions.find((row) => row.code === '04621').reason, 'non-hkd-security');
  assert.equal(data.exclusions.find((row) => row.code === '03333').reason, 'invalid-listing-date');
  assert.equal(data.exclusions.find((row) => row.code === '80700').reason, 'non-hkd-counter');
});

test('classification keeps true three source levels and fourth-level metadata, independent of BELONG_INDUSTRY', () => {
  const data = buildHkIndustrySnapshot([directory('00700'), directory('00700')], [profile('00700', {
    INDUSTRY_TYPE: '通讯服务-媒体与娱乐-互动媒体与服务-互动媒体与服务',
    BELONG_INDUSTRY: '软件服务',
  })], asOf);
  assert.equal(data.members.length, 1);
  assert.deepEqual(data.members[0].industryPath, ['通讯服务', '媒体与娱乐', '互动媒体与服务']);
  assert.equal(data.members[0].industryDetail, '互动媒体与服务');
  assert.equal(data.members[0].industry, '软件服务');
  assert.throws(() => buildHkIndustrySnapshot([], [], 'bad date'), /Invalid snapshot date/);
});

test('bundled snapshot has unique canonical stock codes and full membership at each real taxonomy depth', () => {
  const members = lib.HK_INDUSTRY_MEMBERS, stats = lib.hkStats(), tree = lib.hkIndustryTree();
  assert.ok(members.length > 2000);
  assert.equal(stats.stocks, members.length);
  assert.equal(new Set(members.map((row) => row.code)).size, members.length);
  assert.equal(tree.reduce((total, node) => total + node.count, 0), members.length);
  assert.equal(lib.hkIndustrySymbol('00700'), 'hk00700');
  assert.equal(lib.hkIndustrySymbol('08001'), 'hk08001');
  for (const invalid of ['00000', '700', '600519', '80700', 'hk00700', '0000x'])
    assert.equal(lib.hkIndustrySymbol(invalid), null);
  assert.equal(lib.hkIndustryMember('03333'), undefined);
  assert.equal(lib.hkIndustryMember('06157'), undefined);
  assert.equal(lib.hkIndustryMember('02800'), undefined); // ETP, outside t3/t4 stock directory.
  for (const member of members) {
    assert.equal(lib.hkIndustrySymbol(member.code), `hk${member.code}`);
    const path = member.industryPath;
    for (let level = 1; level <= path.length; level++) {
      const node = lib.findHkIndustryNode(path[level - 1], level, path[0], level > 1 ? path[1] : null);
      assert.ok(node, `${member.code}: valid hierarchy at level ${level}`);
      assert.ok(node.stocks.includes(member.code));
    }
  }
  const tencent = lib.hkIndustryMember('00700');
  assert.deepEqual(tencent.industryPath, ['通讯服务', '媒体与娱乐', '互动媒体与服务']);
  assert.equal(lib.findHkIndustryNode('商业银行', 3, '房地产'), null);
  assert.equal(lib.resolveHkIndustry('不存在的行业'), null);
});
