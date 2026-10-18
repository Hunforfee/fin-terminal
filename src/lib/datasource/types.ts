/**
 * 统一数据模型 —— 所有数据源 Provider 都必须产出这里的形状。
 * 上层（页面 / 组件）只依赖本文件，不感知具体数据源，
 * 因此替换 Provider（腾讯 -> 新浪 -> iFinD）时无需改动任何 UI 代码。
 */

export type Market = 'SH' | 'SZ' | 'BJ' | 'HK' | 'US';

export type AssetKind = 'stock' | 'index' | 'fund' | 'etf' | 'bond' | 'unknown';

/** 周期：日 / 周 / 月 */
export type Period = 'day' | 'week' | 'month' | 'minute';

/** 复权方式：不复权 / 前复权 / 后复权 */
export type Adjust = 'none' | 'qfq' | 'hfq';

/** 搜索联想结果 */
export interface SearchHit {
  /** 标准化代码，如 600519 */
  code: string;
  /** 带市场前缀的查询代码，如 sh600519 */
  symbol: string;
  name: string;
  market: Market;
  kind: AssetKind;
  /** 拼音缩写，便于 "gzmt" 这类输入命中 */
  pinyin?: string;
  /** 交易所板块描述，如 沪A / 深A / 科创板 */
  board?: string;
  /** 东方财富 secid，形如 1.600519 */
  secid?: string;
}

/** 实时行情快照 */
export interface Quote {
  code: string;
  symbol: string;
  name: string;
  market: Market;
  kind: AssetKind;
  /** 最新价 */
  price: number | null;
  /** 昨收 */
  prevClose: number | null;
  /** 今开 */
  open: number | null;
  /** 最高 / 最低 */
  high: number | null;
  low: number | null;
  /** 涨跌额 */
  change: number | null;
  /** 涨跌幅 % */
  changePct: number | null;
  /** 成交量（手） */
  volume: number | null;
  /** 成交额（元） */
  amount: number | null;
  /** 换手率 % */
  turnoverRate: number | null;
  /** 量比 */
  volumeRatio: number | null;
  /** 振幅 % */
  amplitude: number | null;
  /** 市盈率 TTM */
  pe: number | null;
  /** 市盈率（动态） */
  peForward: number | null;
  /** 市盈率（静态） */
  peStatic: number | null;
  /** 市净率 */
  pb: number | null;
  /** 总市值（亿元） */
  totalMarketCap: number | null;
  /** 流通市值（亿元） */
  floatMarketCap: number | null;
  /** 52 周高 / 低 */
  high52w: number | null;
  low52w: number | null;
  /** 股息率 %（仅港股行情源提供，A股走 /api/dividend-yield 预期股息率） */
  dividendYield?: number | null;
  /** 行情时间戳（ISO 字符串） */
  ts: string | null;
  /** 数据来源标识，用于页面上标注 */
  source: string;
  /** 是否来自兜底快照 */
  stale: boolean;
}

/** K 线单根 */
export interface Candle {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  /** 成交量（手） */
  volume: number;
}

/** K 线序列响应 */
export interface KLineSeries {
  symbol: string;
  code: string;
  period: Period;
  adjust: Adjust;
  candles: Candle[];
  source: string;
  stale: boolean;
}

/** 分时点 */
export interface MinutePoint {
  /** HH:MM */
  time: string;
  price: number;
  /** 累计成交量（手） */
  volume: number;
  /** 累计成交额（元） */
  amount: number;
}

