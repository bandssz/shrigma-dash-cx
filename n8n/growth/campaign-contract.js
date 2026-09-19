/* One campaign contract for the dashboard and AI clients. No transport or secrets. */
'use strict';
const CampaignContract=(()=>{
 const VERSION='crm-campaign-v1',BRANDS={aristo:'oaristocrata.com',fish:'fishermans.com.br',olivas:'olivasdocampo.com'};
 const STORES={...BRANDS,olivas:'olivasdocampo.com.br'};
 const error=(code,message,field)=>{const e=new Error(message);e.code=code;e.field=field;throw e;};
 const text=(v,max,field)=>{if(typeof v!=='string'||!v.trim()||v.length>max)error('FIELD_INVALID',`Revise ${field}.`,field);return v.trim();};
 const slug=(v,field)=>{v=text(v,100,field);if(!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(v))error('SLUG_INVALID',`${field}: use letras minúsculas, números, hífen ou sublinhado.`,field);return v;};
 const array=v=>Array.isArray(v)?v:[];
 const positive=v=>Number.isSafeInteger(v)&&v>0;
 const utc=v=>{if(typeof v!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(v)||!Number.isFinite(Date.parse(v)))error('SCHEDULE_TIMEZONE','Informe data e hora com fuso horário.','send_at');const [y,m,d]=v.slice(0,10).split('-').map(Number),day=new Date(Date.UTC(y,m-1,d));if(day.getUTCFullYear()!==y||day.getUTCMonth()!==m-1||day.getUTCDate()!==d)error('SCHEDULE_TIMEZONE','Informe uma data válida com fuso horário.','send_at');return new Date(v).toISOString();};
 function normalize(input){
  if(!input||typeof input!=='object'||Array.isArray(input))error('DEFINITION_INVALID','Informe a campanha em JSON.');
  if(input.schema_version!==VERSION)error('CONTRACT_VERSION','Versão do contrato de campanha incompatível.','schema_version');
  if(!Object.hasOwn(BRANDS,input.brand))error('BRAND_INVALID','Escolha Fishermans, O Aristocrata ou Olivas do Campo.','brand');
  if(input.channel!=='email')error('CHANNEL_UNAVAILABLE','Este cadastro é de campanhas de e-mail. WhatsApp usa os templates e fluxos existentes.','channel');
  const initiative=input.initiative||{};
  const lists=[...new Set(array(input.list_ids))].sort((a,b)=>a-b);
  if(!lists.length||lists.length>30||!lists.every(positive))error('LISTS_INVALID','Selecione de uma a 30 listas válidas.','list_ids');
  if(!positive(input.template_id))error('TEMPLATE_INVALID','Escolha um template de campanha.','template_id');
  const sender=text(input.from_email,254,'from_email'),reply=text(input.reply_to,254,'reply_to');
  const mailbox="[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+";
  const senderAddress=sender.match(new RegExp('^('+mailbox+')$','i'))?.[1]||sender.match(new RegExp('^[^<>\\r\\n]+<('+mailbox+')>$','i'))?.[1];
  if(!senderAddress||senderAddress.split('@')[1].toLowerCase()!==BRANDS[input.brand]||/[\r\n]/.test(sender))error('SENDER_BRAND','Remetente não corresponde à marca.','from_email');
  if(!/^[^\s<>@]+@[^\s<>@]+$/.test(reply)||reply.split('@')[1].toLowerCase()!==BRANDS[input.brand])error('REPLY_BRAND','Reply-To não corresponde à marca.','reply_to');
  if(/[\r\n]/.test(input.subject||''))error('SUBJECT_INVALID','O assunto deve ter uma única linha.','subject');
  const html=text(input.html,300000,'html'),plain=text(input.text,100000,'text');
  if(!/\{\{\s*UnsubscribeURL\s*\}\}/.test(html)||!/\{\{\s*UnsubscribeURL\s*\}\}/.test(plain))error('UNSUBSCRIBE_MISSING','Inclua {{ UnsubscribeURL }} no HTML e na versão em texto.','html');
  if(/<(script|iframe|object|embed|form)\b|\bon[a-z]+\s*=|javascript\s*:/i.test(html))error('HTML_ACTIVE_CONTENT','Remova scripts, formulários e eventos do HTML.','html');
  const tags=[...new Set(array(input.tags).map(v=>slug(v,'tags')))];
  if(tags.length>20)error('TAGS_LIMIT','Use até 20 tags.','tags');
  return {schema_version:VERSION,brand:input.brand,channel:'email',initiative:{key:slug(initiative.key,'initiative.key'),name:text(initiative.name,160,'initiative.name')},utm_campaign:slug(input.utm_campaign,'utm_campaign'),name:text(input.name,200,'name'),subject:text(input.subject,250,'subject'),from_email:sender,reply_to:reply,list_ids:lists,template_id:input.template_id,html,text:plain,tags,send_at:input.send_at?utc(input.send_at):null};
 }
 function checkCatalog(d,catalog){
  if(!catalog||catalog.brand!==d.brand||catalog.current!==true)error('CATALOG_UNAVAILABLE','Consulte o catálogo atual da marca antes de salvar.');
  const lists=array(catalog.lists),templates=array(catalog.templates);
  if(d.list_ids.some(id=>!lists.some(l=>l.id===id&&l.brand===d.brand&&l.available===true)))error('LIST_SCOPE','Uma lista não está disponível para esta marca.','list_ids');
  if(!templates.some(t=>t.id===d.template_id&&t.type==='campaign'&&t.available===true))error('TEMPLATE_SCOPE','Template de campanha não disponível.','template_id');
  const mapping=array(catalog.initiatives).find(i=>i.utm_campaign===d.utm_campaign);
  if(mapping&&mapping.key!==d.initiative.key)error('INITIATIVE_CONFLICT','Esta UTM já pertence a outra iniciativa.','initiative.key');
 }
 function prepare(input,{catalog,tracking,trackingId,now=Date.now()}={}){
  const d=normalize(input);checkCatalog(d,catalog);
  if(!tracking||typeof tracking.prepare!=='function')error('TRACKING_UNAVAILABLE','Preparador de rastreamento indisponível.');
  if(!positive(trackingId))error('TRACKING_ID_REQUIRED','A API deve reservar a identidade do disparo.');
  const p=tracking.prepare({id:trackingId,status:'draft',sent:0,started_at:null,content_type:'html',body_source:null,lists:d.list_ids,body:d.html,altbody:d.text},{brand:d.brand,campaign:d.utm_campaign,now});
  // The server reserves the real Listmonk draft ID before preparing; no invented subscriber IDs.
  const urls=[...p.body.matchAll(/https?:\/\/[^\s<>"']+/g),...String(p.altbody||'').matchAll(/https?:\/\/[^\s<>"']+/g)];
  if(!urls.some(m=>{try{let u=new URL(m[0].replace(/@TrackLink$/,'').replace(/&amp;/g,'&'));if(![STORES[d.brand],'www.'+STORES[d.brand]].includes(u.hostname))return false;if(u.pathname.startsWith('/discount/'))u=new URL(u.searchParams.get('redirect'),u.origin);const t=u.searchParams.get('utm_term')||'';return /^\/(products|pages|collections)\//.test(u.pathname)&&(t===p.token||t.endsWith('--'+p.token));}catch{return false;}}))error('NO_COMMERCIAL_LINK','Inclua ao menos um link comercial da loja.','html');
  return {definition:{...d,html:p.body,text:p.altbody},tracking:{policy:VERSION,term:p.token,list_ids:p.lists,changed_links:p.changes.length},payload:{name:d.name,subject:d.subject,from_email:d.from_email,headers:[{'Reply-To':d.reply_to}],type:'regular',content_type:'html',body:p.body,altbody:p.altbody,body_source:null,lists:d.list_ids,template_id:d.template_id,tags:d.tags,messenger:'email',send_at:d.send_at,attribs:{crm:{policy:VERSION,brand:d.brand,initiative_key:d.initiative.key,initiative_name:d.initiative.name,utm_campaign:d.utm_campaign,tracking_term:p.token}}}};
 }
 function schedule(request,current,{now=Date.now(),canPublish=false}={}){
  if(!canPublish)error('CAPABILITY_MISSING','Esta chave não pode agendar campanhas.');
  if(request?.confirm!=='agendar')error('CONFIRM_REQUIRED','Confirme o agendamento da campanha revisada.');
  if(!current||!positive(current.id)||!request.expected_version||request.expected_version!==current.version)error('VERSION_CONFLICT','A campanha mudou. Recarregue antes de agendar.');
  if(current.status!=='draft'||current.sent!==0||current.started_at)error('CAMPAIGN_ALREADY_STARTED','Só é possível agendar um rascunho ainda não iniciado.');
  if(current.validation?.policy!==VERSION||current.validation?.version!==current.version||current.validation?.ok!==true)error('VALIDATION_STALE','Valide a versão atual antes de agendar.');
  if(!current.send_at||!Number.isFinite(Date.parse(current.send_at))||Date.parse(current.send_at)<now+15*60e3)error('SCHEDULE_TOO_SOON','Agende com pelo menos 15 minutos de antecedência.');
  return {method:'PUT',path:`/api/campaigns/${current.id}/status`,body:{status:'scheduled'}};
 }
 function cancel(request,current,{now=Date.now(),canPublish=false}={}){
  if(!canPublish)error('CAPABILITY_MISSING','Esta chave não pode cancelar agendamentos.');
  if(request?.confirm!=='cancelar')error('CONFIRM_REQUIRED','Confirme o cancelamento do agendamento revisado.');
  if(!current||!positive(current.id)||!request.expected_version||request.expected_version!==current.version)error('VERSION_CONFLICT','A campanha mudou. Recarregue antes de cancelar.');
  if(current.status!=='scheduled'||current.sent!==0||current.started_at!==null)error('CAMPAIGN_ALREADY_STARTED','Só é possível cancelar uma campanha agendada ainda não iniciada.');
  if(!current.send_at||!Number.isFinite(Date.parse(current.send_at))||Date.parse(current.send_at)<=now)error('SCHEDULE_NOT_FUTURE','O agendamento precisa continuar no futuro para ser cancelado.');
  // This is the guarded provider action, not Listmonk's native status route.
  return {action:'cancel',id:current.id,expected_version:current.version};
 }
 function request(action,input,{idempotencyKey,expectedVersion}={}){
  const allowed=['catalogo','listar','obter','salvar','validar','agendar','cancelar','operacao'];
  if(!allowed.includes(action))error('ACTION_INVALID','Ação de campanha inválida.');
  if(['salvar','validar','agendar','cancelar'].includes(action)&&!/^[a-zA-Z0-9_-]{16,100}$/.test(idempotencyKey||''))error('IDEMPOTENCY_REQUIRED','Informe uma chave de idempotência para esta operação.');
  return {...input,acao:'campanha_'+action,...(idempotencyKey?{idempotency_key:idempotencyKey}:{}),...(expectedVersion?{expected_version:expectedVersion}:{})};
 }
 return {VERSION,BRANDS,STORES,normalize,checkCatalog,prepare,schedule,cancel,request};
})();
if(typeof module!=='undefined')module.exports=CampaignContract;
