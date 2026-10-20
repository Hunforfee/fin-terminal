import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const suffix=process.argv.includes('--batch=2')?'-2':'';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),file=path.join(root,`docs/a-research-batch-500${suffix}.json`);
const b=JSON.parse(await fs.readFile(file,'utf8')),counts={},failed=[];
for(const c of b.companies){
 const a=JSON.parse(await fs.readFile(path.join(root,c.file),'utf8'));
 const raw=JSON.parse(await fs.readFile(path.join(root,`src/data/analyses/_raw/a-batch-500${suffix}`,c.code+'.json'),'utf8'));
 c.evidenceStatus=raw.reviews.length?'collected':'prospectus-and-structured-data';c.reportCatalog=raw.reports.length;
 c.financialPeriod=a.evidence.financial.reportDate;c.businessPeriod=a.evidence.business.reportDate;
 c.pdfIdentityMatched=a.evidence.pdf.identityMatched;counts[c.industry]=(counts[c.industry]||0)+1;
 if(!c.pdfIdentityMatched)failed.push(`${c.name}（${c.code}）`);
}
b.pdfIdentityMatched=b.companies.filter(x=>x.pdfIdentityMatched).length;b.pdfManualCheckRequired=failed;b.created=b.companies.length;
await fs.writeFile(file,JSON.stringify(b,null,2)+'\n');
const md=`# A股首批500家公司核查清单\n\n日期：${b.asOf}。新增500家，不含已认可的承德露露样稿；此前已有解析保留。当前只在本地，未经新授权不推送，也不开始下一批。\n\n统一版块：业务与模式、营收构成、护城河、竞争对手对比、市场观点、公司资料。\n\n## 资料与研究状态\n\n每家保留真实主营构成、财务报告期、来源、原文链接及核对事项；按商业模式整理经营与资本回报判断。${b.pdfIdentityMatched}家的原文PDF身份与页面文本提取通过，${500-b.pdfIdentityMatched}家需要人工打开原文核对：${failed.join('、')||'无'}。**文本提取和稿件接入不等于完成逐项人工复核。** 所有本批稿保留内部draft状态，不生成机构评级或目标价。\n\n六家新上市公司采用招股说明书与结构化财务资料，缺少独立定期报告经营评述，正文及任务清单有说明。同行优先取相同细分行业；仅为业务模式或大行业参照时明确区别，不伪称直接竞争者。\n\n## 建议核查顺序\n\n先看业务是否讲对，再按文内来源核对主营报告期、金额和占比；随后核对现金与利润、资本开支、同行差异与正反情景。不要将分部总项与“其中”子项相加，不把半年ROE年化，不把金融经营现金当工业企业自由现金。\n\n## 行业分布\n\n${Object.entries(counts).map(([k,v])=>`- ${k}：${v}家`).join('\n')}\n\n## 本地逐家入口\n\n|序号|代码|公司|行业|财务期|原文身份提取|\n|---|---|---|---|---|---|\n`+b.companies.map((c,i)=>`|${i+1}|${c.code}|[${c.name}](http://127.0.0.1:3101/?learn=${c.code}&preview=a-batch-500)|${c.industry}|${c.financialPeriod}|${c.pdfIdentityMatched?'通过':'人工核对'}|`).join('\n')+'\n';
const ipo=b.companies.filter(x=>x.evidenceStatus==='prospectus-and-structured-data').length;
const reviewMd=md.replace('# A股首批500家公司核查清单',suffix?'# A股第二批500家公司核查清单':'# A股首批500家公司业务改写核查清单')
 .replace('新增500家，不含已认可的承德露露样稿；此前已有解析保留。',suffix?'新增第二批500家，排除第一批、历史解析和已认可样稿。':'已按桃李面包方向改写原500家业务正文，保留其余版块与证据。')
 .replace('也不开始下一批','本轮两批完成后不继续扩充')
 .replace('六家新上市公司采用招股说明书与结构化财务资料',`${ipo}家公司采用招股说明书与结构化财务资料`)
 .replace('每家保留真实主营构成、财务报告期、来源、原文链接及核对事项；按商业模式整理经营与资本回报判断。','每家保留主营、报告期、来源、原文与核对事项；业务正文以产品用途、客户、交付过程及行业替代关系为主线。正文结合公司数据与分商业模式框架，不表示1000家已逐项人工精修。');
await fs.writeFile(path.join(root,`docs/a-research-batch-500${suffix}.md`),reviewMd);
console.log(JSON.stringify({prepared:b.created,pdfIdentityMatched:b.pdfIdentityMatched,pdfManualCheckRequired:failed,industries:Object.keys(counts).length}));
