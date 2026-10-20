import {guides,sectorOf} from './hk-research-guides.mjs';
import {guides as aGuides} from './a-research-guides.mjs';
import {businessProfile} from './business-first-profiles.mjs';
const G=(model,drivers,advantage,cash,risk)=>({model,drivers,advantage,cash,risk,peers:[]});
const extras={
 retail:aGuides.retail||G('零售采购商品并通过门店或线上渠道向消费者销售，代销与自营承担的库存风险不同。','客流、客单价、动销、折扣与门店效率共同影响经营。','选品、供应与服务需由重复购买和持续现金回报验证。','核对库存、供应商账期、租赁及门店投入。','需求、折扣竞争和库存过时可能侵蚀利润。'),
 trading:aGuides.trading,construction:aGuides.construction,building:aGuides.building,professional:aGuides.professional,
 coal:aGuides.coal,pharmaRetail:aGuides.pharmaRetail,paper:aGuides.paper,industrialGas:aGuides.industrialGas,insurance:aGuides.insurance,payment:aGuides.payment,
 assetManager:G('资产管理受托管理客户资金，以管理费、业绩费及自有资金投资等取得收入；管理资产不属于公司自由支配资产。','管理规模、资金净流入、收费结构和投资表现影响收入，规模涨跌要区分市场估值与客户申赎。','投资流程、客户关系和合规执行需由长期留存及风险调整结果验证，不以单年收益认定能力。','区分客户资产与公司现金，核对种子投资、赎回、激励及分红约束。','业绩波动、客户赎回和费率下降可能同时压缩收入，不能把受托规模当股东资产。'),
 exchange:G('交易所与金融数据业务连接交易、清算、上市或数据使用者，通过明确服务收费，收入来源并非全部与股价同向。','交易量、收费标准、上市活动、数据订阅及清算资金收益可能影响经营，各项需分别核对。','流动性网络和系统可靠性可能形成进入条件，优势应由持续使用、服务与监管许可验证。','清算保证金及客户资金不是股东自由现金，应与自有现金、系统投入分开。','市场低迷、费率压力、技术中断及监管变化可能影响收入和资本要求。'),
 service:G('服务企业按约定提供人员、运营或专业支持，项目收费、持续服务与代收代付应区分。','客户委托量、服务单价、人员效率、履约范围和续约影响经营。','流程、质量和客户关系需由重复委托、服务结果及实际回款验证。','人员、设备、项目保证金和应收形成资金需求，代收款不等于可分配现金。','客户预算、履约责任、人员成本与合同集中可能影响回报。'),
 insuranceBroker:G('保险经纪连接客户与保险公司，通常通过佣金及相关服务收费，与自行承保承担赔付风险不同。','新单、续期、佣金规则、退保追索及渠道成本影响收入。','专业匹配、客户服务与合规需由长期续保和实际留存验证。','区分代收保费和公司现金，核对佣金回收、退佣及获客投入。','产品规则、佣金调整、退保和销售合规可能影响收入与责任。'),
 consumerCredit:G('消费信贷以自有或取得的资金向客户提供融资，利息、服务费与实际承担的信用风险需要对应。','放款与还款、定价、违约、追收和融资成本共同影响回报，贷款增长不能直接等同于收入增长。','风控、客户获取与催收能力需由完整批次的实际回收和损失验证，不能仅看当期逾期。','放款占用资金，借款期限与回收期限需匹配，经营现金增加不一定代表利润可分配。','失业、欺诈、利率限制及融资压力可能恶化回收，不能以高名义收益掩盖信用损失。'),
};
const rules=[
 ['assetManager',/资产管理与托管/],['exchange',/金融交易所和数据/],['insuranceBroker',/保险经纪商/],['insurance',/多元化保险|再保险/],
 ['consumerCredit',/消费信贷|抵押贷款金融/],['payment',/交易与支付/],['broker',/综合性资本市场/],['holding',/多领域控股/],['service',/特殊金融服务|综合金融服务/],
 ['building',/建筑材料|建筑产品/],['construction',/建筑与工程|住宅建筑/],['machinery',/农用农业机械|电气部件与设备|汽车零件与设备|重型电气设备/],
 ['software',/信息科技咨询|数据处理与外包|互联网服务与基础设施|医疗保健技术/],['electronics',/电子制造服务/],['coal',/煤与消费用燃料/],
 ['music',/^广告$|互动媒体与服务|广播/],['retail',/专卖店|多品类零售|电脑与电子产品零售|汽车零售|日常消费品零售|家庭装饰零售|家庭装潢零售/],
 ['trading',/^经销商$|技术产品经销商|贸易公司与经销商/],['paper',/商业印刷|林业产品|纸质和塑料包装/],['chemicals',/商品化工|金属、玻璃及塑料器皿|轮胎与橡胶/],
 ['travel',/地面客运|消闲设施/],['medicalService',/管理型保健护理|保健护理机构/],['manufacturingConsumer',/家庭装饰品|家用器具与特殊消费品|居家用品/],
 ['power',/新能源发电业者/],['propertyService',/房地产服务/],['oil',/石油天然气设备与服务/],['service',/综合支持服务|特殊消费者服务|安全和报警服务|人力资源与就业服务|办公服务与用品/],
 ['professional',/调查和咨询服务/],['pharmaRetail',/药品零售/],['apparel',/纺织品/],['logistics',/机场服务|地面货运/],['metals',/^铜$|白银|多种金属与采矿|贵重金属与矿石/],
 ['food',/酿酒商与葡萄酒商/],['landlord',/REIT/],['devices',/医疗保健用品/],['water',/复合型公用事业/],['telecom',/有线和卫星电视/],['industrialGas',/工业气体/]
];
const aliases={aerospace:'aviation',smartDriving:'electronics',cdmo:'medicalService',ecommerce:'retail',localPlatform:'software',franchisedDrink:'restaurant',casino:'travel',lease:'otherFinance',assetManager:'otherFinance',exchange:'otherFinance',consumerCredit:'otherFinance',service:'professional',insuranceBroker:'insurance'};
export function hkGuide(code,industry,business=''){
 const leaf=industry.split('-').at(-1);let key=rules.find(([,re])=>re.test(leaf))?.[0];
 if(!key)key=sectorOf(code,industry);
 // Known issuer overrides take precedence over taxonomy where already documented.
 if(['09880','02228','03690','02665','02473'].includes(code))key=sectorOf(code,industry);
 const g=extras[key]||guides[key]||aGuides[key];if(!g)throw Error('No guide '+key);
 let profile=businessProfile(aliases[key]||key,industry);
 if(['casino','ecommerce','localPlatform','franchisedDrink','lease','cdmo','smartDriving'].includes(key))profile={use:g.model,customers:'实际使用者、采购决策方与结算付费方可能不同，需按公司披露的具体交易关系区分。',delivery:'产品或服务需要经过合同、交付和实际采用形成业务，规划规模与可实现经营结果之间存在条件。',competition:'替代方案来自相同使用场景，客户比较功能、价格、可靠性与使用成本，不能仅以行业名称或规模排序。',development:'业务拓展需要真实客户采用、持续交付与必要投入，新项目计划不等于已经形成收入。'};
 if(['assetManager','exchange','insuranceBroker','consumerCredit'].includes(key))profile={use:g.model,customers:'委托人、客户和交易对手承担不同角色，客户资金、受托资产与公司自有资产需分开。',delivery:'合同订立、服务执行、结算与持续合规共同构成交付，名义规模不等于已实现收费。',competition:'竞争应按具体服务、客户场景及风险承担方式比较，不能把牌照或规模直接当作持久优势。',development:'新客户与新产品需要实际使用和合规执行，拓展范围也可能改变风险与服务责任。'};
 return {key,g,profile};
}
