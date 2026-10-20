import { fetchJson } from './http';
import { cached } from './cache';
import { numOrNull } from './codes';

/** Explicit provider ratio in percentage points, not a sum with missing balances treated as zero. */
export function parseDebtRatios(rows: Record<string, unknown>[], secucode: string, today: string): Map<string, number | null> {
  const values = new Map<string, number | null>();
  for (const row of rows) {
    if (row.SECUCODE !== secucode || row.CURRENCY !== 'CNY') throw Error('有息负债率证券或币种不匹配');
    const date = String(row.REPORT_DATE ?? '').slice(0, 10);
    if (!/^\d{4}-(03-31|06-30|09-30|12-31)$/.test(date) || date > today) throw Error('有息负债率报告期无效');
    if (String(row.NOTICE_DATE ?? '').slice(0, 10) > today) continue;
    const raw = numOrNull(row.INTEREST_DEBT_RATIO);
    const value = raw !== null && raw >= 0 ? raw : null;
    if (values.has(date) && values.get(date) !== value) throw Error('有息负债率同一期存在冲突');
    values.set(date, value);
  }
  return values;
}

export async function fetchDebtRatios(code: string, years: number): Promise<Map<string, number | null>> {
  if (!/^\d{6}$/.test(code)) throw Error('无效股票代码');
  const secucode = `${code}.${/^[023]/.test(code) ? 'SZ' : /^(4|8|92)/.test(code) ? 'BJ' : 'SH'}`;
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  return cached(`interest-debt-ratio:v1:${secucode}:${years}:${today}`, 30 * 60e3, async () => {
    const rows: Record<string, unknown>[] = [];
    for (let page = 1; ; page++) {
      const url = new URL('https://datacenter.eastmoney.com/securities/api/data/v1/get');
      url.search = new URLSearchParams({ reportName: 'RPT_F10_FINANCE_MAINFINADATA',
        columns: 'SECUCODE,REPORT_DATE,NOTICE_DATE,CURRENCY,INTEREST_DEBT_RATIO',
        filter: `(SECUCODE="${secucode}")(REPORT_DATE>='${Number(today.slice(0, 4)) - years}-01-01')`,
        pageSize: '100', pageNumber: String(page), sortColumns: 'REPORT_DATE', sortTypes: '-1' }).toString();
      const result = await fetchJson<{ success?: boolean; result?: { data?: Record<string, unknown>[]; pages?: number } | null }>(url.toString(), { timeoutMs: 15000 });
      if (result.success === false || !Array.isArray(result.result?.data)) throw Error('有息负债率数据暂不可用');
      rows.push(...result.result.data);
      if (page >= (result.result.pages ?? 1)) break;
      if (page >= 10) throw Error('有息负债率分页不完整');
    }
    return parseDebtRatios(rows, secucode, today);
  });
}
