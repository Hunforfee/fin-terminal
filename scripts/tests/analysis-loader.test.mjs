import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';
import {load} from './load-modules.mjs';
const {normalizeStockCode}=await load('datasource/codes');
const {simplifiedChinese}=await load('simplifiedChinese');
let code=ts.transpileModule(await fs.readFile('src/data/analyses/index.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
code=code.replace(/import \{ normalizeStockCode \} from [^;]+;/,'const normalizeStockCode = globalThis.__testNormalize;');
code=code.replace(/import \{ simplifiedChinese \} from [^;]+;/,'const simplifiedChinese = globalThis.__testSimplify;');
globalThis.__testNormalize=normalizeStockCode;
globalThis.__testSimplify=simplifiedChinese;
const module=await import('data:text/javascript;base64,'+Buffer.from(code+'\nexport {cache};').toString('base64'));
delete globalThis.__testNormalize;
delete globalThis.__testSimplify;
test('server loader accepts canonical aliases but refuses unknown/path input',()=>{
 const a=module.getPreAnalysis('sh600519');assert.equal(a.code,'600519');
 assert.equal(module.getPreAnalysis('600519.SH'),a);
 assert.equal(module.getPreAnalysis('hk700').code,'00700');
 for(const s of ['../600519','../../package.json','hello','999999'])assert.equal(module.getPreAnalysis(s),undefined,s);
});
test('loader cache stays bounded when browsing a large corpus',()=>{
 for(const key of Object.keys(module.ANALYSIS_FILES).slice(0,160))assert.equal(module.getPreAnalysis(key)?.code,key);
 assert.equal(module.cache.size,128);
});
test('production tracing ships analysis JSON and excludes raw evidence',async()=>{
 const {default:config}=await import('../../next.config.mjs');
 for(const route of ['/api/analysis','/api/company-learning'])assert.deepEqual(config.outputFileTracingIncludes[route],['./src/data/analyses/[0-9]*.json']);
});
