/* Templates ponta a ponta — camada de regras (Fase A, 11/09/2026).
   O que isto é: as regras para o painel falar com a API de templates proposta em BACKEND_REQUESTS.md (R5):
   ler capacidades, montar chamadas, traduzir erros e decidir que botão pode aparecer.
   O que isto NÃO é: a API. Nada aqui existe sem a API declarar `capabilities` no GET Growth.
   Sem `capabilities`, tudo é false e o painel continua com rascunho só neste dispositivo.
   Sem DOM: tudo aqui é testável em Node com um fetch falso. A tela fica em growth-drafts-ui.js. */
'use strict';
const GTA={
  CHAVE_ESCRITA:'shrigma_tpl_key',            // precedente: shrigma_ab_key (A/B). A chave de leitura Growth não escreve.
  CHAVE_LEITURA:'shrigma_k_growth',
  POLL_MS:60000,                                // R5.4: consultar a submissão a cada 60 s enquanto "submetido"
  ESTADOS:[['local','Local'],['rascunho','No servidor'],['validado','Validado'],['submetido','Submetido'],['publicado','Publicado']],
  ORDEM:{local:0,rascunho:1,validado:2,submetido:3,publicado:4,rejeitado:4},
  esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));},
  stamp(v){const t=Date.parse(v||'');return Number.isFinite(t)?new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(t)):'—';},

  /* ---------- capacidades (R5.1) ----------
     Ausente → tudo false. `pode.x` = capacidade true E endpoint conhecido; sem endpoint nenhum botão aparece,
     porque um botão que não sabe para onde chamar é um botão que não funciona. */
  caps(api,globais={}){
    const c=api&&typeof api==='object'&&api.capabilities&&typeof api.capabilities==='object'?api.capabilities:null;
    const t=c&&c.templates&&typeof c.templates==='object'?c.templates:{};
    const w=c&&c.workflows&&typeof c.workflows==='object'?c.workflows:{};
    const b=v=>v===true;
    const url=v=>typeof v==='string'&&/^https:\/\/\S+$/.test(v)?v:null;
    const endpoint=url(c?.endpoints?.templates)||url(globais.TEMPLATE_API_URL)||null;
    const caps={declaradas:!!c,endpoint,api_version:typeof c?.api_version==='string'?c.api_version:null,
      write_key_required:c?c.write_key_required!==false:true,
      read_content:b(t.read_content),draft:b(t.draft),validate:b(t.validate),submit:b(t.submit),list_history:b(t.list_history),
      set_mode:b(w.set_mode),activate:b(w.activate)};
    caps.pode={};['read_content','draft','validate','submit','list_history','set_mode','activate'].forEach(k=>{caps.pode[k]=caps[k]&&!!endpoint;});
    caps.semEndpoint=!!c&&!endpoint&&['read_content','draft','validate','submit','list_history'].some(k=>caps[k]);
    return caps;
  },

  /* ---------- idempotência e conteúdo ---------- */
  uuid(){
    if(typeof crypto!=='undefined'&&typeof crypto.randomUUID==='function')return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0;return (c==='x'?r:(r&3|8)).toString(16);});
  },
  // FNV-1a do conteúdo exportável: serve para saber se o rascunho mudou depois de ir ao servidor. Não é segurança.
  hash(obj){
    const s=JSON.stringify(obj);let h=0x811c9dc5;
    for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0;}
    return h.toString(16).padStart(8,'0');
  },

  /* ---------- cliente ----------
     Devolve sempre {ok,status,body,rede}. Nunca lança. Nunca loga chave. */
  cliente({endpoint,fetch:fetchFn,chaveLeitura,chaveEscrita}){
    const fx=fetchFn||(typeof fetch==='function'?fetch:null);
    const parse=async r=>{try{return await r.json();}catch(_){return null;}};
    const chama=async(url,init)=>{
      if(!endpoint||!fx)return {ok:false,status:0,body:null,rede:true};
      try{const r=await fx(url,init);return {ok:r.status>=200&&r.status<300,status:r.status,body:await parse(r),rede:false};}
      catch(_){return {ok:false,status:0,body:null,rede:true};}
    };
    const get=params=>{const q=new URLSearchParams({k:chaveLeitura||'',...params});return chama(`${endpoint}?${q}`,{signal:typeof AbortSignal!=='undefined'&&AbortSignal.timeout?AbortSignal.timeout(20000):undefined});};
    const post=corpo=>{const body={k:chaveEscrita||'',...corpo};return chama(endpoint,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':corpo.idempotency_key||''},body:JSON.stringify(body)});};
    return {
      listar:marca=>get({acao:'listar',...(marca&&marca!=='todas'?{marca}:{})}),
      historico:ref=>get({acao:'historico',...ref}),                                   // {key} ou {draft_id}
      submissao:submission_id=>get({acao:'submissao',submission_id}),
      rascunho:(rascunho,extra)=>post({acao:'rascunho',rascunho,...extra}),           // extra: idempotency_key, draft_id?, expected_version?
      validar:(draft_id,idempotency_key)=>post({acao:'validar',draft_id,idempotency_key}),
      submeter:(draft_id,expected_version,confirm,idempotency_key)=>post({acao:'submeter',draft_id,expected_version,confirm,idempotency_key}),
    };
  },

  /* ---------- erros (R5.3 / R5.7) ----------
     Uma frase, no vocabulário da pessoa. `chaveInvalida` avisa a tela para esquecer a chave guardada. */
  erro(res,acao=''){
    const b=res.body&&typeof res.body==='object'?res.body:{};
    const seg=b.retry_after?` Tente em ${b.retry_after} s.`:'';
    if(res.rede)return {texto:'Falha de rede: nada foi confirmado. Confira o histórico antes de repetir.',tipo:'incerto'};
    switch(res.status){
      case 401:return {texto:'Chave de escrita inválida. Informe a chave de novo.',tipo:'chave',chaveInvalida:true};
      case 403:return {texto:`Esta chave não tem a capacidade "${b.capability||acao||'?'}". Peça uma chave com essa capacidade.`,tipo:'chave'};
      case 409:
        if(b.erro==='idempotency_replay_mismatch')return {texto:'Esta tentativa repetiu uma chave de idempotência com conteúdo diferente. Gere uma nova tentativa.',tipo:'conflito'};
        return {texto:`Alterado por ${b.changed_by||'outra chave'} às ${GTA.stamp(b.changed_at)}${Number.isFinite(+b.current_version)?` (versão ${b.current_version})`:''}. Recarregue e refaça; nada foi sobrescrito.`,tipo:'conflito',conflito:{current_version:b.current_version,changed_by:b.changed_by||null,changed_at:b.changed_at||null}};
      case 422:{const erros=Array.isArray(b.erros)?b.erros:(b.erro?[{mensagem:b.erro}]:[]);return {texto:erros.length?erros.map(x=>x.mensagem||x.codigo||'erro').join(' · '):'A API recusou o conteúdo.',tipo:'validacao',erros};}
      case 429:return {texto:`Muitas tentativas.${seg||' Aguarde um instante.'}`,tipo:'limite'};
      case 502:return b.nothing_changed===true?{texto:`Meta/Listmonk indisponível; nada foi alterado.${seg}`,tipo:'indisponivel'}:{texto:'Meta/Listmonk indisponível e estado incerto. Consulte o histórico antes de repetir.',tipo:'incerto'};
      default:return {texto:`A API respondeu ${res.status||'sem status'}. Nada foi confirmado.`,tipo:'incerto'};
    }
  },

  /* ---------- estado do rascunho no servidor ----------
     `r.servidor` guarda o que a API confirmou: draft_id, version, estado, hash do conteúdo salvo, submissão e eventos.
     `sujo` = conteúdo local diferente do que foi salvo no servidor; bloqueia validar/submeter até salvar de novo. */
  situacao(r){
    const s=r&&r.servidor&&typeof r.servidor==='object'?r.servidor:null;
    if(!s||!s.draft_id)return {estado:'local',sujo:false,servidor:null};
    const sujo=typeof GR!=='undefined'&&s.hash?GTA.hash(GR.conteudo(r))!==s.hash:false;
    return {estado:['rascunho','validado','submetido','publicado','rejeitado'].includes(s.estado)?s.estado:'rascunho',sujo,servidor:s};
  },
  // R5.7: botões só das capacidades true; submeter exige validado quando a API valida, senão basta rascunho no servidor.
  acoes(caps,r){
    const {estado,sujo,servidor}=GTA.situacao(r);
    const noServidor=!!servidor&&!sujo;
    return {
      salvarServidor:caps.pode.draft,
      validar:caps.pode.validate&&noServidor&&['rascunho','validado','rejeitado'].includes(estado),
      submeter:caps.pode.submit&&noServidor&&(caps.validate?estado==='validado':['rascunho','validado','rejeitado'].includes(estado)),
      verificar:!!servidor?.submission_id&&estado==='submetido'&&!!caps.endpoint,
      historico:caps.pode.list_history&&!!servidor&&(!!servidor.template_key||!!servidor.draft_id),
    };
  },
  rotuloEstado(r,ctx={}){
    const {estado,sujo,servidor}=GTA.situacao(r);
    if(estado==='local')return {texto:'Rascunho local',tone:'neutral'};
    if(sujo)return {texto:`Alterado após salvar no servidor (v${servidor.version})`,tone:'warning'};
    if(estado==='rascunho')return {texto:`Rascunho no servidor · não submetido${servidor.erros?.length?' · com erros na validação':''}`,tone:'neutral'};
    if(estado==='validado')return {texto:'Validado · não submetido',tone:'info'};
    if(estado==='submetido')return {texto:`Submetido · aguardando ${servidor.provider==='listmonk'?'Listmonk':'Meta'} desde ${GTA.stamp(servidor.submitted_at)}`,tone:'info'};
    if(estado==='rejeitado')return {texto:`Rejeitado${servidor.rejected_reason?`: ${servidor.rejected_reason}`:''}`,tone:'warning'};
    // publicado ≠ ativo: só é "ativo" se um workflow do inventário usa este template em modo real.
    const at=GTA.publicadoAtivo({key:servidor.template_key,name:servidor.provider_name||r.nome,status:'APPROVED',mapped_in:Array.isArray(ctx.mapped_in)?ctx.mapped_in:[]},ctx.workflows||[]); // rascunho recém-publicado: nenhum workflow o usa até o manifesto dizer
    return {texto:at.rotulo,tone:at.tone};
  },
  /* Cruza template aprovado com o inventário: ativo = algum workflow mapeado com o modo em `real`. Sem mapped_in, não se sabe. */
  publicadoAtivo(row,workflows=[]){
    if(row.status!=='APPROVED')return {situacao:'nao_publicado',rotulo:'Não publicado',tone:'neutral'};
    const links=Array.isArray(row.mapped_in)?row.mapped_in.filter(l=>l&&typeof l==='object'&&typeof l.workflow_key==='string'):null; // F06: vínculo malformado não derruba
    if(links===null)return {situacao:'desconhecido',rotulo:'Publicado · ativação desconhecida (sem vínculo no manifesto)',tone:'neutral'};
    const wfDe=l=>workflows.find(w=>w&&w.key===l.workflow_key);
    // F03: só conta como ativo o workflow cuja consulta é atual (quando o inventário informa isso) e com campos válidos.
    const atual=wf=>!wf.collection||(wf.collection.current&&wf.fieldsValid!==false);
    const reais=links.filter(l=>{const wf=wfDe(l);const m=wf?(wf.modes||[]).find(x=>x&&x.key===l.mode_key):null;return wf&&atual(wf)&&wf.active===true&&m&&m.value==='real';});
    if(reais.length)return {situacao:'ativo',rotulo:`Publicado · ativo em modo real (${reais.map(l=>l.workflow_key).join(', ')})`,tone:'verified'};
    const antigos=links.filter(l=>{const wf=wfDe(l);const m=wf?(wf.modes||[]).find(x=>x&&x.key===l.mode_key):null;return wf&&!atual(wf)&&m&&m.value==='real';});
    if(antigos.length)return {situacao:'desconhecido',rotulo:`Publicado · ativação não confirmada (último modo observado real em ${antigos.map(l=>l.workflow_key).join(', ')}, consulta desatualizada)`,tone:'warning'};
    return {situacao:'nao_ativo',rotulo:links.length?'Publicado · não ativo (nenhum workflow em modo real)':'Publicado · não ativo (sem workflow mapeado)',tone:'warning'};
  },
  evento(servidor,ev){servidor.eventos=(Array.isArray(servidor.eventos)?servidor.eventos:[]).concat([ev]).slice(-30);},

  /* ---------- prévia fiel de components (R5.2) ----------
     Formato da Graph API da Meta. Só texto escapado: body_html de e-mail NUNCA é injetado — mostra altbody ou o HTML como texto. */
  previaComponents(components){
    const e=GTA.esc,fill=(t,ex)=>String(t||'').replace(/\{\{\s*(\d+)\s*\}\}/g,(_,n)=>ex&&ex[n-1]!==undefined?String(ex[n-1]):`{{${n}}}`);
    if(components&&typeof components==='object'&&!Array.isArray(components)){ // e-mail (Listmonk)
      const txt=components.altbody||String(components.body_html||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
      return `<div class="draft-mail"><div class="draft-mail-assunto">${e(components.subject||'(sem assunto)')}</div><div class="draft-mail-corpo">${e(txt)||'<span class="mini">Sem texto.</span>'}</div></div>`;
    }
    if(!Array.isArray(components))return '<span class="mini">Conteúdo não disponível.</span>';
    const c=t=>components.find(x=>x&&x.type===t)||null;
    const body=c('BODY'),ex=body?.example?.body_text?.[0],head=c('HEADER'),foot=c('FOOTER'),btns=c('BUTTONS')?.buttons||[];
    const headTxt=head?(head.format==='TEXT'||!head.format?fill(head.text,head.example?.header_text):`[${String(head.format).toLowerCase()}]`):'';
    return `<div class="draft-bubble">${headTxt?`<div class="draft-bubble-head">${e(headTxt)}</div>`:''}<div class="draft-bubble-body">${e(fill(body?.text,ex))||'<span class="mini">Sem corpo.</span>'}</div>${foot?`<div class="draft-bubble-foot">${e(foot.text)}</div>`:''}</div>
      ${btns.filter(b=>b&&b.text).map(b=>`<div class="draft-bubble-btn">${b.type==='URL'?'↗ ':b.type==='PHONE_NUMBER'?'☏ ':''}${e(b.text)}</div>`).join('')}`;
  },
};
if(typeof module!=='undefined'&&module.exports)module.exports=GTA;
