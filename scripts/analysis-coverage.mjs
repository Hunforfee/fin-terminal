import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalCode, inspectCoverage, isCompanyTarget } from './lib/analysis-coverage.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const today = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const check = process.argv.includes('--check'), targetPath = path.join(root,'scripts/analysis-targets.json');
let previous; try { previous = JSON.parse(await fs.readFile(targetPath,'utf8')); } catch {}
const targets = new Map((previous?.companies || []).map(item => [item.code,item]));
function add(value, origin, name, group, kind) {
  if (!isCompanyTarget(value,kind)) return;
  const code = canonicalCode(value); if (!code) return;
  const item = targets.get(code) || {code,market:code.length===5?'HK':'A',name:name || code,origins:[],groups:[]};
  if (name && item.name === code) item.name = name;
  if (!item.origins.includes(origin)) item.origins.push(origin);
  if (group && !item.groups.includes(group)) item.groups.push(group);
  targets.set(code,item);
}
const watch = JSON.parse(await fs.readFile(path.join(root,'scripts/uncovered-watchlist.json'),'utf8'));
for (const item of watch) add(item.code,'watchlist_snapshot',item.name,item.group);
let approvedBatch;
try { approvedBatch=JSON.parse(await fs.readFile(path.join(root,'docs/a-research-batch-500.json'),'utf8')); } catch (error) { if(error.code!=='ENOENT')throw error; }
for(const item of approvedBatch?.companies || []) if(item.analysisStatus==='draft') add(item.code,'approved_a_batch_500',item.name);
let secondBatch;
try { secondBatch=JSON.parse(await fs.readFile(path.join(root,'docs/a-research-batch-500-2.json'),'utf8')); } catch (error) { if(error.code!=='ENOENT')throw error; }
for(const item of secondBatch?.companies || []) if(item.analysisStatus==='draft') add(item.code,'approved_a_batch_500_2',item.name);
let fullA;
try { fullA=JSON.parse(await fs.readFile(path.join(root,'docs/full-market-research.json'),'utf8')); } catch(error){if(error.code!=='ENOENT')throw error;}
for(const item of fullA?.companies || []) if(item.market==='A') add(item.code,'approved_remaining_a',item.name);
let fullHK;
try { fullHK=JSON.parse(await fs.readFile(path.join(root,'docs/full-hk-research.json'),'utf8')); } catch(error){if(error.code!=='ENOENT')throw error;}
for(const item of fullHK?.companies || []) if(item.market==='HK') add(item.code,'approved_remaining_hk',item.name);
const universe = await fs.readFile(path.join(root,'src/lib/universe.ts'),'utf8');
const stocks = universe.slice(universe.indexOf('export const STOCKS:'),universe.indexOf('export const FUNDS:'));
for (const match of stocks.matchAll(/code:\s*['"](\d{5,6})['"],\s*name:\s*['"]([^'"]+)['"]/g)) add(match[1],'builtin_company_pool',match[2]);
for (const file of await fs.readdir(path.join(root,'src/data/analyses'))) if (/^\d{5,6}\.json$/.test(file)) {
  const code = file.slice(0,-5); let name;
  try { name = JSON.parse(await fs.readFile(path.join(root,'src/data/analyses',file),'utf8')).fullName; } catch {}
  add(code,'existing_analysis',name);
}
const inputIndex = process.argv.indexOf('--watchlist');
if (inputIndex >= 0) {
  if (!process.argv[inputIndex+1]) throw Error('Missing --watchlist JSON path');
  const data = JSON.parse(await fs.readFile(path.resolve(process.argv[inputIndex+1]),'utf8'));
  const list = Array.isArray(data) ? data : data.items || data.codes;
  if (!Array.isArray(list)) throw Error('Expected a JSON array, watchlist.items or codes');
  for (const item of list) add(typeof item === 'string' ? item : item.symbol || item.code,'watchlist_import',item.name,item.group,item.kind);
}
const companies = [...targets.values()].sort((a,b)=>a.code.localeCompare(b.code));
const entries = await inspectCoverage(root,companies,today);
const counts = Object.fromEntries(['missing','invalid','unregistered','draft','reviewed','legacy'].map(status=>[status,entries.filter(item=>item.status===status).length]));
const summary = {scope:fullHK?'approved-a-hk-directory-and-existing-companies':fullA?'approved-a-directory-and-existing-companies':'watchlist-and-builtin-companies',asOf:today,companies:entries.length,...counts};
if (!check) {
  await fs.mkdir(path.join(root,'docs'),{recursive:true});
  await fs.writeFile(targetPath,JSON.stringify({version:1,scope:summary.scope,scopeNote:'用户授权的网站A股及港股目录快照、仓库自选快照、内置公司池及已有解析；不代表交易所实时全量名册，不包含指数/基金。',companies},null,2)+'\n');
  await fs.writeFile(path.join(root,'docs/analysis-coverage.json'),JSON.stringify({version:1,summary,entries},null,2)+'\n');
  const queue = entries.filter(item=>!['legacy','reviewed'].includes(item.status));
  await fs.writeFile(path.join(root,'docs/analysis-work-queue.json'),JSON.stringify({version:1,summary,meaning:'有正文不等于已复核。按missing/invalid/unregistered/draft依次处理；不得把待复核研究稿标成已核验深度报告。',entries:queue},null,2)+'\n');
  const md = `# 公司解析覆盖清单\n\n范围：授权A股目录、自选快照、内置公司池和已有解析；港股暂停新增。日期：${today}。\n\n共 ${entries.length} 家；缺稿 ${counts.missing}，格式错误 ${counts.invalid}，未接入 ${counts.unregistered}，待复核研究稿 ${counts.draft}，已有解析 ${counts.legacy}，有复核记录 ${counts.reviewed}。**缺稿为零不代表所有内容已完成原文复核。**\n\n操作规则见 [接续说明](analysis-handoff.md)，机器清单见 [覆盖状态](analysis-coverage.json) 和 [工作队列](analysis-work-queue.json)。\n\n|代码|公司|市场|状态|\n|---|---|---|---|\n` + entries.map(item=>`|${item.code}|${item.name.replaceAll('|','/')}|${item.market}|${item.status}|`).join('\n')+'\n';
  await fs.writeFile(path.join(root,'docs/analysis-coverage.md'),md.replace('港股暂停新增','港股按最新授权新增'));
}
console.log(JSON.stringify(summary));
if (counts.missing || counts.invalid || counts.unregistered || (process.argv.includes('--require-no-drafts') && counts.draft)) process.exitCode = 1;
