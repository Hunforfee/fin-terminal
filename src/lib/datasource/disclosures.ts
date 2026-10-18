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
  const [sina, eastmoney] = await Promise.all([
    fetchDisclosureDatesFromSina(code, fromYear),
    // 新浪的季报分组页面对部分年份抓不到（2026-10 实测一季报/三季报大面积缺失），
    // 用东财公告列表补齐缺失报告期的真实披露日期
    fetchDisclosureDatesFromEastmoney(code, fromYear).catch(() => new Map<string, string>()),
  ]);
  const result = new Map<string, string>();
  for (const dates of [sina, eastmoney]) for (const [report, date] of dates) {
    if (!result.has(report) || date < result.get(report)!) result.set(report, date);
  }
  return result;
}

async function fetchDisclosureDatesFromSina(code: string, fromYear: number): Promise<Map<string, string>> {
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

async function fetchDisclosureDatesFromEastmoney(
  code: string,
  fromYear: number,
): Promise<Map<string, string>> {
  const dates = new Map<string, string>();
  for (let page = 1; page <= 6; page++) {
    const url = new URL('https://datacenter-web.eastmoney.com/api/data/v1/get');
    url.search = new URLSearchParams({
      reportName: 'RPT_LICO_FN_CPD',
      columns: 'SECURITY_CODE,REPORTDATE,NOTICE_DATE',
      filter: `(SECURITY_CODE="${code}")`,
      pageSize: '60',
      pageNumber: String(page),
      sortColumns: 'REPORTDATE',
      sortTypes: '-1',
    }).toString();
    const raw = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(12000),
    }).then((r) => r.json());
    const rows: { REPORTDATE?: string; NOTICE_DATE?: string }[] =
      Array.isArray(raw?.result?.data) ? raw.result.data : [];
    if (!rows.length) break;
    for (const row of rows) {
      const report = (row.REPORTDATE ?? '').slice(0, 10);
      const notice = (row.NOTICE_DATE ?? '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(report) || !/^\d{4}-\d{2}-\d{2}$/.test(notice)) continue;
      if (!/^\d{4}-(03-31|06-30|09-30|12-31)$/.test(report)) continue; // 仅季报/半年报/年报报告期
      if (notice <= report) continue;
      if (!dates.has(report) || notice < dates.get(report)!) dates.set(report, notice);
    }
    const oldest = (rows.at(-1)?.REPORTDATE ?? '').slice(0, 10);
    const pages = raw?.result?.pages ?? 1;
    if (page >= pages || (oldest && oldest < `${fromYear}-01-01`)) break;
  }
  return dates;
}
