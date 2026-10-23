/** Purpose-specific required fields, not a percentage of unrelated statement columns. */
export type QualityStatement = 'profit'|'balance'|'cashflow';
type Page={dates:string[];rows:{kind:string;name:string;vals:unknown[]}[]};
const aliases:Record<QualityStatement,Record<string,string[]>>={
 profit:{npParent:['归属于母公司所有者的净利润','归属于母公司股东的净利润','归属于母公司的净利润']},
 balance:{assets:['资产总计','资产总额'],liabilities:['负债合计','负债总计'],equityParent:['归属于母公司股东权益合计','归属于母公司所有者权益合计','归属于母公司股东权益总计','归属于母公司所有者权益总计','归属于母公司股东的权益']},
 cashflow:{operatingCash:['经营活动产生的现金流量净额','经营活动产生现金流量净额']},
};
const normalize=(s:string)=>s.replace(/[\s()（）:：]/g,'');
const populated=(v:unknown)=>v!==null && v!==undefined && String(v).trim()!=='' && Number.isFinite(Number(String(v).replaceAll(',','')));
export function financialPageGaps(page:Page|undefined|null,id:QualityStatement,dates:string[]) {
 return dates.flatMap(date=>{
  const index=page?.dates?.indexOf(date)??-1;
  if(index<0)return [{date,missing:['report']}];
  const missing=Object.entries(aliases[id]).filter(([,names])=>!page!.rows?.some(r=>r.kind==='field' && names.some(n=>normalize(n)===normalize(r.name)) && populated(r.vals[index]))).map(([field])=>field);
  return missing.length?[{date,missing}]:[];
 });
}
export function assertFinancialPage(page:Page,id:QualityStatement,dates:string[]){
 const gaps=financialPageGaps(page,id,dates);
 if(gaps.length)throw Error(`财报关键输入不完整 ${id}: ${gaps.map(g=>`${g.date}(${g.missing.join(',')})`).join(';')}`);
}
