import fs from 'node:fs/promises';
import {hkGuide} from './hk-full-guides.mjs';
import {simplified} from './hk-simplified.mjs';
const b=JSON.parse(await fs.readFile('docs/full-hk-research.json','utf8')),gaps=[],industries={};
for(const t of b.companies){
 const r=JSON.parse(await fs.readFile(`src/data/analyses/_raw/full-market/${t.code}.json`,'utf8')),reasons=[];
 if(r.profile?.SECURITY_CODE!==t.code||!r.profile?.ORG_NAME)reasons.push('缺少可确认的公司身份');
 if(!r.profile?.MAIN_BUSINESS?.trim()&&!(r.profile?.ORG_PROFILE?.length>100&&/生产|制造|销售|服務|服務|業務|业务/.test(r.profile.ORG_PROFILE)))reasons.push('缺少具体主营业务说明');
 try{const k=hkGuide(t.code,simplified(r.profile?.INDUSTRY_TYPE||''));t.businessGuide=k.key;}catch(e){reasons.push('缺少匹配的业务框架：'+e.message);const i=r.profile?.INDUSTRY_TYPE||t.industry;industries[i]=(industries[i]||0)+1;}
 t.readiness=reasons.length?'source-gap':'ready';t.gaps=reasons;if(reasons.length)gaps.push({code:t.code,name:t.name,reasons});
}
b.ready=b.companies.filter(x=>x.readiness==='ready').length;
await fs.writeFile('docs/full-hk-research.json',JSON.stringify(b,null,2)+'\n');
await fs.writeFile('docs/full-hk-source-gaps.json',JSON.stringify({asOf:b.asOf,gaps},null,2)+'\n');
console.log(JSON.stringify({requested:b.requested,ready:b.ready,gaps:gaps.length,industries}));
