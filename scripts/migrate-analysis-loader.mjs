import fs from 'node:fs/promises';
const file='src/data/analyses/index.ts',old=await fs.readFile(file,'utf8');
if(old.includes('export const ANALYSIS_FILES:')){console.log('Lazy loader already installed');process.exit(0);}
const types=old.slice(old.indexOf('export interface Competitor'),old.indexOf('export const ANALYSES'));
if(!types.includes('interface PreAnalysis'))throw Error('Unexpected index');
const files=(await fs.readdir('src/data/analyses')).filter(x=>/^\d{5,6}\.json$/.test(x)).sort();
const registry=files.map(x=>`  '${x.slice(0,-5)}': '${x}',`).join('\n');
await fs.writeFile(file,`/** Server-side lazy loading keeps the research corpus out of application bundles. */
import fs from 'node:fs';
import path from 'node:path';
import { normalizeStockCode } from '../../lib/datasource/codes';
${types}
export const ANALYSIS_FILES: Readonly<Record<string,string>> = {
${registry}
};
const cache = new Map<string,PreAnalysis>();
const CACHE_LIMIT = 128;
export function getPreAnalysis(code: string): PreAnalysis | undefined {
  const normalized = normalizeStockCode(code);
  if (!normalized) return undefined;
  const key = normalized.code;
  const filename = ANALYSIS_FILES[key];
  if (!filename) return undefined;
  const cached = cache.get(key);
  if (cached) { cache.delete(key); cache.set(key,cached); return cached; }
  try {
    const data = JSON.parse(fs.readFileSync(path.join(process.cwd(),'src/data/analyses',filename),'utf8')) as PreAnalysis;
    if (data.code !== key) return undefined;
    cache.set(key,data);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    return data;
  } catch { return undefined; }
}
`);
