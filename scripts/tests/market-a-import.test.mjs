import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load-modules.mjs';

const mod = await load('marketAImportRecords');
const market = await load('marketStore');
const now = Date.parse('2026-10-23T02:00:00Z');

/** 内存存储：digest CAS 写入语义与持久层一致。 */
function memory() {
  const data = new Map();
  return {
    data,
    read: async key => structuredClone(data.get(key) ?? null),
    async write(row, expected) {
      if ((data.get(row.key)?.digest ?? null) !== expected) return false;
      data.set(row.key, structuredClone(row));
      return true;
    },
    remove: async key => data.delete(key), incident: async () => {},
    seed(key, kind, payload) { data.set(key, market.marketRecord(key, kind, 'test', payload, 1e8, now)); },
  };
}

test('披露日期：正常导入、保留窗口、预约与未来日期排除', async () => {
  const store = memory();
  const r = await mod.importDisclosureDates(store, {
    symbol: 'sh600519',
    items: [
      { date: '2025-12-31', published: '2026-04-17', basis: '巨潮公告' },
      { date: '2024-12-31', published: '2030-01-01' },          // 未来日期 → missing
      { date: '2023-12-31', published: '2023-03-31' },          // 未晚于报告期 → 预约排除
      { date: 'bad-date', published: '2024-04-01' },            // 日期无效
    ],
  }, now);
  assert.equal(r.saved, 1);
  assert.deepEqual(r.savedPeriods, ['2025-12-31']);
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.missing.length, 3);
  assert.match(r.missing[0].reason, /晚于今天/);
  assert.match(r.missing[1].reason, /预约/);
  const saved = await store.read(r.key);
  assert.equal(saved.key, 'disclosures-v3:600519:12');
  assert.equal(saved.kind, 'disclosure-dates');
  const map = new Map(saved.payload.$marketMap);
  assert.equal(map.get('2025-12-31'), '2026-04-17');
});

test('披露日期：冲突返回明细不覆盖，幂等导入 skipped', async () => {
  const store = memory();
  await mod.importDisclosureDates(store, { symbol: 'sh600519', items: [{ date: '2025-12-31', published: '2026-04-17' }] }, now);
  // 冲突：同报告期不同披露日
  const c = await mod.importDisclosureDates(store, { symbol: 'sh600519', items: [{ date: '2025-12-31', published: '2026-04-20', basis: '另一来源' }] }, now);
  assert.equal(c.saved, 0);
  assert.equal(c.conflicts.length, 1);
  assert.equal(c.conflicts[0].stored, '2026-04-17');
  assert.equal(c.conflicts[0].incoming, '2026-04-20');
  assert.equal(c.skipped, true);
  const stored = await store.read(c.key);
  assert.equal(new Map(stored.payload.$marketMap).get('2025-12-31'), '2026-04-17'); // 原值未覆盖
  // 幂等：相同值重复导入
  const idem = await mod.importDisclosureDates(store, { symbol: 'sh600519', items: [{ date: '2025-12-31', published: '2026-04-17' }] }, now);
  assert.equal(idem.skipped, true);
  assert.deepEqual(idem.savedPeriods, ['2025-12-31']);
  // 附加新报告期正常合并
  const add = await mod.importDisclosureDates(store, { symbol: 'sh600519', items: [{ date: '2025-06-30', published: '2025-08-02' }] }, now);
  assert.equal(add.saved, 1);
  const merged = new Map((await store.read(add.key)).payload.$marketMap);
  assert.equal(merged.get('2025-12-31'), '2026-04-17');
  assert.equal(merged.get('2025-06-30'), '2025-08-02');
});

test('披露日期：港股拒绝、缺 items 拒绝', async () => {
  const store = memory();
  await assert.rejects(mod.importDisclosureDates(store, { symbol: 'hk00700', items: [{ date: '2025-12-31', published: '2026-03-01' }] }, now), /仅支持 A 股/);
  await assert.rejects(mod.importDisclosureDates(store, { symbol: 'sh600519', items: [] }, now), /items 为空/);
});

