/* Browser protection for template operations. The exact server receipt is the
 * only reconciliation authority. No POST replay, reservation removal or expiry.
 * Credentials are never stored. The preflight GET identifies the authenticated actor.
 */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.GTJ=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const SLOT='shrigma_template_operations_v1:grupo-shrigma'; // Independent of actor, endpoint, draft and action.
  const UNKNOWN='Operação sem confirmação. Consulte esta mesma tentativa; não repita nem crie outra para substituí-la.';
  const unavailable='A escrita de templates exige armazenamento local e proteção entre abas. A consulta e a edição local continuam disponíveis.';
  const fail=(code,message)=>Object.assign(new Error(message),{code});
  const clone=value=>JSON.parse(JSON.stringify(value));
  const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const HEX=/^[a-f0-9]{64}$/;
  const unresolved=operation=>['pending','unknown'].includes(operation.phase)||operation.applied!==true;
  function canonical(value){
    const stable=v=>{
      if(v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return v;
      if(Array.isArray(v))return v.map(stable);
      if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(key=>[key,stable(v[key])]));
      throw fail('TPL_INPUT','A operação contém um campo inválido.');
    };
    return JSON.stringify(stable(value));
  }
  async function sha256(value,cryptoProvider){
    if(!cryptoProvider?.subtle?.digest)throw fail('TPL_UNAVAILABLE',unavailable);
    const bytes=new TextEncoder().encode(typeof value==='string'?value:canonical(value));
    const hash=await cryptoProvider.subtle.digest('SHA-256',bytes);
    return Array.from(new Uint8Array(hash),n=>n.toString(16).padStart(2,'0')).join('');
  }
  function request(value){
    if(!value||!['rascunho','validar','submeter'].includes(value.acao))throw fail('TPL_INPUT','Ação de template inválida.');
    const allowed=value.acao==='rascunho'?['acao','rascunho','draft_id','expected_version','idempotency_key']:['acao','draft_id','expected_version','confirm','idempotency_key'];
    if(Object.keys(value).some(k=>!allowed.includes(k)))throw fail('TPL_INPUT','Campo não permitido na operação de template.');
    const out=clone(value);
    if(value.acao==='rascunho'){
      if(!value.rascunho||typeof value.rascunho!=='object'||Array.isArray(value.rascunho))throw fail('TPL_INPUT','Conteúdo de template ausente.');
      const fields=['canal','marca','idioma','categoria','nome','peca','cabecalho','corpo','rodape','assunto','exemplos','botoes'],emailFields=['from_email','reply_to','preheader'];
      if(Object.keys(value.rascunho).some(k=>!fields.includes(k)&&!(value.rascunho.canal==='email'&&emailFields.includes(k)))||emailFields.some(k=>Object.hasOwn(value.rascunho,k)&&typeof value.rascunho[k]!=='string'))throw fail('TPL_INPUT','Campo não permitido no conteúdo do template.');
      if(!['whatsapp','email'].includes(value.rascunho.canal)||!['fish','aristo','olivas'].includes(value.rascunho.marca))throw fail('TPL_INPUT','Marca ou canal inválido.');
      if(fields.filter(k=>!['exemplos','botoes'].includes(k)).some(k=>typeof value.rascunho[k]!=='string')||!value.rascunho.exemplos||Array.isArray(value.rascunho.exemplos)||Object.entries(value.rascunho.exemplos).some(([k,v])=>!/^\d+$/.test(k)||typeof v!=='string')||!Array.isArray(value.rascunho.botoes)||value.rascunho.botoes.some(b=>!b||typeof b!=='object'||Array.isArray(b)||Object.entries(b).some(([k,v])=>!['tipo','texto','valor','exemplo_url'].includes(k)||typeof v!=='string')))throw fail('TPL_INPUT','Conteúdo de template inválido para preservar a tentativa.');
    }
    if(value.acao!=='rascunho'||value.draft_id!==undefined){
      if(typeof value.draft_id!=='string'||!value.draft_id||value.draft_id.length>256||!Number.isSafeInteger(value.expected_version)||value.expected_version<1)throw fail('TPL_INPUT','A revisão do template precisa ser conferida antes de escrever.');
    }else if(value.expected_version!==undefined)throw fail('TPL_INPUT','Revisão sem identidade de rascunho.');
    if(value.acao==='submeter'&&value.confirm!=='submeter')throw fail('TPL_INPUT','A submissão exige confirmação explícita.');
    if(value.acao==='validar'&&value.confirm!==undefined)throw fail('TPL_INPUT','Confirmação inesperada.');
    if(value.idempotency_key!==undefined&&!UUID.test(value.idempotency_key))throw fail('TPL_INPUT','Identidade de operação inválida.');
    if(canonical(out).length>300000)throw fail('TPL_INPUT','O conteúdo excede o limite do registro local.');
    return out;
  }
  function payloadFor(value){
    const r=request(value);
    return {acao:r.acao,rascunho:r.rascunho??null,draft_id:r.draft_id??null,expected_version:r.expected_version??null,confirm:r.confirm??null};
  }
  function wireFor(payload){return request(Object.fromEntries(Object.entries(payload).filter(([,v])=>v!==null)));}
  function create({storage,locks,endpoint,crypto:cryptoProvider,now=()=>Date.now(),uuid=()=>cryptoProvider.randomUUID(),legacyPending=()=>false}={}){
    let origin=null,memory=null;
    try{const u=new URL(endpoint);if(u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash)origin=u.href;}catch(_){}
    const available=()=>!!(origin&&storage?.getItem&&storage?.setItem&&locks?.request&&cryptoProvider?.subtle?.digest&&typeof uuid==='function');
    function read(){
      let raw;try{raw=storage.getItem(SLOT);}catch(_){throw fail('TPL_STORAGE',unavailable);}
      if(raw===null){if(memory?.operations.length)throw fail('TPL_JOURNAL_REMOVED','O registro da tentativa desapareceu. Preserve este navegador e concilie com o integrador.');return {version:1,revision:0,operations:[]};}
      try{
        const j=JSON.parse(raw);
        if(j.version!==1||!Number.isSafeInteger(j.revision)||j.revision<0||!Array.isArray(j.operations))throw Error();
        const ids=new Set();
        for(const op of j.operations){
          if(!UUID.test(op.id)||ids.has(op.id)||!['pending','unknown','confirmed','rejected'].includes(op.phase)||typeof op.actor!=='string'||!op.actor.trim()||!HEX.test(op.request_sha256)||!Number.isFinite(op.started_at)||typeof op.endpoint!=='string'||typeof op.local_id!=='string'||!op.local_id)throw Error();
          if(canonical(payloadFor(wireFor(op.request_payload)))!==canonical(op.request_payload))throw Error();
          if(typeof op.applied!=='boolean'||['confirmed','rejected'].includes(op.phase)&&!op.receipt)throw Error();
          ids.add(op.id);
        }
        memory=clone(j);return j;
      }catch(_){throw fail('TPL_JOURNAL_INVALID','O registro local de templates precisa ser conciliado. Nenhuma nova operação será enviada.');}
    }
    function persist(j){
      const next={...j,revision:j.revision+1},raw=JSON.stringify(next);
      try{storage.setItem(SLOT,raw);if(storage.getItem(SLOT)!==raw)throw Error();memory=clone(next);j.revision=next.revision;}
      catch(_){throw fail('TPL_STORAGE',unavailable);}
    }
    function inspect(){
      try{const j=read(),legacy=legacyPending()===true;return {...clone(j),available:available(),blocked:legacy||!available()||j.operations.some(unresolved),legacy,message:legacy?'Existe uma tentativa antiga pendente. Preserve seu identificador e consulte o integrador.':!available()?unavailable:j.operations.some(x=>['pending','unknown'].includes(x.phase))?UNKNOWN:j.operations.some(unresolved)?'Um recibo confirmado aguarda atualização local. Abra o mesmo recibo para recuperar antes de outra operação.':''};}
      catch(e){return {operations:[],available:false,blocked:true,message:e.message};}
    }
    async function exclusive(work){
      if(!available())throw fail('TPL_UNAVAILABLE',unavailable);
      return locks.request(SLOT,{mode:'exclusive',ifAvailable:true},lock=>{if(!lock)throw fail('TPL_BUSY','Outra aba está conferindo uma operação de template. Aguarde; nenhuma repetição foi enviada.');return work();});
    }
    async function receiptFor(op,response){
      const body=response?.body,remote=body?.operation;
      if(response?.status!==200||body?.contract!=='template_operation_v1'||!remote||remote.state!=='completed'||remote.hash_schema!=='json-stable-sha256-v1'||remote.idempotency_key!==op.id||remote.acao!==op.request_payload.acao||remote.actor!==op.actor||remote.request_sha256!==op.request_sha256||canonical(remote.request_payload)!==canonical(op.request_payload))throw fail('TPL_UNKNOWN',UNKNOWN);
      if(await sha256(remote.request_payload,cryptoProvider)!==op.request_sha256)throw fail('TPL_UNKNOWN',UNKNOWN);
      const receipt=remote.response,status=receipt?.status,data=receipt?.body;
      if(!Number.isInteger(status)||status<200||status>599||!data||typeof data!=='object'||Array.isArray(data))throw fail('TPL_UNKNOWN',UNKNOWN);
      if(status<300){
        const p=op.request_payload;
        if(p.acao==='rascunho'){
          if(data.estado!=='rascunho'||typeof data.draft_id!=='string'||!data.draft_id||!Number.isSafeInteger(data.version)||!p.draft_id&&data.version!==1||p.draft_id&&(data.draft_id!==p.draft_id||data.version!==p.expected_version+1))throw fail('TPL_UNKNOWN',UNKNOWN);
        }else if(p.acao==='validar'){
          if(data.estado!=='validado'||data.draft_id!==p.draft_id||data.version!==p.expected_version||!Array.isArray(data.erros)||data.erros.length)throw fail('TPL_UNKNOWN',UNKNOWN);
        }else if(!(data.estado==='submetido'||data.estado==='publicado'&&data.provider_status==='APPROVED')||data.draft_id!==p.draft_id||data.version!==undefined&&data.version!==p.expected_version||!UUID.test(remote.claim_id)||data.operation_id!==remote.claim_id||data.submission_id!=='s_'+remote.claim_id.replace(/-/g,'')||!['meta','listmonk'].includes(data.provider))throw fail('TPL_UNKNOWN',UNKNOWN);
      }
      // The backend returns only the stored operation response, with its exact request identity.
      return {actor:remote.actor,status,body:clone(data)};
    }
    async function reconcileInside(j,op,lookup){
      let receipt;
      try{receipt=await receiptFor(op,await lookup(op.id,op.request_payload.acao));}
      catch(_){op.phase='unknown';try{persist(j);}catch(_){}throw fail('TPL_UNKNOWN',UNKNOWN);}
      op.receipt=receipt;op.phase=receipt.status<300?'confirmed':'rejected';op.completed_at=now();
      persist(j); // On failure the original durable pending/unknown remains a fence.
      return {ok:receipt.status>=200&&receipt.status<300,status:receipt.status,body:clone(receipt.body),operation_id:op.id};
    }
    async function run(input,{transport,lookup,persistLocal}={}){
      const raw=request(input?.request_payload),localId=input?.local_id;
      if(raw.idempotency_key!==undefined||typeof localId!=='string'||!localId||localId.length>256||typeof transport!=='function'||typeof lookup!=='function'||typeof persistLocal!=='function')throw fail('TPL_INPUT','A operação precisa de identidade e recibo verificáveis.');
      return exclusive(async()=>{
        const j=read();if(legacyPending()!==false)throw fail('TPL_LEGACY','Existe uma tentativa antiga pendente. Preserve seu identificador e consulte o integrador.');
        if(j.operations.some(unresolved))throw fail('TPL_PENDING',UNKNOWN);
        const previous=[...j.operations].reverse().find(op=>op.phase==='confirmed'&&(op.local_id===localId||raw.draft_id&&op.receipt.body.draft_id===raw.draft_id));
        if(previous){
          const draftId=previous.receipt.body.draft_id||previous.request_payload.draft_id,version=previous.receipt.body.version||previous.request_payload.expected_version;
          if(!raw.draft_id||raw.draft_id!==draftId||raw.expected_version<version)throw fail('TPL_LOCAL_STALE','Esta aba está com uma revisão anterior. Reabra o rascunho atualizado ou seu recibo antes de escrever. Nada foi enviado.');
        }
        const id=uuid();if(!UUID.test(id)||j.operations.some(op=>op.id===id))throw fail('TPL_INPUT','Não foi possível preparar uma identidade nova.');
        // Only a fresh UUID may use MISSING as preflight. It never clears a reservation.
        let preflight;try{preflight=await lookup(id,raw.acao);}catch(_){throw fail('TPL_PREFLIGHT','Não foi possível conferir o acesso e o recibo da operação. Nada foi enviado.');}
        if(preflight?.status===401&&preflight.body?.erro==='invalid_key')throw fail('TPL_AUTH','Chave de escrita inválida. Informe a chave de novo. Nada foi enviado.');
        const remote=preflight?.body?.operation;
        if(preflight?.status!==200||preflight.body.contract!=='template_operation_v1'||remote?.state!=='missing'||remote.hash_schema!=='json-stable-sha256-v1'||remote.idempotency_key!==id||remote.acao!==raw.acao||typeof remote.actor!=='string'||!remote.actor.trim()||remote.request_payload!==null||remote.request_sha256!==null||remote.response!==null)throw fail('TPL_PREFLIGHT','O acesso ou a consulta segura de operações não foi confirmado. Nada foi enviado.');
        if(await persistLocal()!==true)throw fail('TPL_STORAGE','O rascunho não pôde ser preservado neste navegador. Nada foi enviado.');
        const payload=payloadFor(raw);
        const op={id,local_id:localId,actor:remote.actor,request_payload:payload,request_sha256:await sha256(payload,cryptoProvider),endpoint:origin,phase:'pending',applied:false,started_at:now()};
        j.operations.push(op);persist(j); // Durable, verified reservation before the only POST.
        try{await transport({...clone(raw),idempotency_key:id});}catch(_){} // Timeout is reconciled only by the exact read-only lookup.
        return reconcileInside(j,op,lookup);
      });
    }
    async function reconcile(id,lookup){
      if(!UUID.test(id)||typeof lookup!=='function')throw fail('TPL_INPUT','Identidade de consulta inválida.');
      return exclusive(async()=>{
        const j=read(),op=j.operations.find(x=>x.id===id);
        if(!op||op.endpoint!==origin)throw fail('TPL_UNKNOWN','A origem desta tentativa mudou ou não foi encontrada. Preserve o registro e consulte o integrador.');
        if(['confirmed','rejected'].includes(op.phase))return {ok:op.receipt.status<300,status:op.receipt.status,body:clone(op.receipt.body),operation_id:op.id};
        return reconcileInside(j,op,lookup);
      });
    }
    async function markApplied(id,persistLocal){
      if(!UUID.test(id)||typeof persistLocal!=='function')throw fail('TPL_INPUT','Aplicação local inválida.');
      return exclusive(async()=>{
        const j=read(),op=j.operations.find(x=>x.id===id);
        if(!op||!['confirmed','rejected'].includes(op.phase)||!op.receipt)throw fail('TPL_UNKNOWN',UNKNOWN);
        if(await persistLocal(clone(op))!==true)throw fail('TPL_STORAGE','O recibo está confirmado, mas a atualização local não foi preservada. Abra o mesmo recibo para recuperar.');
        if(op.applied)return true;
        op.applied=true;op.applied_at=now();persist(j);return true;
      });
    }
    return Object.freeze({available,inspect,run,reconcile,markApplied});
  }
  return Object.freeze({SLOT,canonical,sha256,request,payloadFor,create});
});
