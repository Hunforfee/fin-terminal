/** Public A-share financial fallback, shared by every security and every reader.
 * Legacy source-sina-* keys describe the normalized schema, not the actual source.
 * Amounts arrive in CNY yuan; only monetary statement fields become CNY wan.
 */
import { fetchJson } from './http';
import { normalizeStockCode, numOrNull } from './codes';
import type { StatementId } from './sinaStatements';

type RawRow = Record<string, unknown>;
export interface FinancialSourceMetadata {
  fieldSources?: Record<string, string[]>;
  sourceEvidence?: Record<string, unknown>;
}
export interface StatementSourcePage extends FinancialSourceMetadata {
  dates: string[];
  rows: { kind: 'date' | 'group' | 'field'; name: string; vals: string[] }[];
  unit: string;
}
export interface IndicatorSourcePage extends FinancialSourceMetadata {
  dates: string[];
  rows: Map<string, (string | null)[]>;
}
const reports = { balance: 'RPT_F10_FINANCE_GBALANCE', profit: 'RPT_F10_FINANCE_GINCOME',
  cashflow: 'RPT_F10_FINANCE_GCASHFLOW', indicators: 'RPT_F10_FINANCE_MAINFINADATA' } as const;
const reportFamilies = {
  balance:['RPT_F10_FINANCE_GBALANCE','RPT_F10_FINANCE_BBALANCE','RPT_F10_FINANCE_SBALANCE','RPT_F10_FINANCE_IBALANCE'],
  cashflow:['RPT_F10_FINANCE_GCASHFLOW','RPT_F10_FINANCE_BCASHFLOW','RPT_F10_FINANCE_SCASHFLOW','RPT_F10_FINANCE_ICASHFLOW'],
  profit:[reports.profit], indicators:[reports.indicators],
};
// Remember only a verified report family, not financial values. Bounded and
// short-lived; it avoids probing all sectors for every year of the same stock.
const familyHints=new Map<string,{reportName:string;until:number}>();
const SOURCE = 'eastmoney:reported:CNY:wan:current-revisions';
const INDICATOR_SOURCE = 'eastmoney:reported-indicators:CNY:current-revisions';

