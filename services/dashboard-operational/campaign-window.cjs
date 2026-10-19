'use strict';
// Response projection only. Original attribution calculations and source SQL
// are unchanged; all-time campaign/UTM identities stay available to claimants.
const Home=require('./public/crm-preview/home.js');
const day=v=>String(v||'').slice(0,10),numeric=v=>v!==null&&v!==undefined&&v!==''&&typeof v!=='boolean'&&Number.isFinite(Number(v))?Number(v):null;
const fail=()=>{throw Object.assign(Error('CAMPAIGN_WINDOW_INVALID'),{code:'CAMPAIGN_WINDOW_INVALID',status:400});};
const offset=(d,n)=>new Date(Date.parse(d+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
function projectCampaignWindow(data,{ini,fim,model,channel,brand}){
 const dates=Home.dates(ini,fim);if(!dates.length||!['last_click','last_non_direct'].includes(model)||!['email','whatsapp','todos'].includes(channel)||!['aristo','fish'].includes(brand)||data?.brand!==brand||JSON.stringify(data.brands)!==JSON.stringify([brand]))fail();
 const a=data.crm_attribution,relations=[a?.daily,a?.hourly,a?.quality,a?.reconciliation,data.crm_diario,a?.dispatch_evidence?.daily],foreign=relations.some(rows=>Array.isArray(rows)&&rows.some(row=>['brand','marca'].some(k=>Object.hasOwn(row||{},k)&&({fishermans:'fish',aristocrata:'aristo'}[row[k]]||row[k])!==brand))),valid=a?.schema_version===2&&Array.isArray(a.daily)&&a.daily.every(Home.validAttributionRow),n=dates.length,available=[];
 // Keep the original invalidity and cross-window model-presence semantics.
 if(!valid||foreign)return data;
 const modelValid=model===(a.default_model||'last_click')||a.daily.some(r=>r.model===model);
 if(modelValid)for(const row of a.daily)if(row.model===model&&row.grain==='channel'&&(channel==='todos'||row.dimension?.[0]===channel)&&[row.receita,row.pedidos].some(v=>numeric(v)!==null)&&Number.isFinite(Date.parse(row.dia)))available.push(day(row.dia));
 if(channel!=='whatsapp')for(const row of data.crm_diario||[])if((row.canal||'email')==='email'&&row.janela==='1d'&&[row.enviados,row.cliques].some(v=>numeric(v)!==null))available.push(day(row.dia));
 const latest=available.sort().at(-1),fallback=available.length>0&&!available.some(d=>d>=ini&&d<=fim),effective=fallback?{ini:offset(latest,1-n),fim:latest}:{ini,fim};
 const ranges=[{ini:offset(ini,-n),fim},...(fallback?[{ini:offset(effective.ini,-n),fim:effective.fim}]:[])],inside=r=>ranges.some(w=>day(r.dia)>=w.ini&&day(r.dia)<=w.fim);
 const firstModel=new Set(),sentinels=new Set();a.daily.forEach((r,i)=>{if(!firstModel.has(r.model)){firstModel.add(r.model);sentinels.add(i);}});
 const slice=rows=>Array.isArray(rows)&&rows.every(r=>Home.dates(day(r.dia),day(r.dia)).length===1)?rows.filter(inside):rows;
 const attr={...a,daily:a.daily.filter((r,i)=>inside(r)||sentinels.has(i))};
 // Coverage is intentionally complete: duplicates, checked_at and validity
 // outside this period cannot disappear and turn incomplete data into zero.
 for(const key of ['quality','reconciliation','hourly'])if(Object.hasOwn(a,key))attr[key]=slice(a[key]);
 if(a.dispatch_evidence&&typeof a.dispatch_evidence==='object')attr.dispatch_evidence={...a.dispatch_evidence,daily:slice(a.dispatch_evidence.daily)};
 return{...data,crm_diario:slice(data.crm_diario),crm_attribution:attr,campaign_window:{schema:'crm-campaign-window-read-v1',requested:{ini,fim},effective,comparison:{ini:offset(effective.ini,-n),fim:offset(effective.ini,-1)},fallback,model,channel,allTimeCampaignIdentityPreserved:true,modelPresenceRows:'original'}};
}
function campaignListSummary(data){if(!Array.isArray(data?.campaigns))throw Error('CAMPAIGN_LIST_INVALID');return{...data,campaigns:data.campaigns.map(c=>({...c,definition:Object.fromEntries(Object.entries(c.definition||{}).filter(([k])=>!['html','text','body_html','body_text'].includes(k)))}))};}
function requestWindow(headers,brand){const ini=headers['x-shrigma-campaign-ini'],fim=headers['x-shrigma-campaign-fim'],model=headers['x-shrigma-campaign-model'],channel=headers['x-shrigma-campaign-channel'];if(!['aristo','fish'].includes(brand)||typeof ini!=='string'||typeof fim!=='string'||ini.length!==10||fim.length!==10||!Home.dates(ini,fim).length||!['last_click','last_non_direct'].includes(model)||!['email','whatsapp','todos'].includes(channel))fail();return{ini,fim,model,channel,brand};}
module.exports={projectCampaignWindow,campaignListSummary,requestWindow};
