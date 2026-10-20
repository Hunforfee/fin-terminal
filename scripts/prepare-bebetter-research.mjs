/** Explicit exception: no invented segment revenue for a pre-commercial innovator. */
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
const code='688759',file=`src/data/analyses/${code}.json`,r=JSON.parse(await fs.readFile(`src/data/analyses/_raw/full-market/${code}.json`,'utf8'));
const bfile='docs/full-market-research.json',b=JSON.parse(await fs.readFile(bfile,'utf8')),target=b.companies.find(x=>x.code===code);
if(!target||target.market!=='A'||b.baselineExisting[code])throw Error('Out of scope');
const report=r.reviews.find(x=>x.REPORT_DATE.startsWith('2026-06-30'));
if(!report?.BUSINESS_REVIEW.includes('尚未形成销售收入'))throw Error('Recheck commercial status');
const summary=[
 '广州必贝特医药股份有限公司（688759）开发创新药，核心业务是把药物分子从发现、临床研究、注册推进到可供患者使用的产品。公司概况将研发方向分为小分子药物与寡核苷酸偶联物；2026年中期经营评述围绕BEBT-908、BEBT-209、BEBT-109以及小核酸平台展开。[概况][主营] 这与成熟药企持续销售多种药物不同：研发资产需要逐项跨过有效性、安全性、注册和生产要求，研发投入、临床入组或获批本身都不是已实现销售。理解这家公司，首先要区分已获批产品、在研适应症与早期平台，不宜用一张收入饼图替代产品进程。',
 'BEBT-908是目前商业化衔接的关键。2026年中期经营评述称，该产品于2025年6月获批，但受托生产方原料药工艺变更后，仍需推进补充申请审评、相关检查和生产放行，报告期尚未形成销售收入。[主营] 这说明“取得上市许可”和“有合规、稳定、可交付的商品”之间仍存在环节；没有销售分项并不是可以自行估计销量或份额。早期招股资料也披露委托第三方CDMO生产的安排。[招股] 这里的研究重点是生产责任、质量衔接与实际供货能力，而非仅数获批产品数量。后续进度须以新增公告更新，不能把中期状态直接当作今天的最终状态。',
 '产品最终进入医疗使用，需要医生对治疗证据作判断，也受到医院准入、患者可及性、支付和供应条件影响。经营评述介绍了学术推广与医保准备，同时明确形式审查不等于最终纳入医保。[主营] 从一般行业机制看，进入支付目录可能扩大可及人群，也可能改变价格与净销售收入；具备临床价值也不意味着所有适用患者都会转为本公司的销售。因此，商业化分析应沿适用患者、实际供货、终端采用及结算展开，不能将潜在人群乘上假设价格当成确定收入，更不能据此作治疗推荐。',
 '在研管线与已获批用途应分开看。中期经营评述介绍了BEBT-908的联合方案研究、BEBT-209的乳腺癌相关临床研究，以及BEBT-109的肺癌相关研究；这些是当期披露的研发安排，不意味着相关适应症均已获批。[主营] 同一分子进入更多疾病或治疗线次，需要新的证据支持，也可能面对不同的标准治疗与竞争方案。小核酸平台则要同时解决候选序列、递送、有效性与安全性等问题，平台能力不能简单等同于可上市药物数量。对投资者而言，跨项目可复用的研发能力需要连续结果验证，不能由某个单项进展反推全部管线都会成功。',
 '我的业务判断是，必贝特应以产品证据、合规生产、实际采用和研发持续能力四条线理解。公司中期评述称自有产业化项目仍在建设，在满足相关要求前继续依赖受托生产；自建产能与委托生产的成本、责任和时间安排不同。[主营] 行业层面，药物之间的竞争要比较对应适应症和治疗线次、证据、给药便利与可及性，不能只按药企市值排名。现有资料未提供可用主营收入分项，本稿不制造产品占比、毛利率、目标价或机构评级。接下来需要核对中报原文、后续生产与注册公告、临床披露及实际销售，财务与融资状况则用于判断公司能否承受这一兑现过程。'
].join('\n\n');
const points=(items)=>items.map(([point,detail])=>({point,detail}));
const a={code,fullName:r.profile.ORG_NAME,industry:r.profile.EM2016,position:'创新药研发与商业化衔接；按产品证据与供货条件理解',researchStatus:'draft',viewBasis:'research_hypotheses',summary,
 moat:points([['差异化需临床证据','研发方向涉及小分子与小核酸。是否形成优势须比较对应适应症的证据、安全性与可及性，不能以技术名称认定壁垒。'],['生产质量与衔接','BEBT-908的中期供货仍受生产变更相关流程影响；稳定生产与质量执行是产品交付的条件，未据此认定已形成优势。'],['研发持续性','项目进展需要连续临床与注册结果支持。单项里程碑不等于整个研发平台已获得商业验证。']]),
 competitors:[{name:'贝达药业',code:'300558',note:'创新药研发与商业化的研究参照；需按具体药物、适应症、治疗线次和证据重新确认竞争重合，本稿不认定为全部管线的直接竞争者。'}],
 bullCase:points([['供货环节实际兑现','若相关生产和监管环节完成并形成实际交付，才可进一步研究销售；获批日期不能替代实际供货。'],['管线证据逐步加强','若试验结果支持相应用途且监管进度兑现，产品机会才逐步清晰；不预先计入确定收入。'],['研发资源形成产出','平台和团队投入需转化为可重复的候选筛选与开发成果，不能只以研发金额证明能力。']]),
 bearCase:points([['生产衔接延后','工艺变更、审评、检查或放行延后可能影响交付，中期披露的时间不确定性需持续跟踪。'],['研发不确定性','临床结果、注册和竞争变化可能改变单项资产价值；平台型投入也可能无法形成有效产品。'],['现金与估值压力','持续研发与产业化建设需要资金；低收入或无分项收入阶段不能用未兑现远期销售掩盖融资及估值风险。']]),
 businessSnapshot:{summary:null,scope:null,industry:r.profile.EM2016,review:null,reviewDate:'2026-06-30',source:'2026中期经营评述；未取得可用主营收入分项，不补造占比。',groups:[]},
 sources:[{id:'profile',label:'[概况] 公司身份与业务资料',url:r.urls.profile,kind:'aggregate',retrievedAt:b.asOf},{id:'business',label:'[主营] 2026中期经营评述',url:r.urls.business,kind:'aggregate',retrievedAt:b.asOf},{id:'finance',label:'[财务] 历史财务口径',url:r.urls.finance,kind:'aggregate',retrievedAt:b.asOf},{id:'prospectus',label:'[招股] 2025招股说明书（历史生产安排）',url:'https://static.cninfo.com.cn/finalpage/2025-10-23/1224726268.PDF',kind:'disclosure',retrievedAt:b.asOf}],
 verificationTasks:['阅读2026中报原文及其后公告，更新生产变更、审评、检查与商业放行状态。','逐项核对适应症、临床阶段、注册与医保结果；不把形式审查当作纳入。','核实是否已形成销售、收入构成、销售成本及实际回款；未披露不补零或比例。','按具体药物和治疗线次确认竞争对象，补充直接覆盖券商报告。','核对现金储备、研发承诺、建设投入和融资安排。'],
 evidence:{batchId:b.id,profileIdentity:{securityCode:code,fullName:r.profile.ORG_NAME,sourceId:'profile'},business:{sourceId:'business',reportDate:'2026-06-30',dimension:'未取得收入分项',items:[],reviewDate:'2026-06-30'},editorialStyle:'business-product-industry-v3',manualReview:false,originalReportRead:false,method:'无收入分项的单独业务研究稿；当期业务事实据F10经营评述，历史生产安排据招股资料检索，尚未逐页人工核验。'},
 source:'资料截至2026-10-20；主要依据公司2026中期经营评述的F10聚合展示，历史生产安排另参2025招股资料。无可用主营收入分项，机构观点未核验。',generatedAt:b.asOf+'T00:00:00.000Z'};
await fs.writeFile(file,JSON.stringify(a,null,2)+'\n',{flag:'wx'});
target.readiness='ready-special-case';target.gaps=[];target.specialCase='无可用收入分项，单独解释研发与商业化，不填造比例';target.analysisStatus='draft';target.file=file;target.sha256=crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
b.created=b.companies.filter(x=>x.analysisStatus==='draft').length;
await fs.writeFile(bfile,JSON.stringify(b,null,2)+'\n');
