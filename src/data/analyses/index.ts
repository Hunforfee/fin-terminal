/**
 * 预生成的「业务与行业地位」深度综述索引。
 * 由 scripts/fetch-analysis-raw.mjs 抓取真实 F10 数据后，基于真实数据撰写并落盘为 {code}.json。
 * 弹窗优先读取此处预生成综述；未覆盖的股票回退到实时 F10 数据展示。
 */
import c600415 from './600415.json';
import c600519 from './600519.json';
import c300750 from './300750.json';
import c002594 from './002594.json';
import c601318 from './601318.json';
import c000333 from './000333.json';

export interface PreAnalysis {
  code: string;
  industry: string;
  summary: string;
  source: string;
  generatedAt: string;
}

export const ANALYSES: Record<string, PreAnalysis> = {
  '600415': c600415 as PreAnalysis,
  '600519': c600519 as PreAnalysis,
  '300750': c300750 as PreAnalysis,
  '002594': c002594 as PreAnalysis,
  '601318': c601318 as PreAnalysis,
  '000333': c000333 as PreAnalysis,
};

export function getPreAnalysis(code: string): PreAnalysis | undefined {
  return ANALYSES[code];
}
