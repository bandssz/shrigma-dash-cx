'use strict';
// The cookie selects person/front/brand; one private service key authenticates
// each existing source. Fixed READ routes return only the selected brand.
const crypto=require('node:crypto');
const {decide,forward,FIXED_DESTINATIONS}=require('./proxy.cjs');
const Individual=require('./dashboard-individual-read.cjs');
const Affiliate=require('./afiliados-read.cjs');
const AffiliateProjection=require('./afiliados-read-contract.cjs');
const Journeys=require('./crm-published-journey-read.cjs');
const fail=(code,status=403)=>{throw Object.assign(Error(code),{code,status});};
const AREA={growth:'growth',organico:'organico',influs:'influs',afiliados:'influs'};
function sourceKeysFromEnv(env){
 const names={growth:'DASHBOARD_SERVICE_READ_CRM_KEY',organico:'DASHBOARD_SERVICE_READ_ORGANICO_KEY',influs:'DASHBOARD_SERVICE_READ_INFLUS_KEY',afiliados:'DASHBOARD_SERVICE_READ_AFILIADOS_KEY'};
 const out={};for(const [front,name]of Object.entries(names)){const value=env[name];if(value!==undefined){if(typeof value!=='string'||!/^[A-Za-z0-9_.:-]{8,256}$/.test(value))fail('SERVICE_READ_CONFIG_INVALID',500);out[front]=value;}}
 return Object.freeze(out);
}
function createReader({auth,upstreams,keys={},fetchImpl=globalThis.fetch,projectGrowth}={}){
 if(!auth?.authorizeBrand||!auth?.authorize||typeof fetchImpl!=='function'||typeof projectGrowth!=='function'||Object.keys(keys).some(k=>!Object.hasOwn(AREA,k)))fail('SERVICE_READ_CONFIG_INVALID',500);
 const credentials=Object.freeze({...keys}),versions=Object.fromEntries(Object.keys(credentials).map(front=>[front,crypto.randomBytes(32).toString('hex')]));
 const noSecrets=value=>{const serialized=JSON.stringify(value);for(const secret of Object.values(credentials))if(serialized.includes(secret))fail('BRAND_RESPONSE_UNSCOPED',502);};
 let pending=0;
 const current=(context,front,brand)=>{
  const user=auth.authorizeBrand({...context,area:AREA[front],productFront:front,edit:false},brand);
  return {user,stamp:JSON.stringify([user.id,user.role,user.areas,user.permissions,user.productFronts,user.brands,user.jobTitle])};
 };
 const same=(context,front,brand,before)=>{if(current(context,front,brand).stamp!==before.stamp)fail('SERVICE_READ_ACCESS_CHANGED',403);};
 const journeys=Journeys.createReader({fetchImpl,authorize:(context,{brand})=>{const {user}=current(context,'growth',brand);if(!credentials.growth)fail('SERVICE_READ_SOURCE_NOT_LINKED',503);return {userId:user.id,binding:versions.growth+':'+user.id,credential:credentials.growth};}});
 const templates=require('./crm-master-template-read.cjs').createReader({fetchImpl,authorize:(context,{brand})=>{const {user}=current(context,'growth',brand);if(!credentials.growth)fail('SERVICE_READ_SOURCE_NOT_LINKED',503);return {userId:user.id,binding:versions.growth+':'+user.id,credential:credentials.growth};}});
 function availability(context,brand){
  current(context,'afiliados',brand);if(brand==='olivas')fail('BRAND_READ_CONTRACT_NOT_READY',503);
  return {schema:'shrigma-affiliate-read-availability-v1',brand,readLinked:!!credentials.afiliados,binding:versions.afiliados||null,readOnly:true};
 }
 async function read({context,route,method,query,body,viewBrand,origin}){
  let front,brand,d,affiliateCommand;
  if(route==='templates'){
   if(method!=='GET'||body!==undefined)fail('READ_ONLY');
   const action=query.get('acao');
   if(action==='listar'&&query.get('canal')==='email'){const result=await templates.read({...context,method},query);noSecrets(result.body);return result;}
   if(!['fluxos_capacidade','fluxos_listar'].includes(action))fail('READ_ONLY');
   const result=action==='fluxos_capacidade'?journeys.capability(context,query):await journeys.read(context,query);noSecrets(result.body);return result;
  }
  if(route==='affiliate-read'){
   affiliateCommand=Affiliate.decision(method,query,body);brand=affiliateCommand.brand;front='afiliados';
   if(method==='GET')return {status:200,body:availability(context,brand)};
  }else{
   d=decide(route,method,query,body);if(d.edit)fail('READ_ONLY');front=d.area;
   if(!Object.hasOwn(AREA,front)||front==='afiliados')fail('READ_ONLY');
   const identity=route==='cx'&&query.get('access')==='1'||route==='crm-read'&&d.action==='identity';
   if(identity){const user=auth.authorize({...context,area:AREA[front],edit:false});return {status:200,body:{schema:'shrigma_access_identity_v1',role:user.role==='superadmin'?'master':'manager',panel:front,allowedPanels:user.areas,owner:user.jobTitle||'administrador',brand:user.brand,brands:user.brands,brandAccess:user.brandAccess}};}
   const allowed=front==='growth'?route==='crm-read'&&method==='GET'&&d.action==='cache_growth':front==='organico'?['cx','cache'].includes(route)&&method==='GET'&&d.action==='':front==='influs'&&route==='influ'&&method==='POST'&&d.action==='listar';
   if(!allowed)fail('READ_ONLY');
   if(viewBrand!==undefined&&(!['cx','cache','crm-read'].includes(route)||method!=='GET'||!['fish','aristo','olivas'].includes(viewBrand)))fail('BRAND_INVALID',400);
   const user=auth.authorize({...context,area:AREA[front],productFront:front,edit:false});
   brand=body?.marca||query.get('brand')||query.get('marca')||viewBrand||user.brand;
  }
  const before=current(context,front,brand);if(brand==='olivas')fail('BRAND_READ_CONTRACT_NOT_READY',503);
  const credential=credentials[front];if(!credential)fail('SERVICE_READ_SOURCE_NOT_LINKED',503);
  if(route==='affiliate-read'&&affiliateCommand.expected_binding!==versions.afiliados)fail('AFFILIATE_READ_BINDING_CHANGED',409);
  const targetRoute=route==='affiliate-read'?'tts':route;
  if(upstreams?.[targetRoute]?.href!==FIXED_DESTINATIONS[targetRoute])fail('SERVICE_READ_DESTINATION_INVALID',503);
  if(pending>=8)fail('UPSTREAM_BUSY',429);pending++;
  try{
   const result=await forward({route:targetRoute,method:route==='affiliate-read'?'POST':method,query:route==='affiliate-read'?new URLSearchParams():query,body:route==='affiliate-read'?{ini:body.ini,fim:body.fim}:body,user:before.user,credential,upstreams,origin,fetchImpl});
   same(context,front,brand,before);if(result.status!==200)fail('SERVICE_READ_SOURCE_REFUSED',503);
   noSecrets(result.body);
   let payload=front==='growth'?projectGrowth(result.body,brand,'growth',origin):front==='afiliados'?AffiliateProjection.project(result.body,{brand,ini:body.ini,fim:body.fim,credential}):Individual.project(result.body,{area:front,brand,query:body||Object.fromEntries(query),credential});
   if(front==='growth')payload=Journeys.capabilities(payload,origin,true);
   same(context,front,brand,before);return {status:200,body:payload};
  }finally{pending--;}
 }
 async function summary(context,brands,origin,now=Date.now()){
  auth.authorize({...context,admin:true});
  if(!Array.isArray(brands)||brands.length>2||brands.some(b=>!['fish','aristo'].includes(b))||new Set(brands).size!==brands.length)fail('BRAND_INVALID',400);
  const fim=new Date(now-3*3600000).toISOString().slice(0,10),ini=new Date(now-3*3600000-29*86400000).toISOString().slice(0,10);
  const measuredAt=new Date(now).toISOString();
  const jobs=brands.flatMap(brand=>Object.keys(AREA).map(async front=>{
   auth.authorize({...context,admin:true});
   let result;
   try{
    const q=new URLSearchParams();let route,method='GET',body,viewBrand;
    if(front==='growth'){route='crm-read';q.set('action','cache_growth');q.set('painel','growth');viewBrand=brand;}
    else if(front==='organico'){route='cache';q.set('painel','organico');viewBrand=brand;}
    else if(front==='influs'){route='influ';method='POST';body={acao:'listar',ini,fim,marca:brand};}
    else{route='affiliate-read';method='POST';body={ini,fim,brand,expected_binding:availability(context,brand).binding};}
    result=await read({context,route,method,query:q,body,viewBrand,origin});
    const b=result.body,counts={},freshness={};
    for(const [key,value]of Object.entries(b)){
     if(Array.isArray(value)&&!['crm_credencial','read_issues'].includes(key))counts[key]=value.length;
     if(['gerado_em','_cache_gerado_em'].includes(key)&&typeof value==='string')freshness[key]=new Date(value).toISOString();
    }
    // Only dates from allowlisted collector fields leave this diagnostic;
    // rows, emails, names, cookies, keys and provider error text stay private.
    for(const rows of Object.values(b).filter(Array.isArray))for(const row of rows)for(const key of ['coletado_em','ultima_coleta','ultima_ok','ultima']){
     const v=row?.[key];if(typeof v==='string'&&Number.isFinite(Date.parse(v))&&(!freshness[key]||Date.parse(v)>Date.parse(freshness[key])))freshness[key]=new Date(v).toISOString();
    }
    if(b.coleta&&typeof b.coleta[brand]==='string'&&Number.isFinite(Date.parse(b.coleta[brand])))freshness.pedidos_coletados_em=new Date(b.coleta[brand]).toISOString();
    const attribution=b.organico_attribution||b.crm_attribution,attributionCounts={};
    if(attribution&&typeof attribution==='object')for(const name of ['daily','quality','coverage'])if(Array.isArray(attribution[name])){
     attributionCounts[name]=attribution[name].length;
     if(name==='daily'&&front==='organico')attributionCounts.detailedRows=attribution[name].filter(row=>row.detail_level==='utm').length;
     for(const row of attribution[name])if(typeof row.checked_at==='string'&&Number.isFinite(Date.parse(row.checked_at))&&(!freshness.attribution_checked_at||Date.parse(row.checked_at)>Date.parse(freshness.attribution_checked_at)))freshness.attribution_checked_at=new Date(row.checked_at).toISOString();
    }
    result={front,brand,status:200,counts,freshness,...(Object.keys(attributionCounts).length?{attributionCounts}:{}),source:front==='growth'?'crm-panel-read':front==='organico'?'cache-organico':front==='influs'?'influ-listar':'tts-painel',window:front==='influs'||front==='afiliados'?{ini,fim}:null,readOnly:true};
    if(Array.isArray(b.read_issues))result.sourceIssues=b.read_issues.filter(p=>['crm_carrinho','cx_post_midia','clientes','conciliacao','saude','coleta'].includes(p.section)&&['rows_type_invalid','row_type_invalid','brand_marker_invalid','field_type_invalid','contract_invalid','relation_ambiguous'].includes(p.reason)&&(!p.field||/^[a-z_]{1,64}$/.test(p.field))).map(p=>({section:p.section,reason:p.reason,...(p.field?{field:p.field}:{})}));
   }catch(e){
    result={front,brand,status:Number.isInteger(e.status)?e.status:503,error:/^[A-Z_]{1,80}$/.test(e.code||'')?e.code:'SERVICE_READ_UNCONFIRMED',counts:null,freshness:null,readOnly:true};
    const p=e.projectionIssue;
    if(['growth','organico','influs'].includes(front)&&p&&/^(crm_[a-z_]+|wa_[a-z_]+|cx_[a-z_]+|(?:attribution|organic)\.[a-z_]+|influs|roi|cupons|custos|receita_cupom|termos|clientes|conciliacao|saude)$/.test(p.section||'')&&['rows_type_invalid','row_type_invalid','brand_marker_invalid','field_type_invalid'].includes(p.reason)&&(!p.field||/^[a-z_]{1,64}$/.test(p.field)))result.diagnostic={section:p.section,reason:p.reason,...(p.field?{field:p.field}:{})};
   }
   auth.authorize({...context,admin:true});return result;
  }));
  const sources=await Promise.all(jobs);auth.authorize({...context,admin:true});
  return {schema:'shrigma-four-front-read-summary-v1',measuredAt,sources,readOnly:true,operational:false};
 }
 return Object.freeze({read,availability,summary});
}
module.exports={createReader,sourceKeysFromEnv};
