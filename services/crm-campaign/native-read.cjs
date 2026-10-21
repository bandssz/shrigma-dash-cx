'use strict';
// API16 compatibility for original campaign reads. The issuer still owns auth;
// no credential-table grant, operation claim, write or new persisted state.
const {createHash}=require('node:crypto');
const ACTIONS=new Set(['campanha_listar','campanha_obter']);
const fail=(status,error)=>Object.assign(Error(error),{status,body:{error,message:'Consulta não confirmada.'}});
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const version=c=>createHash('md5').update(JSON.stringify(canonical(c))).digest('hex');
function brandOf(list){
 const tags=Array.isArray(list.tags)?list.tags:[];
 if(tags.some(t=>['cross','aposentada','olivas'].includes(t)))return null;
 const aristo=list.id===16||tags.some(t=>['aristo','aristocrata'].includes(t)),fish=list.id===17||tags.some(t=>['fish','fishermans'].includes(t));
 return aristo===fish?null:aristo?'aristo':'fish';
}
function project(c,brand,lists){
 const meta=c?.attribs?.crm,ids=(c?.lists||[]).map(x=>typeof x==='number'?x:x.id);
 if(!Number.isSafeInteger(c?.id)||c.id<=0||meta?.policy!=='crm-campaign-v1'||meta.brand!==brand||!ids.length||ids.some(id=>!lists.has(id)))throw fail(404,'CAMPAIGN_NOT_FOUND');
 if(!Number.isSafeInteger(c.template_id)||c.template_id<1||typeof c.body!=='string'||typeof c.altbody!=='string')throw fail(503,'CAMPAIGN_READ_INCOMPLETE');
 const headers=Array.isArray(c.headers)?c.headers:[],reply=headers.flatMap(h=>Object.entries(h)).find(([k])=>k.toLowerCase()==='reply-to')?.[1]??null;
 const out={id:c.id,status:c.status,sent:c.sent,started_at:c.started_at??null,send_at:c.send_at??null,definition:{schema_version:'crm-campaign-v1',brand,channel:'email',initiative:{key:meta.initiative_key??null,name:meta.initiative_name??null},utm_campaign:meta.utm_campaign??null,name:c.name,subject:c.subject,from_email:c.from_email,reply_to:reply,list_ids:ids,template_id:c.template_id,html:c.body,text:c.altbody,tags:c.tags||[],send_at:c.send_at??null}};
 // Wire-compatible optimistic version only. API16 has no atomic CAS.
 return {id:out.id,version:version({...out,updated_at:c.updated_at,created_at:c.created_at,attribs:c.attribs,media:c.media||[],headers}),...Object.fromEntries(Object.entries(out).filter(([k])=>k!=='id'))};
}
function createNativeRead({request,authenticate,maxPages=100,maxCampaigns=10000}){
 if(typeof request!=='function'||typeof authenticate!=='function')throw Error('NATIVE_READ_CONFIG');
 const supports=command=>ACTIONS.has(command?.acao);
 const verify=(proof,initial,brand)=>{
  if(!proof||typeof proof.actor!=='string'||!proof.actor.trim()||!Array.isArray(proof.caps))throw fail(401,'UNAUTHORIZED');
  if(!proof.caps.includes('read_content'))throw fail(403,'CAPABILITY_MISSING');
  if(Object.hasOwn(proof,'brand')&&proof.brand!==brand)throw fail(403,'BRAND_DENIED');
  if(initial&&(proof.actor!==initial.actor||JSON.stringify([...proof.caps].sort())!==JSON.stringify([...initial.caps].sort())))throw fail(403,'AUTHORIZATION_CHANGED');
 };
 async function execute({key,auth,command,interrupted=()=>false}){
  if(!supports(command))return null;
  const brand=command.brand;if(!['aristo','fish'].includes(brand))throw fail(422,'BRAND_INVALID');verify(auth,null,brand);
  if(command.acao==='campanha_obter'&&(!Number.isSafeInteger(command.id)||command.id<=0))throw fail(422,'ID_INVALID');
  const read=async path=>{if(interrupted())throw fail(503,'READ_UNAVAILABLE');return request(path);};
  const rawLists=await read('/api/lists?minimal=true&per_page=all'),rows=Array.isArray(rawLists)?rawLists:rawLists?.results;
  if(!Array.isArray(rows))throw fail(503,'LISTMONK_RESPONSE_UNCONFIRMED');
  const lists=new Set(rows.filter(l=>brandOf(l)===brand).map(l=>l.id));let body;
  if(command.acao==='campanha_obter')body={campaign:project(await read('/api/campaigns/'+command.id),brand,lists)};
  else{
   const campaigns=[],seen=new Set();let complete=false,total;
   for(let page=1;page<=maxPages;page++){
    // Original lists include complete bodies. Do not silently replace content
    // with empty strings from the modern table's no_body=true response.
    const data=await read('/api/campaigns?no_body=false&per_page=100&page='+page);
    if(!Array.isArray(data?.results)||!Number.isSafeInteger(data.total)||data.total<0||data.total>maxCampaigns||total!==undefined&&total!==data.total)throw fail(503,'CAMPAIGN_LIST_CHANGED');total=data.total;
    for(const c of data.results){if(seen.has(c.id))throw fail(503,'CAMPAIGN_LIST_CHANGED');seen.add(c.id);if(c.attribs?.crm?.policy==='crm-campaign-v1'&&c.attribs.crm.brand===brand)campaigns.push(project(c,brand,lists));}
    if(page*100>=total){complete=seen.size===total;break;}
   }
   if(!complete)throw fail(503,'CAMPAIGN_LIST_INCOMPLETE');body={campaigns};
  }
  verify(await authenticate(key),auth,brand);if(interrupted())throw fail(503,'READ_UNAVAILABLE');return {status:200,body};
 }
 return Object.freeze({supports,execute});
}
module.exports={createNativeRead,project,brandOf,version};
