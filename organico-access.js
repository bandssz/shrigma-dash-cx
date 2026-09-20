/* Acesso de leitura do Orgânico. Chave nova vive somente nesta página. */
const OrganicAccess=(()=>{
 'use strict';
 function validKey(value){return typeof value==='string'&&value.trim().length>0&&value.trim().length<=2048&&!/[\r\n\x00-\x1f]/.test(value);}
 function parseFile(text){
  if(typeof text!=='string'||text.length>4096)throw Error('invalid_access_file');
  let p;try{p=JSON.parse(text);}catch(_){throw Error('invalid_access_file');}
  if(!p||Array.isArray(p)||Object.keys(p).sort().join(',')!=='key,panel,schema'||p.schema!=='shrigma_read_access_v1'||p.panel!=='organico'||!validKey(p.key))throw Error('invalid_access_file');
  return p.key.trim();
 }
 function bind({document,readExisting,onAccess}){
  const $=s=>document.querySelector(s),form=$('#organico-acesso'),field=$('#organico-chave'),file=$('#organico-chave-arquivo'),msg=$('#organico-acesso-msg'),fields=$('#organico-acesso-campos');
  let session='',useExisting=true,busy=false,importing=false,epoch=0;
  const message=s=>{msg.textContent=s;};
  function current(){if(session)return session;if(!useExisting)return '';try{return readExisting()||'';}catch(_){return '';}}
  function show(text='Informe o acesso de leitura para consultar os dados.'){form.hidden=false;message(text);field.focus();}
  function cancel(){epoch++;importing=false;fields.disabled=busy;field.value='';file.value='';form.hidden=true;message('');$('#organico-acesso-abrir').focus();}
  function reject(){session='';useExisting=false;show('Acesso recusado. Confira se a chave permite consultar Orgânico.');}
  function setBusy(value){busy=!!value;fields.disabled=busy||importing;form.setAttribute('aria-busy',String(busy));if(!busy&&!importing&&!form.hidden)field.focus();}
  $('#organico-acesso-abrir').onclick=()=>show();
  $('#organico-acesso-cancelar').onclick=cancel;
  form.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();cancel();}};
  form.onsubmit=async e=>{
   e.preventDefault();if(busy||importing)return;
   if(!validKey(field.value)){message('Informe uma chave de leitura válida.');field.focus();return;}
   session=field.value.trim();useExisting=false;field.value='';file.value='';form.hidden=true;setBusy(true);
   try{await onAccess();}finally{setBusy(false);}
  };
  file.onchange=async()=>{
   const selected=file.files?.[0],ticket=++epoch;if(!selected)return;let loaded=false;
   importing=true;fields.disabled=true;field.value='';message('Lendo arquivo de acesso…');
   try{
    if(selected.size>4096)throw Error('invalid_access_file');
    const text=await selected.text();const key=parseFile(text);
    if(ticket!==epoch)return;
    field.value=key;loaded=true;message('Arquivo de leitura do Orgânico carregado. Confirme em Acessar.');
   }catch(_){if(ticket===epoch){field.value='';message('Arquivo inválido. Use somente o arquivo de acesso de leitura do Orgânico.');}}
   finally{if(ticket===epoch){importing=false;fields.disabled=busy;file.value='';if(loaded&&!busy)field.focus();}}
  };
  return {current,show,reject,setBusy};
 }
 return {bind,parseFile};
})();
if(typeof module!=='undefined')module.exports=OrganicAccess;
