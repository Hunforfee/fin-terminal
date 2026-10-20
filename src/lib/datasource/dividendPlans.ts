import { fetchJson, UpstreamError } from './http';

/** 每股金额均为税前；公告方案与已经除息的事件分开保存。 */
export interface DividendPlan {
  reportDate: string;
  announceDate: string;
  perShare: number | null;
  exDate: string | null;
  scheduleKnownDate: string | null;
  special: boolean;
  cancelled: boolean;
  implemented?: boolean;
}

type Row = Record<string, unknown>;
type Response = { success: boolean; result?: { pages: number; count: number; data: Row[] } | null };
const date = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.slice(0, 10) : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) ? s : null;
};

export function parseDividendPlans(rows: Row[]): DividendPlan[] {
  return rows.flatMap(row => {
    const reportDate = date(row.REPORT_DATE);
    const progress = String(row.ASSIGN_PROGRESS ?? '');
    const profile = String(row.IMPL_PLAN_PROFILE ?? '');
    const cancelled = /取消|终止|不实施/.test(progress + profile);
    const revised = cancelled || /修订|调整|变更/.test(progress + profile);
    // 取消/修订只在相应公告后生效，不能从原预案日倒灌。
    const announceDate = revised ? date(row.NOTICE_DATE) : date(row.PLAN_NOTICE_DATE);
    if (!reportDate || !announceDate) return [];
    const raw = row.PRETAX_BONUS_RMB;
    const cash = raw == null || raw === '' ? null : Number(raw);
    const noDividend = /不分配|不派|不进行.*分配/.test(progress + profile) || /10.*(?:送|转)/.test(profile) && !/派|现金/.test(profile);
    const perShare = cancelled || noDividend ? 0 : cash !== null && Number.isFinite(cash) && cash >= 0 ? cash / 10 : null;
    // 政策性预披露（例如“金额不超过半年利润”）并非具体分红方案，不新增一个未知金额的派息。
    if (/预披露/.test(progress) && perShare === null) return [];
    return [{ reportDate, announceDate, perShare, cancelled, implemented: !cancelled && /实施/.test(progress),
      exDate: date(row.EX_DIVIDEND_DATE), scheduleKnownDate: date(row.NOTICE_DATE),
      special: /特别|特殊|special/i.test(profile) }];
  }).sort((a, b) => a.announceDate.localeCompare(b.announceDate));
}

/** 方案包含董事会预案、零分红和实施方案；不把仅有政策上限的预披露当成具体金额。 */
export async function fetchDividendPlans(code: string): Promise<DividendPlan[]> {
  if (!/^\d{6}$/.test(code)) throw new Error('股票代码无效');
  const rows: Row[] = [];
  for (let page = 1; ; page++) {
    const url = new URL('https://datacenter-web.eastmoney.com/api/data/v1/get');
    url.search = new URLSearchParams({ reportName: 'RPT_SHAREBONUS_DET', columns: 'ALL',
      filter: `(SECURITY_CODE="${code}")`, pageSize: '100', pageNumber: String(page),
      sortColumns: 'PLAN_NOTICE_DATE,REPORT_DATE', sortTypes: '-1,-1' }).toString();
    const data = await fetchJson<Response>(url.toString(), { timeoutMs: 15000 });
    if (!data.success || !data.result || !Array.isArray(data.result.data) || !(data.result.pages >= 1)) {
      // 接口空响应也可能是限流或字段变化，不能当成确认不分红。
      throw new UpstreamError('分红方案数据不可用', url.toString(), 'parse');
    }
    rows.push(...data.result.data);
    if (page >= data.result.pages) break;
    if (page >= 20) throw new UpstreamError('分红方案分页不完整', url.toString(), 'parse');
  }
  const plans = parseDividendPlans(rows);
  if (!plans.length) throw new Error('缺少有效分红公告');
  return plans;
}
