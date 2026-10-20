/**
 * 校验 src/data/analyses/ 下所有分析 JSON 的结构合法性。
 * 用法：node scripts/validate-analyses.mjs [code1 code2 ...]
 * 不传代码则校验全部。退出码非 0 表示存在错误。
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'analyses');
const REQUIRED = ['code', 'fullName', 'industry', 'position', 'summary', 'moat', 'competitors', 'bullCase', 'bearCase', 'source', 'generatedAt'];
const LIST_MIN = { moat: 3, competitors: 3, bullCase: 3, bearCase: 3 };

const targets = process.argv.slice(2);
let files = [];
for (const f of await readdir(DIR)) {
  if (!f.endsWith('.json') || f.startsWith('_')) continue;
  files.push(basename(f, '.json'));
}
if (targets.length) files = files.filter((c) => targets.includes(c));
files.sort();

const errors = [];
const warned = [];
for (const code of files) {
  const path = join(DIR, `${code}.json`);
  let d;
  try {
    d = JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    errors.push(`${code}: JSON 解析失败 - ${e.message}`);
    continue;
  }
  const where = [];
  for (const k of REQUIRED) if (!(k in d) || d[k] === null || d[k] === '') where.push(`缺字段 ${k}`);
  if (d.code !== code) where.push(`code 不匹配(${d.code})`);
  if (typeof d.summary === 'string') {
    const paras = d.summary.split('\n\n').filter(Boolean);
    if (paras.length < 3) where.push(`summary 仅 ${paras.length} 段(至少3段)`);
    if (paras.length !== 5) warned.push(`${code}: summary ${paras.length} 段(常规5段)`);
    if (d.summary.length < 900) warned.push(`${code}: summary 仅 ${d.summary.length} 字`);
  } else where.push('summary 非字符串');
  for (const [k, min] of Object.entries(LIST_MIN)) {
    if (!Array.isArray(d[k])) { where.push(`${k} 非数组`); continue; }
    if (d[k].length < min) where.push(`${k} 仅 ${d[k].length} 条(应≥${min})`);
    d[k].forEach((it, i) => {
      if (!it || typeof it !== 'object') where.push(`${k}[${i}] 非对象`);
      else for (const f of ['point', 'detail', 'name', 'note']) {
        if (f in it && typeof it[f] !== 'string') where.push(`${k}[${i}].${f} 非字符串`);
      }
      if (it && typeof it.point === 'string' && it.point.length > 20) warned.push(`${code}: ${k}[${i}].point 过长(${it.point.length}字)`);
    });
  }
  const rs = d.ratingSummary;
  if (rs) {
    for (const k of ['buy', 'hold', 'sell']) if (typeof rs[k] !== 'number') where.push(`ratingSummary.${k} 非数字`);
    if (rs && rs.buy === 0 && rs.hold === 0 && rs.sell === 0 && !/无直接|无券商|无研报|无覆盖|未覆盖|如实记零/.test(d.source || '')) {
      warned.push(`${code}: 评级全零但 source 未注明无覆盖`);
    }
  } else where.push('缺 ratingSummary');
  const tp = d.targetPriceRange;
  if (tp) {
    if (typeof tp.min !== 'number' || typeof tp.max !== 'number') where.push('targetPriceRange 非数字');
    else if (tp.min > tp.max) where.push(`targetPriceRange min>max(${tp.min}>${tp.max})`);
  }
  if (where.length) errors.push(`${code}: ${where.join('; ')}`);
}

console.log(`检查 ${files.length} 份分析文件`);
if (warned.length) {
  console.log(`\n提示 ${warned.length} 条:`);
  for (const w of warned) console.log('  ⚠ ' + w);
}
if (errors.length) {
  console.log(`\n错误 ${errors.length} 条:`);
  for (const e of errors) console.log('  ✗ ' + e);
  process.exit(1);
} else {
  console.log('\n✓ 全部通过');
}
