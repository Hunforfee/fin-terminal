import fs from 'node:fs/promises';import {gzipSync} from 'node:zlib';
const args=process.argv.slice(2),get=n=>{const i=args.indexOf(n);return i>=0?args[i+1]:undefined;};
const input=get('--input');if(!input)throw Error('Usage: npm run market:import:batch -- --input batch.json [--wait] [--drive] [--report result.json]');
const origin=process.env.MARKET_IMPORT_ORIGIN??process.env.MARKET_UPDATE_ORIGIN,token=process.env.MARKET_MAINTENANCE_TOKEN;
if(!origin||!token||token.length<32)throw Error('Set MARKET_IMPORT_ORIGIN and MARKET_MAINTENANCE_TOKEN');
const base=new URL(origin);if(base.username||base.password||base.search||base.hash||base.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(base.hostname))throw Error('Use HTTPS origin without credentials');
const raw=await fs.readFile(input);if(raw.length>8*1024*1024)throw Error('Split input: decoded JSON limit is 8MiB');
const parsed=JSON.parse(raw.toString('utf8'));if(!parsed.idempotencyKey)throw Error('Input needs a stable idempotencyKey');
const compressed=raw.length>512*1024;let report;
async function call(path,body,encoding){
 for(let a=0;a<3;a++)try{
  const r=await fetch(new URL(path,base),{method:body?'POST':'GET',headers:{'x-fin-maintain-token':token,...(body?{'Content-Type':'application/json'}:{}),...(encoding?{'Content-Encoding':'gzip'}:{})},body,redirect:'error',signal:AbortSignal.timeout(110000)});
  const data=await r.json();if(!r.ok||!data.ok){if(r.status<500&&r.status!==429)throw Object.assign(new Error(`HTTP ${r.status}: ${data.error??'request rejected'}`),{terminal:true});throw Error(`HTTP ${r.status}`);}return data;
 }catch(e){if(e.terminal||a===2)throw e;await new Promise(r=>setTimeout(r,Math.min(30000,2000*2**a)));}
}
report=await call('/api/market/import-batch',compressed?gzipSync(raw):raw,compressed);
console.log(JSON.stringify({jobId:report.data.id,state:report.data.state,reused:report.reused,workerConfigured:report.workerConfigured}));
if(args.includes('--wait')||args.includes('--drive'))while(!report.data.finished){
 if(args.includes('--drive'))await call('/api/market/import-batch/worker',Buffer.from('{}'));
 else await new Promise(r=>setTimeout(r,3000));
 report=await call('/api/market/import-batch?jobId='+encodeURIComponent(report.data.id));
 console.log(JSON.stringify({state:report.data.state,total:report.data.total,imported:report.data.imported,unchanged:report.data.unchanged,pending:report.data.pending,conflicts:report.data.conflicts,failed:report.data.failed}));
}
if(get('--report'))await fs.writeFile(get('--report'),JSON.stringify(report,null,2)+'\n');
if(report.data.finished&&report.data.state!=='completed')process.exitCode=2;
