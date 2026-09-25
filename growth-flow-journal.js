/* Durable journey attempts. A read-only receipt, never a POST replay, resolves them.
 * One origin-wide fence survives actor, brand, journey, endpoint and tab changes.
 */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.GFJ=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const SLOT='shrigma_flow_operations_v1:grupo-shrigma',UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
 const UNKNOWN='Esta jornada tem uma tentativa sem confirmação. Consulte a mesma tentativa antes de editar ou repetir.';
 const UNAVAILABLE='Para alterar jornadas, permita o armazenamento local e use um navegador com proteção entre abas. A leitura continua disponível.';
 const fail=(code,message)=>Object.assign(new Error(message),{code}),clone=v=>JSON.parse(JSON.stringify(v));
 const canonical=v=>JSON.stringify(stable(v));
 function stable(v){if(Array.isArray(v))return v.map(stable);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])]));return v;}
 function request(p){
  if(!p||!['fluxo_salvar','fluxo_publicar','fluxo_estado'].includes(p.acao)||typeof p.key!=='string'||!/^(fish|aristo):[\w:-]+$/.test(p.key)||!Number.isSafeInteger(p.expected_version)||p.expected_version<1)throw fail('FLOW_INPUT','Confira a jornada e a versão antes de alterar.');
  const fields=['acao','key','expected_version','idempotency_key',...(p.acao==='fluxo_salvar'?['definition']:p.acao==='fluxo_publicar'?['confirm']:['confirm','enabled'])];
  if(Object.keys(p).some(k=>!fields.includes(k))||p.idempotency_key!==undefined&&!UUID.test(p.idempotency_key))throw fail('FLOW_INPUT','Campos da tentativa inválidos.');
  if(p.acao==='fluxo_salvar'&&(!p.definition||typeof p.definition.name!=='string'||!Array.isArray(p.definition.steps)||Object.keys(p.definition).some(k=>!['name','steps','layout'].includes(k))))throw fail('FLOW_INPUT','Rascunho inválido.');
  if(p.acao==='fluxo_publicar'&&p.confirm!=='publicar'||p.acao==='fluxo_estado'&&(typeof p.enabled!=='boolean'||p.confirm!==(p.enabled?'retomar':'pausar')))throw fail('FLOW_CONFIRM','Confirme a mudança de estado da jornada.');
  if(canonical(p).length>300000)throw fail('FLOW_INPUT','O rascunho excede o limite local.');return clone(p);
 }
 const unresolved=op=>op.applied!==true;
 function create({storage,locks,endpoint,uuid=()=>crypto.randomUUID(),now=()=>Date.now()}={}){
  let origin=null,memory=null;try{const u=new URL(endpoint);if(u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash)origin=u.href;}catch(_){}
  const available=()=>!!(origin&&storage?.getItem&&storage?.setItem&&locks?.request&&typeof uuid==='function');
  function read(){
   let raw;try{raw=storage.getItem(SLOT);}catch(_){throw fail('FLOW_STORAGE',UNAVAILABLE);}
   if(raw===null){if(memory?.operations.length)throw fail('FLOW_REMOVED','O registro da tentativa desapareceu. Preserve este navegador e consulte o integrador.');return {version:1,revision:0,operations:[]};}
   try{
    const j=JSON.parse(raw);if(j.version!==1||!Number.isSafeInteger(j.revision)||j.revision<0||!Array.isArray(j.operations))throw Error();const ids=new Set();
    for(const op of j.operations){
     if(!UUID.test(op.id)||ids.has(op.id)||!['pending','unknown','confirmed','rejected'].includes(op.phase)||typeof op.actor!=='string'||!op.actor||typeof op.endpoint!=='string'||!Number.isFinite(op.started_at)||typeof op.applied!=='boolean'||!op.context||op.context.baseVersion!==op.request_payload.expected_version||op.context.brand!==op.request_payload.key.split(':')[0]||typeof op.context.dirty!=='boolean')throw Error();
     if(canonical(request(op.request_payload))!==canonical(op.request_payload)||op.request_payload.idempotency_key!==op.id||['confirmed','rejected'].includes(op.phase)&&!op.receipt)throw Error();ids.add(op.id);
    }memory=clone(j);return j;
   }catch(_){throw fail('FLOW_INVALID','O registro local das jornadas precisa ser conciliado. Nenhuma nova tentativa será enviada.');}
  }
  function persist(j){const next={...j,revision:j.revision+1},raw=JSON.stringify(next);try{storage.setItem(SLOT,raw);if(storage.getItem(SLOT)!==raw)throw Error();memory=clone(next);j.revision=next.revision;}catch(_){throw fail('FLOW_STORAGE',UNAVAILABLE);}}
  function inspect(){try{const j=read(),pending=j.operations.find(unresolved);return {...clone(j),pending:pending?clone(pending):null,available:available(),blocked:!!pending||!available(),message:pending?UNKNOWN:!available()?UNAVAILABLE:''};}catch(e){return {operations:[],pending:null,available:false,blocked:true,uncertain:true,message:e.message};}}
  async function exclusive(work){if(!available())throw fail('FLOW_UNAVAILABLE',UNAVAILABLE);return locks.request(SLOT,{mode:'exclusive',ifAvailable:true},lock=>{if(!lock)throw fail('FLOW_BUSY','Outra aba está conferindo a jornada. Aguarde; nenhuma nova tentativa foi enviada.');return work();});}
  function receipt(op,r){
   const remote=r?.body?.operation;
   if(r?.status!==200||r.body.contract!=='flow_operation_v1'||remote?.state!=='completed'||remote.actor!==op.actor||remote.idempotency_key!==op.id||remote.acao!==op.request_payload.acao||canonical(remote.request_payload)!==canonical(op.request_payload))throw fail('FLOW_UNKNOWN',UNKNOWN);
   const response=remote.response,status=response?._http,body=response?._body;
   if(!Number.isInteger(status)||status<200||status>499||!body||typeof body!=='object'||Array.isArray(body))throw fail('FLOW_UNKNOWN',UNKNOWN);
   if(status<300){
    const f=body.flow,p=op.request_payload,version=p.expected_version+(p.acao==='fluxo_publicar'?0:1);
    if(body.valid!==true||f?.key!==p.key||f.brand!==op.context.brand||f.version!==version||!f.draft||!Array.isArray(f.draft.steps)||!Array.isArray(f.available_steps))throw fail('FLOW_UNKNOWN',UNKNOWN);
    if(p.acao==='fluxo_salvar'&&canonical(f.draft)!==canonical(p.definition)||p.acao==='fluxo_publicar'&&f.published_version!==version||p.acao==='fluxo_estado'&&f.enabled!==p.enabled)throw fail('FLOW_UNKNOWN',UNKNOWN);
   }else if(typeof body.erro!=='string')throw fail('FLOW_UNKNOWN',UNKNOWN);
   return {ok:status<300,status,body:clone(body),operation_id:op.id};
  }
  async function reconcileInside(j,op,lookup){
   let r;try{r=receipt(op,await lookup(op.id,op.request_payload.acao));}catch(_){op.phase='unknown';try{persist(j);}catch(_){}throw fail('FLOW_UNKNOWN',UNKNOWN);}
   op.receipt=r;op.phase=r.ok?'confirmed':'rejected';op.completed_at=now();persist(j);return clone(r);
  }
  async function run({request_payload,context},{transport,lookup}={}){
   const p=request(request_payload);
   if(p.idempotency_key!==undefined||typeof transport!=='function'||typeof lookup!=='function'||!context||context.baseVersion!==p.expected_version||context.brand!==p.key.split(':')[0]||typeof context.dirty!=='boolean'||typeof context.name!=='string'||!context.draft||Object.keys(context).some(k=>!['brand','name','baseVersion','draft','dirty'].includes(k))||canonical(context).length>300000)throw fail('FLOW_INPUT','A tentativa precisa preservar o rascunho e sua versão.');
   return exclusive(async()=>{
    const j=read();if(j.operations.some(unresolved))throw fail('FLOW_PENDING',UNKNOWN);
    const newest=[...j.operations].reverse().find(op=>op.phase==='confirmed'&&op.request_payload.key===p.key);
    if(newest&&p.expected_version<newest.receipt.body.flow.version)throw fail('FLOW_STALE','Outra aba já atualizou esta jornada. Atualize a leitura antes de escrever; seu rascunho foi preservado.');
    const id=uuid();if(!UUID.test(id)||j.operations.some(op=>op.id===id))throw fail('FLOW_INPUT','Não foi possível criar a identidade da tentativa.');
    let preflight;try{preflight=await lookup(id,p.acao);}catch(_){throw fail('FLOW_PREFLIGHT','Não foi possível conferir a consulta segura da tentativa. Nada foi enviado.');}
    const remote=preflight?.body?.operation;
    if(preflight?.status!==200||preflight.body.contract!=='flow_operation_v1'||remote?.state!=='missing'||remote.idempotency_key!==id||remote.acao!==p.acao||typeof remote.actor!=='string'||!remote.actor||remote.request_payload!==null||remote.response!==null)throw fail('FLOW_PREFLIGHT','O acesso ou a consulta segura da tentativa não foi confirmado. Nada foi enviado.');
    const op={id,actor:remote.actor,endpoint:origin,request_payload:{...p,idempotency_key:id},context:clone(context),phase:'pending',applied:false,started_at:now()};
    j.operations.push(op);persist(j); // Must survive reload before the only mutation.
    try{await transport(clone(op.request_payload));}catch(_){} // Never infer failure from timeout.
    return reconcileInside(j,op,lookup);
   });
  }
  async function reconcile(id,lookup){return exclusive(async()=>{const j=read(),op=j.operations.find(x=>x.id===id);if(!op||op.endpoint!==origin)throw fail('FLOW_UNKNOWN','A origem da tentativa mudou. Preserve o registro e consulte o integrador.');return op.receipt?clone(op.receipt):reconcileInside(j,op,lookup);});}
  async function apply(id,update){return exclusive(async()=>{const j=read(),op=j.operations.find(x=>x.id===id);if(!op?.receipt)throw fail('FLOW_UNKNOWN',UNKNOWN);if(await update(clone(op))!==true)throw fail('FLOW_STORAGE','O resultado foi confirmado, mas a recuperação local está pendente. Consulte a mesma tentativa.');op.applied=true;op.applied_at=now();persist(j);return true;});}
  return Object.freeze({inspect,run,reconcile,apply});
 }
 return Object.freeze({SLOT,canonical,request,create});
});
