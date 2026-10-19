import { STOCKS } from '../universe';
import { SW2021 } from '../sw2021';
import { hkIndustryMember } from '../hkIndustries';
import { normalizeStockCode } from './codes';
import { cached } from './cache';
import { fetchJson } from './http';
import { fetchBusiness, type BusinessInfo } from './business';
import { fetchReports, type ResearchReport } from './research';
import { fetchAnnouncements, type CompanyAnnouncement } from './announcements';
import { fetchHkIndicatorPoints } from './hkFinance';
import { getQuote } from './index';
import { todayResearchDate } from '../researchNotes';
import { parseLearningAnnual,parseLearningLatest,learningDate,type LearningAnnual,type LearningCandidate } from '../companyLearning';
import { getPreAnalysis } from '../../data/analyses';
import { makeLearningResearch, type LearningResearch } from '../learningResearch';
import type { Quote } from './types';

const industries=new Map<string,string>();
for(const node of SW2021.industries)for(const code of node.stocks)industries.set(code,node.name);
const names=new Map(STOCKS.map(c=>[c.code,c.name]));
function candidate(input:string,origin:LearningCandidate['origin']):LearningCandidate|null {
  const stock=normalizeStockCode(input);if(!stock||stock.kind!=='stock')return null;
  const hk=stock.market==='HK'?hkIndustryMember(stock.code):null;
  return {symbol:stock.symbol,code:stock.code,name:hk?.name??names.get(stock.code)??stock.code,
    industry:stock.market==='HK'?(hk?.industryPath[0]??hk?.industry??''):industries.get(stock.code)??'',origin};
}
export function getLearningPool(codes:string[]):LearningCandidate[] {
  const watched=codes.flatMap(code=>{const c=candidate(code,'watchlist');return c?[c]:[];});
  const interested=new Set(watched.map(c=>c.industry).filter(Boolean));
  const fallback=STOCKS.flatMap(stock=>{
    const c=candidate(stock.code,'universe');if(!c)return[];
    return [{...c,origin:interested.has(c.industry)?'industry' as const:'universe' as const}];
  });
  return [...new Map([...fallback,...watched].map(c=>[c.symbol,c])).values()];
}
export interface LearningSource {id:string;label:string;url:string}
export interface LearningBrief {
  symbol:string;code:string;name:string;industry:string;summary:string|null;
  business:BusinessInfo|null;quote:Quote|null;generatedAt:string;
  research:LearningResearch|null;
  sources:LearningSource[];
}
export interface LearningDigest extends LearningBrief {
  annual:LearningAnnual[];reports:ResearchReport[];announcements:CompanyAnnouncement[];
  latestReport:LearningAnnual|null;
  unavailable:string[];aiAvailable:boolean;
}
const sourceLinks=(code:string,symbol:string,hk:boolean):LearningSource[]=>[
  {id:'business',label:'公司概况 · 东财 F10',url:hk?`https://emweb.securities.eastmoney.com/PC_HKF10/CompanyInfo/index?code=${code}&type=web`:`https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/Index?type=web&code=${symbol.toUpperCase()}`},
  ...(!hk?[{id:'business-review',label:'经营评述 · 东财 F10',url:`https://emweb.securities.eastmoney.com/PC_HSF10/BusinessAnalysis/Index?type=web&code=${symbol.toUpperCase()}`}]:[]),
  {id:'finance',label:'主要财务指标 · 东财',url:'https://datacenter-web.eastmoney.com/api/data/v1/get?'+new URLSearchParams({reportName:hk?'RPT_HKF10_FN_MAININDICATOR':'RPT_F10_FINANCE_MAINFINADATA',columns:'ALL',filter:hk?`(SECUCODE="${code}.HK")`:`(SECURITY_CODE="${code}")`,pageSize:'40',pageNumber:'1',sortColumns:'REPORT_DATE',sortTypes:'-1'})},
  {id:'quote',label:'腾讯行情',url:`https://gu.qq.com/${symbol}`},
  {id:'reports',label:hk?'披露易检索':'券商研报原文',url:hk?'https://www1.hkexnews.hk/search/titlesearch.xhtml?lang=zh':`https://data.eastmoney.com/report/stock/${code}.html`},
  {id:'announcements',label:hk?'披露易公告':'年报与公告原文',url:hk?'https://www1.hkexnews.hk/search/titlesearch.xhtml?lang=zh':`https://data.eastmoney.com/notices/stock/${code}.html`},
];
async function hkBusiness(code:string):Promise<BusinessInfo|null> {
  const url='https://datacenter.eastmoney.com/securities/api/data/v1/get?'+new URLSearchParams({reportName:'RPT_HKF10_INFO_ORGPROFILE',columns:'ALL',filter:`(SECUCODE="${code}.HK")`,pageSize:'1',pageNumber:'1',source:'F10',client:'PC'});
  const j=await fetchJson<{result?:{data?:Record<string,unknown>[]}}>(url,{timeoutMs:12000});
  const row=j.result?.data?.[0];if(!row)return null;
  const text=(v:unknown)=>typeof v==='string'&&v.trim()?v.trim():null;
  return {summary:text(row.ORG_PROFILE),scope:text(row.MAIN_BUSINESS)??text(row.BUSINESS_SCOPE),industry:null,review:null,reviewDate:null,groups:[],segments:[],reportDate:null,source:'eastmoney-hkf10'};
}
export async function getLearningBrief(input:string):Promise<LearningBrief> {
  const stock=normalizeStockCode(input);if(!stock||stock.kind!=='stock')throw Error('请选择股票');
  return cached(`company-learning-brief-v3:${stock.symbol}:${todayResearchDate()}`,86400e3,async()=>{
    const hk=stock.market==='HK';
    const prepared=hk?undefined:getPreAnalysis(stock.code);
    const [quote,business]=await Promise.all([getQuote(stock.symbol).catch(()=>null),(hk?hkBusiness(stock.code):fetchBusiness(stock.code,'A')).catch(()=>null)]);
    if(!quote&&!business?.summary&&!business?.scope&&!prepared)throw Error('公司资料暂不可用，请重试或换一家公司');
    const meta=candidate(stock.symbol,'universe')!;
    const research=makeLearningResearch(prepared,todayResearchDate(),business);
    const summary=(research?.introduction||business?.scope||business?.summary||'').replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim();
    return {symbol:stock.symbol,code:stock.code,name:quote?.name||meta.name,industry:meta.industry,quote,business,
      research,summary:summary||null,generatedAt:new Date().toISOString(),sources:sourceLinks(stock.code,stock.symbol,hk)};
  });
}
async function financialData(code:string,hk:boolean,today:string):Promise<{annual:LearningAnnual[];latest:LearningAnnual|null}> {
  if(hk){
    const points=await fetchHkIndicatorPoints(`${code}.HK`,9);
    const reports=points.filter(p=>p.date<=today).sort((a,b)=>b.date.localeCompare(a.date));
    const row=(p:typeof reports[number]):LearningAnnual=>({period:p.date,revenue:p.raw.OPERATE_INCOME??null,profit:p.raw.HOLDER_PROFIT??null,deducted:null,roe:p.raw.ROE_AVG??null,ocf:p.raw.NETCASH_OPERATE??null,debt:p.raw.DEBT_ASSET_RATIO??null});
    return {annual:reports.filter(p=>p.kind==='annual').slice(0,5).map(row),latest:reports[0]?row(reports[0]):null};
  }
  const url=sourceLinks(code,'',false).find(s=>s.id==='finance')!.url;
  const j=await fetchJson<{success?:boolean;result?:{data?:Record<string,unknown>[]}}>(url,{timeoutMs:15000});
  if(!j.success||!Array.isArray(j.result?.data))throw Error('年报数据暂不可用');
  return {annual:parseLearningAnnual(j.result.data,code,today),latest:parseLearningLatest(j.result.data,code,today)};
}
export async function getLearningDigest(input:string):Promise<LearningDigest> {
  const stock=normalizeStockCode(input);if(!stock||stock.kind!=='stock')throw Error('请选择股票');
  const today=todayResearchDate(),hk=stock.market==='HK';
  return cached(`company-learning-digest-v3:${stock.symbol}:${today}`,86400e3,async()=>{
    const [brief,annual,reports,announcements]=await Promise.allSettled([
      getLearningBrief(stock.symbol),financialData(stock.code,hk,today),fetchReports(stock.code,hk?'HK':'A'),
      hk?Promise.resolve([] as CompanyAnnouncement[]):fetchAnnouncements(stock.code,40),
    ]);
    if(brief.status==='rejected')throw brief.reason;
    const latestReport=annual.status==='fulfilled'?annual.value.latest:null;
    return {...brief.value,annual:annual.status==='fulfilled'?annual.value.annual:[],latestReport,
      research:makeLearningResearch(hk?undefined:getPreAnalysis(stock.code),today,brief.value.business,latestReport),
      reports:reports.status==='fulfilled'?reports.value.filter(r=>r.date&&learningDate(r.date)&&r.date<=today):[],
      announcements:announcements.status==='fulfilled'?announcements.value.filter(r=>/^AN[\w-]+$/.test(r.artCode)&&learningDate(r.date)&&r.date<=today):[],
      unavailable:[annual.status==='rejected'?'年报指标':'',reports.status==='rejected'?'研报':'',announcements.status==='rejected'?'公告':''].filter(Boolean),
      aiAvailable:!!process.env.AI_API_KEY};
  });
}
