/**
 * 静态标的池 —— 指数 / 行业龙头 / 宽基 ETF。
 *
 * 这里只存放「不会频繁变化的公开事实」：代码、名称、所属行业、板块。
 * 价格、估值、涨跌幅一律实时抓取，不落库、不写死。
 * 用途：条件选股的全量候选池、行业对比的同业样本、首页默认展示。
 */

export interface UniverseItem {
  code: string;
  name: string;
  /** 简化行业分类（对齐申万一级的通俗命名） */
  industry: string;
  board: string;
}

export interface IndexItem {
  code: string;
  name: string;
  symbol: string;
  desc: string;
}

/** 指数池 */
export const INDICES: IndexItem[] = [
  { code: '000001', name: '上证指数', symbol: 'sh000001', desc: '上海证券交易所综合指数' },
  { code: '000300', name: '沪深300', symbol: 'sh000300', desc: '沪深两市核心大盘蓝筹' },
  { code: '000016', name: '上证50', symbol: 'sh000016', desc: '沪市最具影响力的 50 只龙头' },
  { code: '000905', name: '中证500', symbol: 'sh000905', desc: '沪深两市中盘成长代表' },
  { code: '000852', name: '中证1000', symbol: 'sh000852', desc: '小盘股代表指数' },
  { code: '000688', name: '科创50', symbol: 'sh000688', desc: '科创板核心 50 家硬科技' },
  { code: '399001', name: '深证成指', symbol: 'sz399001', desc: '深圳证券交易所成分指数' },
  { code: '399006', name: '创业板指', symbol: 'sz399006', desc: '创业板 100 家创新企业' },
  { code: '899050', name: '北证50', symbol: 'bj899050', desc: '北交所核心 50 家' },
];

/** 行业分类（用于筛选与对比） */
export const INDUSTRIES: string[] = [
  '银行',
  '非银金融',
  '食品饮料',
  '医药生物',
  '电子',
  '电力设备',
  '计算机',
  '通信',
  '汽车',
  '家用电器',
  '机械设备',
  '基础化工',
  '有色金属',
  '房地产',
  '建筑装饰',
  '公用事业',
  '交通运输',
  '商贸零售',
  '煤炭',
  '石油石化',
  '钢铁',
  '农林牧渔',
  '国防军工',
  '传媒',
  '建筑材料',
  '美容护理',
  '纺织服饰',
];

