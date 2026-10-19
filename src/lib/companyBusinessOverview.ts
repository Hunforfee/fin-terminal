import type { BusinessInfo } from './datasource/business';

/** Arrange disclosed facts into readable paragraphs; do not infer customers, pricing or competitive advantages. */
const coreBusiness = /主营|主要从事|主要业务|核心业务|主导产品|主要产品|业务包括|业务涵盖|核心产品/;
const businessDetail = /研发|生产|加工|销售|供应|服务|客户|渠道|经销|直销|收费|收储|运销|种植|产业链/;
const promotion = /荣获|荣誉|荣膺|获评|先后被评|商标是|商标为|文明单位|先进集体|五一劳动|质量奖|贡献力量|党的|党中央|总书记/;
const companyHistory = /组建成立|成立于|股票代码|股票简称|挂牌上市|上交所上市|深交所上市|股份制改造/;
const whitespace = (value: string) => value.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ').trim();

function sentences(value: string | null | undefined): string[] {
  const parts = (value || '').split(/[。；;\n\r]+/).map(whitespace).map(text => {
    const withoutHeading = text.replace(/^[（(][一二三四五六七八九十]+[)）][^。；;]*?(?=20\d{2}年|报告期内|公司|本公司|本集团)/, '');
    // Omit promotional clauses while retaining the business statements in the same sentence.
    return withoutHeading.split(/[,，]/).filter(clause =>
      !promotion.test(clause) && (!companyHistory.test(clause) || coreBusiness.test(clause))
    ).join('，');
  }).filter(text => text.length >= 12);
  return [...new Set(parts)];
}
function chooseComplete(passages: string[], limit: number, budget: number): string[] {
  const chosen: string[] = [];
  let length = 0;
  for (const passage of passages) {
    if (chosen.length >= limit) break;
    if (chosen.length && length + passage.length > budget) continue;
    chosen.push(passage); length += passage.length;
  }
  return chosen;
}
const paragraph = (parts: string[]) => parts.map(text => `${text.replace(/[。；;]+$/, '')}。`).join('');
const ratio = (value: number) => `${(value * 100).toFixed(Math.abs(value * 100) < 0.1 && value !== 0 ? 2 : 1)}%`;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export interface CompanyBusinessOverview {
  paragraphs: string[];
  compositionDate: string | null;
  reviewDate: string | null;
}
export function buildCompanyBusinessOverview(business: BusinessInfo | null | undefined): CompanyBusinessOverview {
  if (!business) return {paragraphs: [], compositionDate: null, reviewDate: null};
  const profile = sentences(business.summary);
  const focused = profile.filter(text => coreBusiness.test(text));
  const details = profile.filter(text => !coreBusiness.test(text) && businessDetail.test(text));
  const scope = sentences(business.scope).filter(text => businessDetail.test(text));
  const core = chooseComplete(focused.length ? focused : scope.length ? scope : details, 2, 500);
  const operations = chooseComplete(details.filter(text => !core.includes(text)), 4, 650);
  const paragraphs = [paragraph(core), paragraph(operations)].filter(Boolean);

  const segments = (business.segments || []).filter(s => s.name && !/合计|总计/.test(s.name));
  const ordered = [...segments].sort((a,b) => (b.income ?? -Infinity) - (a.income ?? -Infinity));
  const income = ordered.filter(s => finite(s.incomeRatio) && s.incomeRatio >= 0).slice(0,3);
  // Negative aggregate gross profit can invert ratios or make them exceed 100%.
  const comparableGross=segments.every(s=>(s.profitRatio==null||(finite(s.profitRatio)&&s.profitRatio>=0&&s.profitRatio<=1))&&(s.grossMargin==null||s.grossMargin>=0));
  const gross = comparableGross?[...segments].filter(s => finite(s.profitRatio) && s.profitRatio > 0)
    .sort((a,b) => b.profitRatio! - a.profitRatio!)[0]:undefined;
  let compositionDate: string | null = null;
  if (business.reportDate && income.length) {
    compositionDate = business.reportDate;
    let text = `从${business.reportDate}报告期的${business.dimension || '主营构成'}口径看，${income.map(s => `${s.name}的收入占比为${ratio(s.incomeRatio!)}`).join('，')}。`;
    const first = income[0];
    if (finite(first.grossMargin)) text += `其中，${first.name}的毛利率为${ratio(first.grossMargin)}。`;
    if (gross && gross.name !== first.name) {
      text += `按该口径的毛利占比，${gross.name}贡献${ratio(gross.profitRatio!)}的毛利${finite(gross.grossMargin) ? `，毛利率为${ratio(gross.grossMargin)}` : ''}；毛利贡献与收入规模需要分别看，不能直接等同于归母净利润贡献。`;
    }
    paragraphs.push(text);
  }

  const review = sentences(business.review);
  const clientEvidence = /客户|面向|服务于|向.{0,35}提供|供应商|经销商|直销|销售模式|采购模式|经营模式|商业模式|销售渠道|定价|全流程|产品回收/;
  const reviewParts = chooseComplete(review.filter(text => clientEvidence.test(text) && !profile.includes(text)), 3, 600);
  const reviewDate = reviewParts.length ? business.reviewDate || null : null;
  if (reviewParts.length) {
    paragraphs.push(`公司${reviewDate ? `在${reviewDate}报告期的` : '在'}经营评述中披露：${paragraph(reviewParts)}`);
  }
  return {paragraphs, compositionDate, reviewDate};
}
