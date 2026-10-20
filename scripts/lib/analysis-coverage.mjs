import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
export function canonicalCode(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  const hk = s.match(/^(?:hk)?(\d{1,5})(?:\.hk)?$/i);
  if (hk) return Number(hk[1]) > 0 && Number(hk[1]) < 80000 ? hk[1].padStart(5,'0') : null;
  const a = s.match(/^(?:sh|sz|bj)?(\d{6})(?:\.(?:sh|sz|bj))?$/i);
  return a && Number(a[1]) > 0 ? a[1] : null;
}
export function registeredCodes(index) { return new Set([...index.matchAll(/['"]([0-9]{5,6})['"]\s*:/g)].map(match => match[1])); }
export function isCompanyTarget(value, kind) {
  if (['index','fund','etf'].includes(String(kind || '').toLowerCase())) return false;
  const code = canonicalCode(value); if (!code) return false;
  const input = value.toLowerCase();
  if (code.length === 6 && (/^(5|15|16|18|399|899)/.test(code) || /^sh0\d{5}$/.test(input) || /^0\d{5}\.sh$/.test(input))) return false;
  return true;
}
export function validateAnalysis(data, code, today) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['解析必须是对象'];
  if (data.code !== code) errors.push('文件名与code不一致');
  for (const field of ['fullName','industry','position','summary','source','generatedAt']) if (typeof data[field] !== 'string' || !data[field].trim()) errors.push(`缺少${field}`);
  const date = typeof data.generatedAt === 'string' ? data.generatedAt.slice(0,10) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date || date > today) errors.push('生成日期无效或在未来');
  if (typeof data.summary === 'string' && data.summary.split(/\n\s*\n/).filter(Boolean).length < 3) errors.push('业务正文不足三个段落');
  for (const field of ['moat','bullCase','bearCase']) {
    if (!Array.isArray(data[field]) || data[field].length < 3 || data[field].some(item => !item || typeof item.point !== 'string' || !item.point.trim() || typeof item.detail !== 'string' || !item.detail.trim())) errors.push(`${field}需至少三个有效要点`);
  }
  if (!Array.isArray(data.competitors) || data.competitors.some(item => !item || typeof item.name !== 'string' || !item.name.trim() || typeof item.note !== 'string' || !item.note.trim())) errors.push('同行条目无效');
  if (data.ratingSummary && ['buy','hold','sell'].some(key => !Number.isInteger(data.ratingSummary[key]) || data.ratingSummary[key] < 0)) errors.push('评级统计无效');
  if (data.targetPriceRange && (![data.targetPriceRange.min,data.targetPriceRange.max].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0) || data.targetPriceRange.min > data.targetPriceRange.max)) errors.push('目标价范围无效');
  if (data.researchStatus && !['draft','reviewed'].includes(data.researchStatus)) errors.push('研究状态无效');
  if (data.researchStatus === 'draft') {
    if (data.viewBasis !== 'research_hypotheses') errors.push('研究稿必须区分假设与机构观点');
    if (!Array.isArray(data.verificationTasks) || !data.verificationTasks.length) errors.push('研究稿必须提供待核验事项');
    if (data.ratingSummary || data.targetPriceRange) errors.push('未核验研究稿不得虚构机构评级或目标价');
    if (!Array.isArray(data.sources) || data.sources.length < 2) errors.push('研究稿必须提供来源');
  }
  if (data.sources) for (const source of data.sources) {
    try { const u = new URL(source.url); if (!/^https?:$/.test(u.protocol) || !source.label || !['issuer','disclosure','aggregate'].includes(source.kind)) throw Error(); }
    catch { errors.push('来源链接无效'); }
  }
  if (data.researchStatus === 'reviewed' && (!data.evidence?.originalReportRead || !data.reviewedAt || !data.reviewedBy)) errors.push('复核完成状态必须有原文阅读及复核记录');
  return errors;
}
export async function inspectCoverage(root, targets, today) {
  const index = await fs.readFile(path.join(root,'src/data/analyses/index.ts'),'utf8');
  const registered = registeredCodes(index), entries = [];
  for (const target of targets) {
    const code = target.code, file = `src/data/analyses/${code}.json`;
    let raw, data, errors = [];
    try { raw = await fs.readFile(path.join(root,file),'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (raw) try { data = JSON.parse(raw); errors = validateAnalysis(data,code,today); } catch { errors = ['JSON无法解析']; }
    const status = !raw ? 'missing' : errors.length ? 'invalid' : !registered.has(code) ? 'unregistered' : data.researchStatus === 'draft' ? 'draft' : data.researchStatus === 'reviewed' ? 'reviewed' : 'legacy';
    entries.push({ ...target, file, registered: registered.has(code), status, ...(raw ? { sha256: crypto.createHash('sha256').update(raw).digest('hex') } : {}), ...(data?.generatedAt ? { contentDate: data.generatedAt } : {}), ...(errors.length ? { errors } : {}), ...(data?.verificationTasks?.length ? { tasks: data.verificationTasks } : {}) });
  }
  return entries;
}
