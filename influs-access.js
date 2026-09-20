/* Acesso local ao painel de Influs. Nenhuma chave nova é persistida; login não grava cadastro. */
const InflusAccess=(()=>{
 'use strict';
 const roles=new Set(['read','write']);
 const validKey=v=>typeof v==='string'&&v.trim().length>0&&v.trim().length<=2048&&!/[\x00-\x20\x7f]/.test(v.trim());
 const validAuthor=v=>typeof v==='string'&&v.trim().length>=2&&v.trim().length<=60&&!/[\x00-\x1f\x7f]/.test(v);
 function parseFile(text,role){
  if(!roles.has(role)||typeof text!=='string'||text.length>8192)throw Error('invalid_access_file');
  let p;try{p=JSON.parse(text);}catch(_){throw Error('invalid_access_file');}
  const keys=['schema','panel','role','key'];
  if(!p||Array.isArray(p)||typeof p!=='object'||p.schema!=='shrigma_panel_access_v1'||p.panel!=='influs'||p.role!==role||!validKey(p.key)||keys.some(k=>!Object.hasOwn(p,k))||Object.keys(p).some(k=>!keys.includes(k)&&!(role==='write'&&k==='author'))||Object.hasOwn(p,'author')&&!validAuthor(p.author))throw Error('invalid_access_file');
  return {key:p.key.trim(),author:p.author?.trim()||''};
 }
 function bind({document,host,readExisting,writeExisting,authorExisting,onRead}){
  let sessionRead='',sessionWrite='',sessionAuthor='',legacyRead=true,legacyWrite=true,role='read',busy=false,importing=false,epoch=0,fileError=false,caller=null;
  const legacy=fn=>{try{return fn?.()||'';}catch(_){return '';}};
  const current=r=>{const v=r==='read'?sessionRead||(legacyRead?legacy(readExisting):''):sessionWrite||(legacyWrite?legacy(writeExisting):'');return validKey(v)?v.trim():'';};
  const author=()=>{const a=sessionAuthor||legacy(authorExisting);return validAuthor(a)?a.trim():'';};
  host.innerHTML=`<div class="influ-access-toolbar"><button type="button" class="btn sec" data-influ-access="read">Acesso de leitura</button><button type="button" class="btn sec" data-influ-access="write">Acesso de cadastro e autoria</button><span class="mini" id="influ-access-status" role="status" aria-live="polite"></span></div>
   <form id="influ-access-form" class="nota" hidden aria-labelledby="influ-access-title" novalidate>
    <h3 id="influ-access-title"></h3><p class="mini">A chave informada fica apenas nesta página aberta. Acesso de cadastro não autoriza ações do TikTok Shop.</p>
    <fieldset id="influ-access-fields"><div class="influ-access-grid">
     <div><label for="influ-access-key" id="influ-access-key-label">Chave</label><input id="influ-access-key" type="password" autocomplete="off" spellcheck="false" maxlength="2048" aria-describedby="influ-access-message"></div>
     <div id="influ-access-author-wrap"><label for="influ-access-author">Seu nome no histórico</label><input id="influ-access-author" type="text" autocomplete="name" maxlength="60" aria-describedby="influ-access-message"></div>
     <div><label for="influ-access-file">Importar arquivo de acesso deste painel</label><input id="influ-access-file" type="file" accept="application/json,.json"></div>
    </div><button class="btn" id="influ-access-submit" type="submit">Acessar</button></fieldset>
    <button class="btn sec" id="influ-access-cancel" type="button">Cancelar</button><p class="mini" id="influ-access-message" role="status" aria-live="polite"></p>
   </form>`;
  const $=s=>document.querySelector(s),form=$('#influ-access-form'),field=$('#influ-access-key'),authorField=$('#influ-access-author'),file=$('#influ-access-file'),fields=$('#influ-access-fields'),message=$('#influ-access-message'),status=$('#influ-access-status');
  const originParent=form.parentNode;
  function restore(){if(form.parentNode!==originParent)originParent.appendChild(form);}
  function focusCaller(){const target=caller?.isConnected?caller:host.querySelector(`[data-influ-access="${role}"]`);target?.focus();}
  function setBusy(value){busy=!!value;fields.disabled=busy||importing;form.setAttribute('aria-busy',String(busy));}
  function show(r,{text,explicit=false,force=false}={}){
   if(!roles.has(r)||busy&&!force)return;
   if(!explicit&&!form.hidden)return;
   epoch++;importing=false;fileError=false;role=r;caller=document.activeElement;restore();
   const drawer=caller?.closest?.('#i-editor')||document.querySelector('#i-editor:not([hidden])');if(drawer&&!drawer.hidden)drawer.prepend(form);
   field.value='';file.value='';authorField.value=r==='write'?author():'';
   $('#influ-access-title').textContent=r==='read'?'Acesso de leitura — Influs':'Acesso de cadastro — Creators';
   $('#influ-access-key-label').textContent=r==='read'?'Chave de leitura':'Chave de escrita do cadastro';
   $('#influ-access-author-wrap').hidden=r!=='write';
   field.placeholder=current(r)?'Já informada; preencha somente para trocar':'';
   field.removeAttribute('aria-invalid');authorField.removeAttribute('aria-invalid');
   $('#influ-access-submit').textContent=r==='read'?'Acessar leitura':'Usar nesta página';
   message.textContent=text||(r==='read'?'Consulte com a chave de leitura do painel.':'Informe chave e autoria. Depois, confira os dados e clique novamente na ação desejada.');
   fields.disabled=busy;form.hidden=false;(current(r)&&r==='write'&&!author()?authorField:field).focus();
  }
  function cancel(){epoch++;importing=false;fileError=false;field.value='';authorField.value='';file.value='';form.hidden=true;message.textContent='';fields.disabled=busy;restore();focusCaller();}
  function requireRead(){const k=current('read');if(!k)show('read');return k;}
  function requireWrite(){const k=current('write');if(!k||!author()){if(form.hidden||role!=='write')show('write',{explicit:true});return '';}return k;}
  function reject(r,key,text){if(key&&key!==current(r))return; if(r==='read'){sessionRead='';legacyRead=false;}else{sessionWrite='';legacyWrite=false;}show(r,{text:text||'Acesso recusado. Confira o papel permitido para esta chave.',explicit:true,force:true});}
  function forgetRead(){sessionRead='';legacyRead=false;show('read',{text:'Acesso de leitura não confirmado. Informe uma chave válida para Influs.',explicit:true,force:true});}
  host.querySelectorAll('[data-influ-access]').forEach(b=>b.onclick=()=>show(b.dataset.influAccess,{explicit:true}));
  $('#influ-access-cancel').onclick=cancel;
  form.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();cancel();}};
  field.oninput=()=>{fileError=false;field.removeAttribute('aria-invalid');};
  authorField.oninput=()=>authorField.removeAttribute('aria-invalid');
  form.onsubmit=async e=>{
   e.preventDefault();if(form.hidden||busy||importing)return;
   const key=field.value.trim()||current(role),a=authorField.value.trim();
   if(fileError||!validKey(key)){message.textContent='Informe uma chave válida para este acesso.';field.setAttribute('aria-invalid','true');field.focus();return;}
   if(role==='write'&&!validAuthor(a)){message.textContent='Informe seu nome no histórico, entre 2 e 60 caracteres.';authorField.setAttribute('aria-invalid','true');authorField.focus();return;}
   const selectedRole=role;epoch++;
   if(role==='read'){sessionRead=key;legacyRead=false;}else{sessionWrite=key;sessionAuthor=a;legacyWrite=false;}
   field.value='';authorField.value='';file.value='';form.hidden=true;restore();focusCaller();
   status.textContent=role==='read'?'Consultando o acesso de leitura…':'Acesso e autoria informados nesta página. Nenhuma alteração foi enviada; clique novamente na ação desejada.';
   if(selectedRole==='write')return; // Never retain or resume the action that opened authentication.
   setBusy(true);
   try{await onRead?.();if(form.hidden)status.textContent='Consultas finalizadas; confira no painel os dados e eventuais avisos de falha.';}
   catch(_){status.textContent='Não foi possível concluir a leitura. Tente novamente pelo painel.';}
   finally{setBusy(false);}
  };
  file.onchange=async()=>{
   const selected=file.files?.[0],ticket=++epoch,expectedRole=role;if(!selected)return;let focusWhenReady=false;
   importing=true;fileError=false;fields.disabled=true;field.value='';message.textContent='Lendo arquivo de acesso…';
   try{
    if(selected.size>8192)throw Error('invalid_access_file');
    const parsed=parseFile(await selected.text(),expectedRole);if(ticket!==epoch)return;
    field.value=parsed.key;if(expectedRole==='write'&&parsed.author)authorField.value=parsed.author;
    message.textContent='Arquivo conferido. Confirme o acesso no botão; nenhuma alteração será enviada.';focusWhenReady=true;
   }catch(_){if(ticket===epoch){field.value='';fileError=true;message.textContent='Arquivo inválido ou de outro painel/papel. Use o acesso específico de Influs.';}}
   finally{if(ticket===epoch){importing=false;fields.disabled=busy;file.value='';if(focusWhenReady&&!fields.disabled)field.focus();}}
  };
  return {current,author,requireRead,requireWrite,show,reject,forgetRead,isSessionRead:k=>!!sessionRead&&sessionRead===k};
 }
 return {bind,parseFile,validKey,validAuthor};
})();
if(typeof module!=='undefined')module.exports=InflusAccess;
