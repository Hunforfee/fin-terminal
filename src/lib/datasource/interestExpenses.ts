import { HISTORY_YEARS } from '../marketHistoryPlan';
import { fetchJson } from './http';
import { cachedMarketInput } from '../marketInputs';
import { numOrNull } from './codes';
import type { StatementCatalog } from './sinaStatements';

export const INTEREST_FIELDS = ['pl_利润总额', 'pl_利息费用'] as const;
export function withInterestFields(catalogs: StatementCatalog[]): StatementCatalog[] {
  return catalogs.map(c => {
    if (c.id !== 'profit') return c;
    const keys = new Set(c.groups.flatMap(g => g.fields.map(f => f.key)));
    const fields = INTEREST_FIELDS.filter(k => !keys.has(k)).map(key => ({
      key, sina: key.slice(3), label: key === 'pl_利息费用' ? '利息费用（费用化）' : '利润总额',
      group: '利息保障倍数口径', statement: 'profit' as const, unit: 'wan' as const,
    }));
    return { ...c, total: c.total + fields.length,
      groups: [...c.groups, ...(fields.length ? [{label:'利息保障倍数口径',fields}] : [])] };
  });
}

export function parseInterestExpenses(rows: Record<string, unknown>[]): Map<string, Map<string, number | null>> {
  const out = new Map<string, Map<string, number | null>>();
  const number = (v: unknown) => { const n = numOrNull(v); return n === null ? null : n / 1e4; };
  for (const r of rows) {
    const d = String(r.REPORT_DATE ?? '').slice(0,10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    out.set(d, new Map([
      ['pl_利润总额', number(r.TOTAL_PROFIT)],
      // FE_INTEREST_EXPENSE 是财务费用附注中的费用化利息支出；FINANCE_EXPENSE 是含利息收入/汇兑的净额，禁止替代。
      ['pl_利息费用', number(r.FE_INTEREST_EXPENSE)],
    ]));
  }
  return out;
}

export async function fetchInterestExpenses(code: string, years: number) {
  const all=await cachedMarketInput(`source-interest-expenses:v1:${code}`,'source-interest-expenses','eastmoney:CNY:wan:explicit-interest-expense',1800e3,
    ()=>fetchAllInterestExpenses(code),value=>{if(!value.size)throw Error('利息费用报告期缺失');});
  const from=`${new Date().getFullYear()-Math.min(HISTORY_YEARS,Math.max(1,years))-1}-01-01`;
  return new Map([...all].filter(([date])=>date>=from));
}
async function fetchAllInterestExpenses(code: string) {
  if (!/^\d{6}$/.test(code)) throw new Error('无效股票代码');
  const secucode = `${code}.${/^[023]/.test(code) ? 'SZ' : /^(4|8|92)/.test(code) ? 'BJ' : 'SH'}`;
  const rows: Record<string, unknown>[] = [];
  for (let page=1; ; page++) {
    const url = new URL('https://datacenter.eastmoney.com/securities/api/data/v1/get');
    url.search = new URLSearchParams({reportName:'RPT_F10_FINANCE_GINCOME',columns:'SECUCODE,REPORT_DATE,TOTAL_PROFIT,FE_INTEREST_EXPENSE',
      filter:`(SECUCODE="${secucode}")(REPORT_DATE>='${new Date().getFullYear()-HISTORY_YEARS-1}-01-01')`,
      pageSize:'100',pageNumber:String(page),sortColumns:'REPORT_DATE',sortTypes:'-1'}).toString();
    const j = await fetchJson<{success?:boolean;result?:{data?:Record<string,unknown>[];pages?:number}|null}>(url.toString(),{timeoutMs:15000});
    if (j.success === false || !Array.isArray(j.result?.data)) throw new Error('真实利息费用数据不可用');
    rows.push(...j.result.data);
    if (page >= (j.result.pages ?? 1)) break;
    if (page >= 10) throw new Error('利息费用分页不完整');
  }
  return parseInterestExpenses(rows);
}
