import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load-modules.mjs';
const { fetchDisclosureDates, parseDisclosureDates } = await load('datasource/disclosures');

test('sina quarterly pages yield report periods strictly after the report date', () => {
  const html = '<div>2023-10-28&nbsp;<a href="#">五粮液:2023年第三季度报告</a>2023-04-27&nbsp;<a href="#">五粮液:2023年第一季度报告(英文版)</a></div>';
  const dates = parseDisclosureDates(html);
  assert.equal(dates.get('2023-09-30'), '2023-10-28');
  assert.ok(!dates.has('2023-03-31'), 'english versions are not first disclosures');
});

test('missing sina groups are backfilled from eastmoney disclosure schedule', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('datacenter-web.eastmoney.com')) {
      return new Response(JSON.stringify({ result: { pages: 1, data: [
        { REPORTDATE: '2023-09-30 00:00:00', NOTICE_DATE: '2023-10-28 00:00:00' },
        { REPORTDATE: '2022-09-30 00:00:00', NOTICE_DATE: '2022-10-28 00:00:00' },
        { REPORTDATE: '2022-06-30 00:00:00', NOTICE_DATE: '2022-08-29 00:00:00' },
      ] } }));
    }
    return new Response('', { status: 503 }); // sina 全部失败时东财仍可独立兜底
  };
  try {
    const dates = await fetchDisclosureDates('000858', 2020);
    assert.equal(dates.get('2023-09-30'), '2023-10-28');
    assert.equal(dates.get('2022-09-30'), '2022-10-28');
    assert.equal(dates.get('2022-06-30'), '2022-08-29');
    assert.ok(!dates.has('2022-03-31'), 'non-disclosed reports are not invented');
  } finally { globalThis.fetch = original; }
});
