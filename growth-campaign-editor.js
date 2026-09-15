/* Commercial campaign drafts. Remote delivery is not enabled by this editor. */
'use strict';
const GCE=(()=>{
 const KEY='shrigma_campaign_composer_v1';
 const fields=['brand','initiative_name','initiative_key','utm_campaign','name','subject','from_email','reply_to','list_ids','template_id','send_at','tags','html','text'];
 let root=null,dirty=false;
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const blank=brand=>({brand:brand==='aristo'?'aristo':'fish',initiative_name:'',initiative_key:'',utm_campaign:'',name:'',subject:'',from_email:'',reply_to:'',list_ids:'',template_id:'',send_at:'',tags:'',html:'',text:''});
 const split=v=>String(v||'').split(',').map(v=>v.trim()).filter(Boolean);
 const definition=v=>CampaignContract.normalize({schema_version:CampaignContract.VERSION,brand:v.brand,channel:'email',initiative:{key:v.initiative_key,name:v.initiative_name},utm_campaign:v.utm_campaign,name:v.name,subject:v.subject,from_email:v.from_email,reply_to:v.reply_to,list_ids:split(v.list_ids).map(Number),template_id:Number(v.template_id),html:v.html,text:v.text,tags:split(v.tags),send_at:v.send_at?v.send_at+'-03:00':null});
 const fromDefinition=input=>{const d=CampaignContract.normalize(input);return {brand:d.brand,initiative_name:d.initiative.name,initiative_key:d.initiative.key,utm_campaign:d.utm_campaign,name:d.name,subject:d.subject,from_email:d.from_email,reply_to:d.reply_to,list_ids:d.list_ids.join(', '),template_id:String(d.template_id),send_at:d.send_at?new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3,hourCycle:'h23'}).format(new Date(d.send_at)).replace(' ','T').replace(',','.').replace(/\.000$/,''):'',tags:d.tags.join(', '),html:d.html,text:d.text};};
 function values(){return Object.fromEntries(fields.map(k=>[k,root.querySelector(`[name="${k}"]`).value]));}
 function message(text,error=false){const el=root.querySelector('[data-ce-status]');el.textContent=text;el.dataset.error=String(error);}
 function keep(){dirty=true;try{localStorage.setItem(KEY,JSON.stringify(values()));message('Rascunho salvo neste navegador. Ainda não cadastrado para envio.');}catch{message('Não foi possível salvar neste navegador. Exporte o JSON para guardar o rascunho.',true);}}
 function fill(v){for(const k of fields)root.querySelector(`[name="${k}"]`).value=typeof v[k]==='string'?v[k]:'';}
 const input=(name,label,placeholder='',extra='')=>`<label>${label}<input name="${name}" autocomplete="off" placeholder="${esc(placeholder)}" ${extra}></label>`;
 function mount({marca='fish'}={}){
  const target=typeof document!=='undefined'?document.getElementById('campaign-composer'):null;
  if(!target||target===root)return;root=target;
  root.innerHTML=`<details class="ce-shell"><summary><span class="ce-icon" aria-hidden="true">+</span><span class="ce-title"><strong>Preparar campanha</strong><span>Crie pelo painel ou importe o conteúdo preparado com IA.</span></span><span class="ce-tag">Rascunho local</span></summary>
   <div class="ce-body"><div class="ce-intro"><div><span class="ce-eyebrow">CADASTRO DE E-MAIL</span><h3>Uma iniciativa. Todos os seus disparos.</h3><p>A iniciativa reúne a campanha no relatório. Cada disparo mantém sua base e identificação próprias.</p></div><label class="ce-import">Importar JSON<input type="file" accept=".json,application/json" data-ce-import></label></div>
   <form novalidate><fieldset><legend><span>01</span> Campanha e iniciativa</legend><div class="ce-grid"><label>Marca<select name="brand"><option value="fish">Fishermans</option><option value="aristo">O Aristocrata</option></select></label>${input('initiative_name','Iniciativa comercial','Ex.: Semana do Cliente')}${input('initiative_key','Identificador da iniciativa','Ex.: semana-do-cliente-2026')}${input('utm_campaign','UTM da campanha','Use o identificador já adotado na iniciativa')}${input('name','Nome deste disparo','Ex.: Abertura · clientes recorrentes')}${input('subject','Assunto do e-mail','O assunto que aparece na caixa de entrada','maxlength="250"')}</div></fieldset>
   <fieldset><legend><span>02</span> Público e remetente</legend><div class="ce-grid">${input('list_ids','IDs das listas','Ex.: 123, 124')}${input('template_id','ID do template de campanha','Consulte o catálogo de templates','inputmode="numeric"')}${input('from_email','Remetente','Marca <email@dominio-da-marca>')}${input('reply_to','Endereço para respostas','email@dominio-da-marca')}${input('send_at','Data desejada · Brasília, UTC−3 (opcional)','','type="datetime-local" step="60"')}${input('tags','Tags (opcional)','abertura, clientes-recorrentes')}</div><p class="ce-help">Os IDs serão conferidos com o catálogo da marca na integração de envio. Informar uma data aqui não agenda a campanha.</p></fieldset>
   <fieldset><legend><span>03</span> Conteúdo</legend><div class="ce-grid ce-content"><label>HTML do e-mail<textarea name="html" spellcheck="false" placeholder="Cole o HTML com os links da loja e {{ UnsubscribeURL }}"></textarea></label><label>Versão em texto<textarea name="text" placeholder="Cole a versão em texto, incluindo os links e {{ UnsubscribeURL }}"></textarea></label></div></fieldset>
   <div class="ce-tracking"><strong>Rastreamento vinculado ao disparo</strong><p>A API de cadastro deverá aplicar as UTMs ao HTML e ao texto com o ID real do envio. O JSON exportado é uma preparação; ainda não confirma links rastreados, listas disponíveis ou agendamento.</p></div>
   <div class="ce-actions"><button type="button" class="ce-primary" data-ce-export>Verificar e exportar JSON</button><button type="button" class="ce-secondary" data-ce-reset>Limpar rascunho</button><span data-ce-status role="status" aria-live="polite">Rascunho local. Ainda não cadastrado para envio.</span></div>
   </form></div></details>`;
  let initial=blank(marca);try{const saved=JSON.parse(localStorage.getItem(KEY)||'null');if(saved&&typeof saved==='object'&&!Array.isArray(saved)){initial={...initial,...Object.fromEntries(fields.filter(k=>typeof saved[k]==='string').map(k=>[k,saved[k]]))};if(!['fish','aristo'].includes(initial.brand))initial.brand='fish';}}catch{}
  fill(initial);dirty=fields.some(k=>k!=='brand'&&initial[k]);
  root.querySelector('form').addEventListener('submit',e=>e.preventDefault());
  root.querySelector('form').addEventListener('input',keep);
  root.querySelector('[data-ce-import]').addEventListener('change',async e=>{
   const f=e.target.files?.[0];if(!f)return;
   try{if(f.size>800000)throw Error('Use um arquivo JSON de até 800 KB.');const v=fromDefinition(JSON.parse(await f.text()));if(dirty&&!confirm('Substituir o rascunho local pelo conteúdo deste arquivo?'))return;fill(v);keep();message('JSON importado e campos conferidos. Catálogo e UTMs finais serão validados na integração de envio.');}catch(err){message(err instanceof SyntaxError?'O arquivo não contém um JSON válido.':err.message,true);}finally{e.target.value='';}
  });
  root.querySelector('[data-ce-export]').addEventListener('click',()=>{
   try{const d=definition(values()),blob=new Blob([JSON.stringify(d,null,2)+'\n'],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`campanha-${d.brand}-${d.utm_campaign}.json`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);keep();message('JSON exportado. Estrutura conferida; envio e rastreamento final ainda dependem da integração.');}
   catch(err){message(err.message,true);const mapped={'initiative.key':'initiative_key','initiative.name':'initiative_name'};root.querySelector(`[name="${mapped[err.field]||err.field}"]`)?.focus();}
  });
  root.querySelector('[data-ce-reset]').addEventListener('click',()=>{if(!confirm('Limpar o rascunho salvo neste navegador?'))return;fill(blank(values().brand));try{localStorage.removeItem(KEY);}catch{}dirty=false;message('Rascunho limpo. Nenhuma campanha de envio foi alterada.');});
 }
 return {mount,definition,fromDefinition};
})();
if(typeof module!=='undefined')module.exports=GCE;
