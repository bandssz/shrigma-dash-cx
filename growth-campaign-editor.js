/* Campaign editor. Server actions require explicitly announced capabilities. */
'use strict';
const GCE=(()=>{
 const KEY='shrigma_campaign_composer_v1';
 const fields=['brand','initiative_name','initiative_key','utm_campaign','name','subject','from_email','reply_to','list_ids','template_id','send_at','tags','html','text'];
 let root=null,dirty=false,api=null,remote=null,remoteCaps=null,remoteBusy=false,remoteBrand=null,remoteCampaigns=[];
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const blank=brand=>({brand:['fish','aristo','olivas'].includes(brand)?brand:'fish',initiative_name:'',initiative_key:'',utm_campaign:'',name:'',subject:'',from_email:'',reply_to:'',list_ids:'',template_id:'',send_at:'',tags:'',html:'',text:''});
 const split=v=>String(v||'').split(',').map(v=>v.trim()).filter(Boolean);
 const definition=v=>CampaignContract.normalize({schema_version:CampaignContract.VERSION,brand:v.brand,channel:'email',initiative:{key:v.initiative_key,name:v.initiative_name},utm_campaign:v.utm_campaign,name:v.name,subject:v.subject,from_email:v.from_email,reply_to:v.reply_to,list_ids:split(v.list_ids).map(Number),template_id:Number(v.template_id),html:v.html,text:v.text,tags:split(v.tags),send_at:v.send_at?v.send_at+'-03:00':null});
 const fromDefinition=input=>{const d=CampaignContract.normalize(input);return {brand:d.brand,initiative_name:d.initiative.name,initiative_key:d.initiative.key,utm_campaign:d.utm_campaign,name:d.name,subject:d.subject,from_email:d.from_email,reply_to:d.reply_to,list_ids:d.list_ids.join(', '),template_id:String(d.template_id),send_at:d.send_at?new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3,hourCycle:'h23'}).format(new Date(d.send_at)).replace(' ','T').replace(',','.').replace(/\.000$/,''):'',tags:d.tags.join(', '),html:d.html,text:d.text};};
 function values(){return Object.fromEntries(fields.map(k=>[k,root.querySelector(`[name="${k}"]`).value]));}
 function message(text,error=false){const el=root.querySelector('[data-ce-status]');el.textContent=text;el.dataset.error=String(error);}
 function keep(){dirty=true;try{localStorage.setItem(KEY,JSON.stringify(values()));message('Alterações guardadas neste navegador.');}catch{message('Não foi possível salvar neste navegador. Exporte o JSON para guardar o rascunho.',true);}paintRemote();}
 function fill(v){for(const k of fields)root.querySelector(`[name="${k}"]`).value=typeof v[k]==='string'?v[k]:'';}
 const input=(name,label,placeholder='',extra='')=>`<label>${label}<input name="${name}" autocomplete="off" placeholder="${esc(placeholder)}" ${extra}></label>`;
 function mount({marca='fish',api:payload=null}={}){
  api=payload;
  const target=typeof document!=='undefined'?document.getElementById('campaign-composer'):null;
  if(!target)return;if(target===root){setupRemote();return;}root=target;
  root.innerHTML=`<details class="ce-shell"><summary><span class="ce-icon" aria-hidden="true">+</span><span class="ce-title"><strong>Preparar campanha</strong><span>Crie pelo painel ou importe o conteúdo preparado com IA.</span></span><span class="ce-tag">Rascunho local</span></summary>
   <div class="ce-body"><div class="ce-intro"><div><span class="ce-eyebrow">CADASTRO DE E-MAIL</span><h3>Uma iniciativa. Todos os seus disparos.</h3><p>A iniciativa reúne a campanha no relatório. Cada disparo mantém sua base e identificação próprias.</p></div><label class="ce-import">Importar JSON<input type="file" accept=".json,application/json" data-ce-import></label></div>
   <section class="ce-remote" data-ce-remote hidden aria-label="Campanhas no servidor"><div class="ce-grid"><label>Chave de escrita<input type="password" data-ce-key autocomplete="off" placeholder="Use a chave já fornecida para operar o painel"></label><div class="ce-remote-access"><button type="button" class="ce-secondary" data-ce-key-save>Usar chave neste navegador</button><span data-ce-key-state></span></div></div><div class="ce-actions"><button type="button" class="ce-secondary" data-ce-refresh>Carregar catálogo e campanhas</button><button type="button" class="ce-secondary" data-ce-new>Preparar novo rascunho</button><button type="button" class="ce-secondary" data-ce-consult>Consultar tentativa</button></div><p data-ce-server-state role="status" aria-live="polite"></p><div data-ce-campaigns></div><div data-ce-catalog></div><div class="ce-actions"><button type="button" class="ce-primary" data-ce-save>Salvar no servidor</button><button type="button" class="ce-secondary" data-ce-validate>Validar versão salva</button><button type="button" class="ce-primary" data-ce-schedule>Agendar versão validada</button><button type="button" class="ce-secondary" data-ce-cancel>Cancelar agendamento</button></div><p class="ce-help">Salvar mantém o rascunho sem envio. Validar confere a revisão. Agendar usa a data revisada. Resultado incerto exige consulta da mesma tentativa.</p></section><form novalidate><fieldset><legend><span>01</span> Campanha e iniciativa</legend><div class="ce-grid"><label>Marca<select name="brand"><option value="fish">Fishermans</option><option value="aristo">O Aristocrata</option><option value="olivas">Olivas do Campo</option></select></label>${input('initiative_name','Iniciativa comercial','Ex.: Semana do Cliente')}${input('initiative_key','Identificador da iniciativa','Ex.: semana-do-cliente-2026')}${input('utm_campaign','UTM da campanha','Use o identificador já adotado na iniciativa')}${input('name','Nome deste disparo','Ex.: Abertura · clientes recorrentes')}${input('subject','Assunto do e-mail','O assunto que aparece na caixa de entrada','maxlength="250"')}</div></fieldset>
   <fieldset><legend><span>02</span> Público e remetente</legend><div class="ce-grid">${input('list_ids','IDs das listas','Ex.: 123, 124')}${input('template_id','ID do template de campanha','Consulte o catálogo de templates','inputmode="numeric"')}${input('from_email','Remetente','Marca <email@dominio-da-marca>')}${input('reply_to','Endereço para respostas','email@dominio-da-marca')}${input('send_at','Data desejada · Brasília, UTC−3 (opcional)','','type="datetime-local" step="60"')}${input('tags','Tags (opcional)','abertura, clientes-recorrentes')}</div><p class="ce-help">Os IDs serão conferidos com o catálogo da marca na integração de envio. Informar uma data aqui não agenda a campanha.</p></fieldset>
   <fieldset><legend><span>03</span> Conteúdo</legend><div class="ce-grid ce-content"><label>HTML do e-mail<textarea name="html" spellcheck="false" placeholder="Cole o HTML com os links da loja e {{ UnsubscribeURL }}"></textarea></label><label>Versão em texto<textarea name="text" placeholder="Cole a versão em texto, incluindo os links e {{ UnsubscribeURL }}"></textarea></label></div></fieldset>
   <div class="ce-tracking"><strong>Rastreamento vinculado ao disparo</strong><p>A API de cadastro deverá aplicar as UTMs ao HTML e ao texto com o ID real do envio. O JSON exportado é uma preparação; ainda não confirma links rastreados, listas disponíveis ou agendamento.</p></div>
   <div class="ce-actions"><button type="button" class="ce-secondary" data-ce-preview>Abrir prévia do HTML</button><button type="button" class="ce-primary" data-ce-export>Verificar e exportar JSON</button><button type="button" class="ce-secondary" data-ce-reset>Limpar rascunho</button><span data-ce-status role="status" aria-live="polite">Rascunho local. Ainda não cadastrado para envio.</span></div>
   </form></div></details>`;
  let initial=blank(marca);try{const saved=JSON.parse(localStorage.getItem(KEY)||'null');if(saved&&typeof saved==='object'&&!Array.isArray(saved)){initial={...initial,...Object.fromEntries(fields.filter(k=>typeof saved[k]==='string').map(k=>[k,saved[k]]))};if(!['fish','aristo','olivas'].includes(initial.brand))initial.brand='fish';}}catch{}
  fill(initial);dirty=fields.some(k=>k!=='brand'&&initial[k]);
  root.querySelector('form').addEventListener('submit',e=>e.preventDefault());
  root.querySelector('form').addEventListener('input',keep);
  root.querySelector('[name=brand]').addEventListener('change',()=>{setupRemote();keep();});
  root.querySelector('[data-ce-import]').addEventListener('change',async e=>{
   const f=e.target.files?.[0];if(!f)return;
   try{if(remote?.locked())throw Error('Consulte a tentativa pendente antes de importar outro conteúdo.');if(f.size>800000)throw Error('Use um arquivo JSON de até 800 KB.');const v=fromDefinition(JSON.parse(await f.text()));if(dirty&&!confirm('Substituir o rascunho local pelo conteúdo deste arquivo?'))return;fill(v);setupRemote();keep();message('JSON importado e campos conferidos. Catálogo e UTMs finais serão validados na integração de envio.');}catch(err){message(err instanceof SyntaxError?'O arquivo não contém um JSON válido.':err.message,true);}finally{e.target.value='';}
  });
  root.querySelector('[data-ce-export]').addEventListener('click',()=>{
   try{const d=definition(values()),blob=new Blob([JSON.stringify(d,null,2)+'\n'],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`campanha-${d.brand}-${d.utm_campaign}.json`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);keep();message('JSON exportado. Estrutura conferida; envio e rastreamento final ainda dependem da integração.');}
   catch(err){message(err.message,true);const mapped={'initiative.key':'initiative_key','initiative.name':'initiative_name'};root.querySelector(`[name="${mapped[err.field]||err.field}"]`)?.focus();}
  });
  root.querySelector('[data-ce-preview]').addEventListener('click',()=>{const v=values();GMP.openEmail({source:v.html||'<p>Escreva o HTML para visualizar o e-mail.</p>',subject:v.subject,label:'Prévia do conteúdo da campanha'});});
  root.querySelector('[data-ce-reset]').addEventListener('click',()=>{if(remote?.locked()){message('Consulte a tentativa pendente antes de limpar o conteúdo.',true);return;}if(!confirm('Limpar o rascunho salvo neste navegador?'))return;fill(blank(values().brand));try{localStorage.removeItem(KEY);}catch{}dirty=false;message('Rascunho limpo. Nenhuma campanha de envio foi alterada.');paintRemote();});
  bindRemote();setupRemote();
 }
 const q=selector=>root.querySelector(selector);
 const keyValue=slot=>{try{return localStorage.getItem(slot)||'';}catch{return '';}};
 const stamp=v=>v?new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'}).format(new Date(v))+' · Brasília':'Sem data';
 const statusName=s=>({draft:'Rascunho',scheduled:'Agendada',running:'Em envio',paused:'Pausada',finished:'Concluída',cancelled:'Cancelada'}[s]||s||'Não confirmado');
 function setupRemote(){
  if(typeof GCA==='undefined')return;
  const next=GCA.caps(api),brand=values().brand;
  if(remote&&remoteBrand===brand&&remoteCaps?.endpoint===next.endpoint){remoteCaps=next;remote.updateCapabilities(next);paintRemote();return;}
  remote=null;remoteCaps=next;remoteBrand=brand;remoteCampaigns=[];
  q('[data-ce-catalog]').innerHTML='';q('[data-ce-campaigns]').innerHTML='';
  for(const n of ['list_ids','template_id'])q(`[name=${n}]`).closest('label').hidden=false;
  if(next.endpoint&&next.brands.includes(brand)){
   try{remote=GCA.createClient({capabilities:next,brand,readKey:()=>typeof shrigmaChave==='function'?shrigmaChave('growth'):keyValue(GTA.CHAVE_LEITURA),writeKey:()=>keyValue(GTA.CHAVE_ESCRITA)});}
   catch(err){message(err.message,true);}
  }
  paintRemote();
 }
 function paintRemote(){
  if(!root||typeof GCA==='undefined')return;
  const exists=!!remote,section=q('[data-ce-remote]');section.hidden=!exists;
  for(const name of ['list_ids','template_id'])q(`[name=${name}]`).closest('label').hidden=exists;
  q('.ce-tracking p').textContent=exists?'Ao salvar, o servidor aplica as UTMs ao HTML e ao texto com a identidade real desta campanha. A versão salva deve ser validada antes do agendamento.':'A API de cadastro deverá aplicar as UTMs ao HTML e ao texto com o ID real do envio. O JSON exportado é uma preparação; ainda não confirma links rastreados, listas disponíveis ou agendamento.';
  const s=remote?.snapshot(),locked=!!remote?.locked(),frozen=locked||remoteBusy;
  for(const name of fields)q(`[name="${name}"]`).disabled=frozen;
  q('[data-ce-import]').disabled=frozen;q('[data-ce-reset]').disabled=frozen;
  for(const el of q('[data-ce-catalog]').querySelectorAll('input,select'))el.disabled=frozen;
  const selected=new Set(split(values().list_ids));for(const el of q('[data-ce-catalog]').querySelectorAll('[data-ce-list]'))el.checked=selected.has(el.value);
  if(q('[data-ce-template]'))q('[data-ce-template]').value=values().template_id;
  q('[data-ce-key-state]').textContent=typeof GTA!=='undefined'&&keyValue(GTA.CHAVE_ESCRITA)?'Chave de escrita guardada neste navegador.':'Informe a chave para salvar, validar ou agendar.';
  if(!exists)return;
  let d=null;try{d=definition(values());}catch{}
  const writes=remote.canWrite(),c=s.campaign,clean=d&&remote.clean(d),draft=c?.status==='draft'&&c.sent===0&&!c.started_at;
  const set=(name,shown,disabled)=>{const b=q(`[data-ce-${name}]`);b.hidden=!shown;b.disabled=disabled;};
  set('refresh',remoteCaps.read,remoteBusy);set('new',remoteCaps.save,frozen||!writes);set('consult',remoteCaps.operation,remoteBusy||!s.operation);
  set('save',remoteCaps.save,frozen||!writes||!!c&&!draft);set('validate',remoteCaps.validate,frozen||!writes||!draft||!clean);
  set('schedule',remoteCaps.schedule,frozen||!writes||!draft||!clean||s.validation?.version!==c?.version||s.validation?.ok!==true);
  set('cancel',remoteCaps.cancel,frozen||!writes||c?.status!=='scheduled'||c?.sent!==0||c?.started_at!==null||!c?.send_at||Date.parse(c.send_at)<=Date.now());
  const op=s.operation;
  const parts=[c?`${statusName(c.status)} · ${c.sent} enviados · ${stamp(c.send_at)}`:'Ainda sem campanha cadastrada neste editor.'];
  if(!writes)parts.push('Consulta disponível. Este navegador não oferece a proteção entre abas necessária para salvar, validar, agendar ou cancelar.');
  if(c)parts.push(clean?'Conteúdo corresponde à versão salva.':'Há alterações locais; salve antes de validar.');
  if(c&&s.validation?.ok===true&&s.validation.version===c.version)parts.push('Versão salva validada.');
  if(locked)parts.push('Resultado pendente ou incerto. Edição e novas tentativas bloqueadas; consulte a mesma operação.');
  else if(op?.phase==='rejected')parts.push('Tentativa recusada com estado confirmado. Confira o conteúdo antes de nova ação.');
  else if(op?.phase==='succeeded')parts.push('Última operação confirmada pelo servidor.');
  q('[data-ce-server-state]').textContent=parts.join(' ');
  q('.ce-tag').textContent=c?statusName(c.status):'Rascunho local';
  for(const btn of q('[data-ce-campaigns]').querySelectorAll('button'))btn.disabled=frozen;
 }
 async function runRemote(work,{fillSaved=false}={}){
  if(!remote||remoteBusy)return;
  remoteBusy=true;paintRemote();
  try{const result=await work();if(fillSaved&&result?.campaign){fill(fromDefinition(result.campaign.definition));try{localStorage.setItem(KEY,JSON.stringify(values()));}catch{}dirty=false;renderCampaigns([...remoteCampaigns.filter(c=>c.id!==result.campaign.id),result.campaign]);}
   if(result?.readOnly){const status={pending:'em processamento',outcome_unknown:'resultado incerto',succeeded:'concluída no servidor',rejected:'recusada no servidor'}[result.consultation?.state]||'estado não confirmado';message(`Consulta recebida: ${status}. O registro local foi preservado. A confirmação local depende da proteção entre abas deste navegador.`);return;}
   message(remote.locked()?'A tentativa continua pendente ou incerta. Consulte novamente; não crie outra tentativa.':'Operação conferida. O estado acima mostra o que o servidor confirmou.',remote.locked());}
  catch(err){message(err.message,true);}
  finally{remoteBusy=false;paintRemote();}
 }
 function renderCatalog(catalog){
  const e=esc,d=values(),selected=new Set(split(d.list_ids).map(Number));
  q('[data-ce-catalog]').innerHTML=`<div class="ce-catalog"><fieldset><legend>Públicos disponíveis</legend>${catalog.lists.filter(l=>Number.isSafeInteger(l.id)&&l.id>0&&l.available===true&&l.brand===remoteBrand).map(l=>`<label><input type="checkbox" data-ce-list value="${l.id}" ${selected.has(l.id)?'checked':''}> ${e(l.name||l.label||'Lista '+l.id)}</label>`).join('')||'<p>Nenhum público disponível nesta marca.</p>'}</fieldset><label>Modelo de e-mail<select data-ce-template><option value="">Escolha um modelo</option>${catalog.templates.filter(t=>Number.isSafeInteger(t.id)&&t.id>0&&t.available===true&&t.type==='campaign').map(t=>`<option value="${t.id}" ${String(t.id)===d.template_id?'selected':''}>${e(t.name||'Template '+t.id)}</option>`).join('')}</select></label></div>`;
  q('[name=list_ids]').closest('label').hidden=true;q('[name=template_id]').closest('label').hidden=true;
  q('[data-ce-catalog]').querySelectorAll('[data-ce-list]').forEach(el=>el.addEventListener('change',()=>{q('[name=list_ids]').value=[...q('[data-ce-catalog]').querySelectorAll('[data-ce-list]')].filter(x=>x.checked).map(x=>x.value).join(', ');keep();}));
  q('[data-ce-template]').addEventListener('change',e=>{q('[name=template_id]').value=e.target.value;keep();});
 }
 function renderCampaigns(campaigns){
  remoteCampaigns=campaigns;
  q('[data-ce-campaigns]').innerHTML=`<div class="ce-campaign-list">${campaigns.map(c=>`<article><div><strong>${esc(c.definition.name)}</strong><span>${esc(statusName(c.status))} · ${c.sent} enviados · ${esc(stamp(c.send_at))}</span></div><button type="button" class="ce-secondary" data-ce-open="${c.id}">Reabrir</button></article>`).join('')||'<p>Nenhuma campanha disponível nesta marca.</p>'}</div>`;
  q('[data-ce-campaigns]').querySelectorAll('[data-ce-open]').forEach(btn=>btn.addEventListener('click',()=>{if(dirty&&!confirm('Substituir as alterações locais pelo conteúdo salvo desta campanha?'))return;runRemote(async()=>{const s=await remote.reopen(Number(btn.dataset.ceOpen));const catalog=await remote.catalog();fill(fromDefinition(s.campaign.definition));renderCatalog(catalog);return s;},{fillSaved:true});}));
 }
 function bindRemote(){
  q('[data-ce-key-save]').addEventListener('click',()=>{const field=q('[data-ce-key]'),value=field.value.trim();if(!value){message('Informe a chave de escrita.',true);return;}try{localStorage.setItem(GTA.CHAVE_ESCRITA,value);field.value='';message('Chave guardada neste navegador. Permissões serão conferidas pelo servidor.');}catch{message('Não foi possível guardar a chave neste navegador.',true);}paintRemote();});
  q('[data-ce-refresh]').addEventListener('click',()=>runRemote(async()=>{const catalog=await remote.catalog(),campaigns=await remote.list();renderCatalog(catalog);renderCampaigns(campaigns);}));
  q('[data-ce-new]').addEventListener('click',async()=>{if(!remote||remote.locked())return;if(dirty&&!confirm('Guardar uma nova preparação local no lugar do conteúdo atual?'))return;try{await remote.newDraft();fill(blank(values().brand));keep();q('[data-ce-catalog]').innerHTML='';for(const n of ['list_ids','template_id'])q(`[name=${n}]`).closest('label').hidden=false;}catch(err){message(err.message,true);}paintRemote();});
  q('[data-ce-consult]').addEventListener('click',()=>runRemote(()=>remote.consult(),{fillSaved:true}));
  q('[data-ce-save]').addEventListener('click',()=>{if(remote?.locked())return;runRemote(async()=>{await remote.catalog();return remote.save(definition(values()));},{fillSaved:true});});
  q('[data-ce-validate]').addEventListener('click',()=>runRemote(()=>remote.validate(definition(values())),{fillSaved:true}));
  q('[data-ce-cancel]').addEventListener('click',()=>{
   const c=remote?.snapshot()?.campaign;if(!c)return;
   if(!confirm(`Cancelar o agendamento de “${c.definition.name}” para ${stamp(c.send_at)}? A campanha agendada será cancelada; as alterações locais não serão salvas.`))return;
   runRemote(()=>remote.cancel('cancelar'),{fillSaved:true});
  });
  q('[data-ce-schedule]').addEventListener('click',()=>{
   const s=remote?.snapshot(),c=s?.campaign;if(!c)return;
   if(!confirm(`Agendar “${c.definition.name}” para ${stamp(c.send_at)}? Esta ação usa o público da versão validada e poderá iniciar o envio na data indicada.`))return;
   runRemote(()=>remote.schedule(definition(values()),'agendar'),{fillSaved:true});
  });
 }
 return {mount,definition,fromDefinition};
})();
if(typeof module!=='undefined')module.exports=GCE;
