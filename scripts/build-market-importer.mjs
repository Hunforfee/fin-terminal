import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

/** Build only the server storage/import graph, so production import needs no TS runtime. */
export async function buildMarketImporter(root=process.cwd()){
 const sourceRoot=path.join(root,'src/lib'),out=path.join(root,'.market-importer'),sources={};
 const visit=async relative=>{
  if(sources[relative])return;
  const source=await fs.readFile(path.join(sourceRoot,relative),'utf8');
  sources[relative]=createHash('sha256').update(source).digest('hex');
  let code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  const dependencies=[];
  code=code.replace(/(from\s+['"])(\.[^'"]+)(['"])/g,(_all,a,b,c)=>{
   const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(relative),b+(path.extname(b)?'':'.ts')));
   if(resolved.startsWith('../'))throw Error('Import dependency escapes source root');
   dependencies.push(resolved);return a+b.replace(/\.ts$/,'')+(path.extname(b)?'':'.mjs')+c;
  });
  for(const dependency of dependencies)await visit(dependency);
  const target=path.join(out,relative.replace(/\.ts$/,'.mjs'));
  await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,code);
 };
 await visit('marketImportedBars.ts');await visit('klineStorage.ts');await visit('marketImportRecords.ts');
 await visit('marketHkImportRecords.ts');
 await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify({version:1,sources},null,2));
 return {modules:Object.keys(sources).length};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
 console.log(JSON.stringify(await buildMarketImporter()));