test('年度指标：正常导入、未知指标名拒绝、跨年报告期拒绝', async () => {
  const store = memory();
  const r = await mod.importAIndicators(store, {
    symbol: '600519', year: 2025, basis: '2025 年报',
    items: [
      { date: '2025-12-31', indicator: '净资产收益率(%)', value: 34.5 },
      { date: '2025-12-31', indicator: '摊薄每股收益(元)', value: 68.12 },
      { date: '2025-12-31', indicator: '自定义ROE口径', value: 99 },        // 未知指标 → missing
      { date: '2024-12-31', indicator: '净资产收益率(%)', value: 36 },      // 跨年 → missing
      { date: '2025-06-30', indicator: '净资产收益率(%)', value: null },    // 空值 → missing
    ],
  }, now);
  assert.equal(r.saved, 2);
  assert.deepEqual(r.savedPeriods, ['2025-12-31']);
  assert.equal(r.missing.length, 3);
  assert.match(r.missing[0].reason, /未知指标名/);
  const saved = await store.read(r.key);
  assert.equal(saved.key, 'source-sina-indicators:v1:600519:2025');
  assert.equal(saved.kind, 'source-sina-indicators');
  const rows = new Map(saved.payload.rows.$marketMap);
  assert.deepEqual(saved.payload.dates, ['2025-12-31']);
  assert.equal(rows.get('净资产收益率(%)')[0], '34.5');
  assert.equal(rows.get('摊薄每股收益(元)')[0], '68.12');
});

test('年度指标：与库内记录合并，空值不覆盖有效值，冲突明细', async () => {
  const store = memory();
  // 播种已有记录（新浪口径：dates 降序，rows Map 形式 wire $marketMap）
  store.seed('source-sina-indicators:v1:600519:2025', 'source-sina-indicators', {
    dates: ['2025-12-31', '2025-09-30'],
    rows: { $marketMap: [['净资产收益率(%)', ['36.2', '28.1']], ['销售净利率(%)', ['52.3', null]]] },
  });
  const r = await mod.importAIndicators(store, {
    symbol: 'sh600519', year: 2025,
    items: [
      { date: '2025-09-30', indicator: '销售净利率(%)', value: 51.9 },       // 覆盖 null → 保存
      { date: '2025-12-31', indicator: '净资产收益率(%)', value: 36.2 },     // 相同值 → 幂等
      { date: '2025-12-31', indicator: '销售净利率(%)', value: 40.0 },       // 冲突 → 明细不覆盖
      { date: '2025-06-30', indicator: '每股经营性现金流(元)', value: 33.1 }, // 新报告期 + 新指标
    ],
  }, now);
  assert.equal(r.saved, 3);
  assert.deepEqual(r.savedPeriods, ['2025-06-30', '2025-09-30', '2025-12-31']);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].stored, '52.3');
  assert.equal(r.conflicts[0].incoming, 40.0);
  const saved = await store.read(r.key);
  const rows = new Map(saved.payload.rows.$marketMap);
  assert.deepEqual(saved.payload.dates, ['2025-12-31', '2025-09-30', '2025-06-30']); // 降序
  assert.deepEqual(rows.get('净资产收益率(%)'), ['36.2', '28.1', null]);               // 原值保留、新期补 null
  assert.deepEqual(rows.get('销售净利率(%)'), ['52.3', '51.9', null]);                 // null 被有效值覆盖
  assert.deepEqual(rows.get('每股经营性现金流(元)'), [null, null, '33.1']);            // 新行按期对齐
});

test('年度指标：CAS 版本冲突检测（并发修改时拒绝写入）', async () => {
  const data = new Map();
  const store = {
    read: async key => structuredClone(data.get(key) ?? null),
    // 模拟并发竞争：每次 CAS 写入都因 digest 已被第三方改写而失败
    async write() { return false; },
  };
  await assert.rejects(
    mod.importAIndicators(store, { symbol: 'sh600519', year: 2025, items: [{ date: '2025-12-31', indicator: '净资产收益率(%)', value: 34.5 }] }, now),
    /版本冲突/,
  );
});

test('年度指标：港股拒绝、年份越界拒绝', async () => {
  const store = memory();
  await assert.rejects(mod.importAIndicators(store, { symbol: 'hk00700', year: 2025, items: [{ date: '2025-12-31', indicator: '净资产收益率(%)', value: 1 }] }, now), /仅支持 A 股/);
  await assert.rejects(mod.importAIndicators(store, { symbol: 'sh600519', year: 1990, items: [] }, now), /year 必须是/);
});
