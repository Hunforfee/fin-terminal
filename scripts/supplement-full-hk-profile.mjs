import fs from 'node:fs/promises';
const batch=JSON.parse(await fs.readFile('docs/full-hk-research.json','utf8'));
for(const code of ['00362','00482','08249']){
 const file=`src/data/analyses/_raw/full-market/${code}.json`,r=JSON.parse(await fs.readFile(file,'utf8'));
 const url='https://datacenter-web.eastmoney.com/api/data/v1/get?'+new URLSearchParams({reportName:'RPT_HKF10_INFO_ORGPROFILE',columns:'ALL',filter:`(SECURITY_CODE="${code}")`,pageSize:'1',source:'F10',client:'PC'});
 try{
  const response=await fetch(url,{signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('HTTP '+response.status);
  const j=await response.json(),p=j.result?.data?.find(x=>x.SECURITY_CODE===code);
  if(p?.ORG_NAME&&p.MAIN_BUSINESS){r.profile=p;r.urls.profile=url;r.collected=true;r.errors=r.errors.filter(x=>x.source!=='profile');await fs.writeFile(file,JSON.stringify(r,null,2)+'\n');console.log(code,'recovered');}
  else console.log(code,'no complete profile');
 }catch(e){console.log(code,e.message);}
}
