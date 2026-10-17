import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
const root = process.cwd();
const out = path.join(root, 'node_modules', '.valuation-tests');
async function compile(dir) {
  for (const entry of await fs.readdir(dir, {withFileTypes:true})) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { await compile(p); continue; }
    if (!p.endsWith('.ts')) continue;
    const target = path.join(out, path.relative(path.join(root,'src/lib'),p)).replace(/\.ts$/,'.mjs');
    let code = ts.transpileModule(await fs.readFile(p,'utf8'), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
    code = code.replace(/(from\s+['"])(\.[^'"]+)(['"])/g, (_,a,b,c) => a+b+(/\.[a-z]+$/.test(b)?'':'.mjs')+c);
    await fs.mkdir(path.dirname(target), {recursive:true});
    await fs.writeFile(target, code);
  }
}
await compile(path.join(root,'src/lib'));
export const load = name => import(pathToFileURL(path.join(out, name+'.mjs')));
