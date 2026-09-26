(function(root){'use strict';
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const observed=(exact,reported,format)=>exact!=null?format(exact):reported!=null?format(reported)+' (parcial)':format(null);
 const money=n=>n==null?'Não disponível':Number(n).toLocaleString('pt-BR',{style:'currency',currency:'BRL'}),num=n=>n==null?'—':Number(n).toLocaleString('pt-BR',{maximumFractionDigits:2});
 const BRANDS={fish:'Fishermans',aristo:'O Aristocrata'},PAGES={fish:'https://fishermans.com.br/pages/seja-um-influenciador',aristo:'https://oaristocrata.com/pages/seja-um-influenciador'};
 const SLOT='shrigma_creator_pilot_operation_v1',states={novo:'Novo',em_analise:'Em análise',aprovado_piloto:'Aprovado no piloto',pausado:'Pausado',recusado:'Não aprovado'};
 // O link só é emitido porque a persistência até o pedido pago foi medida em pedido real, não suposta.
 // O valor a pagar continua fora: a base do grão de pedido inclui frete, e a comissão é sem frete.
 const linkStates={pausado:'Pausado',ativo:'Ativo',revogado:'Revogado'};
 function bind({document,getData,getMarca,getPeriod,getSection=()=>null,key,endpoint,reload,storage=localStorage,confirmRevoke=(nome)=>typeof confirm!=='function'||confirm(`Revogar o link de ${nome}? O código é preservado para os pedidos que já vieram por ele, e um novo link pode ser gerado depois.`)}){
  const q=s=>document.querySelector(s);let search='',category='todos',page=0,editing=null,payEditing=null,busy=false,message='';
  const journal=()=>{try{const s=storage.getItem(SLOT);return s?JSON.parse(s):null;}catch(_){return {phase:'uncertain',unreadable:true};}};
  const pending=()=>journal()?.phase==='uncertain';
  const store=v=>storage.setItem(SLOT,JSON.stringify(v));
  async function identity(k){const a=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(k));return [...new Uint8Array(a)].map(x=>x.toString(16).padStart(2,'0')).join('');}
  function status(t){message=t;for(const e of document.querySelectorAll('[data-pilot-status]'))e.textContent=t;for(const b of document.querySelectorAll('[data-pilot-save]'))b.disabled=busy||pending();}
  function controls(){return `<p data-pilot-status role="status" aria-live="polite">${esc(message||(pending()?'Há uma gravação sem resposta confirmada. Consulte o recibo antes de editar novamente.':''))}</p>${pending()?'<button class="btn sec" type="button" data-pilot-reconcile>Conferir gravação pendente</button>':''}`;}
  async function response(body,k){const r=await fetch(endpoint(),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,k}),redirect:'error',credentials:'omit',cache:'no-store'});let j;try{j=await r.json();}catch(_){throw Error('Resposta não confirmada.');}if(!j||typeof j!=='object'||Array.isArray(j))throw Error('Resposta não confirmada.');return {r,j};}
  async function save(kind,data,version){
   if(!getData()?.pilot)return status('Atualize os dados antes de editar.');
   if(busy||pending())return status('Confira a gravação pendente antes de fazer outra alteração.');
   const k=key();if(!k)return;
   if(!navigator.locks?.request)return status('Este navegador não oferece a proteção de gravação. Use um navegador atualizado.');
   return navigator.locks.request('creator-pilot-write-v1',{ifAvailable:true},async lock=>{
    if(!lock||pending())return status('Outra gravação está em andamento. Confira o recibo.');
    busy=true;status('Salvando…');let record;
    try{
     const actor=await identity(k);if(key()!==k||!getData()?.pilot)throw Error('Acesso ou dados mudaram.');
     record={request_id:crypto.randomUUID(),actor,kind,phase:'uncertain',at:new Date().toISOString()};store(record);
     const {r,j}=await response({acao:'piloto_salvar',kind,expected_version:version,request_id:record.request_id,data},k);
     if((r.status===401||r.status===403)||j.erro){store({...record,phase:'rejected'});status(j.erro||'Acesso de operação recusado.');return;}
     if(!r.ok||j.ok!==true||j.request_id!==record.request_id||!Number.isInteger(j.version))throw Error('Recibo incompleto.');
     store({...record,phase:'confirmed',receipt:j});editing=null;payEditing=null;status('Salvo no servidor. Atualizando a leitura…');await reload();status('Alteração salva e recibo confirmado.');
    }catch(_){status(record?'Resposta não confirmada. Não repita a operação; use Conferir gravação pendente.':'Não foi possível registrar a operação com segurança. Nada foi enviado.');}
    finally{busy=false;render();}
   });
  }
  async function reconcile(){
   const old=journal(),k=key();if(!old||old.phase!=='uncertain'||!k||busy)return;
   if(old.unreadable)return status('O registro local não pôde ser lido. Preserve-o e peça conciliação ao integrador.');
   if(await identity(k)!==old.actor)return status('A pendência pertence a outro acesso. Use a mesma chave da gravação original.');
   busy=true;status('Conferindo recibo…');
   try{const {r,j}=await response({acao:'piloto_operacao',request_id:old.request_id},k);
    if(r.ok&&j.state==='confirmed'&&j.receipt?.request_id===old.request_id){store({...old,phase:'confirmed',receipt:j.receipt});editing=null;await reload();status('Gravação confirmada no servidor.');}
    else status('Ainda sem recibo confirmado. A gravação continua bloqueada para evitar repetição.');
   }catch(_){status('Não foi possível conferir. A operação permanece pendente.');}finally{busy=false;render();}
  }
  function wire(){for(const b of document.querySelectorAll('[data-pilot-reconcile]'))b.onclick=reconcile;for(const b of document.querySelectorAll('[data-pilot-refresh]'))b.onclick=()=>reload();}
  function renderPartners(payload){
   const host=q('#area-partners');if(!host)return;const brand=getMarca(),programs=payload.programs.filter(p=>brand==='todas'||p.marca===brand),candidates=payload.candidates.filter(p=>brand==='todas'||p.marca===brand);
   const e=editing?payload.candidates.find(c=>c.id===editing):null,chosen=e?.marca||(brand==='aristo'?'aristo':'fish'),deadline=root.CreatorsMeta.paymentDeadline(getPeriod().fim.slice(0,7));
   const vivos=(payload.links||[]).filter(l=>l.state!=='revogado'),porCand=new Map(vivos.map(l=>[l.candidate_id,l]));
   const pedidos=new Map((payload.partner_orders||[]).map(o=>[o.ref,o]));
   const pagamentos=new Map((payload.pagamentos||[]).map(x=>[x.candidate_id,x])),pagavel=payload.commission_payable===true;
   const nomePorRef=new Map((payload.links||[]).map(l=>[l.ref,l.candidate_name])),fech=(payload.fechamento||[]).filter(f=>brand==='todas'||f.marca===brand);
   const dataBR=d=>d?String(d).slice(0,10).split('-').reverse().join('/'):'—';
   const comissaoPeriodo=[...pedidos.values()].filter(o=>brand==='todas'||o.marca===brand);
   const totalComissao=comissaoPeriodo.every(o=>o.comissao!=null)?comissaoPeriodo.reduce((t,o)=>t+Number(o.comissao||0),0):null;
   const ativos=vivos.filter(l=>l.state==='ativo'&&(brand==='todas'||l.marca===brand)).length;
   const linkCell=c=>{
    const l=porCand.get(c.id),trav=busy||pending()?' disabled':'';
    if(!l)return c.state==='aprovado_piloto'
     ?`<button class="btn sec" data-link-new="${esc(c.id)}"${trav}>Gerar link</button>`
     :'<span class="mini">Só parceiro aprovado recebe link.</span>';
    const o=pedidos.get(l.ref),resumo=o&&o.pedidos?(pagavel?(o.comissao!=null?` · base ${money(o.base_elegivel)} · comissão <strong>${money(o.comissao)}</strong>`:` · comissão em apuração${o.pedidos_sem_base?` (${o.pedidos_sem_base} sem base)`:''}`):''):'';
    const extras=o?[o.pedidos_com_cupom?`${o.pedidos_com_cupom} também com cupom de influ (comissionam os dois)`:'',o.pedidos_link_inativo?`${o.pedidos_link_inativo} em dia de link pausado (não contam)`:''].filter(Boolean):[];
    const vendas=o&&o.pedidos?`<span class="mini">${o.pedidos} pedido${o.pedidos>1?'s':''} atribuído${o.pedidos>1?'s':''} no período${resumo}</span>${extras.map(t=>`<span class="mini cp-extra">${t}</span>`).join('')}`:`<span class="mini">Nenhum pedido atribuído ainda.</span>${extras.map(t=>`<span class="mini cp-extra">${t}</span>`).join('')}`;
    const endereco=l.state==='ativo'&&l.url
     ?`<input class="cp-link-url" readonly value="${esc(l.url)}" aria-label="Endereço do link de ${esc(c.name)}"><button class="btn sec" type="button" data-link-copy="${esc(l.ref)}">Copiar</button>`
     :'<span class="mini">Endereço aparece quando o link estiver ativo.</span>';
    const acao=l.state==='ativo'
     ?`<button class="btn sec" data-link-state="${esc(c.id)}:pausado"${trav}>Pausar</button> <button class="btn sec" data-link-state="${esc(c.id)}:revogado"${trav}>Revogar</button>`
     :`<button class="btn sec" data-link-state="${esc(c.id)}:ativo"${trav}>Ativar</button> <button class="btn sec" data-link-state="${esc(c.id)}:revogado"${trav}>Revogar</button>`;
    return `<code>${esc(l.ref)}</code> · ${linkStates[l.state]}${vendas}<div class="cp-link-row">${endereco}</div>${acao}`;
   };
   const PIX={cpf:'CPF',cnpj:'CNPJ',email:'E-mail',telefone:'Telefone',aleatoria:'Chave aleatória'};
   const pagCell=c=>{const x=pagamentos.get(c.id),trav=busy||pending()?' disabled':'';
    if(c.state!=='aprovado_piloto'&&!x)return '<span class="mini">Depois da aprovação.</span>';
    return x?`<span class="cp-pix-ok">Pix ${esc(PIX[x.pix_tipo]||x.pix_tipo)} · final ${esc(x.pix_final)}</span><span class="mini">${esc(x.titular)} · CPF ${esc(x.cpf_mascarado)}</span><button class="btn sec" data-pay-edit="${esc(c.id)}"${trav}>Trocar</button>`
     :`<span class="mini">Sem cadastro de pagamento.</span><button class="btn sec" data-pay-edit="${esc(c.id)}"${trav}>Cadastrar Pix</button>`;};
   const pe=payEditing?candidates.find(c=>c.id===payEditing):null,px=pe?pagamentos.get(pe.id):null;
   const payForm=pe?`<details class="cp-editor" open id="cp-pay"><summary>Pagamento de ${esc(pe.name)}</summary><form id="cp-pay-form" autocomplete="off"><div class="cp-form-grid">
    <label>Titular da conta<input name="titular" maxlength="120" minlength="3" required value="${esc(px?.titular)}"></label>
    <label>CPF do titular<input name="cpf" inputmode="numeric" maxlength="14" required placeholder="${px?'cadastrado · '+esc(px.cpf_mascarado)+' · digite de novo para trocar':'000.000.000-00'}"></label>
    <label>Tipo de chave Pix<select name="pix_tipo">${Object.entries(PIX).map(([k,v])=>`<option value="${k}" ${k===(px?.pix_tipo||'cpf')?'selected':''}>${v}</option>`).join('')}</select></label>
    <label>Chave Pix<input name="pix_chave" maxlength="77" required placeholder="${px?'final '+esc(px.pix_final)+' · digite de novo para trocar':''}"></label></div>
    <p class="mini">Os números são gravados completos no servidor e voltam para a tela só mascarados. O registro da operação guarda apenas um resumo criptográfico.</p>
    <button class="btn" type="submit" data-pilot-save ${busy||pending()?'disabled':''}>Salvar pagamento</button> <button class="btn sec" type="button" id="cp-pay-cancel">Fechar</button></form></details>`:'';
   const hojeBR=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date());
   const sit=f=>!f.base_fechada?`<span class="tag alerta">aguardando base${f.pedidos_sem_base?` · ${f.pedidos_sem_base} pedido(s)`:''}</span>`:!f.mes_encerrado?'<span class="tag nulo">mês em curso</span>'
    :String(f.prazo||'')>=hojeBR?`<span class="tag bom">a pagar até ${esc(dataBR(f.prazo))}</span>`:`<span class="tag nulo" title="O painel não registra o pagamento; confira no financeiro.">prazo era ${esc(dataBR(f.prazo))}</span>`;
   const fechamento=pagavel&&fech.length?`<h3>Fechamento mensal</h3><p class="mini">Competência = mês do pedido. Fecha quando o mês acaba e todos os pedidos têm base da Shopify; pagamento até o dia 5 do mês seguinte.</p>
    <div class="cp-table"><table><thead><tr><th>Competência</th><th>Parceiro</th><th>Pedidos</th><th>Base</th><th>Comissão</th><th>Situação</th></tr></thead><tbody>${fech.map(f=>`<tr><td>${esc(f.competencia.split('-').reverse().join('/'))}</td><td>${esc(nomePorRef.get(f.ref)||f.ref)}<span class="mini">${esc(f.ref)}${pagamentos.has((payload.links||[]).find(l=>l.ref===f.ref)?.candidate_id)?'':' · sem Pix cadastrado'}</span></td><td>${f.pedidos}</td><td>${money(f.base_elegivel)}</td><td>${f.comissao==null?'—':money(f.comissao)}</td><td>${sit(f)}</td></tr>`).join('')}</tbody></table></div>`:'';
   host.innerHTML=`<section class="painel"><div class="painel-cab"><div><h2>Parceiros do site</h2><p>Cadastros e regras do novo programa · piloto interno</p></div><button type="button" class="btn sec" data-pilot-refresh>Atualizar</button></div>
   <div class="cp-programs">${programs.map(p=>`<article data-brand="${p.marca}"><h3>${BRANDS[p.marca]}</h3><strong class="cp-rate">7%</strong><p>Produtos após descontos. Frete, cancelamentos e estornos ficam fora da base.</p><p>Pagamento até o dia <strong>${esc(p.payment_day||5)} do mês seguinte</strong>.</p><p class="mini">Link e cupom no mesmo pedido: ${p.link_cupom==='ambos'||!p.link_cupom?'comissionam os dois':'só '+esc(p.link_cupom)}. Link em ${esc(String(p.link_base||'').replace(/^https:\/\//,'').replace(/\/$/,''))}.</p><a href="${PAGES[p.marca]}" target="_blank" rel="noopener noreferrer">Abrir Seja um Influenciador ↗</a></article>`).join('')}</div>
   <details class="ressalvas"><summary>Como funciona o programa</summary><ul><li>Candidaturas chegam pelas páginas Seja um Influenciador e entram aqui à mão.</li><li>Parceiro aprovado recebe link de rastreio, que nasce pausado. Só conta pedido de dia com link ativo.</li><li>${pagavel?'Comissão de 7% sobre a base coletada da Shopify, fechada por mês e paga até o dia 5 do mês seguinte. O pagamento em si continua fora do painel.':'Link não gera saldo nem valor a pagar enquanto a comissão não for liberada.'}</li><li>Pedido com link e cupom de influ comissiona os dois; a tela mostra quando isso acontece.</li><li>Portal do parceiro vem depois.</li></ul></details>
   <div class="cp-metrics"><span><strong>${candidates.length}</strong> candidatos registrados aqui</span><span><strong>${candidates.filter(c=>c.state==='em_analise').length}</strong> em análise</span><span><strong>${candidates.filter(c=>c.state==='aprovado_piloto').length}</strong> aprovados no piloto</span><span><strong>${ativos}</strong> links ativos</span><span title="Pedidos pagos cuja sessão vencedora veio de um link de parceiro, pelas mesmas regras do painel: pago, não cancelado, líquido positivo, último clique em 30 dias."><strong>${(payload.partner_orders||[]).reduce((t,o)=>t+Number(o.pedidos||0),0)}</strong> pedidos atribuídos no período</span>${pagavel?`<span title="Soma das comissões do período. Só aparece número quando todos os pedidos têm base coletada da Shopify."><strong>${totalComissao==null?'Em apuração':money(totalComissao)}</strong> comissão no período</span>`:'<span><strong>Não liberado</strong> saldo para pagamento</span>'}</div>
   <p class="mini">Competência selecionada: ${esc(getPeriod().fim.slice(0,7))}. Prazo previsto: ${esc(deadline?.split('-').reverse().join('/')||'—')}. Comissões de cupom dos contratos atuais continuam na aba Creators.</p>${controls()}
   <details class="cp-editor" ${e?'open':''}><summary>${e?'Editar candidato':'Adicionar candidato ao piloto'}</summary><form id="cp-candidate-form"><div class="cp-form-grid">
    <label>Marca<select name="marca" ${e?'disabled':''}>${Object.entries(BRANDS).map(([id,n])=>`<option value="${id}" ${id===chosen?'selected':''}>${n}</option>`).join('')}</select></label>
    <label>Nome<input name="name" maxlength="120" minlength="2" required value="${esc(e?.name)}"></label>
    <label>Perfil principal<input name="handle" maxlength="120" placeholder="@perfil" value="${esc(e?.handle)}"></label>
    <label>Origem<select name="source"><option value="formulario_site" ${e?.source==='formulario_site'?'selected':''}>Formulário do site</option><option value="manual" ${e?.source==='manual'?'selected':''}>Cadastro manual</option></select></label>
    <label>Referência do formulário / tarefa<input name="source_reference" maxlength="100" value="${esc(e?.source_reference)}" placeholder="Identificador, se houver"></label>
    <label>Situação<select name="state">${Object.entries(states).map(([id,n])=>`<option value="${id}" ${id===(e?.state||'novo')?'selected':''}>${n}</option>`).join('')}</select></label>
    <label class="cp-wide">Observações<textarea name="note" maxlength="1000" placeholder="Critérios de seleção e próximos passos. CPF e Pix vão no cadastro de pagamento.">${esc(e?.note)}</textarea></label></div>
    <button class="btn" type="submit" data-pilot-save ${busy||pending()?'disabled':''}>Salvar candidato</button> <button class="btn sec" type="button" id="cp-candidate-cancel">Fechar edição</button></form></details>
   <div class="cp-table"><table><thead><tr><th>Candidato</th><th>Marca</th><th>Origem</th><th>Situação</th><th title="O link nasce pausado. Ativar publica o endereço rastreável; revogar encerra o link e preserva o código para os pedidos que já vieram por ele.">Link de parceiro</th><th title="Titular, CPF e chave Pix. A tela só mostra o final; o número completo não volta para o navegador.">Pagamento</th><th>Ação</th></tr></thead><tbody>${candidates.map(c=>`<tr><td><strong>${esc(c.name)}</strong><span class="mini">${esc(c.handle)}</span></td><td>${BRANDS[c.marca]}</td><td>${c.source==='manual'?'Manual':'Formulário do site'}<span class="mini">${esc(c.source_reference)}</span></td><td>${states[c.state]}</td><td>${linkCell(c)}</td><td>${pagCell(c)}</td><td><button class="btn sec" data-candidate-edit="${esc(c.id)}">Editar</button></td></tr>`).join('')||'<tr><td colspan="7">Nenhum candidato registrado neste piloto. A fila dos formulários existentes ainda não é sincronizada automaticamente.</td></tr>'}</tbody></table></div>${payForm}${fechamento}</section>`;
   const form=q('#cp-candidate-form');form.onsubmit=ev=>{ev.preventDefault();const read=n=>form.querySelector(`[name="${n}"]`).value;save('candidato',{id:e?.id||crypto.randomUUID(),marca:e?.marca||read('marca'),name:read('name').trim(),handle:read('handle').trim(),source:read('source'),source_reference:read('source_reference').trim(),state:read('state'),note:read('note').trim()},e?.version||0);};
   for(const b of host.querySelectorAll('[data-link-new]')){const c=candidates.find(x=>x.id===b.dataset.linkNew);b.onclick=()=>c&&save('link',{marca:c.marca,candidate_id:c.id,state:'pausado'},0);}
   for(const b of host.querySelectorAll('[data-link-state]')){const [id,estado]=b.dataset.linkState.split(':'),c=candidates.find(x=>x.id===id),l=porCand.get(id);
    b.onclick=()=>{if(!c||!l)return;if(estado==='revogado'&&!confirmRevoke(c.name))return;return save('link',{marca:c.marca,candidate_id:c.id,state:estado},l.version);};}
   for(const b of host.querySelectorAll('[data-link-copy]')){const campo=b.previousElementSibling;b.onclick=async()=>{try{await navigator.clipboard.writeText(campo.value);status('Endereço copiado.');}catch(_){campo.select();status('Selecionado: use Ctrl+C para copiar.');}};}
   for(const b of host.querySelectorAll('[data-pay-edit]'))b.onclick=()=>{payEditing=b.dataset.payEdit;render();q('#cp-pay-form [name=titular]')?.focus();};
   const pf=q('#cp-pay-form');if(pf&&pe){const read=n=>pf.querySelector(`[name="${n}"]`).value.trim();
    pf.onsubmit=ev=>{ev.preventDefault();const d={marca:pe.marca,candidate_id:pe.id,titular:read('titular'),cpf:read('cpf'),pix_tipo:read('pix_tipo'),pix_chave:read('pix_chave')};
     for(const n of ['cpf','pix_chave'])pf.querySelector(`[name="${n}"]`).value='';save('pagamento',d,px?.version||0);};
    q('#cp-pay-cancel').onclick=()=>{payEditing=null;render();};}
   q('#cp-candidate-cancel').onclick=()=>{editing=null;render();};for(const b of host.querySelectorAll('[data-candidate-edit]'))b.onclick=()=>{editing=b.dataset.candidateEdit;render();q('#cp-candidate-form [name=name]').focus();};
  }
  function renderAds(payload,data){
   const host=q('#area-meta-creators');if(!host)return;const brand=getMarca(),all=payload.ads.filter(a=>brand==='todas'||a.marca===brand),scope=payload.sources.filter(s=>brand==='todas'||s.marca===brand),M=root.CreatorsMeta;
   const rows=all.map(a=>({...a,parsed:M.parseAd(a)})).filter(a=>(category==='todos'||a.parsed.category===category)&&(!search||[a.ad_name,a.campaign_name,a.adset_name,a.ad_id,a.influ,a.parsed.label].join(' ').toLowerCase().includes(search.toLowerCase())));
   const max=Math.max(0,Math.ceil(rows.length/25)-1);page=Math.min(page,max);const visible=rows.slice(page*25,page*25+25),tot=M.summary(rows,scope,brand),groups=M.byCreator(all,data.influs,payload.coupon_by_creator,brand);
   host.innerHTML=`<section class="painel"><div class="painel-cab"><div><h2>Conteúdo em anúncios</h2><p>Resultado de mídia paga, separado das vendas por cupom</p></div><button type="button" class="btn sec" data-pilot-refresh>Atualizar leitura</button></div>
    <p class="nota">Meta · clique de 7 dias · data da conversão solicitada · compras no site. É crédito atribuído pela Meta, não receita adicional ou comissão de parceiro. Valores parciais somam apenas as parcelas reportadas; os dias sem métrica continuam desconhecidos. Os anúncios e orçamentos não são alterados por este painel.</p>
    <details class="cp-coverage" ${tot.complete?'':'open'}><summary>${tot.complete?'Período coberto nas contas mapeadas':'Cobertura parcial — confira as contas'} · ${scope.length} contas mapeadas</summary><ul>${scope.map(s=>`<li><strong>${esc(s.account_name)} · ${BRANDS[s.marca]}</strong>: ${s.covers_period?'período coberto':s.state==='error'?'consulta falhou':s.state==='partial'?'leitura parcial':'fora da janela coletada'} · ${esc(s.since||'—')} a ${esc(s.until||'—')} · última coleta: ${esc(s.last_success?new Date(s.last_success).toLocaleString('pt-BR'):'não confirmada')}${s.error?' · '+esc(s.error):''}</li>`).join('')}</ul><p class="mini">A cobertura se refere às contas mapeadas, não comprova inventário completo de todas as contas da empresa. Ausência de métrica aparece como indisponível. Atualizar leitura consulta a base já coletada.</p></details>
    <div class="cp-filters"><label>Buscar anúncio ou criador<input id="cp-ad-search" value="${esc(search)}" placeholder="Nome, código ou criador"></label><label>Categoria<select id="cp-ad-category">${['todos','UGC','IA','GR','não identificado'].map(c=>`<option value="${c}" ${c===category?'selected':''}>${c==='todos'?'Todas':c}</option>`).join('')}</select></label></div>
    <div class="cp-metrics"><span><strong>${rows.length}</strong> anúncios no recorte</span><span><strong>${money(tot.spend)}</strong> gasto observado</span><span><strong>${observed(tot.purchases,tot.reported_purchases,num)}</strong> compras reportadas Meta</span><span><strong>${observed(tot.purchase_value,tot.reported_purchase_value,money)}</strong> valor reportado Meta</span></div>${controls()}
    <div class="cp-table"><table><thead><tr><th>Anúncio / criador</th><th>Gasto</th><th>Compras Meta</th><th>Valor Meta</th><th>ROAS de mídia</th><th>Vínculo revisado</th></tr></thead><tbody>${visible.map(a=>{
     const people=(data.influs||[]).filter(c=>c.marca===a.marca),suggest=M.suggestion(a,people),hint=people.find(c=>c.influ===suggest),roas=a.purchase_value!=null&&Number(a.spend)>0?Number(a.purchase_value)/Number(a.spend):null;
     return `<tr><td class="cp-ad-name"><strong>${esc(a.ad_name)}</strong><span class="mini">${BRANDS[a.marca]} · ${esc(a.parsed.category)} · ${esc(a.ad_id)}</span><details><summary>Detalhes</summary><p>${esc(a.campaign_name)} / ${esc(a.adset_name)}</p><p>Origem do rótulo: ${esc(a.parsed.source)}. Rótulo extraído: ${esc(a.parsed.label||'não identificado')}. Nome preservado; vínculo exige revisão.</p></details></td><td>${money(a.spend)}</td><td>${observed(a.purchases,a.reported_purchases,num)}</td><td>${observed(a.purchase_value,a.reported_purchase_value,money)}</td><td>${roas==null?'—':num(roas)+'×'}</td><td><label class="sr-only" for="cp-map-${a.ad_id}">Criador do anúncio ${esc(a.ad_id)}</label><select id="cp-map-${a.ad_id}" data-map-account="${esc(a.account_id)}" data-map-ad="${esc(a.ad_id)}"><option value="">A vincular</option>${people.map(c=>`<option value="${esc(c.influ)}" ${a.influ===c.influ?'selected':''}>${esc(c.nome||c.influ)}</option>`).join('')}</select>${hint&&!a.influ?`<span class="mini">Nome compatível: ${esc(hint.nome)}. Confira antes de vincular.</span>`:''}<button class="btn sec" data-pilot-save data-map-save="${esc(a.account_id)}:${esc(a.ad_id)}" ${busy||pending()?'disabled':''}>Salvar vínculo</button></td></tr>`;
    }).join('')||'<tr><td colspan="6">Nenhum anúncio nesta leitura ou filtro. Confira período e cobertura; isso não prova ausência de vendas.</td></tr>'}</tbody></table></div>
    <div class="cp-pagination"><button class="btn sec" id="cp-ad-prev" ${page===0?'disabled':''}>Anterior</button><span>${page+1} de ${max+1}</span><button class="btn sec" id="cp-ad-next" ${page===max?'disabled':''}>Próxima</button></div>
    <h3>Comparar criadores com vínculo revisado</h3><p class="mini">Mesmo período, lentes diferentes. Receita de cupom vem do ledger de pedidos pagos; valor Meta vem dos anúncios vinculados. Não somar as colunas nem usar valor Meta para pagar os 7%.</p>
    <div class="cp-table"><table><thead><tr><th>Criador</th><th>Vendas por cupom</th><th>Gasto de mídia</th><th>Valor Meta</th><th>Anúncios</th></tr></thead><tbody>${groups.map(g=>`<tr><td>${esc(g.name)}<span class="mini">${BRANDS[g.marca]}</span></td><td>${money(g.coupon_revenue)}</td><td>${money(g.spend)}</td><td>${money(g.meta_value)}${g.partial?' <span class="mini">parcial</span>':''}</td><td>${g.ads}</td></tr>`).join('')||'<tr><td colspan="5">Revise um vínculo acima para começar a comparação. Nomes parecidos não são associados automaticamente.</td></tr>'}</tbody></table></div>
   </section>`;
   q('#cp-ad-search').onchange=e=>{search=e.target.value.trim();page=0;render();};q('#cp-ad-category').onchange=e=>{category=e.target.value;page=0;render();};q('#cp-ad-prev').onclick=()=>{page--;render();};q('#cp-ad-next').onclick=()=>{page++;render();};
   for(const b of host.querySelectorAll('[data-map-save]'))b.onclick=()=>{const [account,ad]=b.dataset.mapSave.split(':'),row=all.find(a=>a.account_id===account&&a.ad_id===ad),select=host.querySelector(`[data-map-account="${account}"][data-map-ad="${ad}"]`);if(row)save('vinculo',{marca:row.marca,account_id:account,ad_id:ad,influ:select.value},row.link_version);};
  }
  function render(){const data=getData(),p=data?.pilot;for(const id of ['#area-partners','#area-meta-creators'])if(q(id)&&(!p||p.schema!=='creator_pilot_v1'||p.erro)){q(id).innerHTML='<section class="painel"><h2>Piloto em preparação</h2><p>Dados do piloto ainda não disponíveis nesta consulta. Nenhum valor foi interpretado como zero.</p></section>';}
   if(!p||p.schema!=='creator_pilot_v1'||p.erro)return;
   if(!getSection()||getSection()==='partners')renderPartners(p);if(!getSection()||getSection()==='meta')renderAds(p,data);wire();
  }
  return {render,save,reconcile};
 }
 root.CreatorsPilotUI={bind};
})(typeof window!=='undefined'?window:globalThis);
