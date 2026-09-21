/* Server-backed journey editor. Published settings and drafts remain distinct. */
'use strict';
const GB={
 state:{flows:[],selected:null,draft:null,dirty:false,busy:false,loaded:false,error:'',notice:'',templates:{},pending:null},ctx:{},
 e:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
 clone:v=>JSON.parse(JSON.stringify(v)),
 brandLabel:brand=>({fish:'Fishermans',aristo:'O Aristocrata',olivas:'Olivas do Campo'}[brand]||'Marca não informada'),
 signature(components){
  const result=[];
  for(const c of components||[]){
   if(['BODY','HEADER'].includes(c.type)){
    const vars=[...new Set([...String(c.text||'').matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map(m=>m[1]))].sort();
    if(c.type==='HEADER'||vars.length)result.push({type:c.type,format:c.format||null,vars});
   }else if(c.type==='BUTTONS')result.push({type:'BUTTONS',buttons:(c.buttons||[]).map(b=>({type:b.type,url:b.url||null,phone:b.phone_number||null,reply:b.type==='QUICK_REPLY'?b.text:null}))});
  }return result;
 },
 same(a,b){const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;return JSON.stringify(stable(a))===JSON.stringify(stable(b));},
 compatible(template,slot){
  if(template.status!=='APPROVED')return false;
  if(slot.channel==='whatsapp'&&/^pix(?:-|_|$)/.test(slot.piece||'')&&!template.components?.some(c=>c.type==='BUTTONS'&&c.buttons?.some(b=>b.type==='ORDER_DETAILS')))return false;
  if(slot.channel==='whatsapp')return template.language==='pt_BR'&&(slot.category!=='UTILITY'||template.category==='UTILITY')&&GB.same(GB.signature(template.components),slot.signature);
  const content=String(template.components?.body_html||'')+String(template.components?.subject||'');
  const present=[...content.matchAll(/\.Tx\.Data\.([A-Za-z][A-Za-z0-9_]*)/g)].map(m=>m[1]);
  if(!(slot.required_variables||[]).every(v=>present.includes(v)))return false;
  if(String(template.id)===String(slot.template_id))return true;
  if(!template.draft_id)return false;
  const vars=[...(String(template.components?.body_html||'')+String(template.components?.subject||'')).matchAll(/\.Tx\.Data\.([A-Za-z][A-Za-z0-9_]*)/g)].map(m=>m[1]);
  return vars.every(v=>(slot.variables||[]).includes(v));
 },
 endpoint(){return GTA.caps(GB.ctx.api).endpoint;},
 async request(action,body={},write=false){
  const endpoint=GB.endpoint();if(!endpoint)return {ok:false,body:{erro:'endpoint_indisponivel'}};
  let k=write?localStorage.getItem(GTA.CHAVE_ESCRITA)||'':GTA.chaveLeitura();
  if(write&&!k){k=typeof GRU!=='undefined'?GRU.chaveEscrita(true):null;if(!k)return {ok:false,body:{erro:'Informe a chave de edição para salvar.'}};}
  try{
   const r=await fetch(write?endpoint:endpoint+'?'+new URLSearchParams({acao:action,...body}),write?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({k,acao:action,...body})}:{headers:{Authorization:'Bearer '+k},cache:'no-store',redirect:'error',credentials:'omit'});
   return {ok:r.ok,status:r.status,body:await r.json()};
  }catch(_){return {ok:false,status:0,body:{erro:'Resultado não confirmado. Recarregue antes de repetir.'}};}
 },
 async load(){
  if(GB.state.busy)return;GB.state.busy=true;GB.render();
  const r=await GB.request('fluxos_listar');GB.state.busy=false;
  if(typeof GBC!=='undefined'&&GBC.drag){GBC.pendingRender=true;return;}
  if(!r.ok){GB.state.error=r.body?.erro||'Não foi possível carregar os fluxos.';GB.state.loaded=true;GB.render();return;}
  GB.state.flows=Array.isArray(r.body.flows)?r.body.flows:[];GB.state.loaded=true;GB.state.error='';GB.state.templates={};
  if(!GB.state.dirty){const f=GB.visible().find(f=>f.key===GB.state.selected)||GB.visible()[0];if(f)GB.select(f.key,false);}
  else {const f=GB.state.flows.find(f=>f.key===GB.state.selected);if(f)for(const channel of new Set(f.available_steps.map(s=>s.channel)))GB.loadTemplates(f.brand,channel);}
  GB.render();
 },
 visible(){return GB.state.flows.filter(f=>!GB.ctx.marca||GB.ctx.marca==='todas'||f.brand===GB.ctx.marca);},
 select(key,confirmDirty=true){
  if(confirmDirty&&GB.state.dirty&&!confirm('Há alterações não salvas. Deseja descartá-las?'))return;
  const f=GB.state.flows.find(f=>f.key===key);if(!f)return;
  GB.state.selected=key;GB.state.baseVersion=f.version;GB.state.draft=GB.clone(f.draft);GB.state.dirty=false;GB.state.pending=null;GB.state.notice='';GB.render();
  for(const channel of new Set(f.available_steps.map(s=>s.channel)))GB.loadTemplates(f.brand,channel);
 },
 async loadTemplates(brand,channel){
  const key=brand+':'+channel;if(GB.state.templates[key])return;
  GB.state.templates[key]=[];const r=await GB.request('listar',{marca:brand,canal:channel});
  if(r.ok)GB.state.templates[key]=(r.body.templates||[]).filter(t=>t.brand===brand&&t.channel===channel);
  else delete GB.state.templates[key];GB.render();
 },
 change(){GB.state.dirty=true;GB.state.pending=null;GB.state.notice='';},
 async mutate(action,extra={}){
  if(GB.state.busy)return;const f=GB.state.flows.find(f=>f.key===GB.state.selected);if(!f)return;
  const payload={key:f.key,expected_version:GB.state.baseVersion??f.version,...extra};
  if(action==='fluxo_salvar')payload.definition=GB.clone(GB.state.draft);
  if(action==='fluxo_publicar')payload.confirm='publicar';
  const signature=JSON.stringify({action,payload});
  if(!GB.state.pending||GB.state.pending.signature!==signature)GB.state.pending={signature,id:GTA.uuid()};
  payload.idempotency_key=GB.state.pending.id;GB.state.busy=true;GB.state.error='';GB.render();
  const r=await GB.request(action,payload,true);GB.state.busy=false;
  if(!r.ok){GB.state.error=(r.body?.messages||[]).join(' · ')||GTA.erro(r,action).texto||r.body?.erro;GB.render();return;}
  const updated=r.body.flow;GB.state.flows=GB.state.flows.map(x=>x.key===updated.key?updated:x);GB.state.baseVersion=updated.version;GB.state.draft=GB.clone(updated.draft);GB.state.dirty=false;GB.state.pending=null;
  GB.state.notice=action==='fluxo_publicar'?'Versão publicada. Os próximos eventos usarão estas configurações.':action==='fluxo_estado'?(updated.enabled?'Fluxo retomado.':'Fluxo pausado.'):'Rascunho salvo no servidor.';GB.render();
 },
 stepHtml(step,index,f){
  const e=GB.e,slot=f.available_steps.find(x=>x.key===step.key)||step;
  const choices=(GB.state.templates[f.brand+':'+step.channel]||[]).filter(t=>GB.compatible(t,slot));
  const current=choices.some(t=>String(t.id)===String(step.template_id));
  const icon=step.channel==='email'?'✉':'◉';
  const wait=Number(slot.max_wait)>0?`<div class="builder-wait"><span>◷</span><label>Após <input type="number" min="${e(slot.min_wait)}" max="${e(slot.max_wait)}" step="0.5" data-step="${index}" data-field="wait_min" value="${e(step.wait_min)}" ${Number(slot.min_wait)===Number(slot.max_wait)?'readonly':''}> minutos ${e(slot.wait_label||'do gatilho')}</label></div>`:'';
  return `<li class="builder-stage ${step.enabled?'':'is-off'}" data-stage="${e(step.key)}">${wait}<div class="builder-message"><div class="builder-message-head"><span class="builder-channel ${e(step.channel)}">${icon}</span><div><small>${step.channel==='email'?'E-MAIL':'WHATSAPP'}</small><strong>${e(slot.name)}</strong></div><label class="builder-toggle"><input type="checkbox" data-step="${index}" data-field="enabled" ${step.enabled?'checked':''} aria-label="Ativar ${e(slot.name)}"><span>Ativa</span></label></div>
   ${slot.kind==='interactive'?`<label>Mensagem<textarea data-step="${index}" data-field="body" rows="4" maxlength="1024">${e(step.body)}</textarea></label>`:`<label>Template<select data-step="${index}" data-field="template_id">${current?'':`<option value="${e(step.template_id)}">${e(step.template_name||'Selecionar template')}</option>`}${choices.map(t=>`<option value="${e(t.id)}" ${String(t.id)===String(step.template_id)?'selected':''}>${e(t.name)}</option>`).join('')}</select></label><button class="builder-text-button" type="button" data-create-template="${e(step.channel)}">+ Criar template de ${step.channel==='email'?'e-mail':'WhatsApp'}</button>`}
   ${slot.variables?.length?`<p class="builder-variables">Dados: ${slot.variables.map(e).join(' · ')}</p>`:''}
   <div class="builder-stage-actions"><button type="button" data-remove="${index}">Remover etapa</button></div></div></li>`;
 },
 journeySummary(f,d){
  const channels=[...new Set(d.steps.map(s=>s.channel))].map(c=>c==='email'?'E-mail':'WhatsApp').join(' + ');
  const note=f.journey_kind==='nps'?'Pesquisa e lembrete na mesma jornada · prazo desde o registro inicial · seleção às 19h de Brasília':f.journey_kind==='order'?'Cada evento inicia seu próprio ramo · os estados não precisam chegar em sequência':f.available_steps.some(s=>s.flow==='carrinho')?'Todos os toques desde o abandono · compra e elegibilidade conferidas antes de cada envio':'Etapas e canais reunidos pelo objetivo da jornada';
  return `<div class="builder-journey-summary"><span>${GB.e(channels)}</span><span>${d.steps.length} etapas</span><p>${GB.e(note)}</p></div>`;
 },
 stagesHtml(f,d){
  const groups=new Map();d.steps.forEach((step,index)=>{const key=Number(step.wait_min)||0;if(!groups.has(key))groups.set(key,[]);groups.get(key).push({step,index});});
  return [...groups.entries()].sort((a,b)=>a[0]-b[0]).map(([wait,items])=>`<section class="builder-moment"><h3>${wait?`Após ${GB.e(wait)} minutos`:'Ao receber o evento'}</h3><p>${items.some(x=>f.available_steps.find(s=>s.key===x.step.key)?.source_template_id)?'Uma mensagem, conforme a transportadora e os dados disponíveis.':items.some(x=>x.step.variant)?'WhatsApp escolhe a variante A ou B. E-mail segue sua própria etapa.':items.length>1?'Os canais são acionados no mesmo evento.':'A etapa é executada se suas condições continuarem válidas.'}</p><ul class="builder-stages ${items.length>1?'builder-parallel':''}">${items.map(({step,index})=>GB.stepHtml(step,index,f)).join('')}</ul></section>`).join('');
 },
 render(ctx){
  if(typeof GBC!=='undefined'&&GBC.drag){if(ctx)GB.ctx=ctx;GBC.pendingRender=true;return;}
  if(ctx){const old=GB.ctx.marca;GB.ctx=ctx;if(old!==ctx.marca&&GB.state.loaded&&!GB.state.dirty){const first=GB.visible()[0];if(first&&first.key!==GB.state.selected){GB.select(first.key,false);return;}}}const root=document.querySelector('#control-fluxos');if(!root)return;
  const s=GB.state,e=GB.e,visible=GB.visible(),f=s.flows.find(x=>x.key===s.selected),d=s.draft;
  if(!s.loaded&&!s.busy){GB.load();return;}
  const rail=`<aside class="builder-rail"><div class="builder-rail-title">Jornadas <span>${visible.length}</span></div>${visible.map(x=>`<button type="button" class="builder-flow ${x.key===s.selected?'selected':''}" data-flow-key="${e(x.key)}"><span class="builder-dot ${x.enabled?'on':''}"></span><span><strong>${e(x.name)}</strong><small>${e(GB.brandLabel(x.brand))} · ${x.draft.steps.length} etapas</small></span></button>`).join('')}${!visible.length?'<p>Nenhum fluxo carregado.</p>':''}<button type="button" class="builder-reload" id="builder-reload" ${s.busy?'disabled':''}>↻ Atualizar</button></aside>`;
  const visual=typeof GBC!=='undefined';
  const available=f?f.available_steps.filter(x=>!d?.steps.some(y=>y.key===x.key)):[];
  const feedback=`${s.error?`<div class="builder-alert" role="alert">${e(s.error)}</div>`:''}${s.notice?`<div class="builder-notice" role="status">${e(s.notice)}</div>`:''}`;
  const main=f&&d?`<main class="builder-main">${visual?feedback:''}<header class="builder-header"><div><label class="builder-flow-label">Jornada<select id="builder-flow-picker">${visible.map(x=>`<option value="${e(x.key)}" ${x.key===s.selected?'selected':''}>${e(GB.brandLabel(x.brand))} · ${e(x.name)}</option>`).join('')}</select></label><span class="builder-eyebrow">${e(GB.brandLabel(f.brand).toUpperCase())} / AUTOMAÇÃO</span><input class="builder-title" aria-label="Nome do fluxo" id="builder-name" value="${e(d.name)}" maxlength="120"><div class="builder-status"><span class="builder-status-pill ${f.enabled?'live':''}">${!f.runtime_ready?'Em preparação':f.enabled?'Ativo':'Pausado'}</span><span>Publicada v${f.published_version}</span>${s.dirty||f.version!==f.published_version?'<span class="builder-draft-label">Alterações em rascunho</span>':''}</div></div><div class="builder-header-actions">${visual?`<button type="button" id="builder-reload" ${s.busy?'disabled':''}>↻ Atualizar</button>`:''}<button type="button" id="builder-toggle" ${s.busy||s.dirty||!f.runtime_ready?'disabled':''}>${f.enabled?'Pausar':'Retomar'}</button><button type="button" id="builder-save" ${s.busy||!s.dirty?'disabled':''}>Salvar rascunho</button><button type="button" class="builder-primary" id="builder-publish" ${s.busy||s.dirty||!f.runtime_ready?'disabled':''}>Publicar alterações</button></div></header>
   ${GB.journeySummary(f,d)}${visual?GBC.html(f,d):`   <div class="builder-canvas"><div class="builder-trigger"><span class="builder-trigger-icon">↯</span><div><small>ENTRADA NO FLUXO</small><strong>${e(f.trigger)}</strong><p>${e(f.binding_description||'Cada evento mantém sua identidade para evitar envios repetidos.')}</p></div></div>
   ${GB.stagesHtml(f,d)}
   ${available.length?`<div class="builder-add"><select id="builder-add-slot" aria-label="Etapa para adicionar">${available.map(x=>`<option value="${e(x.key)}">${e(x.name)} · ${x.channel==='email'?'E-mail':'WhatsApp'}</option>`).join('')}</select><button type="button" id="builder-add">+ Adicionar etapa</button></div>`:''}
   <div class="builder-end">✓ Fim da jornada</div><div class="builder-exits"><strong>Saídas automáticas</strong><span>${e(f.exit_description||'Compra, cancelamento e descadastro são respeitados pelas guardas de cada jornada.')}</span></div>
   ${!f.runtime_ready?'<p class="builder-runtime-note">Você pode preparar e salvar esta jornada. A publicação será liberada quando a conexão com a operação estiver concluída.</p>':''}</div>`}</main>`:'<main class="builder-main builder-empty">Selecione uma jornada para editar suas etapas.</main>';
  root.innerHTML=`${visual&&f&&d?'':feedback}<div class="builder-layout ${visual?'builder-visual':''}" aria-busy="${s.busy}">${visual?'':rail}${main}</div>`;GB.bind(root);if(visual&&f&&d)GBC.mount(root,f,d);
 },
 bind(root){
  if(GB.state.busy)root.querySelectorAll('[data-step],[data-remove],[data-create-template],#builder-flow-picker').forEach(el=>el.disabled=true);
  root.querySelectorAll('[data-flow-key]').forEach(b=>b.onclick=()=>GB.select(b.dataset.flowKey));
  root.querySelector('#builder-flow-picker')?.addEventListener('change',ev=>{GB.select(ev.target.value);ev.target.value=GB.state.selected;});
  root.querySelector('#builder-reload')?.addEventListener('click',()=>GB.load());
  root.querySelector('#builder-name')?.addEventListener('input',ev=>{GB.state.draft.name=ev.target.value;GB.change();GB.refreshActions();});
  root.querySelectorAll('[data-step]').forEach(input=>input.addEventListener('change',()=>{
   const step=GB.state.draft.steps[Number(input.dataset.step)],field=input.dataset.field;
   step[field]=field==='enabled'?input.checked:field==='wait_min'?Number(input.value):input.value;
   if(field==='template_id'){
    const f=GB.state.flows.find(x=>x.key===GB.state.selected),t=(GB.state.templates[f.brand+':'+step.channel]||[]).find(x=>String(x.id)===String(input.value));
    if(t)step.template_name=t.name;
   }
   if(field==='wait_min'&&step.channel==='whatsapp'&&step.variant)GB.state.draft.steps.filter(s=>s.channel===step.channel&&s.piece===step.piece).forEach(s=>s.wait_min=step.wait_min);
   GB.change();GB.refreshActions();
   if(field==='enabled')input.closest('.builder-stage')?.classList.toggle('is-off',!step.enabled);
   if(typeof GBC!=='undefined')GBC.redraw();
   if(field==='wait_min'){
    root.querySelectorAll('[data-field="wait_min"]').forEach(el=>el.value=GB.state.draft.steps[Number(el.dataset.step)].wait_min);
    const title=input.closest('.builder-moment')?.querySelector('h3');if(title)title.textContent='Espera alterada · salve para reorganizar as etapas';
   }
  }));
  root.querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>{GB.state.draft.steps.splice(+b.dataset.remove,1);GB.change();GB.render();});
  root.querySelector('#builder-add')?.addEventListener('click',()=>{const f=GB.state.flows.find(x=>x.key===GB.state.selected),key=root.querySelector('#builder-add-slot').value,slot=f.available_steps.find(s=>s.key===key);GB.state.draft.steps.push(GB.clone(slot));GB.change();GB.render();});
  root.querySelector('#builder-save')?.addEventListener('click',()=>GB.mutate('fluxo_salvar'));
  root.querySelector('#builder-publish')?.addEventListener('click',()=>GB.mutate('fluxo_publicar'));
  root.querySelector('#builder-toggle')?.addEventListener('click',()=>{const f=GB.state.flows.find(x=>x.key===GB.state.selected);GB.mutate('fluxo_estado',{enabled:!f.enabled});});
  root.querySelectorAll('[data-create-template]').forEach(b=>b.onclick=()=>{
   const f=GB.state.flows.find(x=>x.key===GB.state.selected);document.querySelector('[data-control-tab="drafts"]')?.click();
   delete GB.state.templates[f.brand+':'+b.dataset.createTemplate];
   GRU.abrir(GR.novo({marca:f.brand,canal:b.dataset.createTemplate}),null);
  });
 },
 refreshActions(){const t=document.querySelector('#builder-toggle');if(t)t.disabled=true;const b=document.querySelector('#builder-save');if(b)b.disabled=GB.state.busy||!GB.state.dirty;const p=document.querySelector('#builder-publish');if(p)p.disabled=true;},
};
if(typeof module!=='undefined'&&module.exports)module.exports=GB;