/** 估值指标（含历史分位） */
export interface Valuation {
  code: string;
  pe: number | null;
  pb: number | null;
  /** 市盈率在历史区间中的百分位（0-100，越低越便宜） */
  pePercentile: number | null;
  pbPercentile: number | null;
  /** 预期股息率 %：已公告方案延续法，未来一年的税前股息收入占买入价的估计。 */
  dividendYield: number | null;
  /** 静态股息率 %：过去十二个月已实施税前现金分红 / 同日不复权股价。 */
  staticDividendYield?: number | null;
  dividendYieldMethod?: 'announced-forward';
  dividendForecast?: { asOf: string; expectedPerShare: number | null; staticPerShare: number | null; rawClose: number };
  /** 股息率历史分位 % */
  dyPercentile?: number | null;
  /** 净资产收益率 %（由 PB/PE 恒等式派生） */
  roe: number | null;
  /** 估算净利润（亿元）= 总市值 / PE */
  netProfit: number | null;
  /** 估算净资产（亿元）= 总市值 / PB */
  netAssets: number | null;
  /** 历史 PE 序列（用于绘制估值带） */
  history: ValuationPoint[];
  /** 历史序列口径：real = 由真实定期报告还原；estimate = 兜底估算 */
  basis?: 'real' | 'estimate';
  priceAdjust?: 'qfq';
  warnings?: string[];
  historyUnavailableReason?: string;
  marketComparison?: { pe: number | null; pb: number | null; ts: string | null };
  /** 序列区间年数 */
  years?: number;
  /** 序列统计（分位值 / 极值 / 均值） */
  stats?: ValuationStats;
  /**
   * 主口径：'disclosure' = 当日披露即纳入（理杏仁公司估值口径）；
   * 'cutoff' = 法定披露截止日次日统一切换（中证/国证指数口径）。
   * 两者差异主要出现在财报季的滞后性上。
   */
  method?: ValuationMethod;
  source: string;
  stale: boolean;
  /** 对比用：另一种口径的同口径结果（前端「可复现对比」用，不影响主图） */
  alt?: {
    method: ValuationMethod;
    history: ValuationPoint[];
    stats: ValuationStats;
    current: { pe: number | null; pb: number | null; dy: number | null };
  };
  /** 口径说明用的数据来源信息 */
  fin?: {
    /** 最近一期报告期 */
    report: string | null;
    /** 最近一期归母净利润 TTM（亿元） */
    npTTM: number | null;
    /** 最近一期总股本（亿股） */
    shares: number | null;
    /** 最近一期每股净资产（元） */
    bps: number | null;
    /** 报表覆盖的报告期数量 */
    points: number;
    /** 是否取到真实公告日 */
    realDates: boolean;
    /** 复权序列是否含未回填的除权事件 */
    adjustGaps: number;
  };
}

export type ValuationMethod = 'disclosure' | 'cutoff';

/** 单个指标在所选区间内的统计 */
export interface SeriesStats {
  current: number | null;
  percentile: number | null;
  p80: number | null;
  p50: number | null;
  p20: number | null;
  max: number | null;
  avg: number | null;
  min: number | null;
  /** 样本数（交易日数） */
  count: number;
}

export interface ValuationStats {
  pe: SeriesStats;
  pb: SeriesStats;
  dy: SeriesStats;
  /** 起始日 / 结束日 */
  from: string;
  to: string;
}

export interface ValuationPoint {
  date: string;
  pe: number | null;
  pb: number | null;
  close: number;
  rawClose?: number;
  adjustmentFactor?: number;
  /** 预期股息率 %；未知数据为 null，明确零分红为 0。 */
  dy: number | null;
  /** 过去十二个月已实施分红的静态股息率 %。 */
  dyStatic?: number | null;
}

/** 财务摘要 */
export interface FinancialSummary {
  code: string;
  /** 报告期，如 2025-12-31 */
  periods: string[];
  /** 营业收入（亿元） */
  revenue: (number | null)[];
  /** 净利润（亿元） */
  netProfit: (number | null)[];
  /** ROE % */
  roe: (number | null)[];
  /** 毛利率 % */
  grossMargin: (number | null)[];
  /** 资产负债率 % */
  debtRatio: (number | null)[];
  /** 营收同比增速 % */
  revenueGrowth: (number | null)[];
  /** 净利润同比增速 % */
  profitGrowth: (number | null)[];
  /** 指标来源说明（真实抓取 / 恒等式派生 / 样本） */
  provenance: 'fetched' | 'derived' | 'sample';
  note?: string;
}

/** 行业对比条目 */
export interface PeerRow {
  code: string;
  name: string;
  price: number | null;
  changePct: number | null;
  pe: number | null;
  pb: number | null;
  roe: number | null;
  totalMarketCap: number | null;
}

/** 大盘概览 */
export interface MarketOverview {
  indices: Quote[];
  updatedAt: string;
  source: string;
  stale: boolean;
}

/** 条件筛选入参 */
export interface ScreenCriteria {
  market?: 'all' | 'SH' | 'SZ' | 'BJ';
  peMin?: number;
  peMax?: number;
  pbMin?: number;
  pbMax?: number;
  roeMin?: number;
  marketCapMin?: number;
  marketCapMax?: number;
  changePctMin?: number;
  changePctMax?: number;
  /** 行业 / 板块关键字 */
  industry?: string;
  limit?: number;
}

/** 数据源能力声明 —— 用于 /api/health 与前端提示 */
export interface ProviderStatus {
  name: string;
  label: string;
  ok: boolean;
  /** 上次探测耗时 ms */
  latencyMs: number | null;
  detail: string;
  /** 是否为预留未启用的 Provider */
  reserved?: boolean;
}