/** 行业龙头池（条件选股的候选 Universe） */
export const STOCKS: UniverseItem[] = [
  // 银行
  { code: '601398', name: '工商银行', industry: '银行', board: '沪市主板' },
  { code: '601288', name: '农业银行', industry: '银行', board: '沪市主板' },
  { code: '601939', name: '建设银行', industry: '银行', board: '沪市主板' },
  { code: '601988', name: '中国银行', industry: '银行', board: '沪市主板' },
  { code: '600036', name: '招商银行', industry: '银行', board: '沪市主板' },
  { code: '601166', name: '兴业银行', industry: '银行', board: '沪市主板' },
  { code: '600000', name: '浦发银行', industry: '银行', board: '沪市主板' },
  { code: '002142', name: '宁波银行', industry: '银行', board: '深市主板' },
  // 非银金融
  { code: '601318', name: '中国平安', industry: '非银金融', board: '沪市主板' },
  { code: '601601', name: '中国太保', industry: '非银金融', board: '沪市主板' },
  { code: '601628', name: '中国人寿', industry: '非银金融', board: '沪市主板' },
  { code: '600030', name: '中信证券', industry: '非银金融', board: '沪市主板' },
  { code: '601688', name: '华泰证券', industry: '非银金融', board: '沪市主板' },
  { code: '000776', name: '广发证券', industry: '非银金融', board: '深市主板' },
  // 食品饮料
  { code: '600519', name: '贵州茅台', industry: '食品饮料', board: '沪市主板' },
  { code: '000858', name: '五粮液', industry: '食品饮料', board: '深市主板' },
  { code: '000568', name: '泸州老窖', industry: '食品饮料', board: '深市主板' },
  { code: '600809', name: '山西汾酒', industry: '食品饮料', board: '沪市主板' },
  { code: '002304', name: '洋河股份', industry: '食品饮料', board: '深市主板' },
  { code: '000596', name: '古井贡酒', industry: '食品饮料', board: '深市主板' },
  { code: '600887', name: '伊利股份', industry: '食品饮料', board: '沪市主板' },
  { code: '603288', name: '海天味业', industry: '食品饮料', board: '沪市主板' },
  // 医药生物
  { code: '600276', name: '恒瑞医药', industry: '医药生物', board: '沪市主板' },
  { code: '300760', name: '迈瑞医疗', industry: '医药生物', board: '创业板' },
  { code: '603259', name: '药明康德', industry: '医药生物', board: '沪市主板' },
  { code: '300015', name: '爱尔眼科', industry: '医药生物', board: '创业板' },
  { code: '600436', name: '片仔癀', industry: '医药生物', board: '沪市主板' },
  { code: '000538', name: '云南白药', industry: '医药生物', board: '深市主板' },
  { code: '600196', name: '复星医药', industry: '医药生物', board: '沪市主板' },
  // 电子
  { code: '002415', name: '海康威视', industry: '电子', board: '深市主板' },
  { code: '000725', name: '京东方A', industry: '电子', board: '深市主板' },
  { code: '002475', name: '立讯精密', industry: '电子', board: '深市主板' },
  { code: '002371', name: '北方华创', industry: '电子', board: '深市主板' },
  { code: '688981', name: '中芯国际', industry: '电子', board: '科创板' },
  { code: '603501', name: '韦尔股份', industry: '电子', board: '沪市主板' },
  // 电力设备
  { code: '300750', name: '宁德时代', industry: '电力设备', board: '创业板' },
  { code: '601012', name: '隆基绿能', industry: '电力设备', board: '沪市主板' },
  { code: '600438', name: '通威股份', industry: '电力设备', board: '沪市主板' },
  { code: '300124', name: '汇川技术', industry: '电力设备', board: '创业板' },
  { code: '002129', name: 'TCL中环', industry: '电力设备', board: '深市主板' },
  // 计算机
  { code: '600570', name: '恒生电子', industry: '计算机', board: '沪市主板' },
  { code: '002230', name: '科大讯飞', industry: '计算机', board: '深市主板' },
  { code: '688111', name: '金山办公', industry: '计算机', board: '科创板' },
  { code: '300454', name: '深信服', industry: '计算机', board: '创业板' },
  { code: '600845', name: '宝信软件', industry: '计算机', board: '沪市主板' },
  // 通信
  { code: '000063', name: '中兴通讯', industry: '通信', board: '深市主板' },
  { code: '600050', name: '中国联通', industry: '通信', board: '沪市主板' },
  { code: '601728', name: '中国电信', industry: '通信', board: '沪市主板' },
  // 汽车
  { code: '002594', name: '比亚迪', industry: '汽车', board: '深市主板' },
  { code: '600104', name: '上汽集团', industry: '汽车', board: '沪市主板' },
  { code: '601633', name: '长城汽车', industry: '汽车', board: '沪市主板' },
  { code: '000625', name: '长安汽车', industry: '汽车', board: '深市主板' },
  { code: '601238', name: '广汽集团', industry: '汽车', board: '沪市主板' },
  // 家用电器
  { code: '000333', name: '美的集团', industry: '家用电器', board: '深市主板' },
  { code: '000651', name: '格力电器', industry: '家用电器', board: '深市主板' },
  { code: '600690', name: '海尔智家', industry: '家用电器', board: '沪市主板' },
  { code: '002508', name: '老板电器', industry: '家用电器', board: '深市主板' },
  { code: '002050', name: '三花智控', industry: '家用电器', board: '深市主板' },
  // 机械设备
  { code: '600031', name: '三一重工', industry: '机械设备', board: '沪市主板' },
  { code: '601766', name: '中国中车', industry: '机械设备', board: '沪市主板' },
  { code: '300450', name: '先导智能', industry: '机械设备', board: '创业板' },
  { code: '002472', name: '双环传动', industry: '机械设备', board: '深市主板' },
  // 基础化工
  { code: '600309', name: '万华化学', industry: '基础化工', board: '沪市主板' },
  { code: '600426', name: '华鲁恒升', industry: '基础化工', board: '沪市主板' },
  { code: '002648', name: '卫星化学', industry: '基础化工', board: '深市主板' },
  // 有色金属
  { code: '601899', name: '紫金矿业', industry: '有色金属', board: '沪市主板' },
  { code: '600111', name: '北方稀土', industry: '有色金属', board: '沪市主板' },
  { code: '603993', name: '洛阳钼业', industry: '有色金属', board: '沪市主板' },
  { code: '600547', name: '山东黄金', industry: '有色金属', board: '沪市主板' },
  // 房地产
  { code: '000002', name: '万科A', industry: '房地产', board: '深市主板' },
  { code: '600048', name: '保利发展', industry: '房地产', board: '沪市主板' },
  { code: '001979', name: '招商蛇口', industry: '房地产', board: '深市主板' },
  // 建筑装饰
  { code: '601668', name: '中国建筑', industry: '建筑装饰', board: '沪市主板' },
  { code: '601390', name: '中国中铁', industry: '建筑装饰', board: '沪市主板' },
  { code: '601186', name: '中国铁建', industry: '建筑装饰', board: '沪市主板' },
  // 公用事业
  { code: '600900', name: '长江电力', industry: '公用事业', board: '沪市主板' },
  { code: '601985', name: '中国核电', industry: '公用事业', board: '沪市主板' },
  { code: '600025', name: '华能水电', industry: '公用事业', board: '沪市主板' },
  // 交通运输
  { code: '601919', name: '中远海控', industry: '交通运输', board: '沪市主板' },
  { code: '600009', name: '上海机场', industry: '交通运输', board: '沪市主板' },
  { code: '002352', name: '顺丰控股', industry: '交通运输', board: '深市主板' },
  { code: '601006', name: '大秦铁路', industry: '交通运输', board: '沪市主板' },
  // 商贸零售
  { code: '601888', name: '中国中免', industry: '商贸零售', board: '沪市主板' },
  { code: '600655', name: '豫园股份', industry: '商贸零售', board: '沪市主板' },
  // 煤炭
  { code: '601088', name: '中国神华', industry: '煤炭', board: '沪市主板' },
  { code: '601225', name: '陕西煤业', industry: '煤炭', board: '沪市主板' },
  { code: '600188', name: '兖矿能源', industry: '煤炭', board: '沪市主板' },
  // 石油石化
  { code: '601857', name: '中国石油', industry: '石油石化', board: '沪市主板' },
  { code: '600028', name: '中国石化', industry: '石油石化', board: '沪市主板' },
  { code: '600938', name: '中国海油', industry: '石油石化', board: '沪市主板' },
  // 钢铁
  { code: '600019', name: '宝钢股份', industry: '钢铁', board: '沪市主板' },
  { code: '000898', name: '鞍钢股份', industry: '钢铁', board: '深市主板' },
  // 农林牧渔
  { code: '002714', name: '牧原股份', industry: '农林牧渔', board: '深市主板' },
  { code: '300498', name: '温氏股份', industry: '农林牧渔', board: '创业板' },
  { code: '600298', name: '安琪酵母', industry: '农林牧渔', board: '沪市主板' },
  // 国防军工
  { code: '600893', name: '航发动力', industry: '国防军工', board: '沪市主板' },
  { code: '600760', name: '中航沈飞', industry: '国防军工', board: '沪市主板' },
  { code: '002179', name: '中航光电', industry: '国防军工', board: '深市主板' },
  // 传媒
  { code: '002027', name: '分众传媒', industry: '传媒', board: '深市主板' },
  { code: '300413', name: '芒果超媒', industry: '传媒', board: '创业板' },
  // 建筑材料
  { code: '600585', name: '海螺水泥', industry: '建筑材料', board: '沪市主板' },
  { code: '002271', name: '东方雨虹', industry: '建筑材料', board: '深市主板' },
  // 美容护理
  { code: '603605', name: '珀莱雅', industry: '美容护理', board: '沪市主板' },
  // 纺织服饰
  { code: '600398', name: '海澜之家', industry: '纺织服饰', board: '沪市主板' },
];