// Explicit mappings only. Do not guess Chinese subjects from provider field names.
// SHARE_CAPITAL is an amount, never an actual share count. EPS remains yuan/share.
const fields: Record<StatementId, Record<string, string>> = {
  balance: {
    MONETARYFUNDS:'货币资金', TRADE_FINASSET:'交易性金融资产', NOTE_RECE:'应收票据', ACCOUNTS_RECE:'应收账款',
    NOTE_ACCOUNTS_RECE:'应收票据及应收账款', FINANCE_RECE:'应收款项融资', PREPAYMENT:'预付款项',
    OTHER_RECE:'其他应收款', TOTAL_OTHER_RECE:'其他应收款合计', INVENTORY:'存货', TOTAL_CURRENT_ASSETS:'流动资产合计',
    AVAILABLE_SALE_FINASSET:'可供出售金融资产', HOLD_MATURITY_INVEST:'持有至到期投资', LONG_EQUITY_INVEST:'长期股权投资',
    INVEST_REALESTATE:'投资性房地产', FIXED_ASSET:'固定资产', CIP:'在建工程', PROJECT_MATERIAL:'工程物资',
    USERIGHT_ASSET:'使用权资产', INTANGIBLE_ASSET:'无形资产', DEVELOP_EXPENSE:'开发支出', GOODWILL:'商誉',
    LONG_PREPAID_EXPENSE:'长期待摊费用', DEFER_TAX_ASSET:'递延所得税资产', TOTAL_NONCURRENT_ASSETS:'非流动资产合计',
    TOTAL_ASSETS:'资产总计', SHORT_LOAN:'短期借款', NOTE_PAYABLE:'应付票据', ACCOUNTS_PAYABLE:'应付账款',
    NOTE_ACCOUNTS_PAYABLE:'应付票据及应付账款', ADVANCE_RECEIVABLES:'预收款项', CONTRACT_LIAB:'合同负债',
    STAFF_SALARY_PAYABLE:'应付职工薪酬', TAX_PAYABLE:'应交税费', INTEREST_PAYABLE:'应付利息', DIVIDEND_PAYABLE:'应付股利',
    OTHER_PAYABLE:'其他应付款', TOTAL_OTHER_PAYABLE:'其他应付款合计', NONCURRENT_LIAB_1YEAR:'一年内到期的非流动负债',
    TOTAL_CURRENT_LIAB:'流动负债合计', LONG_LOAN:'长期借款', BOND_PAYABLE:'应付债券', LEASE_LIAB:'租赁负债',
    TOTAL_NONCURRENT_LIAB:'非流动负债合计', TOTAL_LIABILITIES:'负债合计', SHARE_CAPITAL:'实收资本(或股本)',
    CAPITAL_RESERVE:'资本公积', TREASURY_SHARES:'库存股', OTHER_COMPRE_INCOME:'其他综合收益',
    OTHER_EQUITY_TOOL:'其他权益工具', PREFERRED_SHARES:'优先股', PERPETUAL_BOND:'永续债', SURPLUS_RESERVE:'盈余公积',
    UNASSIGN_RPOFIT:'未分配利润', TOTAL_PARENT_EQUITY:'归属于母公司股东权益合计', MINORITY_EQUITY:'少数股东权益',
    TOTAL_EQUITY:'所有者权益(或股东权益)合计', TOTAL_LIAB_EQUITY:'负债和所有者权益总计',
    CASH_DEPOSIT_PBC:'现金及存放中央银行款项', DEPOSIT_INTERBANK:'存放同业款项', LEND_FUND:'拆出资金',
    LOAN_ADVANCE:'发放贷款及垫款', LOAN_PBC:'向中央银行借款', IOFI_DEPOSIT:'同业及其他金融机构存放款项',
    BORROW_FUND:'拆入资金', ACCEPT_DEPOSIT:'吸收存款', GENERAL_RISK_RESERVE:'一般风险准备',
  },
  profit: {
    TOTAL_OPERATE_INCOME:'营业总收入', OPERATE_INCOME:'营业收入', TOTAL_OPERATE_COST:'营业总成本', OPERATE_COST:'营业成本',
    OPERATE_TAX_ADD:'营业税金及附加', SALE_EXPENSE:'销售费用', MANAGE_EXPENSE:'管理费用', RESEARCH_EXPENSE:'研发费用',
    FINANCE_EXPENSE:'财务费用', FE_INTEREST_EXPENSE:'利息费用', FE_INTEREST_INCOME:'利息收入',
    ASSET_IMPAIRMENT_LOSS:'资产减值损失', CREDIT_IMPAIRMENT_LOSS:'信用减值损失',
    FAIRVALUE_CHANGE_INCOME:'公允价值变动收益', INVEST_INCOME:'投资收益', INVEST_JOINT_INCOME:'对联营企业和合营企业的投资收益',
    EXCHANGE_INCOME:'汇兑收益', ASSET_DISPOSAL_INCOME:'资产处置收益', OTHER_INCOME:'其他收益', OPERATE_PROFIT:'营业利润',
    NONBUSINESS_INCOME:'营业外收入', NONBUSINESS_EXPENSE:'营业外支出', TOTAL_PROFIT:'利润总额', INCOME_TAX:'所得税费用',
    NETPROFIT:'净利润', PARENT_NETPROFIT:'归属于母公司所有者的净利润', MINORITY_INTEREST:'少数股东损益',
    DEDUCT_PARENT_NETPROFIT:'扣除非经常性损益后的净利润', BASIC_EPS:'基本每股收益(元)', DILUTED_EPS:'稀释每股收益(元)',
    OTHER_COMPRE_INCOME:'其他综合收益', TOTAL_COMPRE_INCOME:'综合收益总额',
    PARENT_TCI:'归属于母公司所有者的综合收益总额', MINORITY_TCI:'归属于少数股东的综合收益总额',
  },
  cashflow: {
    SALES_SERVICES:'销售商品、提供劳务收到的现金', RECEIVE_TAX_REFUND:'收到的税费返还',
    RECEIVE_OTHER_OPERATE:'收到其他与经营活动有关的现金', TOTAL_OPERATE_INFLOW:'经营活动现金流入小计',
    BUY_SERVICES:'购买商品、接受劳务支付的现金', PAY_STAFF_CASH:'支付给职工以及为职工支付的现金',
    PAY_ALL_TAX:'支付的各项税费', PAY_OTHER_OPERATE:'支付其他与经营活动有关的现金', TOTAL_OPERATE_OUTFLOW:'经营活动现金流出小计',
    NETCASH_OPERATE:'经营活动产生的现金流量净额', WITHDRAW_INVEST:'收回投资收到的现金', RECEIVE_INVEST_INCOME:'取得投资收益收到的现金',
    DISPOSAL_LONG_ASSET:'处置固定资产、无形资产和其他长期资产收回的现金净额', DISPOSAL_SUBSIDIARY_OTHER:'处置子公司及其他营业单位收到的现金净额',
    RECEIVE_OTHER_INVEST:'收到其他与投资活动有关的现金', TOTAL_INVEST_INFLOW:'投资活动现金流入小计',
    CONSTRUCT_LONG_ASSET:'购建固定资产、无形资产和其他长期资产支付的现金', INVEST_PAY_CASH:'投资支付的现金',
    OBTAIN_SUBSIDIARY_OTHER:'取得子公司及其他营业单位支付的现金净额', PAY_OTHER_INVEST:'支付其他与投资活动有关的现金',
    TOTAL_INVEST_OUTFLOW:'投资活动现金流出小计', NETCASH_INVEST:'投资活动产生的现金流量净额', ACCEPT_INVEST_CASH:'吸收投资收到的现金',
    RECEIVE_LOAN_CASH:'取得借款收到的现金', ISSUE_BOND:'发行债券收到的现金', RECEIVE_OTHER_FINANCE:'收到其他与筹资活动有关的现金',
    TOTAL_FINANCE_INFLOW:'筹资活动现金流入小计', PAY_DEBT_CASH:'偿还债务支付的现金', ASSIGN_DIVIDEND_PORFIT:'分配股利、利润或偿付利息支付的现金',
    PAY_OTHER_FINANCE:'支付其他与筹资活动有关的现金', TOTAL_FINANCE_OUTFLOW:'筹资活动现金流出小计', NETCASH_FINANCE:'筹资活动产生的现金流量净额',
    RATE_CHANGE_EFFECT:'汇率变动对现金及现金等价物的影响', CCE_ADD:'现金及现金等价物净增加额', BEGIN_CCE:'期初现金及现金等价物余额', END_CCE:'期末现金及现金等价物余额',
    CUSTOMER_DEPOSIT_ADD:'客户存款和同业存放款项净增加额', LOAN_PBC_ADD:'向中央银行借款净增加额',
    RECEIVE_INTEREST_COMMISSION:'收取利息、手续费及佣金的现金', LOAN_ADVANCE_ADD:'客户贷款及垫款净增加额',
    PAY_INTEREST_COMMISSION:'支付利息、手续费及佣金的现金',
  },
};
// These are directly comparable metrics. Weighted ROE, diluted EPS and net-asset
// profit margin must NOT silently replace Sina's different ROE/EPS/ROA definitions.
const indicators: Record<string, string> = {
  XSJLL:'销售净利率(%)', ZCFZL:'资产负债率(%)', LD:'流动比率', SD:'速动比率',
  MGJYXJJE:'每股经营性现金流(元)', BPS:'每股净资产_调整前(元)', MGWFPLR:'每股未分配利润(元)',
};
const isoDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d+'T00:00:00Z'))
  && new Date(d+'T00:00:00Z').toISOString().slice(0,10) === d;
