/* Portal-only campaign editor with explicit unbound CREATE drafts. It consumes the closed BFF DTO;
   legacy Growth receipt/capability objects are never synthesized. */
'use strict';
function createCampaignEditor({document,getSession,request,storage,locks,now=Date.now,uuid=()=>globalThis.crypto.randomUUID(),createClient=globalThis.ShrigmaCampaignBffClient?.createCampaignBffClient}){
 const $=id=>document.getElementById('campaign-'+id),dialog=document.getElementById('entry-campaign-dialog'),opener=document.getElementById('entry-campaign-open');
 const clone=v=>JSON.parse(JSON.stringify(v)),brands={fish:'Fishermans',aristo:'O Aristocrata'},views=new Map(),busy=new Set();
 let opened=false,epoch=0;
 const corporateBrand=()=>{const u=getSession()?.user;return u?.role==='manager'&&u.brandAccess==='single'&&Object.hasOwn(brands,u.brand)&&Array.isArray(u.brands)&&u.brands.length===1&&u.brands[0]===u.brand?u.brand:null;};
 const allowed=()=>{const s=getSession();return corporateBrand()!==null&&s?.authenticated===true&&s.features?.campaignSubmitWrite===true&&s.user?.role==='manager'&&s.user.areas?.length===1&&s.user.areas[0]==='growth'&&s.user.permissions?.growth?.read===true&&s.user.permissions.growth.edit===true;};
 const historyAllowed=()=>{const s=getSession();return corporateBrand()!==null&&s?.authenticated===true&&s.features?.campaignHistoryRead===true&&s.user?.role==='manager'&&s.user.areas?.length===1&&s.user.areas[0]==='growth'&&s.user.permissions?.growth?.read===true&&s.user.permissions.growth.edit===true;};
 const accessible=()=>allowed()||historyAllowed();
 const createAllowed=()=>allowed()&&getSession()?.features?.campaignCreate!==false;
 const scopeKey=s=>'shrigma_campaign_bff_v1:'+s.uiKey+':'+s.brand;
 const readJournal=s=>{const raw=storage.getItem(scopeKey(s));if(raw===null)return null;if(typeof raw!=='string'||raw.length>300000)throw Error();return JSON.parse(raw);};
 const client=createClient({request,getSession,readJournal,writeJournal:(s,row)=>storage.setItem(scopeKey(s),JSON.stringify(row))});
 const brand=()=>$('brand').value,view=b=>{if(!views.has(b))views.set(b,{campaign:null,validation:null,failed:false,creating:false,newDefinition:null});return views.get(b);};
 const current=()=>view(brand()),say=text=>{$('status').textContent=text;};
 const record=b=>readJournal({uiKey:getSession().uiKey,brand:b});
 const pending=b=>{try{return ['pending','uncertain'].includes(record(b)?.phase);}catch{return true;}};
 const stamp=b=>({b,epoch,owner:getSession()?.uiKey}),live=s=>opened&&accessible()&&s.b===corporateBrand()&&epoch===s.epoch&&brand()===s.b&&getSession()?.uiKey===s.owner;
 const iso=value=>value?new Date(value).toISOString():null;
 const local=value=>{if(!value)return '';const d=new Date(value),n=v=>String(v).padStart(2,'0');return d.getFullYear()+'-'+n(d.getMonth()+1)+'-'+n(d.getDate())+'T'+n(d.getHours())+':'+n(d.getMinutes());};
 const definition=()=>{const v=current(),d=clone(v.creating?v.newDefinition:v.campaign.definition);if(v.creating){d.initiative={key:$('initiative-key').value,name:$('initiative-name').value};d.utm_campaign=$('utm').value;}for(const [field,key]of [['name','name'],['subject','subject'],['from','from_email'],['reply','reply_to'],['html','html'],['text','text']])d[key]=$(field).value;if(v.creating)d.send_at=null;else if($('time').value!==local(d.send_at))d.send_at=iso($('time').value);d.template_id=Number($('template').value);d.list_ids=[...$('lists').querySelectorAll('input:checked')].map(n=>Number(n.value)).sort((a,b)=>a-b);return d;};
 const dirty=()=>{try{return JSON.stringify(definition())!==JSON.stringify(current().campaign?.definition);}catch{return true;}};
 const draft=c=>c?.status==='draft'&&c.sent===0&&c.started_at===null;
 function reviewReady(){const c=current().campaign,v=current().validation,a=v?.audience;return draft(c)&&!dirty()&&v?.ok===true&&v.version===c.version&&a?.campaign_version===c.version&&a.campaign_id===c.id&&a.brand===brand()&&Date.parse(a.checked_at)<=now()+30000&&Date.parse(a.expires_at)>now()&&a.eligible_count>0&&a.native_disabled_count===0&&Date.parse(c.send_at)>=now()+900000;}
 function paint(){
  const b=brand(),v=current(),c=v.campaign,locked=!allowed()||busy.has(b)||pending(b)||v.failed,write=typeof locks?.request==='function';
  $('select').disabled=!allowed();
  $('fields').disabled=locked||!v.creating&&!draft(c);$('save').disabled=locked||!write||v.creating||!draft(c);
  $('new').hidden=!createAllowed();$('new').disabled=locked||!write||!createAllowed()||!v.catalog;$('create').hidden=!v.creating||!createAllowed();$('create').disabled=locked||!write||!createAllowed()||!v.creating;$('create-details').hidden=!v.creating;$('time').disabled=v.creating;$('confirm').disabled=v.creating;
  $('validate').disabled=locked||!write||!draft(c)||dirty();
  $('schedule').disabled=locked||!write||!reviewReady()||!$('confirm').checked;
  $('cancel').disabled=locked||!write||c?.status!=='scheduled'||c.sent!==0||c.started_at!==null||Date.parse(c.send_at)<=now()||!$('confirm').checked;
  let row;try{row=record(b);}catch{}$('consult').disabled=busy.has(b)||!row;
  $('state').textContent=v.creating?'Novo rascunho · ainda sem ID; criação não agenda envio.':c?'Campanha '+c.id+' · '+c.status+(c.send_at?' · '+new Date(c.send_at).toLocaleString():''):'';
  $('review').textContent=reviewReady()?'Público conferido: '+v.validation.audience.eligible_count+' pessoas. Validade até '+new Date(v.validation.audience.expires_at).toLocaleTimeString()+'.':v.validation?'A conferência perdeu a validade ou o conteúdo mudou. Confira novamente.':'Uma nova conferência é necessária antes de agendar.';
  if(!allowed()&&historyAllowed()){
   $('state').textContent=v.history?.campaign?'Campanha '+v.history.campaign.id+' · '+v.history.campaign.status+' (resultado consultado)':'Somente consulta de tentativas';
   $('review').textContent='A leitura está indisponível. Consulte somente as tentativas anteriores; novas alterações exigem renovar o acesso.';
  }
  if(!write&&allowed())say('A edição precisa da proteção entre abas deste navegador. A consulta continua disponível.');
 }
 function option(select,value,label){const o=document.createElement('option');o.value=String(value);o.textContent=label;select.append(o);}
 function fill(){
  const v=current(),c=v.campaign;if(!v.creating&&!c){paint();return;}const d=v.creating?v.newDefinition:c.definition;
  if(v.creating){$('initiative-key').value=d.initiative.key;$('initiative-name').value=d.initiative.name;$('utm').value=d.utm_campaign;}
  for(const [field,key]of [['name','name'],['subject','subject'],['from','from_email'],['reply','reply_to'],['html','html'],['text','text']])$(field).value=d[key];$('time').value=local(d.send_at);$('confirm').checked=false;
  $('template').replaceChildren();for(const t of v.catalog.templates.filter(t=>t.available===true&&t.type==='campaign'))option($('template'),t.id,t.name||'Template '+t.id);$('template').value=String(d.template_id);
  $('lists').replaceChildren();for(const list of v.catalog.lists.filter(l=>l.available===true&&l.brand===brand())){const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.value=String(list.id);input.checked=d.list_ids.includes(list.id);label.append(input,document.createTextNode(' '+(list.name||'Lista '+list.id)));$('lists').append(label);}paint();
 }
 const valid=c=>c&&Number.isSafeInteger(c.id)&&c.id>0&&/^[a-f0-9]{32}$/i.test(c.version||'')&&['draft','scheduled','running','paused','finished','cancelled'].includes(c.status)&&Number.isSafeInteger(c.sent)&&c.sent>=0&&Object.hasOwn(c,'started_at')&&Object.hasOwn(c,'send_at')&&c.definition?.schema_version==='crm-campaign-v1'&&c.definition.brand===brand()&&Array.isArray(c.definition.list_ids);
 async function read(acao,b,id){if(b!==corporateBrand())throw Error('brand_scope_mismatch');const s=getSession(),path='/api/campaigns?'+new URLSearchParams({acao,brand:b,...(id?{id:String(id)}:{})});const r=await request({method:'GET',path,headers:{Accept:'application/json','X-CSRF-Token':s.csrf}});if(r.status!==200)throw Error();return r.body;}
 async function reopen(id,s){const r=await read('campanha_obter',s.b,id);if(!live(s))return;if(!valid(r.campaign)||r.campaign.id!==id)throw Error();const v=current();v.campaign=clone(r.campaign);v.failed=false;v.creating=false;v.newDefinition=null;if(v.validation?.version!==r.campaign.version)v.validation=null;if(![...$('select').querySelectorAll('option')].some(o=>o.value===String(id)))option($('select'),id,r.campaign.definition.name+' · '+r.campaign.status);$('select').value=String(id);fill();}
 function clear(){for(const field of ['name','subject','from','reply','html','text','time','initiative-key','initiative-name','utm'])$(field).value='';$('template').replaceChildren();$('lists').replaceChildren();$('confirm').checked=false;}
 function newDraft(){
  const v=current(),b=brand();if(!opened||!createAllowed()||busy.has(b)||pending(b)||v.failed||!v.catalog||typeof locks?.request!=='function')return;
  const domain=b==='fish'?'fishermans.com.br':'oaristocrata.com';v.campaign=null;v.validation=null;v.creating=true;
  v.newDefinition={schema_version:'crm-campaign-v1',brand:b,channel:'email',initiative:{key:'',name:''},utm_campaign:'',name:'',subject:'',from_email:'contato@'+domain,reply_to:'contato@'+domain,list_ids:[],template_id:v.catalog.templates.find(t=>t.available===true&&t.type==='campaign')?.id||0,html:'{{ UnsubscribeURL }}',text:'{{ UnsubscribeURL }}',tags:[],send_at:null};
  fill();say('Preencha a iniciativa, a campanha, as listas e os links comerciais. Criar conserva um rascunho sem agendamento.');$('name').focus();
 }
 async function loadHistory(){
  const b=brand(),s=stamp(b),v=current();v.failed=true;v.campaign=null;v.validation=null;v.creating=false;v.newDefinition=null;v.catalog=null;v.history=null;clear();paint();
  try{const saved=record(b);if(!saved){say('Não há tentativa salva nesta marca e neste acesso.');return;}
   const consult=()=>client.consult(b),result=typeof locks?.request==='function'?await locks.request('shrigma-campaign-bff:'+s.owner+':'+b,{mode:'exclusive',ifAvailable:true},lock=>{if(!lock)throw Error();return consult();}):await consult();
   if(!live(s))return;v.history=result;say(result.state==='pending'?'Tentativa ainda sem confirmação. Consulte o mesmo registro; o pedido não será repetido.':result.state==='rejected'?'A tentativa anterior foi recusada. Renove a leitura antes de iniciar outra.':'Resultado anterior consultado. Renove a leitura antes de alterar campanhas.');paint();
  }catch{if(live(s)){say('A tentativa foi preservada. Consulte novamente; nenhuma operação será repetida.');paint();}}
 }
 async function load(){
  if(!allowed()){if(historyAllowed())return loadHistory();return;}
  const b=brand(),s=stamp(b),v=current();v.failed=false;v.campaign=null;v.validation=null;v.creating=false;v.newDefinition=null;clear();say('Consultando a marca e a tentativa anterior…');paint();
  let saved,provenId;
  try{saved=record(b);if(saved){
   if(saved.action==='campanha_criar'&&['pending','uncertain'].includes(saved.phase)){v.creating=true;v.newDefinition=clone(saved.command.definition);}
   const consult=()=>client.consult(b);const result=typeof locks?.request==='function'?await locks.request('shrigma-campaign-bff:'+s.owner+':'+b,{mode:'exclusive',ifAvailable:true},lock=>{if(!lock)throw Error();return consult();}):await consult();if(live(s)){v.validation=result.validation;if(saved.action==='campanha_criar'&&result.state==='succeeded'){provenId=result.campaign.id;v.creating=false;v.newDefinition=null;}if(result.state==='rejected'){v.creating=false;v.newDefinition=null;}say(result.state==='pending'?'Há uma tentativa sem confirmação. Consulte a mesma tentativa.':result.validation?'Conferência recebida.':'Tentativa anterior encerrada; uma nova conferência poderá ser feita.');}
  }}catch{if(live(s)){if(saved?.action==='campanha_criar'&&['pending','uncertain'].includes(saved.phase)){v.creating=true;v.newDefinition=clone(saved.command.definition);}say('A tentativa foi preservada. Consulte novamente; nenhuma operação será repetida.');}}
  try{const catalog=await read('campanha_catalogo',b),list=await read('campanha_listar',b);if(!live(s))return;if(catalog?.brand!==b||catalog.current!==true||!Array.isArray(catalog.lists)||!Array.isArray(catalog.templates)||!Array.isArray(list?.campaigns)||list.campaigns.length>1000)throw Error();v.catalog=catalog;$('select').replaceChildren();if(saved?.action==='campanha_criar'&&!provenId)option($('select'),'','Selecione apenas para consultar');const rows=list.campaigns.filter(valid);for(const c of rows)option($('select'),c.id,(c.definition.name||'Campanha '+c.id)+' · '+c.status);const id=saved?.action==='campanha_criar'?provenId:rows.find(c=>c.id===saved?.command?.id)?.id||rows[0]?.id;if(id)await reopen(id,s);else if(v.creating)fill();else say(createAllowed()?'Selecione uma campanha ou use Novo rascunho.':'Selecione uma campanha existente. A criação de novos rascunhos está indisponível.');if(live(s))paint();}
  catch{if(live(s)){v.failed=true;v.campaign=null;say('Não foi possível confirmar a leitura. Preserve a tentativa e consulte novamente.');paint();}}
 }
 async function work(action){
  if(!opened||!accessible()||action!=='consult'&&!allowed()||!['create','save','validate','schedule','cancel','consult'].includes(action))return;
  const b=brand(),s=stamp(b);if(busy.has(b))return;
  const act=async()=>{
   if(!live(s))return;const v=current(),c=v.campaign;
   if(action!=='consult'&&(pending(b)||v.failed||(!c&&action!=='create')||!allowed()))throw Error();
   if(action==='create'&&(!v.creating||!createAllowed())||action!=='consult'&&action!=='create'&&v.creating)throw Error();
   if(['validate','schedule'].includes(action)&&(!draft(c)||dirty())||action==='schedule'&&(!reviewReady()||!$('confirm').checked)||action==='cancel'&&(c?.status!=='scheduled'||c.sent!==0||c.started_at!==null||Date.parse(c.send_at)<=now()||!$('confirm').checked)||action==='save'&&!draft(c))throw Error();
   const q=action==='consult'?null:action==='create'?{brand:b,definition:definition(),idempotency_key:uuid()}:{brand:b,id:c.id,expected_version:c.version,idempotency_key:uuid(),...(action==='save'?{definition:definition()}:{}),...(['schedule','cancel'].includes(action)?{confirm:action==='schedule'?'agendar':'cancelar'}:{}),...(action==='schedule'?{audience_review_id:v.validation.audience.review_id}:{})};
   const result=action==='consult'?await client.consult(b):await client[action](q);
   if(!live(s))return;
   if(!allowed()){v.history=result;v.validation=null;v.campaign=null;v.creating=false;v.newDefinition=null;say(result.state==='pending'?'Tentativa ainda sem confirmação. Consulte o mesmo registro.':'Resultado anterior consultado. Renove a leitura antes de alterar campanhas.');paint();return;}
   v.validation=result.validation;
   if(result.action==='campanha_criar'&&result.state==='succeeded'){v.creating=false;v.newDefinition=null;v.campaign=null;v.failed=true;paint();}
   say(result.state==='pending'?'Resultado ainda sem confirmação. Consulte a mesma tentativa; ela não será repetida.':result.state==='rejected'?'A operação foi recusada. Confira a versão atual antes de iniciar outra tentativa.':action==='schedule'?'Agendamento confirmado.':action==='cancel'?'Cancelamento confirmado.':result.validation?'Público conferido. Confira quantidade e horário antes de confirmar o agendamento.':'Tentativa encerrada. Confira novamente antes de agendar.');
   if(result.state!=='pending'&&result.campaign)await reopen(result.campaign.id,s);
  };
  busy.add(b);paint();
  try{if(typeof locks?.request!=='function'){if(action!=='consult')throw Error();await act();}else await locks.request('shrigma-campaign-bff:'+s.owner+':'+b,{mode:'exclusive',ifAvailable:true},lock=>{if(!lock)throw Error();return act();});}
  catch{if(live(s)){let r;try{r=record(b);}catch{}say(r?.action==='campanha_criar'&&r.phase==='succeeded'&&Number.isSafeInteger(r.createdId)?'Rascunho criado. Consulte a mesma tentativa para confirmar a leitura; o formulário de criação foi encerrado.':'A ação não foi confirmada. Preserve a tentativa e consulte seu resultado; não repita o pedido.');}}
  finally{busy.delete(b);if(live(s))paint();}
 }
 function close(){opened=false;epoch++;dialog.hidden=true;if(dialog.open)dialog.close();opener?.focus();}
 dialog.addEventListener('cancel',event=>{event.preventDefault();close();});dialog.addEventListener('close',()=>{opened=false;epoch++;dialog.hidden=true;opener?.focus();});
 $('new').addEventListener('click',newDraft);$('close').addEventListener('click',close);$('form').addEventListener('submit',event=>event.preventDefault());
 $('brand').addEventListener('change',()=>{const own=corporateBrand();if(!own||brand()!==own){if(own)$('brand').value=own;say('Este acesso está vinculado à sua marca.');return;}epoch++;void load();});$('select').addEventListener('change',()=>{if(!allowed()||brand()!==corporateBrand())return;const s=stamp(brand());void reopen(Number($('select').value),s).catch(()=>{if(live(s)){current().failed=true;say('Campanha não confirmada. Consulte novamente.');paint();}});});
 $('refresh').addEventListener('click',()=>{epoch++;void load();});$('form').addEventListener('input',()=>{$('confirm').checked=false;paint();});$('confirm').addEventListener('change',paint);
 for(const action of ['create','save','validate','schedule','cancel','consult'])$(action).addEventListener('click',()=>void work(action));
 return Object.freeze({async open(){if(!accessible())return false;const own=corporateBrand();$('brand').replaceChildren();option($('brand'),own,brands[own]);$('brand').value=own;$('brand').disabled=true;opened=true;epoch++;dialog.hidden=false;dialog.showModal();$('select').focus();await load();return true;},close});
}
if(typeof module==='object'&&module.exports)module.exports={createCampaignEditor};
else globalThis.ShrigmaCampaignEdit=Object.freeze({createCampaignEditor});
