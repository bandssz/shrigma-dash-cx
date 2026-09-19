/* Server adapter. Native create/compile are injected; SQL performs guarded writes.
   Do not advertise remote campaigns until native compilation and runtime are wired. */
'use strict';
const C=require('./campaign-contract');
const MESSAGES={CAMPAIGN_EDITOR_REQUIRED:'Esta campanha é gerida pelo painel. Recarregue a versão atual antes de editar.',CAMPAIGN_REVIEW_REQUIRED:'A campanha precisa ser validada e agendada pelo painel.',CAMPAIGN_DEPENDENCY_IN_USE:'Uma campanha agendada, em execução ou pausada utiliza este recurso. Cancele a campanha antes de alterar o recurso.'};
const ERRORS=new Set(['CAMPAIGN_OPERATION_INVALID','CAMPAIGN_NOT_FOUND','CAMPAIGN_SCOPE','VERSION_CONFLICT','CAMPAIGN_LOCKED','LIST_SCOPE','TEMPLATE_SCOPE','TEMPLATE_CHANGED','INITIATIVE_INVALID','INITIATIVE_CONFLICT','VALIDATION_STALE','SCHEDULE_TOO_SOON','INITIATIVE_MISSING','CONTENT_UNVALIDATED','CONTENT_EMPTY','CAMPAIGN_EDITOR_REQUIRED','CAMPAIGN_REVIEW_REQUIRED','CAMPAIGN_DEPENDENCY_IN_USE','CAMPAIGN_CREATE_DRAFT_ONLY','CAMPAIGN_ADOPTION_REQUIRED']);
function createProvider({query,nativeCreate,validateContent}){
 if(typeof query!=='function'||typeof nativeCreate!=='function'||typeof validateContent!=='function')throw Error('Postgres, native create and content compilation adapters are required');
 async function call(action,payload){
  try{
   const r=await query('SELECT public.shrigma_campaign_provider($1::text,$2::jsonb) AS result',[action,JSON.stringify(payload)]);
   if(!r||!Array.isArray(r.rows)||r.rows.length!==1||!Object.hasOwn(r.rows[0],'result'))throw Error('Provider result unavailable');
   return r.rows[0].result;
  }catch(e){
   // A PostgreSQL exception aborts this entire statement; network failures don't prove rollback.
   if(['55P03','40P01','40001'].includes(e.code))throw Object.assign(new Error('Outra alteração está em andamento. Recarregue a campanha e confira a versão antes de tentar novamente.'),{code:'CAMPAIGN_BUSY',status:409,nothingChanged:true});
   if(e.code==='P0001'&&ERRORS.has(e.message))throw Object.assign(new Error(MESSAGES[e.message]||e.message),{code:e.message,status:e.message==='CAMPAIGN_NOT_FOUND'?404:409,nothingChanged:true});
   throw e;
  }
 }
 const get=id=>call('get',{id});
 const catalog=brand=>call('catalog',{brand});
 return {
  get,catalog,list:brand=>call('list',{brand}),
  async createDraft(input,{operationId}){
   const d=C.normalize(input);
   if(!['aristo','fish'].includes(d.brand))throw Object.assign(Error('Marca fora desta etapa.'),{code:'BRAND_UNAVAILABLE',status:422,nothingChanged:true});
   C.checkCatalog(d,await catalog(d.brand));
   // Null send_at is deliberate: creation never schedules, even if definition carries a date.
   const c=await nativeCreate({name:d.name,subject:d.subject,from_email:d.from_email,type:'regular',content_type:'html',
    body:d.html,altbody:d.text,body_source:null,send_at:null,headers:[{'Reply-To':d.reply_to}],lists:d.list_ids,
    template_id:d.template_id,tags:d.tags,messenger:'email',attribs:{crm:{policy:C.VERSION,brand:d.brand,
     initiative_key:d.initiative.key,initiative_name:d.initiative.name,utm_campaign:d.utm_campaign,created_operation_id:operationId}}});
   if(!Number.isSafeInteger(c?.id)||c.id<=0)throw Error('Native draft identity unavailable');
   const r=await get(c.id);
   if(!r||r.status!=='draft'||r.sent!==0||r.started_at||r.send_at!==null||r.definition?.brand!==d.brand)throw Error('Native draft not confirmed');
   return r;
  },
  async updateDraft(id,prepared,{expectedVersion,operationId}){
   const d=C.normalize(prepared.definition),cat=await catalog(d.brand);C.checkCatalog(d,cat);
   const templateVersion=cat.templates.find(t=>t.id===d.template_id)?.version;
   if(!templateVersion)throw Object.assign(Error('Template sem versão verificável.'),{code:'TEMPLATE_CHANGED',status:409,nothingChanged:true});
   // The compiler must cover subject, HTML, text and wrapper, without test sends.
   const proof=await validateContent({id,definition:d,templateVersion});
   if(proof?.ok!==true||proof.templateVersion!==templateVersion)throw Object.assign(Error('Compilação do conteúdo não confirmada.'),{code:'CONTENT_UNVALIDATED',status:422,nothingChanged:true});
   return call('update',{id,expectedVersion,operationId,definition:d,templateVersion,contentValidated:true});
  },
  schedule:(id,{expectedVersion,operationId})=>call('schedule',{id,expectedVersion,operationId}),
  cancel:(id,{expectedVersion,operationId})=>call('cancel',{id,expectedVersion,operationId})
 };
}
module.exports={createProvider};
