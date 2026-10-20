/** Create evidence-linked working analyses. Never overwrite existing analyses or claim manual review. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {aGuide} from './a-research-guides.mjs';
const suffix=process.argv.includes('--batch=2')?'-2':'';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),dir=path.join(root,'src/data/analyses'),rawDir=path.join(dir,`_raw/a-batch-500${suffix}`);
const file=path.join(root,`docs/a-research-batch-500${suffix}.json`),batch=JSON.parse(await fs.readFile(file,'utf8')),today=batch.asOf;
const records=await Promise.all(batch.companies.map(async t=>({...JSON.parse(await fs.readFile(path.join(rawDir,t.code+'.json'),'utf8')),target:t})));
const clean=x=>typeof x==='string'?x.replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim():'';
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const money=x=>finite(x)?`${(x/1e8).toFixed(2)}亿元`:'未取得';
const pct=x=>finite(x)?`${x.toFixed(2)}%`:'未取得';
const day=x=>typeof x==='string'?x.slice(0,10):null;
const safeName=x=>clean(x).replace(/\s+/g,'');
const financialKeys=new Set(['bank','life','pnc','insurance','broker','otherFinance','amc']);
function groupsOf(r){
 const date=r.segments.map(x=>day(x.REPORT_DATE)).filter(x=>x&&x<=today).sort().at(-1);
 return ['2','1','3'].map(type=>{
  const seen=new Set();const items=r.segments.filter(x=>day(x.REPORT_DATE)===date&&String(x.MAINOP_TYPE)===type&&!/^(?:合计|总计|小计|营业收入|营业总收入)$/.test(clean(x.ITEM_NAME))).filter(x=>{const n=clean(x.ITEM_NAME);if(seen.has(n))return false;seen.add(n);return true;}).sort((a,b)=>(b.MAIN_BUSINESS_INCOME??-Infinity)-(a.MAIN_BUSINESS_INCOME??-Infinity));
  return {label:({'1':'按行业','2':'按产品','3':'按地区'})[type],date,items:items.map(x=>({name:clean(x.ITEM_NAME),income:finite(x.MAIN_BUSINESS_INCOME)?x.MAIN_BUSINESS_INCOME:null,incomeRatio:finite(x.MBI_RATIO)?x.MBI_RATIO:null,profitRatio:finite(x.MBR_RATIO)?x.MBR_RATIO:null,grossMargin:financialKeys.has(aGuide(r.profile.EM2016).key)?null:finite(x.GROSS_RPOFIT_RATIO)?x.GROSS_RPOFIT_RATIO:null}))};
 }).filter(g=>g.items.length);
}
for(const r of records){
 if(!r.profile?.ORG_NAME||r.profile.SECURITY_CODE!==r.code||!r.financials.length||!r.segments.length)throw Error('Evidence incomplete: '+r.code);
 r.guide=aGuide(r.profile.EM2016);r.groups=groupsOf(r);r.main=r.groups.find(x=>x.label==='按产品')||r.groups.find(x=>x.label==='按行业')||r.groups[0];
 r.latest=r.financials.filter(x=>x.CURRENCY==='CNY').sort((a,b)=>b.REPORT_DATE.localeCompare(a.REPORT_DATE))[0];
 if(!r.latest)throw Error('No confirmed CNY financials: '+r.code);
}
const created=[],skipped=[];
for(const r of records){
 const target=path.join(dir,r.code+'.json');let replace=false;
 try{
  const raw=await fs.readFile(target),old=JSON.parse(raw);
  if(!process.argv.includes('--refresh-generated')){skipped.push(r.code);continue;}
  if(old.evidence?.batchId!==batch.id||old.researchStatus!=='draft'||old.evidence?.manualReview||crypto.createHash('sha256').update(raw).digest('hex')!==r.target.sha256)throw Error('Refuse to overwrite changed/reviewed analysis: '+r.code);
  replace=true;
 }catch(e){if(e.code!=='ENOENT')throw e;}
 const {guide:g,latest:f}=r,name=safeName(r.profile.SECURITY_NAME_ABBR||r.target.name),period=day(f.REPORT_DATE),isFinancial=financialKeys.has(g.key);
 let pdf;try{pdf=JSON.parse(await fs.readFile(path.join(rawDir,r.code+'.pdf-evidence.json'),'utf8'));}catch{}
 const main=r.main.items.filter(x=>!/(其他|抵销|内部)/.test(x.name)&&!/^其中[:：]?/.test(x.name)),top=main[0]||r.main.items[0],second=main[1];
 const topText=r.main.items.filter(x=>!/^其中[:：]?/.test(x.name)).slice(0,3).map(x=>`${x.name}${finite(x.income)?`：${money(x.income)}`:''}${finite(x.incomeRatio)?`、占比${pct(x.incomeRatio*100)}`:''}`).join('；');
 const concentration=finite(top?.incomeRatio)?top.incomeRatio>=0.7?`其中${top.name}占比较高，判断公司价值时应先检验这项业务能否维持需求、价格和回款，不能以其他业务数量掩盖集中度风险。`:top.incomeRatio<0.35?`主要项目收入分布较分散，需要分别核对各业务的利润、资本占用和关联交易，不能仅用集团总收入判断经营质量。`:`${top.name}是重要收入来源，但收入权重不能直接当成利润权重，仍需拆分毛利、费用和资金占用。`:'本期资料没有足够占比支持集中度结论，暂不自行补齐为百分之百。';
 const productMargin=!isFinancial&&finite(top?.grossMargin)?`${top.name}披露毛利率${pct(top.grossMargin*100)}${second&&finite(second.grossMargin)?`，${second.name}为${pct(second.grossMargin*100)}`:''}；毛利还未扣除销售、管理、研发及融资成本。`:isFinancial?'金融业务的分部收益不能按工业产品毛利率解释，应回到利差、手续费、信用成本及资本占用。':'未取得足够可靠的分部毛利口径，不据收入排名推断利润贡献。';
 const latestReview=r.reviews.sort((a,b)=>b.REPORT_DATE.localeCompare(a.REPORT_DATE))[0];
 const reviewText=clean(latestReview?.BUSINESS_REVIEW||'');
 const marker=reviewText.search(/(?:公司|本公司)(?:主要从事|主营业务|从事的主要业务|是一家|是以|专注于)/);
 let excerpt=marker>=0?reviewText.slice(marker,marker+220).split(/[。！？]/)[0]:'';
 if(excerpt.length<20||excerpt.length>180||/全球领先|行业第一|国内第一|龙头|首位/.test(excerpt))excerpt='';
 const annual=r.financials.find(x=>x.REPORT_DATE.startsWith('2025-12-31'));
 const comparable=r.financials.find(x=>day(x.REPORT_DATE)===`${Number(period.slice(0,4))-1}${period.slice(4)}`);
 const coreRatio=finite(f.PARENTNETPROFIT)&&f.PARENTNETPROFIT>0&&finite(f.KCFJCXSYJLR)?f.KCFJCXSYJLR/f.PARENTNETPROFIT:null;
 const earnings=coreRatio!==null?coreRatio<0.7?`扣非利润约为归母利润的${pct(coreRatio*100)}，应检查处置、补贴、公允价值等非经常项目的金额与可持续性，不应直接用报表净利润估计常态收益。`:coreRatio>1.1?`扣非利润高于归母利润，应核对非经常性损益中拖累项目的性质；排除一次性损失也不代表核心业务风险已经消失。`:`扣非与归母利润接近，说明仅从这一对照看非经常项目影响相对有限，但收入确认、减值、费用资本化和回款仍需独立检查。`:`当前利润口径不适合用扣非占比解释，尤其在亏损时，亏损减少不能表述成持续创造了股东现金。`;
 const growth=finite(f.TOTALOPERATEREVETZ)&&finite(f.PARENTNETPROFITTZ)?f.TOTALOPERATEREVETZ>0&&f.PARENTNETPROFITTZ<0?'收入增长而归母利润下降，下一步要定位产品价差、费用、减值或会计范围的变化，规模扩张并未同步带来利润。':f.TOTALOPERATEREVETZ<0&&f.PARENTNETPROFITTZ>0?'收入下降而归母利润改善，需判断来自结构与成本改善还是一次性因素，不能把利润恢复等同需求恢复。':f.TOTALOPERATEREVETZ>0&&f.PARENTNETPROFITTZ>0?'收入和利润方向均有增长，但还要分清销量、价格、结构与低基数，不能仅凭同比作长期外推。':'收入与利润承压时，应先看业务是否仍有现金和资本韧性，再讨论反转弹性，不把低估值直接当成安全边际。':'同比指标不足，暂不作增长趋势结论。';
 const cash=isFinancial?`${g.cash} ${finite(f.ROEJQ)?`同期加权净资产收益率为${pct(f.ROEJQ)}，属于本报告期间值，不直接年化。`:''} 普通企业的经营现金与净利润比值不适用于这类金融资产负债表，不能据经营现金正负认定盈利质量。`:`同期合并经营现金流净额${money(f.NETCASH_OPERATE_PK)}。${finite(f.NETCASH_OPERATE_PK)&&f.NETCASH_OPERATE_PK<0&&f.PARENTNETPROFIT>0?'经营现金净流出与归母盈利方向相反，需要沿收款、采购、存货、合同资产及税费逐项调节；不能尚未核对就归因于季节性。':finite(f.NETCASH_OPERATE_PK)&&f.NETCASH_OPERATE_PK>0&&f.PARENTNETPROFIT<0?'经营现金为正而归母利润为负，需要排查减值、折旧和营运资本释放；卖库存或延迟付款带来的现金不一定可持续。':'经营现金是利润对照线索，但包含营运资本变化，不能直接当自由现金流。'} 合并现金与归母利润范围不同，还需注意少数股东权益。${g.cash}`;
 const yearText=annual?`完整年度参照为2025年：收入${money(annual.TOTALOPERATEREVE)}、归母利润${money(annual.PARENTNETPROFIT)}${!isFinancial?`、经营现金${money(annual.NETCASH_OPERATE_PK)}`:''}；与本期分别列示，不能把全年和半年直接作增减比较。`:'尚未取得可用的完整2025年度口径，不将零散期间拼成年报。';
 const financialParagraph=`截至${period}，聚合财务表列示收入${money(f.TOTALOPERATEREVE)}${finite(f.TOTALOPERATEREVETZ)?`，同比${pct(f.TOTALOPERATEREVETZ)}`:''}；归母利润${money(f.PARENTNETPROFIT)}${finite(f.PARENTNETPROFITTZ)?`，同比${pct(f.PARENTNETPROFITTZ)}`:''}；扣非归母利润${money(f.KCFJCXSYJLR)}。[财务] ${growth}${earnings}${yearText}`;
 const segmentParagraph=`${r.main.date}的${r.main.label}口径中，${topText}。[主营] ${concentration}${productMargin}这些分部来自同一报告期、同一维度，不将产品、行业和地区收入相加；收入占比不等于归母利润占比。分析${name}时，应把${top?.name||'核心业务'}的${g.key==='bank'?'风险调整后收益与资本要求':'售价、交付与实际回款'}作为主线，再判断${second?.name||'其他业务'}能否在增加资金投入后带来增量回报。`;
 const summaries=[
 `${r.profile.ORG_NAME}（${r.code}）的核心研究对象是${top?.name||r.profile.EM2016.split('-').at(-1)}等业务，行业资料归入${r.profile.EM2016}。[概况][主营] ${excerpt?`管理层经营评述提到：“${excerpt}”。[主营] `:''}${g.model}对${name}，应沿客户为什么购买、公司承担什么交付责任、如何收费、承担哪些成本和资金风险逐层理解，而不只看行业标签或营业规模。经营范围列出某项业务不等于它已贡献收入，技术、产能与项目计划也不等于实际商业化。`,
 segmentParagraph,
 financialParagraph,
 `${cash}${finite(f.ZCFZL)&&!isFinancial?`报告期资产负债率为${pct(f.ZCFZL)}，仍须区分有息债务、经营负债、受限资金与到期结构，不能只凭总比例判断偿债安全。`:''}[财务] 当前证据用于定位问题，后续应结合原文附注完成现金与利润、投入与回报的调节，不能把数据收录当作已完成逐项核验。`,
 `研究判断：${g.drivers}${g.advantage}对${name}，正向情景要同时看到${top?.name||'主业'}需求兑现、经济性改善和资本纪律，而非只满足收入增长；反向情景则检查核心条件失效时的利润、现金和融资承受能力。${g.risk}估值先以成熟业务跨周期的可持续回报建立基准，再为新产品、新地区或新项目设置单独兑现条件。尚未取得并核验本公司直接覆盖券商报告，因此市场观点下列出的是研究情景，不提供虚构评级、目标价或机构共识。`
 ];
 const peers=records.filter(x=>x.code!==r.code&&x.profile.EM2016===r.profile.EM2016);
 const modelPeers=records.filter(x=>x.code!==r.code&&x.guide.key===g.key);
 const pool=peers.length?peers:modelPeers.length?modelPeers:records.filter(x=>x.code!==r.code&&x.target.industry===r.target.industry);
 const competitors=pool.slice(0,3).map(p=>{
  const pf=p.latest,same=day(pf.REPORT_DATE)===period;
  return {name:safeName(p.profile.SECURITY_NAME_ABBR),code:p.code,note:`${peers.length?'同一细分行业的候选比较对象':modelPeers.length?'同类商业模式的研究参照，不认定为直接竞争者':'同一大行业的差异对照，业务模式不同，不认定为直接竞争者'}；资料中的主要收入项目为${p.main.items.slice(0,2).map(x=>x.name).join('、')}，与${name}的${top?.name||'主营'}应先核对产品和客户重合。${same&&finite(pf.ROEJQ)&&finite(f.ROEJQ)?`${period}期间加权ROE分别为${pct(pf.ROEJQ)}与${pct(f.ROEJQ)}，均不年化；利润范围、杠杆和一次性因素不同，不能仅据这一差异判定谁更优。`:'报告期与业务组合不同，不直接套用利润率或估值倍数。'}比较重点是${g.key==='bank'?'负债成本、信用损失与资本消耗':'单位经济、回款和增量资本回报'}，而非只比收入规模。`};
 });
 if(!competitors.length)throw Error('No supportable peer comparison: '+r.code);
 const sources=[
  {id:'profile',label:'[概况] 公司身份与业务资料',url:r.urls.profile,kind:'aggregate',retrievedAt:today},
  {id:'business',label:`[主营] ${r.main.date}业务构成与经营评述`,url:r.urls.business,kind:'aggregate',retrievedAt:today},
  {id:'finance',label:`[财务] ${period}及历史财务指标`,url:r.urls.finance,kind:'aggregate',retrievedAt:today},
  ...r.reports.slice(0,2).map((x,i)=>({id:'report'+i,label:`[原文] ${x.title} · ${x.publishedAt}`,url:x.pdfUrl,kind:'disclosure',retrievedAt:today}))
 ];
 const tasks=[`结合${period}原始披露逐项核对财务口径、会计变更、合并范围及关键附注。`,isFinancial?'补齐资本监管、资产质量、负债期限及股东分红约束，不使用工业企业自由现金流判断。':'完成经营现金与利润的调节，区分营运资本释放、维护投入和扩张投入。',`核对${top?.name||'核心业务'}的经营量、单价、客户需求与资本占用，解释分部与集团利润差异。`,'核实同行之间实际产品、客户与市场重合；研究参照不等于已核验直接竞争关系。','核验直接覆盖的券商报告、日期与观点；未取得不代表不存在覆盖，不自动统计评级或目标价。'];
 if(!r.reviews.length)tasks.unshift('新上市公司未取得独立定期报告经营评述，先阅读招股说明书和上市后新增披露，不能把招股历史数据视为最新经营结论。');
 if(!pdf?.identityMatched)tasks.unshift('原文PDF身份或文本提取未通过自动检查，需人工打开源文件核实；正文数值以标注的聚合来源为依据。');
 const analysis={code:r.code,fullName:r.profile.ORG_NAME,industry:r.profile.EM2016,position:`${name}：以${top?.name||r.profile.EM2016.split('-').at(-1)}为主线，核对需求、盈利质量与资本回报`,researchStatus:'draft',viewBasis:'research_hypotheses',summary:summaries.join('\n\n'),
  moat:[{point:'核心业务的经济性',detail:`${top?.name||'主业'}是研究重点。${concentration}${g.advantage}`},{point:'经营能力的验证',detail:`${productMargin}${g.drivers}应以持续客户行为与跨周期回报验证，不能把当期高利润直接认定为永久壁垒。`},{point:'资金与资本纪律',detail:`${g.cash}优势要最终体现在扣除必要投入后的股东回报，而不是单纯扩大资产或项目规模。`}],
  competitors,bullCase:[{point:'主业改善有现金支持',detail:`若${top?.name||'主业'}的需求和单位经济改善同时转化为现金，而非只表现为应收或存货扩张，才支持更可持续的正向判断。${growth}`},{point:'优势转为持续回报',detail:`${g.advantage}需要连续报告期证据支持，不能仅凭管理层愿景或同业估值。`},{point:'增量投入形成价值',detail:`${g.drivers}新业务或项目应以增量回报覆盖资本成本为条件，不预先把规划规模或技术指标计为确定利润。`}],
  bearCase:[{point:'关键经营变量失效',detail:g.risk},{point:'利润现金或资本偏离',detail:isFinancial?g.cash:`本期经营现金${money(f.NETCASH_OPERATE_PK)}只是核对起点。若盈利长期缺少现金支持，需检查收入确认、减值、资金占用与必要投入，不用“暂时性”代替证据。`},{point:'估值与证据不匹配',detail:`对${name}不宜仅用当前利润或行业平均倍数估值。${earnings}原文核对、直接竞争关系和机构观点仍按资料任务继续完善。`}],
  businessSnapshot:{summary:null,scope:null,industry:r.profile.EM2016,review:null,reviewDate:null,source:`东方财富F10公开资料快照 · ${today}；构成期${r.main.date}`,groups:r.groups.map(x=>({...x,items:x.items.slice(0,8)}))},sources,verificationTasks:tasks,
  evidence:{batchId:batch.id,retrievedAt:today,originalReportRead:false,manualReview:false,method:'公开F10财务与主营证据＋分商业模式研究框架；PDF仅作身份及页面文本提取，不等于逐页人工审阅。',profileIdentity:{securityCode:r.profile.SECURITY_CODE,fullName:r.profile.ORG_NAME,sourceId:'profile'},financial:{sourceId:'finance',currency:f.CURRENCY,reportDate:period,noticeDate:day(f.NOTICE_DATE),updateDate:day(f.UPDATE_DATE),values:Object.fromEntries(['TOTALOPERATEREVE','TOTALOPERATEREVETZ','PARENTNETPROFIT','PARENTNETPROFITTZ','KCFJCXSYJLR','NETCASH_OPERATE_PK','ROEJQ','ZCFZL'].map(k=>[k,finite(f[k])?f[k]:null]))},business:{sourceId:'business',reportDate:r.main.date,dimension:r.main.label,items:r.main.items,reviewDate:day(latestReview?.REPORT_DATE)},pdf:{identityMatched:!!pdf?.identityMatched,extractedOnly:true,source:pdf?.source||null,sha256:pdf?.sha256||null,pageCount:pdf?.pageCount||null,extractedPages:pdf?.pages?.map(p=>p.pdfPage)||[],error:pdf?.error||(!pdf?'not extracted':null)},comparison:{annualPeriod:annual?day(annual.REPORT_DATE):null,samePeriodPriorYear:comparable?day(comparable.REPORT_DATE):null}},
  source:`资料获取${today}；公司、主营与财务来自东方财富公开F10，原文链接列于来源。财务截至${period}、主营截至${r.main.date}，金额为合并口径人民币亿元，归母与合并现金范围不同。机构观点未核验，正向情景为研究判断。`,generatedAt:today+'T00:00:00.000Z'};
 await fs.writeFile(target,JSON.stringify(analysis,null,2)+'\n',{flag:replace?'w':'wx'});created.push(r.code);
 r.target.analysisStatus='draft';r.target.file=`src/data/analyses/${r.code}.json`;r.target.sha256=crypto.createHash('sha256').update(await fs.readFile(target)).digest('hex');r.target.pdfIdentityMatched=!!pdf?.identityMatched;
}
batch.created=batch.companies.filter(x=>x.analysisStatus==='draft').length;batch.existingSkipped=skipped;batch.status='local-drafts-awaiting-user-review';batch.sectionTitles=['业务与模式','营收构成','护城河','竞争对手对比','市场观点','公司资料'];batch.qualityNote='逐家采集真实主营及财务数据，使用分商业模式的研究框架整理；属于可继续核实的资料研究稿，不表示500份逐页人工复核报告。';
await fs.writeFile(file,JSON.stringify(batch,null,2)+'\n');console.log(JSON.stringify({created:created.length,skipped:skipped.length}));
