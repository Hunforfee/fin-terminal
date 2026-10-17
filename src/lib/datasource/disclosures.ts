import { fetchText } from './http';

/** Original Chinese reports only: translated versions and corrections are not first disclosure dates. */
export function parseDisclosureDates(html: string): Map<string, string> {
  const dates = new Map<string, string>();
  const re = /(\d{4}-\d{2}-\d{2})(?:&nbsp;|\s)*<a\b[^>]*>([^<]+)<\/a>/g;
  for (const m of html.matchAll(re)) {
    const title = m[2];
    if (/英文|摘要|更正|修订|更新|取消/.test(title)) continue;
    const year = title.match(/(\d{4})年/);
    if (!year) continue;
    const md = /第一季度|一季报/.test(title) ? '03-31'
      : /半年度|中期报告/.test(title) ? '06-30'
      : /第三季度|三季报/.test(title) ? '09-30'
      : /年度报告|年报报告/.test(title) ? '12-31' : null;
    if (!md) continue;
    const report = `${year[1]}-${md}`;
    if (m[1] <= report) continue;
    if (!dates.has(report) || m[1] < dates.get(report)!) dates.set(report, m[1]);
  }
  return dates;
}

export async function fetchDisclosureDates(code: string, fromYear: number): Promise<Map<string, string>> {
  const groups = ['ndbg', 'zqbg', 'yjdbg', 'sjdbg'];
  const results = await Promise.all(groups.map(async group => {
    const dates = new Map<string, string>();
    let previous = '';
    for (let page = 1; page <= 8; page++) {
      const html = await fetchText(
        `https://money.finance.sina.com.cn/corp/view/vCB_AllBulletin.php?stockid=${code}&ftype=${group}&Page=${page}`,
        { encoding: 'gbk', timeoutMs: 12000 },
      ).catch(() => '');
      const got = parseDisclosureDates(html);
      const signature = JSON.stringify([...got]);
      if (!got.size || signature === previous) break;
      previous = signature;
      for (const [report, date] of got) {
        if (!dates.has(report) || date < dates.get(report)!) dates.set(report, date);
      }
      if ([...got.keys()].some(d => Number(d.slice(0, 4)) < fromYear)) break;
    }
    return dates;
  }));
  const result = new Map<string, string>();
  for (const dates of results) for (const [report, date] of dates) {
    if (!result.has(report) || date < result.get(report)!) result.set(report, date);
  }
  return result;
}
