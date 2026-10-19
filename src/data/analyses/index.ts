/**
 * 预生成的「公司深度解析」索引。
 * 由 MCP（通达信 F10 深度资料 + 券商研报）抓取真实数据后，基于真实数据撰写并落盘为 {code}.json。
 * 覆盖 universe.ts 全部 A 股个股；未覆盖的标的回退到实时 F10 数据展示。
 */
import c601398 from './601398.json';
import c601288 from './601288.json';
import c601939 from './601939.json';
import c601988 from './601988.json';
import c600036 from './600036.json';
import c601166 from './601166.json';
import c600000 from './600000.json';
import c002142 from './002142.json';
import c601318 from './601318.json';
import c601601 from './601601.json';
import c601628 from './601628.json';
import c600030 from './600030.json';
import c601688 from './601688.json';
import c000776 from './000776.json';
import c600519 from './600519.json';
import c000858 from './000858.json';
import c000568 from './000568.json';
import c600809 from './600809.json';
import c002304 from './002304.json';
import c000596 from './000596.json';
import c600887 from './600887.json';
import c603288 from './603288.json';
import c600276 from './600276.json';
import c300760 from './300760.json';
import c603259 from './603259.json';
import c300015 from './300015.json';
import c600436 from './600436.json';
import c000538 from './000538.json';
import c600196 from './600196.json';
import c002415 from './002415.json';
import c000725 from './000725.json';
import c002475 from './002475.json';
import c002371 from './002371.json';
import c688981 from './688981.json';
import c603501 from './603501.json';
import c300750 from './300750.json';
import c601012 from './601012.json';
import c600438 from './600438.json';
import c300124 from './300124.json';
import c002129 from './002129.json';
import c600570 from './600570.json';
import c002230 from './002230.json';
import c688111 from './688111.json';
import c300454 from './300454.json';
import c600845 from './600845.json';
import c000063 from './000063.json';
import c600050 from './600050.json';
import c601728 from './601728.json';
import c002594 from './002594.json';
import c600104 from './600104.json';
import c601633 from './601633.json';
import c000625 from './000625.json';
import c601238 from './601238.json';
import c000333 from './000333.json';
import c000651 from './000651.json';
import c600690 from './600690.json';
import c002508 from './002508.json';
import c002050 from './002050.json';
import c600031 from './600031.json';
import c601766 from './601766.json';
import c300450 from './300450.json';
import c002472 from './002472.json';
import c600309 from './600309.json';
import c600426 from './600426.json';
import c002648 from './002648.json';
import c601899 from './601899.json';
import c600111 from './600111.json';
import c603993 from './603993.json';
import c600547 from './600547.json';
import c000002 from './000002.json';
import c600048 from './600048.json';
import c001979 from './001979.json';
import c601668 from './601668.json';
import c601390 from './601390.json';
import c601186 from './601186.json';
import c600900 from './600900.json';
import c601985 from './601985.json';
import c600025 from './600025.json';
import c601919 from './601919.json';
import c600009 from './600009.json';
import c002352 from './002352.json';
import c601006 from './601006.json';
import c601888 from './601888.json';
import c600655 from './600655.json';
import c601088 from './601088.json';
import c601225 from './601225.json';
import c600188 from './600188.json';
import c601857 from './601857.json';
import c600028 from './600028.json';
import c600938 from './600938.json';
import c600019 from './600019.json';
import c000898 from './000898.json';
import c002714 from './002714.json';
import c300498 from './300498.json';
import c600298 from './600298.json';
import c600893 from './600893.json';
import c600760 from './600760.json';
import c002179 from './002179.json';
import c002027 from './002027.json';
import c300413 from './300413.json';
import c600585 from './600585.json';
import c002271 from './002271.json';
import c603605 from './603605.json';
import c600398 from './600398.json';

/** 竞争对手/可比公司 */
export interface Competitor {
  /** 公司简称 */
  name: string;
  /** 证券代码（可空） */
  code?: string;
  /** 对比要点：规模、份额、业务重叠、相对优劣势 */
  note: string;
}

/** 观点/要点条目 */
export interface ViewPoint {
  /** 要点标题（短句） */
  point: string;
  /** 展开说明，含真实数据或机构观点 */
  detail: string;
}

export interface PreAnalysis {
  code: string;
  /** 公司全称 */
  fullName?: string;
  /** 所属行业（含层级） */
  industry: string;
  /** 公司地位一句话 */
  position?: string;

  /** 深度解析正文：多段，每段一个主题，段间用 \n\n 分隔 */
  summary: string;

  /** 核心优势/护城河要点 */
  moat?: ViewPoint[];
  /** 主要竞争对手 */
  competitors?: Competitor[];

  /** 市场看好（多头）主流观点 */
  bullCase?: ViewPoint[];
  /** 市场不看好/分歧（空头）观点 */
  bearCase?: ViewPoint[];

  /** 评级分布 */
  ratingSummary?: { buy: number; hold: number; sell: number };
  /** 目标价区间（元） */
  targetPriceRange?: { min: number; max: number };

  /** 数据来源 */
  source: string;
  /** 生成日期 */
  generatedAt: string;
}

