'use strict';
// Same native operator shared by the gateway and the original campaign adapter.
const error=(status,code)=>Object.assign(Error(code),{status,code});
const allowedEditor=author=>author?.permissions?.growth?.edit===true;
function createDirect({authorize,admitted,credentials,fetchImpl=fetch,now=Date.now}){
 const bases={aristo:16,fish:17},domains={aristo:'oaristocrata.com',fish:'fishermans.com.br'};
 const actions=new Set(['campanha_capacidade','campanha_catalogo','campanha_listar','campanha_obter','campanha_criar','campanha_salvar','campanha_teste','campanha_agendar','campanha_cancelar']);
 const writing=action=>['campanha_criar','campanha_salvar','campanha_teste','campanha_agendar','campanha_cancelar'].includes(action);
 const future=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&Date.parse(value)>=now()+20*60000&&Date.parse(value)<=now()+7*86400000;
 const address=value=>String(value||'').match(/<([^<>]+)>$/)?.[1]||String(value||'');
 const ids=c=>(c.lists||c.list_ids||[]).map(x=>typeof x==='object'?x.id:x);
 const binding=brand=>{const value=credentials?.[brand];if(!value||typeof value.username!=='string'||!value.username||typeof value.token!=='string'||!value.token||!Array.isArray(value.listIds)||!value.listIds.includes(bases[brand]))throw error(503,'LISTMONK_UNAVAILABLE');return value;};
 function campaign(c,brand){
  const lists=ids(c),allowed=binding(brand).listIds;
  if(!idOk(c?.id)||!lists.length||lists.some(id=>!allowed.includes(id)))throw error(403,'CAMPAIGN_BRAND_REFUSED');
  const meta=c.attribs?.shrigma||{},previous=c.attribs?.crm||{},headers=Array.isArray(c.headers)?Object.assign({},...c.headers):c.headers||{};
  return {id:c.id,version:c.updated_at||c.created_at,status:c.status,sent:c.sent??0,started_at:c.started_at??null,send_at:c.send_at??null,attribs:c.attribs??{},media:(c.media||[]).map(x=>typeof x==='object'?x.id:x),headers:c.headers||[],content_type:c.content_type,type:c.type,messenger:c.messenger,definition:{schema_version:'crm-campaign-v1',brand,channel:'email',name:c.name,subject:c.subject,from_email:c.from_email,reply_to:headers['Reply-To']||'contato@'+domains[brand],list_ids:lists,template_id:c.template_id,html:c.body||'',text:c.altbody||'',tags:c.tags||[],initiative:meta.initiative||(previous.initiative_key?{key:previous.initiative_key,name:previous.initiative_name||c.name}:{key:'campanha',name:c.name}),utm_campaign:meta.utm_campaign||previous.utm_campaign||'campanha',send_at:c.send_at??null},audience_id:meta.audience_id||null,audience_name:meta.audience_name||null};
 }
 const idOk=n=>Number.isSafeInteger(n)&&n>0&&n<=2147483647;
 function payload(d,brand,q){
  if(!d||d.brand!==brand||typeof d.name!=='string'||!d.name.trim()||typeof d.subject!=='string'||!d.subject.trim()||typeof d.html!=='string'||!d.html.trim()||!Array.isArray(d.list_ids)||!d.list_ids.length||d.list_ids.some(id=>!binding(brand).listIds.includes(id)))throw error(400,'CAMPAIGN_INPUT');
  const sender=address(d.from_email).toLowerCase(),domain=domains[brand];
  if(!['avisos@'+domain,'contato@'+domain].includes(sender)||d.reply_to!=='contato@'+domain)throw error(403,'CAMPAIGN_BRAND_REFUSED');
  if(d.template_id!==null&&(!Number.isSafeInteger(d.template_id)||d.template_id<0))throw error(400,'CAMPAIGN_INPUT');
  if(q.acao!=='campanha_teste'&&d.send_at!==null&&d.send_at!==undefined&&!future(d.send_at))throw error(400,'NATIVE_INTERNAL_DATE');
  if(q.content_type&&q.content_type!=='html'||q.type&&q.type!=='regular'||q.messenger&&q.messenger!=='email')throw error(400,'CAMPAIGN_FORMAT_UNAVAILABLE');
  if(!require('./campaign-editorial-policy.cjs').review({html:d.html,text:d.text||'',brand,campaign:d.utm_campaign}).ok)throw error(400,'CAMPAIGN_CONTENT_INVALID');
  const headers=(q.headers||[]).map(h=>Object.fromEntries(Object.entries(h).filter(([k])=>k.toLowerCase()!=='reply-to'&&(q.acao!=='campanha_teste'||!['to','cc','bcc'].includes(k.toLowerCase()))))).filter(h=>Object.keys(h).length);headers.push({'Reply-To':d.reply_to});
  const tracked=require('./campaign-write-tracking.js').prepareNative({status:'draft',sent:0,started_at:null,content_type:'html',lists:d.list_ids,body:d.html,altbody:d.text||''},{brand,campaign:d.utm_campaign||'campanha'});
  return {name:d.name.trim(),subject:d.subject,from_email:d.from_email,body:tracked.body,altbody:tracked.altbody,content_type:'html',type:'regular',messenger:'email',lists:d.list_ids,...(d.template_id===null?{}:{template_id:d.template_id}),headers,tags:d.tags||[],send_at:d.send_at??null,media:q.media||[],attribs:{...(q.attribs||{}),shrigma:{...(q.attribs?.shrigma||{}),brand,initiative:d.initiative,utm_campaign:d.utm_campaign,audience_id:q.audience_id??q.attribs?.shrigma?.audience_id??null,audience_name:q.audience_name??q.attribs?.shrigma?.audience_name??null}}};
 }
 async function request(brand,method,path,body){
  const secret=binding(brand);let r;
  try{r=await fetchImpl('https://email.shrigma.com.br/api'+path,{method,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(60000),headers:{Accept:'application/json',Authorization:'Basic '+Buffer.from(secret.username+':'+secret.token).toString('base64'),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
  catch{throw error(502,'LISTMONK_RESULT_UNCONFIRMED');}
  if(!r.ok){await r.body?.cancel();throw error(r.status>=400&&r.status<500?r.status:502,'LISTMONK_HTTP_'+r.status);}
  let size=0,parts=[];for await(const b of r.body){size+=b.length;if(size>8*1024*1024)throw error(502,'LISTMONK_RESPONSE_LIMIT');parts.push(b);}
  let data;try{data=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw error(502,'LISTMONK_RESPONSE_UNCONFIRMED');}
  if(!Object.hasOwn(data,'data'))throw error(502,'LISTMONK_RESPONSE_UNCONFIRMED');return data.data;
 }
 async function handle(context,method,q){
  if(!q||!actions.has(q.acao)||!Object.hasOwn(bases,q.brand))throw error(400,'CAMPAIGN_INPUT');
  const brand=q.brand,action=q.acao,write=writing(action),user=authorize(context,brand,write),released=admitted(context,brand,user);
  if(write&&(!released||!allowedEditor(user)))throw error(403,'CAMPAIGN_RELEASE_CLOSED');
  if(method!==(write?'POST':'GET'))throw error(405,'METHOD_DENIED');
  if(action==='campanha_capacidade')return {status:200,body:{schema:'crm-listmonk-direct-v1',brand,read:true,draft:released&&allowedEditor(user),send:false,native_direct:true}};
  if(action==='campanha_catalogo'){
   const data=await request(brand,'GET','/lists?minimal=true&per_page=all'),rows=Array.isArray(data)?data:data.results;
   if(!Array.isArray(rows))throw error(502,'LISTMONK_RESPONSE_UNCONFIRMED');
   const lists=rows.filter(list=>binding(brand).listIds.includes(list.id)).map(list=>({id:list.id,name:list.name,brand,available:list.status==='active'}));
   // A null layout delegates selection to Listmonk when the campaign is
   // created. The existing campaign role does not read the template catalog.
   const templates=[{id:null,name:'Padrão do Listmonk',brand,type:'campaign',available:true,native_default:true}];
   return {status:200,body:{brand,current:true,read_at:new Date(now()).toISOString(),lists,templates,initiatives:[]}};
  }
  if(action==='campanha_listar'){
   const data=await request(brand,'GET','/campaigns?no_body=true&per_page=100&page='+Math.max(1,Number(q.page)||1));
   const rows=Array.isArray(data)?data:data.results;if(!Array.isArray(rows))throw error(502,'LISTMONK_RESPONSE_UNCONFIRMED');
   const campaigns=[];for(const row of rows)try{campaigns.push(campaign(row,brand));}catch(e){if(e.code!=='CAMPAIGN_BRAND_REFUSED')throw e;}
   const page=Math.max(1,Number(q.page)||1),total=Array.isArray(data)?data.length:data.total;
   return {status:200,body:{campaigns,total,page,has_more:!Array.isArray(data)&&page*100<total}};
  }
  if(action!=='campanha_criar'&&!idOk(q.id))throw error(400,'CAMPAIGN_INPUT');
  if(action==='campanha_obter')return {status:200,body:{campaign:campaign(await request(brand,'GET','/campaigns/'+q.id),brand)}};
  if(['campanha_salvar','campanha_cancelar'].includes(action)&&(!q.attribs||typeof q.attribs!=='object'||Array.isArray(q.attribs)||!Array.isArray(q.media)||q.acao==='campanha_salvar'&&!Array.isArray(q.headers)))throw error(400,'CAMPAIGN_INPUT');
  let data;
  const existing=async()=>campaign(await request(brand,'GET','/campaigns/'+q.id),brand);
  if(action==='campanha_criar'||action==='campanha_salvar'){const body=payload(q.definition,brand,q);if(action==='campanha_salvar')await existing();data=await request(brand,action==='campanha_criar'?'POST':'PUT','/campaigns'+(action==='campanha_criar'?'':'/'+q.id),body);}
  else if(action==='campanha_teste'){
   const target=String(q.recipient||'').trim().toLowerCase();
   if(target.length>254||target.includes('..')||!/^[a-z0-9][a-z0-9._+\-]*@(oaristocrata\.com|fishermans\.com\.br|shrigma\.com\.br)$/.test(target))throw error(400,'CAMPAIGN_TEST_RECIPIENT');
   const body=payload(q.definition,brand,q);body.subject='[TESTE] '+body.subject.replace(/^(?:\[TESTE\] )+/,'');body.subscribers=[target];delete body.send_at;
   await existing();data=await request(brand,'POST','/campaigns/'+q.id+'/test',body);if(data!==true)throw error(502,'LISTMONK_RESPONSE_UNCONFIRMED');
   return {status:200,body:{accepted:true,brand,campaign_id:q.id,recipient:target,subject:body.subject}};
  }else if(action==='campanha_agendar'){
   if(q.confirm!=='agendar')throw error(400,'CAMPAIGN_INPUT');
   if(!future(q.send_at))throw error(400,'NATIVE_INTERNAL_DATE');
   const current=await existing();if(!future(current.send_at)||Date.parse(current.send_at)!==Date.parse(q.send_at))throw error(400,'NATIVE_INTERNAL_DATE');
   data=await request(brand,'PUT','/campaigns/'+q.id+'/status',{status:'scheduled'});
  }else if(action==='campanha_cancelar'){
   if(q.confirm!=='cancelar'||!Array.isArray(q.list_ids)||!q.list_ids.length||q.list_ids.some(id=>!binding(brand).listIds.includes(id)))throw error(400,'CAMPAIGN_INPUT');
   await existing();data=await request(brand,'PUT','/campaigns/'+q.id,{lists:q.list_ids,send_at:null,attribs:q.attribs??{},media:q.media||[]});
  }
  if(!data||typeof data!=='object')throw error(502,'LISTMONK_RESPONSE_UNCONFIRMED');
  return {status:action==='campanha_criar'?201:200,body:{campaign:campaign(data,brand)}};
 }
 return Object.freeze({handle,actions});
}
module.exports={createDirect};
