import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {hkGuide} from './hk-full-guides.mjs';
import {simplified} from './hk-simplified.mjs';
const file='docs/full-hk-research.json',b=JSON.parse(await fs.readFile(file,'utf8')),dir='src/data/analyses';
if(b.companies.some(x=>x.market!=='HK'))throw Error('HK-only manifest required');
const clean=x=>typeof x==='string'?simplified(x.replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim()):'';
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
for(const [code,sha]of Object.entries(b.baselineExisting))if(hash(await fs.readFile(`${dir}/${code}.json`))!==sha)throw Error('Existing file changed: '+code);
const records=[];
for(const t of b.companies)if(t.readiness==='ready'){
 const r=JSON.parse(await fs.readFile(`${dir}/_raw/full-market/${t.code}.json`,'utf8')),p=simplified(r.profile),guide=hkGuide(t.code,p.INDUSTRY_TYPE,p.MAIN_BUSINESS);
 records.push({t,r,p,...guide});
}
const names=new Map();for(const f of await fs.readdir(dir))if(/^\d{5,6}\.json$/.test(f)){const a=JSON.parse(await fs.readFile(`${dir}/${f}`,'utf8'));names.set(a.code,clean(a.fullName));}
for(const x of records)names.set(x.t.code,clean(x.p.SECURITY_NAME_ABBR||x.t.name));
let created=0;
for(const {t,r,p,key,g,profile:bp}of records){
 const target=`${dir}/${t.code}.json`;try{await fs.access(target);continue;}catch(e){if(e.code!=='ENOENT')throw e;}
 const name=clean(p.SECURITY_NAME_ABBR||t.name),fullName=clean(p.ORG_NAME),industry=clean(p.INDUSTRY_TYPE),business=clean(p.MAIN_BUSINESS||p.ORG_PROFILE);
 const brief=business.replace(/^.*?(?:主要从事|主要提供|从事|专注于)/,'').replace(/该公司|本公司/g,'公司').slice(0,42);
 const quote=business.slice(0,32)+(business.length>32?'…':'');
 const peers=records.filter(x=>x.t.code!==t.code&&x.key===key&&x.p.INDUSTRY_TYPE===p.INDUSTRY_TYPE).slice(0,3);
 const peerText=peers.length?`本稿列出${peers.slice(0,2).map(x=>clean(x.p.SECURITY_NAME_ABBR||x.t.name)).join('、')}作为同类业务的比较起点，具体客户、地区和产品的重合仍需核对。`:'现有资料未找到足够可靠的同类比较对象，不为凑数加入不相关公司。';
 const summary=[
 `${fullName}（${t.code}.HK）的主营资料表述为“${quote}”。[主营] ${bp.use}理解${name}，需要先拆开公司提供的具体产品或服务、客户购买动机和实际交付责任。行业资料将其归入${industry.split('-').at(-1)}，这一分类便于检索，但不是对全部业务的完整说明。下文将已取得的公司主营线索与相应业务的一般机制分开，不把同行常见的经营安排说成本公司已经披露的具体合同。`,
 `${bp.customers}${g.model}对${name}，公司名称、品牌、渠道和最终产品并不一定处在同一价值链环节。判断业务边界，应区分自营、代销、收费服务、投资及合营企业的收益；集团业务涉及的地区或客户数量，也不能直接当成上市公司可以取得的全部收入。现有公开资料没有取得足够可靠的同口径分部收入表，因此本稿不推算产品占比、不把业务数量当作分散程度，也不将收入结构等同于利润结构。`,
 `从产品形成到客户使用，${bp.delivery}${g.drivers}这些是解释业务经济性的分析变量，是否适用于${name}的某项具体合同，仍需回到原始披露。客户首次采购与持续复购，对获客、履约、质量及后续服务的要求可能不同；一次性项目交付与可持续收费也不能混为一谈。判断公司做的是什么生意，应同时看客户得到什么、公司承担什么，以及这些责任在交付后是否继续存在。`,
 `${bp.competition}${peerText}${g.advantage}这里把优势作为需要证据支持的判断，不以市场关注度、牌照数量或一项技术名称替代竞争分析。对${name}，应比较相同使用场景里的替代产品和服务，再判断质量、价格、交付可靠性与使用成本如何影响客户选择；行业需求增长并不保证每一家参与者都能取得相同的回报。`,
 `${bp.development}${g.risk}新增产品、地区或项目还需要实际需求和交付能力支持，计划、签约意向与已兑现业务应分开。我的业务判断是，${name}要沿客户需求、产品用途、交付链条和替代关系理解；财务结果用于后续验证，而不替代对业务本身的分析。本轮未逐页核验分部原文和直接覆盖研报，不补造客户、市占率、评级或目标价；资料空白保留在核验任务中，供后续持续补充。`
 ].join('\n\n');
 const period=r.financials?.map(x=>x.REPORT_DATE?.slice(0,10)).filter(x=>x&&x<=b.asOf).sort().at(-1)||null;
 const issuer=p.ORG_WEB&&/^([a-z0-9.-]+\.[a-z]{2,})(\/.*)?$/i.test(p.ORG_WEB)?'https://'+p.ORG_WEB:null;
 const sources=[{id:'profile',label:'[主营] 公司身份与主营业务资料',url:r.urls.profile,kind:'aggregate',retrievedAt:b.asOf},{id:'finance',label:`[财务] 财务资料线索${period?' · '+period:''}`,url:r.urls.finance,kind:'aggregate',retrievedAt:b.asOf},...(issuer?[{id:'issuer',label:'公司网站',url:issuer,kind:'issuer',retrievedAt:b.asOf}]:[]),{id:'disclosures',label:'披露易原文检索（尚未定位全文）',url:'https://www1.hkexnews.hk/search/titlesearch.xhtml?lang=zh',kind:'disclosure',retrievedAt:b.asOf}];
 const a=simplified({code:t.code,fullName,industry,position:`${name}：${brief}${brief.length===42?'…':''}`,researchStatus:'draft',viewBasis:'research_hypotheses',summary,
  moat:[{point:'产品与客户关系',detail:`${g.advantage}对${name}，需要把具体产品、客户采购和持续经营结果对应起来，尚不能仅凭公司主营介绍认定已有护城河。`},{point:'交付与经营能力',detail:`${g.drivers}这些变量需要来自本公司的连续证据，不能把一般行业机制写成已核验经营事实。`},{point:'资本与现金纪律',detail:`${g.cash}业务规模只有在满足必要投入与责任后转为每股回报，才支持长期价值判断。`}],
  competitors:peers.map(x=>({name:clean(x.p.SECURITY_NAME_ABBR||x.t.name),code:x.t.code,note:`同一细分行业中的业务研究参照；先核对实际产品、客户和地区重合，不认定其与${name}的所有业务直接竞争。分部、财年及会计口径未统一前，不比较单一利润率或套用估值倍数。`})),
  bullCase:[{point:'实际需求与交付兑现',detail:`${g.drivers}若需求和单位经济改善同时形成持续交付与回款，才支持正向研究判断，不把行业增长等同本公司确定收入。`},{point:'经营能力转为回报',detail:`${g.advantage}须由复购、服务和资本回报支持，本项为研究假设，不是券商共识。`},{point:'投入与回收相匹配',detail:`${g.cash}扩张需要增量回报覆盖必要投入，而不是仅扩大项目或资产规模。`}],
  bearCase:[{point:'核心经营条件变化',detail:g.risk},{point:'资本与现金偏离',detail:`${g.cash}若利润、回款和必要投入长期不一致，需要解释资金来源及风险承担，不能用“暂时性”替代证据。`},{point:'估值超出证据支持',detail:'尚未逐项核验原始财报、分部口径与直接覆盖机构报告。业务假设失效或信息不完整，都可能使看似便宜的估值失去依据。'}],
  businessSnapshot:{summary:null,scope:null,industry,review:null,reviewDate:null,source:`公司主营资料获取${b.asOf}；未取得可用于展示的同口径收入分项，不填造比例。`,groups:[]},
  sources,verificationTasks:[`取得并阅读${period||'最新已披露期'}原始年报或中报，确认法律实体、合并范围、币种、金额单位和审计意见。`,'补齐产品、行业和地区分部收入及利润，记录页码；不把不同维度相加。',g.cash,'核对具体产品用途、客户购买与交付方式，分清公司事实和一般行业机制。',peers.length?'逐项核对候选同行的产品、客户与区域重合；行业同类不等于直接竞争。':'补充实际业务可比对象，未确认前不列虚构同行。','核验直接覆盖本公司的机构报告、日期和观点，未知评级与目标价不填零。','公告来源部分请求被拒绝，尚未准确定位原文全文；检索入口不是已阅读报告的证据。'],
  evidence:{batchId:b.id,editorialStyle:'business-product-industry-v3',language:'zh-CN',profileIdentity:{securityCode:p.SECURITY_CODE,fullName,sourceId:'profile'},businessGuide:key,reportPeriod:period,originalReportRead:false,manualReview:false,absoluteAmountsUsed:false,numericalBasis:'no-unverified-amounts',method:'逐家公司主营资料与分业务研究机制整理，未逐页核验原文；不直接使用尚未确认币种和单位的绝对金额。'},
  source:`公司主营与财务线索来自东方财富港股资料，获取${b.asOf}${period?'，财务资料期'+period:''}。本稿重点为业务、产品与行业；币种、分部及机构观点仍按任务核验，研究假设不代表机构共识。`,generatedAt:b.asOf+'T00:00:00.000Z'});
 await fs.writeFile(target,JSON.stringify(a,null,2)+'\n',{flag:'wx'});t.name=name;t.file=target;t.analysisStatus='draft';t.sha256=hash(await fs.readFile(target));created++;
}
b.created=b.companies.filter(x=>x.analysisStatus==='draft').length;b.status=b.created===b.requested?'local-drafts-awaiting-user-review':'partial-source-gaps';b.language='zh-CN';b.qualityNote='公司主营资料与分业务研究框架形成的研究稿，非逐家公司人工原文复核；绝对金额及分部占比未确认时不使用。';
await fs.writeFile(file,JSON.stringify(b,null,2)+'\n');console.log(JSON.stringify({created,total:b.created,requested:b.requested,gaps:b.requested-b.created}));
