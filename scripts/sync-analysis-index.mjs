/** Add missing JSON registrations. Never rewrite or delete legacy analysis entries. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registeredCodes, canonicalCode } from './lib/analysis-coverage.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir = path.join(root,'src/data/analyses'), target = path.join(dir,'index.ts');
let index = (await fs.readFile(target,'utf8')).replaceAll('\r\n','\n');
const registered = registeredCodes(index);
const codes = (await fs.readdir(dir)).filter(file => /^\d{5,6}\.json$/.test(file)).map(file => file.slice(0,-5)).filter(code => !registered.has(code)).sort();
for (const code of codes) {
  const data = JSON.parse(await fs.readFile(path.join(dir,`${code}.json`),'utf8'));
  if (canonicalCode(code) !== code || data.code !== code) throw Error(`Invalid analysis identity: ${code}`);
}
if (process.argv.includes('--check')) { console.log(JSON.stringify({ unregistered: codes })); if (codes.length) process.exitCode = 1; }
else if (codes.length) {
 if(index.includes('export const ANALYSIS_FILES:')){
  const marker='\n};\nconst cache';
  const end=index.indexOf(marker);
  if(end<0)throw Error('Lazy registry shape changed');
  index=index.slice(0,end)+'\n'+codes.map(code=>`  '${code}': '${code}.json',`).join('\n')+index.slice(end);
  await fs.writeFile(target,index);console.log(`Registered ${codes.length} analysis files`);
 } else {
  const imports = codes.map(code => `import coverage${code} from './${code}.json';`).join('\n');
  const first = index.indexOf('import c');
  const end = index.indexOf('\n};\n\nexport function getPreAnalysis');
  if (first < 0 || end < first) throw Error('Index shape changed; refusing to rewrite');
  index = index.slice(0,end) + '\n' + codes.map(code => `  '${code}': coverage${code} as PreAnalysis,`).join('\n') + index.slice(end);
  index = index.slice(0,first) + imports + '\n' + index.slice(first);
  await fs.writeFile(target,index);
  console.log(`Registered ${codes.length} analysis files`);
 }
} else console.log('All analysis files are already registered');
