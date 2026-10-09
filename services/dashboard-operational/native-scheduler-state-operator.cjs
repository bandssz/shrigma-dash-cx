'use strict';
const {isProxy}=require('node:util').types;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SCHEDULER_STATE_JS=`'use strict';
(()=>{
 const form=document.getElementById('scheduler-state-authorization'),button=document.getElementById('authorize'),message=document.getElementById('result'),data=document.getElementById('scheduler-state-data');
 let config;try{config=JSON.parse(data.textContent);}catch{button.disabled=true;return;}let attempted=false;
 form.addEventListener('submit',async event=>{event.preventDefault();if(attempted)return;attempted=true;button.disabled=true;
  try{const response=await fetch('/auth/scheduler-state-settings',{method:'POST',credentials:'same-origin',redirect:'error',headers:{'Content-Type':'application/json','X-CSRF-Token':config.csrf},body:JSON.stringify({action:'authorize',connectionId:document.getElementById('connection').value,consent:true})});
   message.textContent=response.status===200?'Leitura das travas autorizada. O integrador fará a consulta nativa.':'Autorização recusada ou incerta. Nenhuma consulta foi executada nesta página.';
  }catch{message.textContent='Autorização incerta. A tentativa não será repetida automaticamente.';}
 });
})();`;
function renderSchedulerStateOperator({csrf,connections}={}){
 if(typeof csrf!=='string'||!csrf||csrf.length>1024||/[\x00-\x1f\x7f]/.test(csrf)||!Array.isArray(connections)||isProxy(connections)||connections.length>64)throw Object.assign(Error('SCHEDULER_STATE_OPERATOR_REFUSED'),{code:'SCHEDULER_STATE_OPERATOR_REFUSED',status:400});
 const ids=new Set(),safe=[];for(const c of connections){if(!c||isProxy(c)||Object.getPrototypeOf(c)!==Object.prototype)throw Error('SCHEDULER_STATE_OPERATOR_REFUSED');const desc=Object.getOwnPropertyDescriptor(c,'id');if(!desc||!Object.hasOwn(desc,'value')||!UUID.test(desc.value)||ids.has(desc.value))throw Error('SCHEDULER_STATE_OPERATOR_REFUSED');ids.add(desc.value);safe.push(desc.value);}
 const data=JSON.stringify({csrf}).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
 return '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Autorizar leitura das travas</title></head><body><main><h1>Autorizar leitura das travas</h1><p>Permite ao integrador consultar somente o estado armazenado das travas do agendador original. Esta autorização não envia campanhas, altera horários nem reinicia serviços.</p><form id="scheduler-state-authorization"><label for="connection">Conexão nativa</label><select id="connection" name="connectionId">'+safe.map((id,i)=>'<option value="'+id+'">Conexão '+(i+1)+'</option>').join('')+'</select><button id="authorize" type="submit"'+(safe.length?'':' disabled')+'>Autorizar leitura das travas</button></form><p id="result" role="status"></p></main><script id="scheduler-state-data" type="application/json">'+data+'</script><script src="/auth/scheduler-state.js" defer></script></body></html>';
}
module.exports=Object.freeze({renderSchedulerStateOperator,SCHEDULER_STATE_JS});
