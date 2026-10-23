// Optional dedicated importer; multiple workers are fenced by the durable queue lease.
const origin=process.env.MARKET_IMPORT_ORIGIN??process.env.MARKET_UPDATE_ORIGIN;
const token=process.env.MARKET_UPDATE_WORKER_TOKEN??process.env.MARKET_MAINTENANCE_TOKEN;
if(!origin||!token||token.length<32)throw Error('Set MARKET_IMPORT_ORIGIN (or MARKET_UPDATE_ORIGIN) and worker/maintenance token');
const base=new URL(origin);
if(base.username||base.password||base.search||base.hash||base.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(base.hostname))throw Error('Use an HTTPS origin without credentials');
const target=new URL('/api/market/import-batch/worker',base);let stop=false;
process.on('SIGINT',()=>{stop=true;});process.on('SIGTERM',()=>{stop=true;});
while(!stop){let delay=15000;
 try{
  const response=await fetch(target,{method:'POST',headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(110000)});
  if([401,403,404].includes(response.status))throw new Error('Import worker rejected or endpoint not deployed');
  const data=await response.json();if(!response.ok||!data.ok)throw new Error('Import worker service unavailable');
  if(data.data.processed){delay=500;console.log(JSON.stringify({job:data.data.job?.id,state:data.data.job?.state,processed:data.data.processedCompanies}));}
 }catch(e){console.error(e instanceof Error?e.message:'Import worker failed');delay=30000;}
 if(!stop)await new Promise(r=>setTimeout(r,delay));
}
