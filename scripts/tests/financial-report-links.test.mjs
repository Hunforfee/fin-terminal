import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load-modules.mjs';
const { parseOriginalReportTitle: parse, selectFinancialReportLinks: select, reportWindowStart, shanghaiDate } = await load('financialReportLinks');
const today = '2026-10-19';
const row = (title, extras = {}) => ({ secCode: '600519', announcementTitle: title, announcementTime: Date.parse('2026-04-22T00:00:00Z'), adjunctUrl: 'finalpage/2026-04-22/1225137588.PDF', ...extras });

test('matches actual report period rather than publication year or header H2 label', () => {
  assert.deepEqual(parse('贵州茅台2025年年度报告'), { period: '2025-12-31', kind: 'annual', revised: false });
  assert.equal(parse('2026年半年度报告全文').period, '2026-06-30');
  assert.equal(parse('2025年第三季度报告').kind, 'q3');
  assert.equal(parse('2026年第一季度报告').period, '2026-03-31');
  assert.equal(parse('2026年一季度报告').period, '2026-03-31');
  assert.equal(parse('2025年三季度报告').period, '2025-09-30');
  assert.equal(parse('2025年度报告').period, '2025-12-31');
  assert.equal(parse('中国平安2026年中期报告').period, '2026-06-30');
  assert.equal(parse('2025年年度报告（2026年4月修订版）').revised, true);
  assert.equal(select([row('2025年年度报告')], '600519', today)[0].publishedAt, '2026-04-22');
});
test('parent announcements cannot link a subsidiary report to the parent financial column', () => {
  assert.equal(parse('中国平安：平安银行股份有限公司2025年第三季度报告'), null);
  assert.equal(parse('中国平安：2025年第三季度报告').period, '2025-09-30');
});
test('rejects summaries, forecasts, meeting materials, corrections-only notices and foreign versions', () => {
  for (const title of ['2025年年度报告摘要', '2025年年度报告（英文版）', '2025年年度报告业绩说明会', '关于2025年年度报告的更正公告', '关于2025年年度报告', '董事会审议2025年年度报告', '2025年年度业绩预告', '2025年年度报告取消公告']) assert.equal(parse(title), null, title);
});
test('selects latest full revision while rejecting hostile attachments and other companies', () => {
  const revised = row('2025年年度报告（修订版）', { announcementTime: Date.parse('2026-06-01'), adjunctUrl: 'finalpage/2026-06-01/1234567890.PDF' });
  const result = select([
    row('2025年年度报告'), revised, row('2025年年度报告摘要'),
    row('2025年年度报告', { secCode: '300498', announcementTime: Date.parse('2026-06-02') }),
    row('2025年年度报告', { adjunctUrl: 'https://evil.example/report.pdf', announcementTime: Date.parse('2026-06-03') }),
  ], '600519', today);
  assert.equal(result.length, 1); assert.equal(result[0].revised, true);
  assert.equal(result[0].url, 'https://static.cninfo.com.cn/finalpage/2026-06-01/1234567890.PDF');
  // A later complete republication supersedes an earlier corrected edition.
  assert.equal(select([revised, row('2025年年度报告', { announcementTime: Date.parse('2026-06-05') })], '600519', today)[0].revised, false);
});
test('only returns disclosed periods within the rolling two-year window; leap day and Shanghai midnight are safe', () => {
  assert.equal(reportWindowStart('2024-02-29'), '2022-02-28');
  assert.equal(shanghaiDate(new Date('2026-10-18T16:00:00Z')), '2026-10-19');
  const result = select([
    row('2024年第三季度报告', { announcementTime: Date.parse('2024-10-30') }),
    row('2024年年度报告', { announcementTime: Date.parse('2025-04-01') }),
    row('2026年年度报告'),
    row('2026年第三季度报告', { announcementTime: Date.parse('2026-10-20') }),
    row('2025年年度报告', { announcementTime: NaN }),
    row('2025年年度报告', { announcementTime: Date.parse('2025-11-01') }),
  ], '600519', today);
  assert.deepEqual(result.map(item => item.period), ['2024-12-31']);
});
test('HK full reports support both title orders, but calendar dates must be confirmed', () => {
  assert.equal(parse('2025 年报', true, true).period, '2025-12-31');
  assert.equal(parse('中期報告 2026', true, true).period, '2026-06-30');
  assert.equal(parse('2025 中报', true, true).period, '2025-06-30');
  assert.equal(parse('中期報告二零二五', true, true).period, '2025-06-30');
  assert.equal(parse('2025 年报', true, false), null);
  assert.equal(parse('2025/26 年报', true, true), null);
  assert.equal(parse('2026年中期业绩公告', true, true), null);
  assert.deepEqual(parse('截至2026年9月30日止六个月中期报告', true), { period: '2026-09-30', kind: 'semi', revised: false });
  assert.equal(parse('截至2026年2月30日止中期报告', true), null);
  assert.equal(select([row('2025 年报', { secCode: '00700' })], '00700', today, true).length, 1);
});