function security(code: string) {
  const n = normalizeStockCode(code);
  if (!n || n.market === 'HK' || n.kind !== 'stock' || !/^\d{6}$/.test(code)) throw Error('A 股财报证券代码无效');
  return `${code}.${n.market}`;
}
export function validateEastmoneyFinancialRows(rows: RawRow[], code: string, year: number, now = Date.now()): RawRow[] {
  const secucode = security(code), today = new Date(now+8*3600e3).toISOString().slice(0,10), seen = new Set<string>();
  if (!Number.isInteger(year) || !Array.isArray(rows) || !rows.length || rows.length > 4) throw Error('备用财报报告期为空或不完整');
  for (const row of rows) {
    if (row.SECUCODE !== secucode || row.CURRENCY !== 'CNY' || row.SECURITY_CODE != null && row.SECURITY_CODE !== code)
      throw Error('备用财报证券或币种不匹配');
    const date = String(row.REPORT_DATE ?? '').slice(0,10), notice = String(row.NOTICE_DATE ?? '').slice(0,10);
    if (!isoDate(date) || Number(date.slice(0,4)) !== year || !/-(03-31|06-30|09-30|12-31)$/.test(date)
      || date > today || seen.has(date) || notice && (!isoDate(notice) || notice <= date || notice > today))
      throw Error('备用财报报告期或披露日期无效、重复或超出范围');
    seen.add(date);
  }
  return [...rows].sort((a,b)=>String(b.REPORT_DATE).localeCompare(String(a.REPORT_DATE)));
}
async function fetchYear(code: string, id: keyof typeof reports, year: number) {
  const secucode=security(code);
  if(!Number.isInteger(year) || year<1990 || year>new Date().getUTCFullYear())throw Error('备用财报年份无效');
  const hint=familyHints.get(`${code}:${id}`), candidates=[...reportFamilies[id]];
  if(hint && hint.until>Date.now() && candidates.includes(hint.reportName))candidates.sort((a,b)=>Number(b===hint.reportName)-Number(a===hint.reportName));
  for (const reportName of candidates) {
    const rows:RawRow[]=[];
    for (let page=1; page<=2; page++) {
    const url=new URL('https://datacenter.eastmoney.com/securities/api/data/v1/get');
    url.search=new URLSearchParams({reportName,columns:'ALL',
      filter:`(SECUCODE="${secucode}")(REPORT_DATE>='${year}-01-01')(REPORT_DATE<='${year}-12-31')`,
      pageSize:'10',pageNumber:String(page),sortColumns:'REPORT_DATE',sortTypes:'-1'}).toString();
    const j=await fetchJson<{success?:boolean;code?:number;message?:string;result?:{data?:RawRow[];pages?:number}|null}>(url.toString(),
      {timeoutMs:12000,retries:0,headers:{Referer:'https://emweb.securities.eastmoney.com/'}});
    // Empty general-industry reports are not proof that a bank/insurer has no
    // financials. Do not fan out after timeouts, HTTP limits or malformed replies.
    if(j.success===false && j.result==null && /返回数据为空/.test(j.message??''))break;
    if(j.success !== true || !Array.isArray(j.result?.data) || !Number.isInteger(j.result.pages) || (j.result.pages??0)<1 || (j.result.pages??0)>2)
      throw Error('东方财富备用财报不可用或分页不完整');
    rows.push(...j.result.data);
    if(page===j.result.pages){
      const valid=validateEastmoneyFinancialRows(rows,code,year);
      if(familyHints.size>=512)familyHints.delete(familyHints.keys().next().value!);
      familyHints.set(`${code}:${id}`,{reportName,until:Date.now()+3600e3});
      return {rows:valid,reportName};
    }
    }
  }
  throw Error('东方财富备用财报分页未结束');
}
function rawNumber(row: RawRow, key: string): number | null {
  const raw=row[key];
  if(raw==null || raw==='' || raw==='-' || raw==='--')return null;
  const n=numOrNull(raw);
  if(n===null)throw Error(`备用财报字段 ${key} 数值无效`);
  return n;
}
function evidence(code: string, reportName: string, rows: RawRow[]) {
  return {eastmoney:{secucode:security(code),reportName,fetchedAt:new Date().toISOString(),
    revision:'current-provider-revision',currency:'CNY',rawAmountUnit:'yuan',rows}};
}
export function parseEastmoneyStatement(rows: RawRow[], code: string, id: StatementId, year: number, now = Date.now(), reportName: string = reports[id]): StatementSourcePage {
  const ordered=validateEastmoneyFinancialRows(rows,code,year,now), dates=ordered.map(r=>String(r.REPORT_DATE).slice(0,10));
  const parsed=Object.entries(fields[id]).map(([field,name])=>({kind:'field' as const,name,vals:ordered.map(row=>{
    const n=rawNumber(row,field);return n===null?'--':String(n / (field.endsWith('_EPS')?1:1e4));
  })})).filter(row=>row.vals.some(v=>v!=='--'));
  if(!parsed.length)throw Error('备用财报没有可对应的已披露科目');
  return {dates,rows:parsed,unit:'万元',fieldSources:Object.fromEntries(parsed.map(r=>[r.name,r.vals.map(v=>v==='--'?'':SOURCE)])),
    sourceEvidence:evidence(code,reportName,ordered)};
}
export function parseEastmoneyIndicators(rows: RawRow[], code: string, year: number, now = Date.now()): IndicatorSourcePage {
  const ordered=validateEastmoneyFinancialRows(rows,code,year,now), dates=ordered.map(r=>String(r.REPORT_DATE).slice(0,10));
  const parsed=new Map(Object.entries(indicators).map(([field,name])=>[name,ordered.map(row=>{
    const n=rawNumber(row,field);return n===null?null:String(n);
  })] as const).filter(([,values])=>values.some(v=>v!==null)));
  if(!parsed.size)throw Error('备用财务指标没有同口径有效值');
  return {dates,rows:parsed,fieldSources:Object.fromEntries([...parsed].map(([name,values])=>[name,values.map(v=>v===null?'':INDICATOR_SOURCE)])),
    sourceEvidence:evidence(code,reports.indicators,ordered)};
}
export async function fetchEastmoneyStatement(code: string, id: StatementId, year: number) {
  const result=await fetchYear(code,id,year);
  return parseEastmoneyStatement(result.rows,code,id,year,Date.now(),result.reportName);
}
export async function fetchEastmoneyIndicators(code: string, year: number) {
  return parseEastmoneyIndicators((await fetchYear(code,'indicators',year)).rows,code,year);
}
/** Resolve actual contributors after a partial refresh has retained older cells. */
export function financialPageSource(page: FinancialSourceMetadata, fallback = 'sina:reported:CNY:wan') {
  const sources=[...new Set(Object.values(page.fieldSources??{}).flat().filter(Boolean))].sort();
  return sources.length?sources.join(' + '):fallback;
}
