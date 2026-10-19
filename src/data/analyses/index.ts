/**
 * 预生成的「公司深度解析」索引。
 * 由 MCP（通达信 F10 深度资料 + 券商研报）抓取真实数据后，基于真实数据撰写并落盘为 {code}.json。
 * 弹窗优先读取此处预生成内容；未覆盖的股票回退到实时 F10 数据展示。
 */
import c600415 from './600415.json';
import c600519 from './600519.json';
import c300750 from './300750.json';
import c002594 from './002594.json';
import c601318 from './601318.json';
import c000333 from './000333.json';

/** 竞争对手/可比公司 */
export interface Competitor {
  /** 公司简称 */
  name: string;
  /** 证券代码（可空） */
  code?: string;
  /** 对比要点：规模、份额、业务重叠、相对优劣势 */
  note: string;
}

/** 市场正反观点中的一条论据 */
export interface ViewPoint {
  /** 要点标题（短句，如「数贸中心进入收入结转期」） */
  point: string;
  /** 展开说明，须含真实数据或机构观点 */
  detail: string;
}

export interface PreAnalysis {
  code: string;
  /** 公司全称 */
  fullName?: string;
  /** 所属行业（含层级，如「商贸零售-商业物业经营」） */
  industry: string;
  /** 公司地位一句话（如「全球最大的小商品集散地」） */
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

  /** 评级分布，如 { buy: 4, hold: 1, sell: 0 } */
  ratingSummary?: {
    /** 买入/强推/推荐 家数 */
    buy: number;
    /** 增持 家数 */
    hold: number;
    /** 中性/减持 家数 */
    sell: number;
  };
  /** 目标价区间（元） */
  targetPriceRange?: { min: number; max: number };

  /** 数据来源 */
  source: string;
  /** 生成日期 */
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
