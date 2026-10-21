import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const priceFields=['open','high','low','close'];
const dateOK=s=>typeof s==='string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
const different=(a,b)=>priceFields.some(f=>Math.abs(a[f]-b[f])>Math.max(1e-8,Math.abs(a[f])*1e-8));

/** Validate the WHOLE package before writing any company. No credentials or network here. */
export async function loadQmtPackage(directory){
 const today=new Date(Date.now()+8*3600e3).toISOString().slice(0,10);
 const root=await fs.realpath(directory),manifest=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8'));
 if(manifest.version!==1 || !/^[a-f0-9]{64}$/.test(manifest.scopeSha256) || !Array.isArray(manifest.scope)
   || manifest.scope.length!==manifest.uniqueStocks || !manifest.stocks || manifest.uniqueStocks>1000)throw Error('导出清单格式或范围无效');
 const scope=new Map();
 for(const item of manifest.scope){
  if(!/^(?:(?:sh|sz|bj)\d{6}|hk\d{5})$/.test(item.symbol) || scope.has(item.symbol))throw Error('清单证券无效或重复');
  scope.set(item.symbol,item);
 }
 const companies=[];
 for(const [symbol,result] of Object.entries(manifest.stocks)){
  if(!scope.has(symbol))throw Error('导出证券超出原始清单');
  if(result.status!=='exported')continue;
  const files=Object.entries(result.files??{}),rawName=`raw/${symbol}.json`;
  if(!files.some(([name])=>name===rawName))throw Error(`${symbol} 缺少原始价格文件`);
  let payload;
  for(const [name,digest] of files){
   if(!new RegExp(`^(?:raw|front_reference|corporate_actions_reference)/${symbol}\\.json$`).test(name) || !/^[a-f0-9]{64}$/.test(digest))throw Error('导出文件路径或校验码无效');
   const target=await fs.realpath(path.join(root,name));
   if(!target.startsWith(root+path.sep))throw Error('导出文件路径超出数据包');
   const bytes=await fs.readFile(target);if(hash(bytes)!==digest)throw Error(`${symbol} 文件校验失败：${name}`);
   if(name===rawName)payload=JSON.parse(bytes);
  }
  if(payload.schema!=='fin-terminal-qmt-raw-v1' || payload.symbol!==symbol || payload.source!=='qmt' || payload.adjust!=='none'
    || payload.period!=='day' || payload.fillData!==false || payload.currency!==(symbol.startsWith('hk')?'HKD':'CNY')
    || payload.qmtCode!==symbol.slice(2)+'.'+symbol.slice(0,2).toUpperCase()
    || payload.requestedFrom!==manifest.requestedFrom || payload.requestedTo!==manifest.requestedTo
    || !Array.isArray(payload.candles) || !payload.candles.length || payload.candles.length>3200)throw Error(`${symbol} 证券、币种、复权或数据范围无效`);
  if(!dateOK(payload.requestedFrom) || !dateOK(payload.requestedTo) || payload.requestedFrom>payload.requestedTo)throw Error('请求日期无效');
  if(payload.listingDate!=null && (!dateOK(payload.listingDate) || payload.listingDate>payload.candles[0].date))throw Error(`${symbol} 上市日期无效`);
  let previous='';
  for(const c of payload.candles){
   if(!dateOK(c.date) || c.date<=previous || c.date<payload.requestedFrom || c.date>payload.requestedTo || c.date>today
     || !priceFields.every(f=>typeof c[f]==='number' && Number.isFinite(c[f])) || c.low<=0
     || c.low>Math.min(c.open,c.close) || c.high<Math.max(c.open,c.close))throw Error(`${symbol} 日线日期、排序或价格无效`);
   previous=c.date;
  }
  if(result.count!==payload.candles.length || result.from!==payload.candles[0].date || result.to!==payload.candles.at(-1).date)throw Error(`${symbol} 清单与文件覆盖不一致`);
  companies.push({symbol,payload,warnings:result.warnings??[]});
 }
 if(!companies.length)throw Error('数据包中没有可导入日线');
 return {manifest,companies,packageDigest:hash(JSON.stringify(manifest))};
}

