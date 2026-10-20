import fs from 'node:fs/promises';
import {aGuide} from './a-research-guides.mjs';
import {businessProfile} from './business-first-profiles.mjs';
const file='docs/full-market-research.json',batch=JSON.parse(await fs.readFile(file,'utf8'));
batch.pausedMarkets={HK:{missing:2548,reason:'用户明确要求港股暂不覆盖'}};
batch.companies=batch.companies.filter(x=>x.market==='A');
batch.requested=batch.companies.length;
batch.scope='网站申万A股公司目录快照中未覆盖的公司；排除B股、基金、指数。港股暂停。';
const gaps=[],industries={};
for(const target of batch.companies){
 const r=JSON.parse(await fs.readFile(`src/data/analyses/_raw/full-market/${target.code}.json`,'utf8'));
 const reasons=[];
 if(r.profile?.SECURITY_CODE!==target.code||!r.profile?.ORG_NAME)reasons.push('公司身份资料不足');
 if(!r.financials?.some(x=>x.CURRENCY==='CNY'))reasons.push('缺少明确人民币财务口径');
 if(!r.segments?.some(x=>x.ITEM_NAME&&!/^(合计|总计|小计|营业收入|营业总收入)$/.test(x.ITEM_NAME)))reasons.push('缺少实际主营分项');
 if(!r.reviews?.length&&!r.profile?.MAIN_BUSINESS&&!(r.profile?.ORG_PROFILE?.length>100&&/产品|研发|生产|服务|销售/.test(r.profile.ORG_PROFILE)))reasons.push('缺少业务说明与经营评述');
 try{const g=aGuide(r.profile?.EM2016||'');businessProfile(g.key,r.profile.EM2016);}catch(e){reasons.push(e.message);industries[r.profile?.EM2016]=(industries[r.profile?.EM2016]||0)+1;}
 const special=target.code==='688759'&&target.specialCase&&target.analysisStatus==='draft';
 target.readiness=special?'ready-special-case':reasons.length?'source-gap':'ready';target.gaps=special?[]:reasons;
 if(reasons.length&&!special)gaps.push({code:target.code,name:r.profile?.SECURITY_NAME_ABBR,industry:r.profile?.EM2016,reasons});
}
batch.ready=batch.companies.filter(x=>x.readiness.startsWith('ready')).length;
await fs.writeFile(file,JSON.stringify(batch,null,2)+'\n');
await fs.writeFile('docs/full-a-source-gaps.json',JSON.stringify({asOf:batch.asOf,gaps},null,2)+'\n');
console.log(JSON.stringify({requested:batch.requested,ready:batch.ready,gaps:gaps.length,industries}));
