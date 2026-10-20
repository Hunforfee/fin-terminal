/** Source-backed working drafts. Never label these as reviewed institutional research. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { guides, sectorOf, peerOverrides } from './hk-research-guides.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'src/data/analyses');
const rawDir = path.join(dir, '_raw/coverage');
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const records = [];
for (const file of await fs.readdir(rawDir)) if (/^\d{5}\.json$/.test(file)) records.push(JSON.parse(await fs.readFile(path.join(rawDir, file), 'utf8')));
const names = new Map(records.map(r => [r.code, r.profile?.SECURITY_NAME_ABBR]));
for (const file of await fs.readdir(dir)) if (/^\d{5,6}\.json$/.test(file)) {
  const data = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
  if (data.fullName) names.set(data.code, data.fullName);
}
for (const [code, name] of Object.entries({ EQIX:'Equinix', DLR:'Digital Realty', VNET:'世纪互联', MOMO:'挚文集团', BMBL:'Bumble', MTCH:'Match Group', MAT:'美泰', HAS:'孩之宝', SWK:'史丹利百得', PM:'菲利普莫里斯国际', 'BAT.L':'英美烟草', 'IMB.L':'帝国品牌', MAR:'万豪国际', PDD:'拼多多', VIPS:'唯品会', RLX:'雾芯科技', '02888':'渣打集团', '00268':'金蝶国际', '00354':'中国软件国际', '00909':'明源云', '00551':'裕元集团', '03813':'宝胜国际', '02120':'康宁医院', '06127':'昭衍新药', '600258':'首旅酒店', '600754':'锦江酒店', '002444':'巨星科技', '603787':'新日股份', '000913':'钱江摩托', '301345':'涛涛车业' })) names.set(code, name);
const notes = {
 '00001':'长和需要分开看零售、港口、基础设施和电讯等资产；单一零售业务标签不能代表整个集团，控股层现金和投资处置条件尤其需要核对。',
 '00019':'太古的饮料、航空、地产及其他投资应按分部和实际持股核对，不能把合营企业的全部利润或现金视为母公司所有。',
 '00697':'首程涉及停车运营与基础设施资产管理，停车收入、管理费和投资收益须分别核对，不能简单归为住宅开发。',
 '00363':'上海实业的基建环保与地产等业务具有不同资金周期，收费和运营现金不应与物业销售或估值变化混合。',
 '00142':'第一太平的多地区、多层级控股结构需要从实际持股、子公司分红及控股层债务逐层还原，合并收入不能直接代表股东可支配现金。',
 '03690':'美团是连接消费者、商家与履约供给的本地服务平台，不是普通餐饮连锁；外卖、到店及新业务应单独核对单位经济。',
 '09987':'百胜中国要按具体餐饮品牌区分直营和加盟，再观察同店与新店贡献；供应链和数字化投入的价值应落在店效及现金回收。',
 '01364':'古茗的核心研究对象是加盟商经济性和向门店供货的能力，不应把加盟店零售流水全部视作上市公司收入。',
 '02460':'华润饮料的包装水与其他即饮饮品需要分别分析。渠道铺货、终端动销与促销费用应同时核对，而不能仅用品牌知名度推断定价权。',
 '09633':'农夫山泉的包装水和不同饮料品类具有不同增长与利润结构，应分开看渠道库存、原料成本与终端消费。',
 '01579':'颐海要区分关联餐饮客户与第三方复合调味品、方便速食等销售渠道；关联采购稳定性和独立品牌能力是两条不同的验证线。',
 '01836':'九兴的鞋履制造和自主品牌零售需要区分，订单结构、海外产地、交付效率与客户集中度比单纯出货增长更重要。',
 '06110':'滔搏属于运动鞋服零售运营环节，应关注品牌授权、折扣、库存与门店回报，不能套用上游制造商的利润结构。',
 '03998':'波司登需要把品牌羽绒服与其他业务分开，暖冬和渠道备货可能使单季出货偏离终端需求。',
 '00116':'周生生的珠宝零售、金料安排及其他业务须分别核对，金价推动的收入变化不能直接解释品牌溢价。',
 '06168':'周六福需要区分加盟网络与直营、金料与工费收入，品牌门店增长能否转化为加盟商及上市公司的现金回报应分别验证。',
 '02473':'喜相逢的汽车融资与租赁属性需要结合客户信用、融资及车辆残值分析，而不是按汽车零部件制造商比较。',
 '09880':'优必选的机器人业务应跟踪实际商业化交付、单机或项目毛利、研发消耗和回款；资料源的生物科技行业标签并不适用于其主营。',
 '02228':'晶泰的计算研发与自动化实验服务需要区分设备或系统交付和持续服务，不能套用传统药品销售逻辑。',
 '02665':'图达通研究应落在激光雷达产品、量产客户及交付经济性，通用软件行业标签不能替代对硬件成本和车规验证的理解。',
 '02498':'速腾聚创需要分开看车载和机器人等应用，客户定点、量产出货、产品降价及研发支出应连起来跟踪。',
 '02533':'黑芝麻智能的车规计算芯片与解决方案，需要用量产和客户实际采购验证，芯片技术参数不能替代商业化收入。',
 '09660':'地平线需要区分计算芯片、算法软件与相关解决方案，车型定点和实际量产收入之间仍需逐项核对。',
 '02631':'天岳先进处于半导体材料环节，衬底规格、良率、认证和设备利用率是关键，而不是按晶圆代工公司机械类比。',
 '00981':'中芯国际是晶圆制造环节，成熟与先进工艺的投资要求、产品组合和利用率不同，产能扩张必须结合折旧和现金需求。',
 '03931':'中创新航的动力与储能电池要分开看客户、出货、成本和质保，客户规模与电芯资本回报之间还需要量化验证。',
 '02382':'舜宇的光学零件、模组及其他业务具有不同利润率，手机与车载业务的量价和资本投入应单独拆分。',
 '01478':'丘钛的摄像头模组与其他组件需要核对规格升级、良率和客户价格要求，不能只用像素或出货数判断回报。',
 '01888':'建滔积层板的覆铜板业务应拆分材料价差、产品结构和利用率，不能把电子终端景气直接等同于自身利润。',
 '00669':'创科实业应按电动工具、户外设备等实际业务及品牌渠道核对，订单、库存和研发平台的回报需要结合看。',
 '02285':'泉峰的电动工具与户外动力设备需要分别看终端需求、渠道去库存和新品投入，电动化趋势并不保证每家公司持续增利。',
 '01686':'新意网的数据中心容量必须区分建设、交付和计费上架；电力、设备与资金承诺应进入资本回报测算。',
 '06969':'思摩尔处于雾化设备及相关产品环节，客户品牌商与制造商的价值分配不同；烟草监管和新业务投入应单列。',
 '06055':'中烟香港的进出口及相关业务需要核对具体授权、区域、产品和交易模式，与直接经营终端消费品牌并不相同。',
 '02588':'中银航空租赁的租金、融资成本、飞机残值与承租人信用需一起分析，航空客流恢复不能直接推出租赁资产回报。',
 '02866':'中远海发应把集装箱制造和租赁等业务拆开，集装箱价格、利用率和长期融资共同决定每股回报。',
 '03918':'金界的主要经营区域与澳门企业不同，对照度假村模式时必须单列当地监管、客源和项目投资，不能套用澳门行业数据。',
 '01114':'华晨中国的合营及投资收益应与自身制造、零部件等业务区分，权益法利润和实际收到分红存在差异。',
 '01199':'中远海运港口需要核对控股与参股码头的权益口径，吞吐量增长不代表全部转为上市公司收入或现金。',
 '06198':'青岛港需要分货种、作业及相关物流服务看利润，并区分港口经营现金与参股企业的分红。',
 '02328':'中国财险的车险、农险、健康及其他非车险应分别看承保质量，综合成本率不能只用保费规模解释。',
 '00966':'中国太平的寿险、财险、再保险及投资业务具有不同负债和资本要求，不能将全部保费统一套用寿险价值指标。',
 '00005':'汇丰需分地区、客户类型和业务线分析，股东回报要结合资本要求、利率和信用风险，而非仅靠全球业务规模判断。',
 '00956':'新天的新能源与天然气业务应分别核对利用率、电价、售气量及资本开支，两条业务的现金转换机制不同。',
 '09992':'泡泡玛特应区分自有或授权IP、产品销售与门店渠道。新品热度须通过持续复购、库存和授权权益验证。',
};
const clean = value => typeof value === 'string' ? value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : '';
const pct = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 10000 ? `${value.toFixed(2)}%` : null;
function webUrl(value) {
  try { const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`); return /^(https?):$/.test(url.protocol) && !/^(localhost|127\.|10\.|192\.168\.)/.test(url.hostname) ? url.href : null; } catch { return null; }
}
const created = [], skipped = [];
const refresh = process.argv.includes('--refresh-generated');
const approvedHashes = refresh ? new Map(JSON.parse(await fs.readFile(path.join(root,'docs/analysis-coverage.json'),'utf8')).entries.map(item=>[item.code,item.sha256])) : new Map();
for (const row of records) sectorOf(row.code,row.profile?.INDUSTRY_TYPE || '');
for (const row of records.sort((a, b) => a.code.localeCompare(b.code))) {
  const target = path.join(dir, `${row.code}.json`);
  let replacing = false;
  let old; try { old = await fs.readFile(target,'utf8'); } catch {}
  if (old) {
    const data = JSON.parse(old);
    if (!refresh || data.researchStatus !== 'draft' || data.evidence?.numericalBasis !== 'aggregate-ratios-only') { skipped.push(row.code); continue; }
    if (data.evidence.originalReportRead || crypto.createHash('sha256').update(old).digest('hex') !== approvedHashes.get(row.code)) throw Error(`Edited/reviewed draft cannot be regenerated: ${row.code}`);
    replacing = true;
  }
  const p = row.profile;
  if (!p?.ORG_NAME || !p.MAIN_BUSINESS || !p.INDUSTRY_TYPE) throw Error(`Insufficient issuer identity/business: ${row.code}`);
  const name = clean(p.SECURITY_NAME_ABBR), fullName = clean(p.ORG_NAME), originalIndustry = clean(p.INDUSTRY_TYPE);
  const sector = sectorOf(row.code, originalIndustry), g = guides[sector];
  const industry = ({ '09880':'工业-机器人及自动化','02228':'医疗研发服务-计算研发与自动化实验','02665':'汽车电子-激光雷达','02473':'金融服务-汽车融资及租赁','03690':'互联网-本地生活平台','09987':'消费者服务-餐饮运营' })[row.code] || originalIndustry;
  const f = row.financials.find(item => item.REPORT_DATE?.slice(0,10) <= today);
  const period = f?.REPORT_DATE?.slice(0,10);
  const rawActivity = clean(p.MAIN_BUSINESS).match(/(?:主要从事|主要提供|专注于)([^。]+)/)?.[1]?.split(/[，,]/)[0]?.replace(/业务(?:的投资控股公司|的公司)?$/, '');
  const activity = rawActivity && rawActivity.length <= 26 ? rawActivity : industry.split('-').at(-1);
  const briefPosition = ({ '00001':'多元化控股与分部现金回报','00019':'多元化实业与投资业务','00697':'停车运营及基础设施资产管理','03690':'本地生活平台与履约服务','09987':'多品牌餐饮运营','09880':'机器人与自动化商业化','02228':'计算研发及自动化实验服务','02473':'汽车融资及租赁','02665':'车规激光雷达','00956':'新能源发电与天然气' })[row.code] || activity;
  const isFinance = ['bank','life','pnc','broker','amc','lease'].includes(sector);
  const metrics = [pct(f?.OPERATE_INCOME_YOY) ? `收入同比${pct(f.OPERATE_INCOME_YOY)}` : '', pct(f?.HOLDER_PROFIT_YOY) ? `归母利润同比${pct(f.HOLDER_PROFIT_YOY)}` : '', pct(f?.ROE_AVG) ? `期内平均净资产收益率${pct(f.ROE_AVG)}` : ''].filter(Boolean);
  const margins = !isFinance ? [pct(f?.GROSS_PROFIT_RATIO) ? `毛利率${pct(f.GROSS_PROFIT_RATIO)}` : '', typeof f?.DEBT_ASSET_RATIO === 'number' && f.DEBT_ASSET_RATIO >= 0 && f.DEBT_ASSET_RATIO <= 100 ? `资产负债率${pct(f.DEBT_ASSET_RATIO)}` : ''].filter(Boolean) : [];
  const metricText = period && metrics.length ? `数据源最近一期${period}记录${metrics.join('、')}。这些是聚合指标线索，需与原始披露中的统计范围和会计调整逐项核对，不能据此直接认定持续增长。` : '本轮尚未核验能够直接用于估值的完整财务口径，收入与利润的持续性需要回到原始报告确认。';
  const cashText = !isFinance && typeof f?.NETCASH_OPERATE === 'number' ? `同期数据源经营现金流为${f.NETCASH_OPERATE < 0 ? '净流出' : f.NETCASH_OPERATE > 0 ? '净流入' : '零'}；其方向仍需结合季节性、营运资本与必要投资解释。` : '';
  const comparisons = (peerOverrides[row.code] || (sector === 'datacenter' ? ['01686','09698','EQIX','DLR'] : sector === 'software' ? ['03888','00268','00354','00909'] : sector === 'cdmo' ? ['02269','02359','03759','06127'] : sector === 'medicalService' ? ['01951','01515','03309','02120'] : g.peers)).filter(code => code !== row.code && names.has(code)).slice(0,3);
  const primary = row.disclosures.find(item => item.publishedAt <= today);
  const issuer = webUrl(clean(p.ORG_WEB));
  const sources = [
    { id: 'profile', label: '公司主营资料 · 东财', url: row.urls.profile, kind: 'aggregate', retrievedAt: row.retrievedAt },
    { id: 'finance', label: `财务指标线索${period ? ` · ${period}` : ''}`, url: row.urls.financials, kind: 'aggregate', retrievedAt: row.retrievedAt },
    ...(issuer ? [{ id: 'issuer', label: '公司网站', url: issuer, kind: 'issuer', retrievedAt: row.retrievedAt }] : []),
    ...(primary ? [{ id: 'report', label: primary.title, url: primary.url, kind: 'disclosure', retrievedAt: row.retrievedAt }] : [{ id: 'disclosures', label: '披露易原文检索', url: 'https://www1.hkexnews.hk/search/titlesearch.xhtml?lang=zh', kind: 'disclosure', retrievedAt: row.retrievedAt }]),
  ];
  const verificationTasks = [
    `核对${period || '最新已披露期'}原始财报：合并范围、报告期、币种、金额单位与审计或审阅意见。`,
    '补充分部收入、分部利润及资本投入，区分经常经营、一次性项目与权益法投资。',
    g.cash,
    `核实可比公司的具体业务重叠：${comparisons.map(code => names.get(code)).join('、') || '本轮尚未确认合适对象'}；不同产品、区域或价值链环节不得直接比较利润率。`,
    '核验直接覆盖本公司的近期券商研报，再决定是否添加机构评级、目标价或市场一致预期；未知统计不填零。',
    ...(primary ? ['已取得原文地址，尚需逐页复核正文、财务附注及关键数值；取得链接不代表完成复核。'] : ['本轮未取得可准确定位的报告全文链接；公告源部分请求被拒绝，需从公司网站或披露易继续取得原文。']),
  ];
  const paragraphs = [
    `${fullName}（${row.code}.HK）的主营资料涉及${activity}。${notes[row.code] || `理解${name}，先区分产品、服务与投资收益各自对应的客户、交付和现金来源，不能只用行业标签概括业务。`}${p.LISTING_DATE ? `资料登记的香港上市日期为${p.LISTING_DATE.slice(0,10)}。` : ''}本稿把已经取得的公司资料、财务线索与待验证的研究判断分开，不对未经核验的市占率或行业排名作结论。`,
    `${g.model}${g.drivers}对${name}，应在原始分部资料中把收入确认、产品或服务量、单价、成本和费用连起来看。若存在关联客户、集团内部交易或不同会计合并方式，先统一口径再计算份额；某项收入占比高，并不说明它一定贡献同等比例的利润或现金。`,
    `${metricText}${margins.length ? `同一数据源还列示${margins.join('、')}，这里只作为财务质量核对的起点。` : ''}${g.advantage}对于经营变化，需要区分行业价格或市场需求的共同影响与公司自身效率改善；利润转正或高同比可能只是低基数，不构成自动上调长期回报的理由。`,
    `${g.cash}${cashText}本轮不引用尚未核对原报表币种和换算基础的绝对金额，也不把港元交易代码当成财报记账币种。${comparisons.length ? `同行对照选择${comparisons.map(code => `${names.get(code)}（${code}）`).join('、')}，用于比较业务模式、资本要求或周期暴露；这些是可比研究对象，不代表本轮已确认它们全部是直接竞争对手。` : '本轮尚未确认足够可比对象，后续需从相同产品和客户场景补齐。'}比较应使用相同报告期与业务口径，先解释差异，再讨论估值高低。`,
    `${g.risk}对${name}的正向情景应以量价或效率改善、现金回收和每股回报的实际证据为条件；反向情景则跟踪这些条件失效时的损失与融资要求。当前不生成目标价、不推测机构评级，也不把行业分析假设写成市场共识。后续研究应完成原文、分部与关键经营量的复核，再据证据更新结论、来源日期和状态。`,
  ];
  const draft = {
    code: row.code, fullName, industry, position: `${name}：${briefPosition}`,
    researchStatus: 'draft', viewBasis: 'research_hypotheses', summary: paragraphs.join('\n\n'),
    moat: [
      { point: '业务与客户线索', detail: `${name}的主营资料支持从产品和客户交付研究业务，但尚不能据此认定长期超额收益。${g.advantage}` },
      { point: '经济性验证', detail: `${g.drivers}${period ? `以${period}指标为起点，继续核对连续报告期。` : ''}` },
      { point: '资本与现金约束', detail: `${g.cash}优势是否成立，应落到扣除必要投入后的每股回报。` },
    ],
    competitors: comparisons.map(code => ({ name: names.get(code), code, note: `作为${name}的业务模式、资本要求或价值链对照对象，先比较其收入与风险由哪些环节产生，再核对费用及现金转换。尚未逐项确认直接竞争关系；产品、地区、合并范围不同，不可直接套用估值或利润率。` })),
    bullCase: [
      { point: '经营改善情景', detail: `${g.drivers}若这些变量持续向好且不是一次性贡献，才支持改善长期现金回报的判断；本项是研究假设，不是已核验的机构观点。` },
      { point: '优势兑现情景', detail: `${g.advantage}需要连续报告期和实际客户行为支持，不能仅凭公司宣传或单期指标。` },
      { point: '资本纪律情景', detail: `${g.cash}若可分配现金在满足这些要求后仍能增长，才可能提高长期每股价值。` },
    ],
    bearCase: [
      { point: '核心经营变量失效', detail: g.risk },
      { point: '利润与现金偏离', detail: `${g.cash}当利润与回款长期偏离，应检查收入确认、营运资本、资产估值和必要投入，不能只看账面增速。` },
      { point: '证据与估值不充分', detail: `尚未完成${name}原始财报与附注、直接竞争关系及机构研究的逐项复核。资料中的缺失和口径差异会直接影响判断，应在复核后才使用绝对金额、目标价或一致预期。` },
    ],
    source: `东方财富港股公司资料及财务指标线索，采集${today}${period ? `，指标期${period}` : ''}；原始披露与币种尚待逐项复核；看好与风险为研究假设，未核验机构评级及目标价。`,
    generatedAt: today, sources, verificationTasks,
    evidence: { collectedAt: row.retrievedAt, reportPeriod: period || null, originalIndustry, businessGuide: sector, originalReportRead: false, numericalBasis: 'aggregate-ratios-only', absoluteAmountsUsed: false, metrics: Object.fromEntries(['OPERATE_INCOME_YOY','HOLDER_PROFIT_YOY','ROE_AVG','GROSS_PROFIT_RATIO','DEBT_ASSET_RATIO'].filter(key=>typeof f?.[key]==='number'&&Number.isFinite(f[key])).map(key=>[key,{value:f[key],unit:'percent',basis:'aggregate-unverified'}])) },
  };
  await fs.writeFile(target, JSON.stringify(draft, null, 2) + '\n', { flag: replacing ? 'w' : 'wx' });
  created.push(row.code);
}
console.log(JSON.stringify({ created: created.length, preserved: skipped.length, codes: created }));
