/* A deliberate local preparation; no fetch, publication or transport. */
'use strict';
const GERU={
 session:null,
 journal(source){
  const j=GRU.caps?.endpoint?GRU.journal()?.inspect():{available:!source.servidor,blocked:!!source.servidor,operations:[]};
  const tests=GRU.emailTestClient()?.inspect();
  if(tests?.blocked||tests?.operations?.some(o=>o.request_payload?.draft_id===source.servidor?.draft_id&&['pending','unknown'].includes(o.phase)))return {...j,blocked:true};
  return j;
 },
 open(id){
  if(GRU.state.ocupado||GRU.state.confirmando||GRU.emailTestSession||GERU.session)return;
  const source=GR.lista().find(r=>r.id===id);
  try{
   if(!source)throw Error('O rascunho não está mais neste dispositivo. Atualize a lista.');
   if(GRU.state.rascunho?.id===id&&JSON.stringify(GR.conteudo(GRU.state.rascunho))!==JSON.stringify(GR.conteudo(source)))throw Error('Salve as alterações neste dispositivo antes de copiar este template.');
   const to=source.marca==='fish'?'aristo':'fish',plan=GER.prepare(source,to,{journal:GERU.journal(source)});
   GERU.session={plan,localId:GR.id(),fields:Object.fromEntries(['nome','assunto','preheader','from_email','reply_to'].map(k=>[k,plan.content[k]||''])),links:plan.links.map(l=>({id:l.id,target:['external','dynamic'].includes(l.kind)?l.url:'',reviewed:false})),review:null,error:'',confirmed:false};
   GRU.replicationSession=true;GRU.render();document.getElementById('rep-name')?.focus();
  }catch(e){GRU.aviso(e.message,'erro');GRU.render();}
 },
 current(s){
  const source=GR.lista().find(r=>r.id===s.plan.source_id);
  if(!source||JSON.stringify(GR.conteudo(source))!==s.plan.source_content||JSON.stringify(source.servidor||null)!==s.plan.source_server||GER.pending(source,GERU.journal(source)))throw Error('O template de origem ou uma operação mudou. Cancele, confira a origem e reabra a cópia.');
  return source;
 },
 html(){
  const s=GERU.session;if(!s)return '';const e=GRU.e,b=GEC.BRANDS[s.plan.to];
  const field=(key,label,id,type='text')=>`<div class="campo"><label for="${id}">${label}</label><input type="${type}" id="${id}" data-rep-field="${key}" value="${e(s.fields[key])}"></div>`;
  return `<section class="painel draft-confirm" id="email-replication" role="dialog" aria-modal="false" aria-labelledby="rep-title" tabindex="-1"><h3 id="rep-title">Copiar e-mail para ${e(b.name)}</h3><div class="rep-badges"><span class="rep-badge" title="A cópia fica neste dispositivo, sem publicação ou envio. A origem permanece intacta.">Novo rascunho local</span>${s.plan.links.some(l=>l.tracking_removed.length||l.directRequired)?'<span class="rep-badge" title="Identificadores do envio anterior e sua campanha UTM não acompanham a cópia. Revise a campanha de destino em cada endereço.">Rastreamento de envio removido</span>':''}</div>${s.error?`<p role="alert" class="drafts-msg" data-tone="erro">${e(s.error)}</p>`:''}
   <div class="form">${field('nome','Nome da cópia','rep-name')}${field('from_email','Remetente','rep-from')}${field('reply_to','Responder para','rep-reply','email')}${field('assunto','Assunto','rep-subject')}${field('preheader','Pré-header','rep-preheader')}</div>
   <h4>Destinos e imagens <span class="rep-badge" title="Confira cada página e imagem na marca de destino. Esta etapa não consulta a loja nem confirma que os endereços existem.">Conferência manual</span></h4>
   ${s.plan.links.length?s.plan.links.map((l,i)=>`<div class="campo rep-link"><label for="rep-url-${i}">${l.kind==='personal'?'Link pessoal — informe o destino direto':l.kind==='origin'?'Endereço da origem':l.kind==='relative'?'Endereço incompleto':l.kind==='dynamic'?'Endereço da automação':'Recurso externo'} · ${e(l.original_url)}</label><input type="text" id="rep-url-${i}" data-rep-url="${i}" value="${e(s.links[i].target)}" placeholder="https://${e(b.domain)}/caminho-conferido" title="Destino completo. Informe a campanha UTM desejada, se houver; a campanha anterior não é copiada."><label title="Confira o endereço, a campanha UTM e, para imagens, a identidade visual da marca de destino."><input type="checkbox" data-rep-reviewed="${i}"${s.links[i].reviewed?' checked':''}>Destino e campanha conferidos para ${e(b.name)}${l.kind==='dynamic'?' nos dados da automação':''}</label></div>`).join(''):'<p class="nota">Sem endereços. Confira o conteúdo na prévia.</p>'}
   <div class="draft-confirm-row"><button type="button" class="btn sec" id="rep-preview">Conferir a cópia</button><button type="button" class="btn sec" id="rep-cancel">Cancelar cópia</button></div>
   ${s.review?`<div id="rep-final"><h4>Prévia da cópia · ${e(b.name)}</h4><dl class="rep-envelope"><dt>Remetente</dt><dd>${e(s.review.from_email)}</dd><dt>Responder para</dt><dd>${e(s.review.reply_to)}</dd><dt>Assunto</dt><dd>${e(s.review.assunto)}</dd><dt>Pré-header</dt><dd>${e(s.review.preheader)}</dd></dl><span class="rep-badge" title="Links e imagens externas ficam desativados nesta prévia. Confira os destinos listados abaixo.">Prévia protegida</span>${GMP.frame(GEC.html(s.review),false,'Prévia da cópia para '+b.name)}<details><summary>Endereços finais revisados</summary><ul>${GER.urls(s.review).map(url=>`<li>${e(url)}<small class="rep-campaign">Campanha UTM: ${e(GER.campaigns(url).join(", ")||"não definida neste endereço")}</small></li>`).join('')||'<li>Sem endereços no conteúdo.</li>'}</ul></details><details><summary>HTML da cópia</summary><pre>${e(GEC.html(s.review))}</pre></details><label><input type="checkbox" id="rep-confirmed"${s.confirmed?' checked':''}>Revisei conteúdo, identidade visual e destinos para ${e(b.name)}.</label><div class="draft-confirm-row"><button type="button" class="btn" id="rep-create"${s.confirmed?'':' disabled'}>Criar rascunho de ${e(b.name)}</button></div></div>`:''}</section>`;
 },
 review(){const s=GERU.session;if(!s)return;try{GERU.current(s);s.review=GER.apply(s.plan,{fields:s.fields,links:s.links});s.error='';s.confirmed=false;}catch(e){s.review=null;s.confirmed=false;s.error=e.message;}GRU.render();document.getElementById(s.review?'rep-confirmed':'rep-preview')?.focus();},
 create(){
  const s=GERU.session;if(!s?.review||!s.confirmed)return;
  try{GERU.current(s);const content=GER.apply(s.plan,{fields:s.fields,links:s.links});if(JSON.stringify(content)!==JSON.stringify(s.review))throw Error('A cópia mudou. Confira a prévia novamente.');
   const item=GR.novo({...content,id:s.localId});if(!GR.guarda(item))throw Error('Não foi possível guardar a cópia neste dispositivo. Libere espaço e tente novamente.');
   const saved=GR.lista().find(r=>r.id===s.localId);if(!saved||JSON.stringify(GR.conteudo(saved))!==JSON.stringify(content)||saved.servidor)throw Error('A gravação local não foi confirmada. Confira a lista antes de repetir.');
   const brand=GEC.BRANDS[s.plan.to].name;GERU.session=null;GRU.replicationSession=false;GRU.aviso('Cópia salva em '+brand+'. Selecione essa marca no cabeçalho para abrir o novo rascunho. Nenhum template foi publicado ou enviado.');GRU.render();
  }catch(e){s.error=e.message;GRU.render();}
 },
 cancel(){const id=GERU.session?.plan.source_id;GERU.session=null;GRU.replicationSession=false;GRU.render();document.querySelector('[data-email-replicate="'+id+'"]')?.focus();},
 bind(root){
  root.querySelectorAll('[data-email-replicate]').forEach(b=>b.onclick=()=>GERU.open(b.dataset.emailReplicate));
  const box=root.querySelector('#email-replication'),s=GERU.session;if(!box||!s)return;
  const changed=()=>{s.review=null;s.confirmed=false;box.querySelector('#rep-final')?.remove();};
  box.querySelectorAll('[data-rep-field]').forEach(el=>el.oninput=()=>{s.fields[el.dataset.repField]=el.value;changed();});
  box.querySelectorAll('[data-rep-url]').forEach(el=>el.oninput=()=>{const i=+el.dataset.repUrl;s.links[i].target=el.value;s.links[i].reviewed=false;box.querySelector('[data-rep-reviewed="'+i+'"]').checked=false;changed();});
  box.querySelectorAll('[data-rep-reviewed]').forEach(el=>el.onchange=()=>{s.links[+el.dataset.repReviewed].reviewed=el.checked;changed();});
  box.querySelector('#rep-preview').onclick=GERU.review;box.querySelector('#rep-cancel').onclick=GERU.cancel;
  if(box.querySelector('#rep-confirmed'))box.querySelector('#rep-confirmed').onchange=e=>{s.confirmed=e.target.checked;box.querySelector('#rep-create').disabled=!s.confirmed;};
  if(box.querySelector('#rep-create'))box.querySelector('#rep-create').onclick=GERU.create;
  box.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();GERU.cancel();}};
 }
};
