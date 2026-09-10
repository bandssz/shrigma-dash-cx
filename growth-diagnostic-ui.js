/* Página auxiliar isolada. Só GET no endpoint Growth já configurado. */
'use strict';
(() => {
  const $=s=>document.querySelector(s),esc=GC.esc;
  let api=null,receivedAt=null,failed=false,loading=false;
  const nf=v=>v===null?'—':v.toLocaleString('pt-BR');
  const brDay=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const previous=d=>new Date(Date.parse(d+'T12:00:00Z')-86400000).toISOString().slice(0,10);
  const valid=()=>GDI.day($('#start').value)&&GDI.day($('#end').value)&&$('#start').value<=$('#end').value;
  function model(){return GDI.model(api,{brand:$('#brand').value,ini:$('#start').value,fim:$('#end').value,receivedAt,readFailed:failed});}
  function render(){
    if(!valid()){$('#status').textContent='Informe um período válido, com início anterior ou igual ao fim.';$('#result').hidden=true;return;}
    if(!api){$('#result').hidden=true;return;}
    const m=model(),s=m.configuration.stages,h=m.history;
    const box=(title,stage)=>`<article class="stage"><h3>${esc(title)}</h3><p class="${stage.state==='blocked'?'unknown':''}">${esc(stage.label)}</p><small>Consulta: ${esc(GC.stamp(stage.checked_at))}</small></article>`;
    const count=(k,title)=>`<div class="count"><strong>${nf(h.counts[k])}</strong><span>${esc(title)}</span></div>`;
    const stateClass=m.configuration.state==='blocked'?'blocked':m.configuration.state==='unknown'?'warning':'';
    $('#received').textContent='Última resposta recebida: '+GC.stamp(receivedAt)+' · Horário de Brasília. Não é o horário de coleta de cada fonte.';
    $('#result').hidden=false;
    $('#result').innerHTML=`${failed?'<p class="notice warning">A última atualização falhou. Os números abaixo são da última resposta recebida; a configuração não é atestada como atual.</p>':''}
      <section class="panel"><span class="overline">Configuração atual · ${esc(m.brand_label)}</span><h2>O envio está habilitado?</h2><p class="notice ${stateClass}">${esc(m.configuration.label)}</p><p class="fine muted">Inventário: ${esc(GC.stamp(m.inventory_at))}. Não depende das datas do histórico.</p><div class="stages">${box('1. Automação de pedido pago',s.transactional)}${box('2. Motor de envio',s.motor)}${box('3. Template de pagamento',s.template)}</div></section>
      <section class="panel"><span class="overline">Histórico próprio · ${esc(m.period.start)} a ${esc(m.period.end)}</span><h2>O que foi registrado?</h2><p>${esc(h.label)}</p>${!h.coverage_complete?'<p class="notice warning">A resposta não comprova cobertura completa deste intervalo. Os totais indisponíveis aparecem como —, não como zero.</p>':''}<div class="counts">${count('registros','Registros processados')}${count('aceitos','Aceitos pela Meta')}${count('entregues','Entregues, incluindo lidos')}${count('lidos','Lidos')}${count('falhas','Falhas de entrega')}${count('erros_sincronos','Rejeições no envio')}${count('pendentes_entrega','Aguardando status final')}${count('sem_disparo_confirmado','Sem disparo confirmado')}</div><p class="fine muted">Último registro: ${esc(GC.stamp(h.last_record_at))} · Último status: ${esc(GC.stamp(h.last_status_at))}. Esses horários são eventos, não horários de coleta.</p></section>
      <section class="panel"><div class="line"><h2>Limites e próximo diagnóstico</h2><button type="button" id="export">Exportar diagnóstico</button></div><p class="fine">O JSON contém apenas este resumo agregado, sem chave de acesso, telefone, e-mail, número de pedido ou conteúdo de mensagem.</p><ul class="fine">${m.limits.map(x=>`<li>${esc(x)}</li>`).join('')}</ul><p class="fine">Para explicar um pedido específico que não foi enviado, ainda é necessário conferir o evento de pagamento na origem, a versão executada, as regras de elegibilidade e o registro do motor. Esta página não substitui essa conferência.</p></section>`;
    $('#export').onclick=()=>{
      const report=model(),blob=new Blob([JSON.stringify(report,null,2)+'\n'],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');
      a.href=url;a.download=`diagnostico-pedido-pago-${report.brand}-${report.period.start}-${report.period.end}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    };
  }
  async function load(explicitKey){
    if(loading)return;
    const key=explicitKey||shrigmaChave('growth');
    if(!key){$('#auth').hidden=false;$('#status').textContent='Informe a chave de leitura do Growth para consultar.';return;}
    loading=true;$('#refresh').disabled=true;$('#status').textContent='Consultando o Growth…';
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);
    try{
      const url=new URL(CX_API_URL);url.searchParams.set('k',key);url.searchParams.set('painel','growth');
      const response=await fetch(url.toString(),{method:'GET',headers:{Accept:'application/json'},signal:controller.signal,redirect:'error',cache:'no-store'});
      if(response.status===401){shrigmaEsqueceChave('growth');$('#auth').hidden=false;throw new Error('unauthorized');}
      if(!response.ok)throw new Error('http_'+response.status);
      const next=await response.json();
      if(!next||next._escopo!=='growth'||!Array.isArray(next.crm_campanha)||!Array.isArray(next.crm_fluxo)||!Array.isArray(next.crm_conversao))throw new Error('wrong_scope');
      api=next;receivedAt=new Date().toISOString();failed=false;
      if(explicitKey)shrigmaGuardaChave('growth',key);
      shrigmaMarcaMestra(key,next._painel);$('#auth-key').value='';$('#auth').hidden=true;
      $('#status').textContent='Consulta recebida. Os horários de cada fonte estão indicados abaixo.';
    }catch(e){
      failed=true;
      $('#status').textContent=e.message==='unauthorized'?'Chave não aceita. Informe uma chave de leitura válida.':e.message==='wrong_scope'?'A resposta não confirmou o escopo Growth. Nenhum dado novo foi aplicado.':e.name==='AbortError'?'A consulta excedeu 20 segundos. Nenhuma alteração foi realizada.':'Não foi possível consultar o Growth. Nenhuma alteração foi realizada.';
    }finally{clearTimeout(timeout);loading=false;$('#refresh').disabled=false;render();}
  }
  $('#start').value=brDay();$('#end').value=brDay();
  for(const id of ['brand','start','end'])$('#'+id).addEventListener('change',render);
  $('#today').onclick=()=>{$('#start').value=brDay();$('#end').value=brDay();render();};
  $('#yesterday').onclick=()=>{$('#end').value=brDay();$('#start').value=previous(brDay());render();};
  $('#refresh').onclick=()=>load();
  $('#auth-form').onsubmit=e=>{e.preventDefault();const key=$('#auth-key').value.trim();if(key)load(key);};
  load();setInterval(()=>load(),60000);setInterval(render,30000);
})();