/** Shared file/PostgreSQL importer, idempotent and conservative on source conflicts. */
export async function importQmtPackage(bundle,store,runtime,{apply=false}={}){
 const result={apply,scopeSha256:bundle.manifest.scopeSha256,packageDigest:bundle.packageDigest,scopeStocks:bundle.manifest.uniqueStocks,
  pricesOnly:true,imported:0,unchanged:0,verified:0,totalBars:0,conflicts:[],warnings:[],companies:[],
  pendingSymbols:bundle.manifest.scope.map(s=>s.symbol).filter(s=>!bundle.companies.some(c=>c.symbol===s))};
 for(const {symbol,payload,warnings} of bundle.companies){
  const wanted=payload.candles,byDate=new Map(wanted.map(c=>[c.date,c]));
  let conflict;
  for(const source of ['canonical','tencent','sina','eastmoney']){
   const row=await store.read(`kline:v2:${symbol}:day:none:${source}:prices-only`);
   if(!row)continue;
   const differences=row.payload.candles.filter(c=>byDate.has(c.date) && different(c,byDate.get(c.date)));
   if(differences.length){conflict={symbol,source,reason:'已存来源与导入价格冲突',dates:differences.slice(0,20).map(c=>c.date)};break;}
  }
  if(conflict){result.conflicts.push(conflict);continue;}
  const key=runtime.importedBarsKey(symbol),old=await store.read(key);
  if(old){
   const existingDates=new Set(old.payload.candles.map(c=>c.date));
   if(wanted.some(c=>!existingDates.has(c.date))){result.conflicts.push({symbol,reason:'已有导入范围较短，须先单独复核扩展，未自动覆盖'});continue;}
   result.unchanged++;
  }else if(apply){
   await runtime.importDailyPrices(store,{symbol,source:'qmt',candles:wanted,...(payload.listingDate?{listingDate:payload.listingDate}:{})});
   result.imported++;
  }
  if(apply){
   const saved=await store.read(key),actual=new Map((saved?.payload.candles??[]).map(c=>[c.date,c]));
   if(wanted.some(c=>!actual.has(c.date) || different(c,actual.get(c.date))))throw Error(`${symbol} 数据库回读校验失败`);
   result.verified++;
  }
  result.totalBars+=wanted.length;
  result.companies.push({symbol,from:wanted[0].date,to:wanted.at(-1).date,count:wanted.length});
  if(warnings.length)result.warnings.push({symbol,warnings});
 }
 return result;
}

async function main(){
 const args=process.argv.slice(2),opts={};
 for(let i=0;i<args.length;i++){
  const key=args[i];if(['--apply','--database'].includes(key)){opts[key]=true;continue;}
  if(!['--input','--store-dir','--report'].includes(key) || !args[i+1] || args[i+1].startsWith('--'))throw Error('参数：--input 解压目录 --store-dir 本地目录 | --database [--apply] [--report 报告路径]');
  opts[key]=args[++i];
 }
 if(!opts['--input'] || !!opts['--database']===!!opts['--store-dir'])throw Error('必须指定数据包目录，以及唯一的本地或服务器数据库目标');
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),runtimeDir=path.join(root,'.market-importer');
 try{await fs.access(path.join(runtimeDir,'manifest.json'));}catch{throw Error('请先执行 npm run market:import:build');}
 const built=JSON.parse(await fs.readFile(path.join(runtimeDir,'manifest.json'),'utf8'));
 for(const [relative,digest] of Object.entries(built.sources)){
  let source;try{source=await fs.readFile(path.join(root,'src/lib',relative));}catch(e){if(e.code==='ENOENT')continue;throw e;}
  if(hash(source)!==digest)throw Error('导入程序与当前代码版本不同，请重新执行 npm run market:import:build');
 }
 const storage=await import(pathToFileURL(path.join(runtimeDir,'marketStore.mjs'))),runtime=await import(pathToFileURL(path.join(runtimeDir,'marketImportedBars.mjs')));
 const bundle=await loadQmtPackage(opts['--input']);
 const url=process.env.MARKET_DATABASE_URL || process.env.DATABASE_URL;
 if(opts['--database'] && !url)throw Error('服务器尚未配置 MARKET_DATABASE_URL');
 const store=opts['--database'] ? storage.postgresMarketStore(url) : storage.fileMarketStore(path.resolve(opts['--store-dir']));
 try{
  const report=await importQmtPackage(bundle,store,runtime,{apply:!!opts['--apply']});
  report.target=opts['--database']?'server-postgresql':'local-file';report.checkedAt=new Date().toISOString();
  if(opts['--report'])await fs.writeFile(path.resolve(opts['--report']),JSON.stringify(report,null,2));
  console.log(JSON.stringify({target:report.target,apply:report.apply,scopeStocks:report.scopeStocks,companies:report.companies.length,imported:report.imported,unchanged:report.unchanged,verified:report.verified,totalBars:report.totalBars,conflicts:report.conflicts.length,warnings:report.warnings.length,pendingSymbols:report.pendingSymbols.length},null,2));
  if(report.conflicts.length)process.exitCode=2;
 }finally{await store.close?.();}
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
 main().catch(error=>{console.error(error.message);process.exitCode=1;});
