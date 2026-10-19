'use client';

import { useCallback } from 'react';
import AiAnalysisPanel, { type CompanyAnalysisReport } from './AiAnalysisPanel';
import { nameOf } from '@/lib/universe';
import type { LearningCandidate } from '@/lib/companyLearning';

export interface LearningReadingContext {
  name: string;
  industry: string;
  questions: string[];
  sources: { label: string; url: string }[];
}

/** Reuse the stock page analysis rather than generating a separate daily article. */
export default function CompanyLearningReport({ company, onReady }: {
  company: LearningCandidate;
  date: string;
  onReady: (data: LearningReadingContext | null) => void;
}) {
  const hk = company.symbol.startsWith('hk');
  const name = nameOf(company.code) || company.name;
  const handleReady = useCallback((report: CompanyAnalysisReport | null) => {
    if (!report) { onReady(null); return; }
    onReady({
      name: report.name || name,
      industry: report.pre?.industry || report.profile?.industry || company.industry,
      questions: report.pre?.bearCase?.map(item => item.point) || [],
      sources: [
        { label: 'AI 分析' + (report.pre?.generatedAt ? ' · ' + report.pre.generatedAt : ''), url: '/stock/' + company.symbol },
        { label: '公司披露资料', url: hk ? 'https://www1.hkexnews.hk/search/titlesearch.xhtml?lang=zh' : 'https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/Index?type=web&code=' + company.symbol.toUpperCase() },
      ],
    });
  }, [company.symbol, company.industry, hk, name, onReady]);
  return <AiAnalysisPanel code={company.code} name={name} market={hk ? 'HK' : 'A'} embedded onReady={handleReady}/>;
}
