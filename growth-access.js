/* Acesso de leitura CRM: chave somente nesta página. */
const GrowthAccess=(()=>{
 'use strict';
 let active=null;
 const validKey=v=>typeof v==='string'&&v.trim().length>0&&v.trim().length<=2048&&!/[\x00-\x20\x7f]/.test(v.trim());
 function readError(e){
  if(['TimeoutError','AbortError'].includes(e?.name))return 'A consulta demorou além do esperado.';
  const allowed=['Acesso recusado. Informe uma chave válida no formulário.','Esta chave não retornou os dados do CRM.'];
  if(allowed.includes(e?.message)||/^Consulta indisponível \(HTTP [1-5][0-9]{2}\)\.$/.test(e?.message||''))return e.message;
  return 'A consulta falhou. Confira a conexão e tente novamente.';
 }
 function bind({document,readExisting,onRead}){
  const $=s=>document.querySelector(s),form=$('#growth-acesso'),field=$('#growth-chave'),fields=$('#growth-acesso-campos'),message=$('#growth-acesso-msg');
  let session='',legacy=true,busy=false,epoch=0,caller=null;
  const current=()=>{let k=session;try{if(!k&&legacy)k=readExisting?.()||'';}catch(_){}return validKey(k)?k.trim():'';};
  function show(text='',{force=false}={}){
   if(!form.hidden&&!force){if(text)message.textContent=text;return;}
   const opening=form.hidden;epoch++;
   if(opening)caller=document.activeElement;
   field.value='';field.removeAttribute('aria-invalid');fields.disabled=busy;form.hidden=false;message.textContent=text;
   if(!busy&&opening)field.focus();
  }
  function cancel(){epoch++;field.value='';form.hidden=true;message.textContent='';fields.disabled=busy;(caller?.isConnected?caller:$('#btn-atualizar'))?.focus();}
  function reject(key,text){if(key!==current())return;session='';legacy=false;show(text||'Chave recusada. Confira o acesso de leitura ao CRM.',{force:true});}
  field.oninput=()=>{field.removeAttribute('aria-invalid');};
  $('#growth-acesso-cancelar').onclick=cancel;
  form.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();cancel();}};
  form.onsubmit=async e=>{
   e.preventDefault();if(form.hidden||busy)return;
   const k=field.value.trim();
   if(!validKey(k)){message.textContent='Informe uma chave de leitura válida.';field.setAttribute('aria-invalid','true');field.focus();return;}
   session=k;legacy=false;epoch++;field.value='';form.hidden=true;busy=true;fields.disabled=true;form.setAttribute('aria-busy','true');
   try{await onRead?.();}
   catch(_){show('Não foi possível concluir a consulta. Confira o acesso e tente novamente.');}
   finally{busy=false;fields.disabled=false;form.setAttribute('aria-busy','false');if(!form.hidden)field.focus();}
  };
  active={current,show,reject,isSession:k=>!!session&&k===session};return active;
 }
 return {bind,validKey,readError,ready:()=>!!active,current:()=>active?.current()||'',isSession:k=>active?.isSession(k)===true};
})();
if(typeof module!=='undefined')module.exports=GrowthAccess;