export const ANALYSES: Record<string, PreAnalysis> = {
  '601398': c601398 as PreAnalysis,
  '601288': c601288 as PreAnalysis,
  '601939': c601939 as PreAnalysis,
  '601988': c601988 as PreAnalysis,
  '600036': c600036 as PreAnalysis,
  '601166': c601166 as PreAnalysis,
  '600000': c600000 as PreAnalysis,
  '002142': c002142 as PreAnalysis,
  '601318': c601318 as PreAnalysis,
  '601601': c601601 as PreAnalysis,
  '601628': c601628 as PreAnalysis,
  '600030': c600030 as PreAnalysis,
  '601688': c601688 as PreAnalysis,
  '000776': c000776 as PreAnalysis,
  '600519': c600519 as PreAnalysis,
  '000858': c000858 as PreAnalysis,
  '000568': c000568 as PreAnalysis,
  '600809': c600809 as PreAnalysis,
  '002304': c002304 as PreAnalysis,
  '000596': c000596 as PreAnalysis,
  '600887': c600887 as PreAnalysis,
  '603288': c603288 as PreAnalysis,
  '600276': c600276 as PreAnalysis,
  '300760': c300760 as PreAnalysis,
  '603259': c603259 as PreAnalysis,
  '300015': c300015 as PreAnalysis,
  '600436': c600436 as PreAnalysis,
  '000538': c000538 as PreAnalysis,
  '600196': c600196 as PreAnalysis,
  '002415': c002415 as PreAnalysis,
  '000725': c000725 as PreAnalysis,
  '002475': c002475 as PreAnalysis,
  '002371': c002371 as PreAnalysis,
  '688981': c688981 as PreAnalysis,
  '603501': c603501 as PreAnalysis,
  '300750': c300750 as PreAnalysis,
  '601012': c601012 as PreAnalysis,
  '600438': c600438 as PreAnalysis,
  '300124': c300124 as PreAnalysis,
  '002129': c002129 as PreAnalysis,
  '600570': c600570 as PreAnalysis,
  '002230': c002230 as PreAnalysis,
  '688111': c688111 as PreAnalysis,
  '300454': c300454 as PreAnalysis,
  '600845': c600845 as PreAnalysis,
  '000063': c000063 as PreAnalysis,
  '600050': c600050 as PreAnalysis,
  '601728': c601728 as PreAnalysis,
  '002594': c002594 as PreAnalysis,
  '600104': c600104 as PreAnalysis,
  '601633': c601633 as PreAnalysis,
  '000625': c000625 as PreAnalysis,
  '601238': c601238 as PreAnalysis,
  '000333': c000333 as PreAnalysis,
  '000651': c000651 as PreAnalysis,
  '600690': c600690 as PreAnalysis,
  '002508': c002508 as PreAnalysis,
  '002050': c002050 as PreAnalysis,
  '600031': c600031 as PreAnalysis,
  '601766': c601766 as PreAnalysis,
  '300450': c300450 as PreAnalysis,
  '002472': c002472 as PreAnalysis,
  '600309': c600309 as PreAnalysis,
  '600426': c600426 as PreAnalysis,
  '002648': c002648 as PreAnalysis,
  '601899': c601899 as PreAnalysis,
  '600111': c600111 as PreAnalysis,
  '603993': c603993 as PreAnalysis,
  '600547': c600547 as PreAnalysis,
  '000002': c000002 as PreAnalysis,
  '600048': c600048 as PreAnalysis,
  '001979': c001979 as PreAnalysis,
  '601668': c601668 as PreAnalysis,
  '601390': c601390 as PreAnalysis,
  '601186': c601186 as PreAnalysis,
  '600900': c600900 as PreAnalysis,
  '601985': c601985 as PreAnalysis,
  '600025': c600025 as PreAnalysis,
  '601919': c601919 as PreAnalysis,
  '600009': c600009 as PreAnalysis,
  '002352': c002352 as PreAnalysis,
  '601006': c601006 as PreAnalysis,
  '601888': c601888 as PreAnalysis,
  '600655': c600655 as PreAnalysis,
  '601088': c601088 as PreAnalysis,
  '601225': c601225 as PreAnalysis,
  '600188': c600188 as PreAnalysis,
  '601857': c601857 as PreAnalysis,
  '600028': c600028 as PreAnalysis,
  '600938': c600938 as PreAnalysis,
  '600019': c600019 as PreAnalysis,
  '000898': c000898 as PreAnalysis,
  '002714': c002714 as PreAnalysis,
  '300498': c300498 as PreAnalysis,
  '600298': c600298 as PreAnalysis,
  '600893': c600893 as PreAnalysis,
  '600760': c600760 as PreAnalysis,
  '002179': c002179 as PreAnalysis,
  '002027': c002027 as PreAnalysis,
  '300413': c300413 as PreAnalysis,
  '600585': c600585 as PreAnalysis,
  '002271': c002271 as PreAnalysis,
  '603605': c603605 as PreAnalysis,
  '600398': c600398 as PreAnalysis,
};

export function getPreAnalysis(code: string): PreAnalysis | undefined {
  return ANALYSES[code];
}
