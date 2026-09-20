/* Acesso de leitura Growth: importação explícita, chave somente nesta página. */
const GrowthAccess=(()=>{
 'use strict';
 let active=null;
 const validKey=v=>typeof v==='string'&&v.trim().length>0&&v.trim().length<=2048&&!/[\x00-\x20\x7f]/.test(v.trim());
 function readError(e){
  if(['TimeoutError','AbortError'].includes(e?.name))return 'A consulta demorou além do esperado.';
  const allowed=['Acesso recusado. Informe uma chave válida no formulário.','Esta chave não retornou os dados de Growth.'];
  if(allowed.includes(e?.message)||/^Consulta indisponível \(HTTP [1-5][0-9]{2}\)\.$/.test(e?.message||''))return e.message;
  return 'A consulta falhou. Confira a conexão e tente novamente.';
 }
 function parseFile(text){
  if(typeof text!=='string'||text.length>8192)throw Error('invalid_access_file');
  let p;try{p=JSON.parse(text);}catch(_){throw Error('invalid_access_file');}
  const keys=['schema','panel','role','key'];
  if(!p||Array.isArray(p)||typeof p!=='object'||p.schema!=='shrigma_panel_access_v1'||p.panel!=='growth'||p.role!=='read'||!validKey(p.key)||keys.some(k=>!Object.hasOwn(p,k))||Object.keys(p).some(k=>!keys.includes(k)))throw Error('invalid_access_file');
  return {key:p.key.trim()};
 }
 function bind({document,readExisting,onRead}){
  const $=s=>document.querySelector(s),form=$('#growth-acesso'),field=$('#growth-chave'),file=$('#growth-acesso-arquivo'),fields=$('#growth-acesso-campos'),message=$('#growth-acesso-msg');
  let session='',legacy=true,busy=false,importing=false,epoch=0,fileError=false,caller=null;
  const current=()=>{let k=session;try{if(!k&&legacy)k=readExisting?.()||'';}catch(_){}return validKey(k)?k.trim():'';};
  function show(text='',{force=false}={}){
   if(!form.hidden&&!force){if(text)message.textContent=text;return;}
   const opening=form.hidden;epoch++;importing=false;fileError=false;
   if(opening)caller=document.activeElement;
   field.value='';file.value='';field.removeAttribute('aria-invalid');fields.disabled=busy;form.hidden=false;message.textContent=text;
   if(!busy&&opening)field.focus();
  }
  function cancel(){epoch++;importing=false;fileError=false;field.value='';file.value='';form.hidden=true;message.textContent='';fields.disabled=busy;(caller?.isConnected?caller:$('#btn-atualizar'))?.focus();}
  function reject(key,text){if(key!==current())return;session='';legacy=false;show(text||'Chave recusada. Confira o acesso de leitura a Growth.',{force:true});}
  field.oninput=()=>{fileError=false;field.removeAttribute('aria-invalid');};
  $('#growth-acesso-cancelar').onclick=cancel;
  form.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();cancel();}};
  form.onsubmit=async e=>{
   e.preventDefault();if(form.hidden||busy||importing)return;
   const k=field.value.trim();
   if(fileError||!validKey(k)){message.textContent='Informe uma chave de leitura válida.';field.setAttribute('aria-invalid','true');field.focus();return;}
   session=k;legacy=false;epoch++;field.value='';file.value='';form.hidden=true;busy=true;fields.disabled=true;form.setAttribute('aria-busy','true');
   try{await onRead?.();}
   catch(_){show('Não foi possível concluir a consulta. Confira o acesso e tente novamente.');}
   finally{busy=false;fields.disabled=importing;form.setAttribute('aria-busy','false');if(!form.hidden)field.focus();}
  };
  file.onchange=async()=>{
   const f=file.files?.[0],ticket=++epoch;if(!f)return;let focusWhenReady=false;
   importing=true;fileError=false;fields.disabled=true;field.value='';message.textContent='Lendo arquivo de acesso…';
   try{
    if(f.size>8192)throw Error('invalid_access_file');
    const parsed=parseFile(await f.text());if(ticket!==epoch)return;
    field.value=parsed.key;message.textContent='Arquivo conferido. Clique em Acessar painel para consultar.';focusWhenReady=true;
   }catch(_){if(ticket===epoch){fileError=true;field.value='';message.textContent='Arquivo inválido ou de outro painel/papel. Use um arquivo de leitura Growth.';}}
   finally{if(ticket===epoch){importing=false;fields.disabled=busy;file.value='';if(focusWhenReady&&!fields.disabled)field.focus();}}
  };
  active={current,show,reject,isSession:k=>!!session&&k===session};return active;
 }
 return {bind,parseFile,validKey,readError,ready:()=>!!active,current:()=>active?.current()||'',isSession:k=>active?.isSession(k)===true};
})();
if(typeof module!=='undefined')module.exports=GrowthAccess;