/** 宽基 / 行业 ETF（基金模块的展示样本） */
export const FUNDS: UniverseItem[] = [
  { code: '510300', name: '沪深300ETF', industry: '宽基指数', board: '沪市ETF' },
  { code: '510500', name: '中证500ETF', industry: '宽基指数', board: '沪市ETF' },
  { code: '510050', name: '上证50ETF', industry: '宽基指数', board: '沪市ETF' },
  { code: '159915', name: '创业板ETF', industry: '宽基指数', board: '深市ETF' },
  { code: '588000', name: '科创50ETF', industry: '宽基指数', board: '沪市ETF' },
  { code: '518880', name: '黄金ETF', industry: '商品', board: '沪市ETF' },
  { code: '512880', name: '证券ETF', industry: '行业指数', board: '沪市ETF' },
  { code: '512480', name: '半导体ETF', industry: '行业指数', board: '沪市ETF' },
  { code: '512690', name: '酒ETF', industry: '行业指数', board: '沪市ETF' },
  { code: '515790', name: '光伏ETF', industry: '行业指数', board: '沪市ETF' },
  { code: '516160', name: '新能源ETF', industry: '行业指数', board: '沪市ETF' },
  { code: '512170', name: '医疗ETF', industry: '行业指数', board: '沪市ETF' },
];

/** 默认自选（首次打开时的示例，用户可自行增删） */
export const DEFAULT_WATCHLIST: string[] = [
  '600519',
  '000858',
  '300750',
  '601318',
  '600036',
  '000300',
  '399006',
  '000001',
];

/** 按行业取同业标的（不含自身） */
export function peersOf(code: string, limit = 20): UniverseItem[] {
  const self = STOCKS.find((s) => s.code === code);
  if (!self) return [];
  return STOCKS.filter((s) => s.industry === self.industry && s.code !== code).slice(0, limit);
}

export function industryOf(code: string): string | null {
  return STOCKS.find((s) => s.code === code)?.industry ?? null;
}

export function nameOf(code: string): string | null {
  return (
    STOCKS.find((s) => s.code === code)?.name ??
    INDICES.find((s) => s.code === code)?.name ??
    FUNDS.find((s) => s.code === code)?.name ??
    null
  );
}
