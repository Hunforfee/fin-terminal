import {aGuide} from './a-research-guides.mjs';
import {businessProfile} from './business-first-profiles.mjs';
const clean=x=>typeof x==='string'?x.replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim():'';
const date=x=>typeof x==='string'?x.slice(0,10):'';
const pct=x=>`${(x*100).toFixed(2)}%`;
export function businessFirstSummary(raw,analysis){
 const industry=raw.profile.EM2016,g=aGuide(industry),p=businessProfile(g.key,industry);
 const name=clean(raw.profile.SECURITY_NAME_ABBR||raw.name||raw.target?.name).replace(/\s+/g,'').replace(/^(XD|DR|XR)/,'');
 const main=analysis.evidence.business,eligible=main.items.filter(x=>!/^其中[:：]?/.test(x.name)&&!/(抵销|抵消|内部)/.test(x.name));
 const primary=eligible.filter(x=>!/(^其他|补充)/.test(x.name)),items=primary.length?primary:eligible;
 const top=items[0],second=items[1],names=items.slice(0,3).map(x=>x.name),products=names.join('、')||industry.split('-').at(-1);
 const mix=items.slice(0,3).map(x=>`${x.name}${typeof x.incomeRatio==='number'?`占收入${pct(x.incomeRatio)}`:''}`).join('；');
 const review=clean((raw.reviews||[]).sort((a,b)=>b.REPORT_DATE.localeCompare(a.REPORT_DATE))[0]?.BUSINESS_REVIEW||'');
 const profile=clean(raw.profile.ORG_PROFILE),material=review+' '+profile;
 const pattern=/(?:公司|本公司|本集团)(?:主要从事|主营业务为|主营业务包括|主要产品包括|从事的主要业务包括|业务主要包括|拥有|专注于|主要生产|主要提供|的主营业务是|的主要产品有)[^。；;]{8,}/g;
 const statement=[...material.matchAll(pattern)].map(x=>x[0]).find(x=>!(/第一|最大|领先|龙头|首家|首位/.test(x.slice(0,50))));
 const positioning=statement?`经营资料中的业务表述为“${statement.slice(0,30)}${statement.length>30?'…':''}”。[主营] `:'';
 const deliveryClues=[['经销','经销'],['直销','直销'],['直营','直营'],['OEM','OEM'],['ODM','ODM'],['订阅','订阅服务'],['租赁','租赁'],['验收','验收交付']].filter(([needle])=>review.includes(needle)).map(([,label])=>label).slice(0,2);
 const topics=[['新产品','新产品'],['新品','新品'],['研发','研发'],['新材料','材料升级'],['客户认证','客户认证'],['渠道','渠道拓展'],['数字化','数字化'],['海外','海外市场'],['智能','智能化'],['技术改造','技术改造']].filter(([needle])=>review.includes(needle));
 const unique=[...new Set(topics.map(x=>x[1]))].slice(0,2);
 const mixAnalysis=typeof top?.incomeRatio==='number'?top.incomeRatio>=0.7?`${top.name}在收入中占比较高，因此公司发展首先取决于这项业务的实际需求与供给能力，其他业务存在并不代表已经形成了同等重要的第二增长来源。`:top.incomeRatio<0.35?`产品或服务分布相对分散，各项业务的需求、履约和客户关系可能不同，不能将公司解释为只卖一种产品。`:`${top.name}是重要业务${second?`，${second.name}也有独立的收入权重`:''}；产品之间可能服务不同场景，收入结构变化不必然意味着终端需求整体增长。`:'现有分项没有足够占比支持集中度结论，不自行把未列明项目补成完整结构。';
 const peers=(analysis.competitors||[]).slice(0,2),peerText=peers.length?`已列的${peers.map(x=>x.name).join('、')}用于后续竞争对比，是否直接竞争仍取决于实际产品、客户和市场的重合，而不是上市行业名称相近。`:'';
 const financial=['bank','insurance','life','pnc','broker','otherFinance','amc'].includes(g.key);
 const context=financial?'服务量和资金规模不是普通商品销量，客户资产、承保或融资余额也不能相互等同。':'产能、意向订单和实际交付处于不同阶段，只有客户采用并完成相应交付，供给能力才转为经营活动。';
 const parts=[
 `${raw.profile.ORG_NAME}（${raw.code}）的主营资料包括${products}，所属细分行业为${industry.split('-').at(-1)}。[概况][主营] ${positioning}${p.use}这些产品或服务通过具体的功能、规格和使用场景满足客户需求，公司由此获得采购或服务订单。不同产品承担的使用任务、交付要求和购买频次可能不同，不能仅因归在同一份报表中，就把它们视为完全相同的一门生意。以下将公司已披露的主营事实与所属行业的一般业务机制结合分析，具体客户和合同以原始披露为边界。`,
 `${main.reportDate}的${main.dimension}资料中，${mix||products}。[主营] ${mixAnalysis}${g.key==='holding'?'集团内各业务首先是不同的经营单元，不能仅凭一起合并报表就假定存在协同。':`${p.customers}`}对${name}而言，${top?.name||'核心业务'}与${second?.name||'其他产品或服务'}的比较，关键在于客户需要的功能、交付方式和重复购买原因，而不是只比较名称或品类数量。这里的收入占比不是利润占比，也不把同一维度中的总项与“其中”子项重复相加。`,
 `从交付过程看，${p.delivery}${g.model}${deliveryClues.length?`本期经营评述出现${deliveryClues.join('、')}相关表述。[主营] 不同交易安排会改变谁负责获客、库存、交付和持续服务，不能据一种模式推断全部业务。`:''}对${name}，产品必须同时满足实际使用要求和可执行的交付条件。${context}客户第一次采购，与形成稳定重复采购，往往又对应不同的销售、服务和配套工作。`,
 `行业竞争需要放在客户的可选方案里理解。${p.competition}${peerText}${g.drivers}这些因素通过实际产品和服务改变客户选择，而不是仅在报表中体现为某个增长率。${name}能否获得持续需求，取决于${top?.name||'核心业务'}相对替代方案的使用价值、交付可靠性与客户承担的总成本。产品进入新应用，不代表所有应用都已经贡献收入；较高的行业关注度，也不等同于本公司已经取得份额。`,
 `${unique.length?`本期经营评述涉及${unique.join('和')}等内容。[主营] `:'现有资料未提供足以单独确认新增长方向的经营评述，不把行业热点直接归入本公司。'}${p.development}对${name}，既有业务的复购与新增场景需要分别理解：前者反映现有产品持续解决客户问题的能力，后者还涉及需求验证、交付调整和业务边界扩展。${g.key==='bank'?'银行新增客户与贷款，要同时放在服务关系和信用风险中看，而不是单看放款规模。':financial?'金融业务的新产品还会改变风险承担与服务责任，不能用销售扩张替代经营质量判断。':`若新增产品只是替代了原有${top?.name||'主业'}的购买，不能全部算作新增市场；若进入新的地区或客户场景，则原有产品与服务体系能否适配，才决定增长能否持续。`}我的业务判断是，${name}应围绕核心产品解决的具体需求、交付链条和行业替代关系理解，财务表现用于后续验证，而不替代对产品和行业本身的分析。`
 ];
 return parts.join('\n\n');
}
