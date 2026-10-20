import type { PreAnalysis, ViewPoint, Competitor } from '../data/analyses';
import type { BusinessInfo } from './datasource/business';
import type { LearningAnnual } from './companyLearning';
import { isResearchDate } from './researchNotes';

export interface LearningResearch {
  researchStatus?: 'draft' | 'reviewed';
  viewBasis?: 'research_hypotheses' | 'institutional_views';
  paragraphs: string[];
  introduction: string;
  source: string;
  date: string;
  advantages: ViewPoint[];
  competitors: Competitor[];
  bull: ViewPoint[];
  bear: ViewPoint[];
  questions: string[];
}

const text = (value: string) => value.replace(/<[^>]*>/g, '').trim();
const points = (items: ViewPoint[] | undefined) => (items || []).filter(p =>
  typeof p?.point === 'string' && typeof p?.detail === 'string' && p.point.trim() && p.detail.trim()
).slice(0, 4).map(p => ({ point: text(p.point), detail: text(p.detail) }));

/** Prepared research stays on the server. Dates belong to the research, not the request time. */
export function makeLearningResearch(pre: PreAnalysis | undefined, today: string, _business: BusinessInfo | null, _latest?: LearningAnnual | null): LearningResearch | null {
  const date = typeof pre?.generatedAt === 'string' ? pre.generatedAt.slice(0,10) : '';
  if (!pre || !isResearchDate(date) || date > today || typeof pre.summary !== 'string' || !pre.summary.trim()) return null;
  const paragraphs = pre.summary.split(/\n\s*\n/).map(text).filter(Boolean);
  const result: LearningResearch = {
    researchStatus: pre.researchStatus,
    viewBasis: pre.viewBasis,
    paragraphs,
    introduction: pre.position ? text(pre.position) : paragraphs[0]?.split('。')[0] || '',
    source: text(pre.source),
    date,
    advantages: points(pre.moat),
    competitors: (pre.competitors || []).filter(c => typeof c.name === 'string' && typeof c.note === 'string').slice(0, 4).map(c => ({ name: text(c.name), code: /^\d{6}$/.test(c.code || '') ? c.code : undefined, note: text(c.note) })),
    bull: points(pre.bullCase),
    bear: points(pre.bearCase),
    questions: [
      pre.moat?.[0] ? `“${text(pre.moat[0].point)}”有哪些可持续追踪的经营证据，与同行相比是否仍然成立？` : '收入增长来自销量、价格还是业务扩张，能否持续？',
      pre.bearCase?.[0] ? `“${text(pre.bearCase[0].point)}”是否正在兑现，最新披露支持什么结论？` : '哪些变化会削弱目前的盈利能力？',
      '新增利润是否转化为经营现金流，维持增长还需要投入多少资本？',
    ],
  };
  return result;
}
