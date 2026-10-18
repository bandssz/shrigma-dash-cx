/* One campaign contract for the dashboard and AI clients. No transport or secrets. */
'use strict';
const CampaignContract=(()=>{
 const VERSION='crm-campaign-v1',BRANDS={aristo:'oaristocrata.com',fish:'fishermans.com.br',olivas:'olivasdocampo.com'};
 const OWNER_CONFIRMED_SENDERS=Object.freeze({aristo:Object.freeze(['avisos@oaristocrata.com','avisos@marketing.oaristocrata.com']),fish:Object.freeze(['avisos@fishermans.com.br','avisos@marketing.fishermans.com.br'])});
 const STORES={...BRANDS,olivas:'olivasdocampo.com.br'};
 const error=(code,message,field)=>{const e=new Error(message);e.code=code;e.field=field;throw e;};
 const text=(v,max,field)=>{if(typeof v!=='string'||!v.trim()||v.length>max)error('FIELD_INVALID',`Revise ${field}.`,field);return v.trim();};
 const slug=(v,field)=>{v=text(v,100,field);if(!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(v))error('SLUG_INVALID',`${field}: use letras minúsculas, números, hífen ou sublinhado.`,field);return v;};
 const array=v=>Array.isArray(v)?v:[];
 const positive=v=>Number.isSafeInteger(v)&&v>0;
 const utc=v=>{if(typeof v!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(v)||!Number.isFinite(Date.parse(v)))error('SCHEDULE_TIMEZONE','Informe data e hora com fuso horário.','send_at');const clock=v.slice(11,19).split(':').map(Number);if(clock[0]>23||clock[1]>59||(clock.length>2&&clock[2]>59))error('SCHEDULE_TIMEZONE','Informe uma hora válida com fuso horário.','send_at');const [y,m,d]=v.slice(0,10).split('-').map(Number),day=new Date(Date.UTC(y,m-1,d));if(day.getUTCFullYear()!==y||day.getUTCMonth()!==m-1||day.getUTCDate()!==d)error('SCHEDULE_TIMEZONE','Informe uma data válida com fuso horário.','send_at');return new Date(v).toISOString();};
 // Admission for NEW sends only. Historical normalization/receipts stay intact.
 function senderProfile(brand,confirmed={}){
  const domain=['fish','aristo'].includes(brand)?BRANDS[brand]:null,allowed=domain?['avisos@'+domain,'avisos@marketing.'+domain]:[];
  return {brand,from:allowed.filter(v=>Array.isArray(confirmed?.[brand])&&confirmed[brand].includes(v)),reply_to:domain?'contato@'+domain:null};
 }
 function senderIdentityAllowed(brand,from,reply,confirmed={}){
  if(typeof from!=='string'||from.length>254||/[\u0000-\u001f\u007f]/.test(from)||typeof reply!=='string'||/[\u0000-\u001f\u007f]/.test(reply))return false;
  const address=from.match(/^([^\s<>@]+@[^\s<>@]+)$/)?.[1]||from.match(/^[^<>\r\n]+<([^\s<>@]+@[^\s<>@]+)>$/)?.[1],profile=senderProfile(brand,confirmed);
  return !!address&&profile.from.includes(address.toLowerCase())&&reply.toLowerCase()===profile.reply_to;
 }
 function requireSender(input){if(['fish','aristo'].includes(input?.brand)&&!senderIdentityAllowed(input.brand,input.from_email,input.reply_to,OWNER_CONFIRMED_SENDERS))error('SENDER_REVIEW_REQUIRED','Escolha um remetente avisos da marca e contato como endereço de respostas.','from_email');return input;}
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
  if(!senderAddress||(senderAddress.split('@')[1].toLowerCase()!==BRANDS[input.brand]&&!(['fish','aristo'].includes(input.brand)&&senderAddress.toLowerCase()==='avisos@marketing.'+BRANDS[input.brand]))||/[\r\n]/.test(sender))error('SENDER_BRAND','Remetente não corresponde à marca.','from_email');
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
 function preflight(input,{catalog,tracking,now=Date.now()}={}){
  const d=normalize(input);checkCatalog(d,catalog);
  if(!tracking||typeof tracking.check!=='function')error('TRACKING_UNAVAILABLE','Conferência dos links indisponível.');
  let check;try{check=tracking.check({status:'draft',sent:0,started_at:null,content_type:'html',body_source:null,lists:d.list_ids,body:d.html,altbody:d.text},{brand:d.brand,campaign:d.utm_campaign,now});}
  catch{error('TRACKING_INVALID','Confira os destinos e as UTMs dos links comerciais antes de salvar.','html');}
  if(!Number.isSafeInteger(check?.commercial_links)||check.commercial_links<1)error('NO_COMMERCIAL_LINK','Inclua ao menos um link para produto, página ou coleção da loja.','html');
  return d;
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
 // New editor drafts use an explicit save/receipt policy. Existing complete
 // definitions and their historical tracking preparations remain byte-identical.
 const DRAFT_WRITES_ENABLED=false,DRAFT_EDITOR_TAG='crm-draft-editor-v2',DRAFT_POLICY='crm-campaign-draft-v1';
 const isEditorDraft=input=>Array.isArray(input?.tags)&&input.tags.includes(DRAFT_EDITOR_TAG);
 function draftSlug(name){
  const value=name.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,90).replace(/-+$/,'');
  if(value)return value;
  let h=2166136261;for(const c of name)h=Math.imul(h^c.codePointAt(0),16777619)>>>0;return 'campanha-'+h.toString(16);
 }
 function normalizeDraft(input,{catalog}={}){
  if(!isEditorDraft(input)||input.schema_version!==VERSION||!['fish','aristo'].includes(input.brand)||input.channel!=='email'||input.send_at!==null)error('DRAFT_INPUT','Preencha nome e assunto e salve sem horário.');
  const name=text(input.name,200,'name'),subject=text(input.subject,250,'subject'),derived=draftSlug(name),domain=BRANDS[input.brand];
  if(/[\r\n]/.test(subject))error('SUBJECT_INVALID','Use uma única linha no assunto.','subject');
  const from=input.from_email||'avisos@'+domain,reply=input.reply_to||'contato@'+domain;
  const address=typeof from==='string'?(from.match(/^([^\s<>@]+@[^\s<>@]+)$/)?.[1]||from.match(/^[^<>\r\n]+<([^\s<>@]+@[^\s<>@]+)>$/)?.[1]):null;
  if(!address||from.length>254||/[\u0000-\u001f\u007f]/.test(from)||!['avisos@'+domain,'avisos@marketing.'+domain].includes(address.toLowerCase()))error('SENDER_BRAND','Escolha um remetente confirmado da marca.','from_email');
  if(reply!=='contato@'+domain)error('REPLY_BRAND','O endereço de respostas é fixo para esta marca.','reply_to');
  if(input.list_ids!==undefined&&!Array.isArray(input.list_ids))error('LISTS_INVALID','Escolha um público salvo.','list_ids');
  const lists=[...new Set(input.list_ids||[])].sort((a,b)=>a-b);
  if(lists.length>30||!lists.every(v=>positive(v)&&v<=2147483647))error('LISTS_INVALID','Escolha listas válidas da marca.','list_ids');
  const template=input.template_id??catalog?.templates?.find(t=>t.available===true&&t.type==='campaign')?.id;
  if(!positive(template)||template>2147483647)error('TEMPLATE_INVALID','O layout padrão da marca não foi confirmado.','template_id');
  const html=input.html??'',plain=input.text??'';
  if(typeof html!=='string'||html.length>300000||typeof plain!=='string'||plain.length>100000)error('FIELD_INVALID','Confira o tamanho do conteúdo.','html');
  if(/<(script|iframe|object|embed|form)\b|\bon[a-z]+\s*=|javascript\s*:/i.test(html))error('HTML_ACTIVE_CONTENT','Remova conteúdo ativo da peça.','html');
  const tags=[...new Set(array(input.tags).map(v=>slug(v,'tags')))];
  if(/^\s*\[TESTE\]/i.test(name)||/^\s*\[TESTE\]/i.test(subject)){if(!tags.includes('crm-internal-test'))tags.push('crm-internal-test');}
  if(tags.length>20)error('TAGS_LIMIT','Use até 20 etiquetas.','tags');
  const d={schema_version:VERSION,brand:input.brand,channel:'email',initiative:{key:slug(input.initiative?.key||derived,'initiative.key'),name:text(input.initiative?.name||name.slice(0,160),160,'initiative.name')},utm_campaign:slug(input.utm_campaign||derived,'utm_campaign'),name,subject,from_email:address.toLowerCase(),reply_to:reply,list_ids:lists,template_id:template,html,text:plain,tags,send_at:null};
  checkCatalog(d,catalog);return d;
 }
 function draftTracking(d){return{policy:DRAFT_POLICY,term:null,list_ids:[...d.list_ids],changed_links:0};}
 function prepareDraft(input,{catalog,tracking,trackingId,now=Date.now(),initial=false}={}){
  const d=normalizeDraft(input,{catalog});
  if(!positive(trackingId))error('TRACKING_ID_REQUIRED','A identidade do rascunho não foi confirmada.');
  // Initial creation can retain an idea without a recipient or dispatch token.
  // A subsequent save of complete content reuses the original preparation.
  if(!initial){
   try{preflight(d,{catalog,tracking,now});return prepare(d,{catalog,tracking,trackingId,now});}
   catch(e){if(!['LISTS_INVALID','FIELD_INVALID','UNSUBSCRIBE_MISSING','NO_COMMERCIAL_LINK','TRACKING_INVALID'].includes(e.code))throw e;}
  }
  return{definition:d,tracking:draftTracking(d)};
 }

 const AUDIENCE_POLICY='listmonk-6.1-regular-v1',AUDIENCE_TTL_MS=300000;
 function audienceReview(a,current,{now=Date.now(),allowBlocked=false}={}){
  const counts=['eligible_count','unique_members_count','excluded_blocklisted_count','excluded_subscription_count','native_disabled_count'];
  if(!a||a.policy!==AUDIENCE_POLICY||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(a.review_id||'')||a.frozen!==false||
   a.campaign_id!==current?.id||a.campaign_version!==current?.version||a.brand!==current?.definition?.brand||
   JSON.stringify(a.list_ids)!==JSON.stringify(current?.definition?.list_ids)||counts.some(k=>!Number.isSafeInteger(a[k])||a[k]<0)||
   a.unique_members_count!==a.eligible_count+a.excluded_blocklisted_count+a.excluded_subscription_count||a.native_disabled_count>a.eligible_count)
   error('AUDIENCE_REVIEW_REQUIRED','Valide o público da versão salva antes de agendar.');
  let checked,expires;try{checked=Date.parse(utc(a.checked_at));expires=Date.parse(utc(a.expires_at));}catch{error('AUDIENCE_REVIEW_REQUIRED','Horário da revisão de público inválido.');}
  if(!Number.isFinite(now)||expires-checked!==AUDIENCE_TTL_MS||checked>now+30000||expires<=now)error('AUDIENCE_STALE','A conferência do público venceu. Valide novamente antes de confirmar.');
  if(!allowBlocked&&a.native_disabled_count>0)error('AUDIENCE_DISABLED','Há destinatários desativados no público nativo. Resolva a política antes de agendar.');
  if(!allowBlocked&&a.eligible_count===0)error('AUDIENCE_EMPTY','Não há destinatários elegíveis agora.');
  return a;
 }
 function schedule(request,current,{now=Date.now(),canPublish=false}={}){
  if(!canPublish)error('CAPABILITY_MISSING','Esta chave não pode agendar campanhas.');
  if(request?.confirm!=='agendar')error('CONFIRM_REQUIRED','Confirme o agendamento da campanha revisada.');
  if(!current||!positive(current.id)||!request.expected_version||request.expected_version!==current.version)error('VERSION_CONFLICT','A campanha mudou. Recarregue antes de agendar.');
  if(current.status!=='draft'||current.sent!==0||current.started_at)error('CAMPAIGN_ALREADY_STARTED','Só é possível agendar um rascunho ainda não iniciado.');
  if(current.validation?.policy!==VERSION||current.validation?.version!==current.version||current.validation?.ok!==true)error('VALIDATION_STALE','Valide a versão atual antes de agendar.');
  if(!current.send_at||!Number.isFinite(Date.parse(current.send_at))||Date.parse(utc(current.send_at))<now+15*60e3)error('SCHEDULE_TOO_SOON','Agende com pelo menos 15 minutos de antecedência.');
  const audience=audienceReview(current.validation.audience,current,{now});
  if(request.audience_review_id!==audience.review_id)error('AUDIENCE_REVIEW_REQUIRED','Confirme a revisão de público exibida.');
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
  const allowed=['catalogo','listar','obter','salvar','validar','agendar','cancelar','operacao','recuperar'];
  if(!allowed.includes(action))error('ACTION_INVALID','Ação de campanha inválida.');
  if(['salvar','validar','agendar','cancelar','recuperar'].includes(action)&&!/^[a-zA-Z0-9_-]{16,100}$/.test(idempotencyKey||''))error('IDEMPOTENCY_REQUIRED','Informe uma chave de idempotência para esta operação.');
  return {...input,acao:'campanha_'+action,...(idempotencyKey?{idempotency_key:idempotencyKey}:{}),...(expectedVersion?{expected_version:expectedVersion}:{})};
 }
 return {DRAFT_WRITES_ENABLED,DRAFT_EDITOR_TAG,DRAFT_POLICY,isEditorDraft,draftSlug,normalizeDraft,draftTracking,prepareDraft,OWNER_CONFIRMED_SENDERS,requireSender,senderProfile,senderIdentityAllowed,VERSION,BRANDS,STORES,AUDIENCE_POLICY,AUDIENCE_TTL_MS,audienceReview,normalize,checkCatalog,preflight,prepare,schedule,cancel,request};
})();
if(typeof module!=='undefined')module.exports=CampaignContract;
