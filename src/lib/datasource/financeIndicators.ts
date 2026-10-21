/** Browser-safe financial indicator metadata; source fetching stays on the server. */
export type IndicatorGroup = 'profit' | 'growth' | 'solvency' | 'cashflow' | 'pershare';

export interface IndicatorDef {
  key: string;
  /** 新浪页面上的指标名（用于解析定位） */
  sina: string;
  label: string;
  group: IndicatorGroup;
  /** 数值单位：pct=百分比，yuan=元，ratio=倍，wan=万元（三大报表口径） */
  unit: 'pct' | 'yuan' | 'ratio' | 'wan';
  /** 数值越小越好的指标（用于着色语义） */
  lowerBetter?: boolean;
}

/** 统一指标目录 —— 页面与图表都以此为准 */
export const INDICATORS: IndicatorDef[] = [
  // 盈利能力
  { key: 'roe', sina: '净资产收益率(%)', label: '净资产收益率 ROE', group: 'profit', unit: 'pct' },
  { key: 'netMargin', sina: '销售净利率(%)', label: '销售净利率', group: 'profit', unit: 'pct' },
  { key: 'operatingMargin', sina: '营业利润率(%)', label: '营业利润率', group: 'profit', unit: 'pct' },
  { key: 'mainMargin', sina: '主营业务利润率(%)', label: '主营业务利润率', group: 'profit', unit: 'pct' },
  { key: 'roa', sina: '资产报酬率(%)', label: '总资产报酬率 ROA', group: 'profit', unit: 'pct' },
  // 成长性
  { key: 'revenueGrowth', sina: '主营业务收入增长率(%)', label: '营业收入增长率', group: 'growth', unit: 'pct' },
  { key: 'profitGrowth', sina: '净利润增长率(%)', label: '净利润增长率', group: 'growth', unit: 'pct' },
  { key: 'equityGrowth', sina: '净资产增长率(%)', label: '净资产增长率', group: 'growth', unit: 'pct' },
  { key: 'assetGrowth', sina: '总资产增长率(%)', label: '总资产增长率', group: 'growth', unit: 'pct' },
  // 偿债能力
  { key: 'debtRatio', sina: '资产负债率(%)', label: '资产负债率', group: 'solvency', unit: 'pct', lowerBetter: true },
  { key: 'interestDebtRatio', sina: '', label: '有息负债率', group: 'solvency', unit: 'pct', lowerBetter: true },
  { key: 'currentRatio', sina: '流动比率', label: '流动比率', group: 'solvency', unit: 'ratio' },
  { key: 'quickRatio', sina: '速动比率', label: '速动比率', group: 'solvency', unit: 'ratio' },
  { key: 'cashRatio', sina: '现金比率(%)', label: '现金比率', group: 'solvency', unit: 'pct' },
  { key: 'equityRatio', sina: '股东权益比率(%)', label: '股东权益比率', group: 'solvency', unit: 'pct' },
  // 现金流
  { key: 'ocfPerShare', sina: '每股经营性现金流(元)', label: '每股经营现金流', group: 'cashflow', unit: 'yuan' },
  { key: 'ocfToRevenue', sina: '经营现金净流量对销售收入比率(%)', label: '经营现金流 / 营业收入', group: 'cashflow', unit: 'pct' },
  { key: 'ocfToProfit', sina: '经营现金净流量与净利润的比率(%)', label: '经营现金流 / 净利润', group: 'cashflow', unit: 'pct' },
  { key: 'cashFlowRatio', sina: '现金流量比率(%)', label: '现金流量比率', group: 'cashflow', unit: 'pct' },
  // 每股指标
  { key: 'eps', sina: '摊薄每股收益(元)', label: '每股收益 EPS', group: 'pershare', unit: 'yuan' },
  { key: 'bps', sina: '每股净资产_调整前(元)', label: '每股净资产 BPS', group: 'pershare', unit: 'yuan' },
  { key: 'undistPerShare', sina: '每股未分配利润(元)', label: '每股未分配利润', group: 'pershare', unit: 'yuan' },
];

export const GROUP_META: Record<IndicatorGroup, { label: string; desc: string }> = {
  profit: { label: '盈利能力', desc: '赚钱的效率与质量' },
  growth: { label: '成长性', desc: '收入与利润的扩张速度' },
  solvency: { label: '偿债能力', desc: '负债水平与短期流动性' },
  cashflow: { label: '现金流', desc: '经营造血能力' },
  pershare: { label: '每股指标', desc: '按股本折算的股东视角' },
};

