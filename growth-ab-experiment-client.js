/* A/B v2 uses the same receipt-only recovery pattern as campaigns and journeys.
 * No POST replay, no key in durable storage, one pending operation across brands.
 */
(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('./growth-ab-experiment-contract.js'):root.GABExperiment);if(typeof module==='object'&&module.exports)module.exports=api;else root.GABExperimentClient=api;})(typeof globalThis!=='undefined'?globalThis:this,function(C){
 'use strict';
 const SLOT='shrigma_ab_experiment_v2:grupo-shrigma',LEGACY_SLOT='shrigma_ab_registry_v1:grupo-shrigma';
 const clone=x=>JSON.parse(JSON.stringify(x)),same=(a,b)=>C.canonical(a)===C.canonical(b);
 const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
 const fail=(code,message)=>Object.assign(Error(message),{code});
 const UNKNOWN='Resultado não confirmado. Consulte a mesma tentativa; não repita com outra configuração ou acesso.';
 function snapshot(e,p,protocol,action){
  if(!e||e.test_id!==p.test_id||e.brand!==p.brand||!same(C.protocol(e.protocol),protocol)||!Number.isSafeInteger(e.version)||e.version<1||!['prepared','scheduled','cancelled','closed'].includes(e.state)||!Array.isArray(e.arms)||e.arms.length!==2)throw fail('AB_V2_RECEIPT',UNKNOWN);
  for(let i=0;i<2;i++){const a=e.arms[i];if(a.arm!==['a','b'][i]||a.campaign_id!==protocol.arms[i].campaign_id||!Number.isInteger(a.allocated)||a.allocated<1||a.allocated>100000||!Number.isInteger(a.revoked)||a.revoked<0||a.revoked>a.allocated)throw fail('AB_V2_RECEIPT',UNKNOWN);}
  if(e.arms.reduce((sum,a)=>sum+a.allocated,0)>100000||Math.abs(e.arms[0].allocated-e.arms[1].allocated)>1)throw fail('AB_V2_RECEIPT',UNKNOWN);
  if(['scheduled','closed'].includes(e.state)&&(e.transport_bound!==true||!Number.isFinite(Date.parse(e.window_start))||Date.parse(e.window_end)-Date.parse(e.window_start)!==protocol.rule.window_hours*3600000))throw fail('AB_V2_RECEIPT',UNKNOWN);
  if(action){const version=action==='prepare'?1:p.expected_version+(action==='review'?0:1),state={prepare:'prepared',review:'prepared',schedule:'scheduled',cancel:'cancelled',close:'closed'}[action];if(e.version!==version||e.state!==state)throw fail('AB_V2_RECEIPT',UNKNOWN);}
  return e;
 }
 function create({endpoint,brand,getKey,fetch:fetcher=globalThis.fetch,storage=globalThis.localStorage,locks=globalThis.navigator?.locks,uuid:makeId=()=>crypto.randomUUID(),now=()=>Date.now()}={}){
  let url;try{url=new URL(endpoint);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw Error();}catch{throw fail('AB_V2_ENDPOINT','Endereço do experimento indisponível.');}
  if(!['fish','aristo'].includes(brand)||typeof getKey!=='function'||typeof fetcher!=='function')throw fail('AB_V2_CONTEXT','Marca ou acesso indisponível.');
  let memory=null;
  const available=()=>!!(storage?.getItem&&storage?.setItem&&locks?.request);
  const access=()=>{const k=getKey();if(typeof k!=='string'||!k)throw fail('AB_V2_ACCESS','Entre no CRM para continuar.');return k;};
  function readJournal(){
   let raw;try{raw=storage.getItem(SLOT);}catch{throw fail('AB_V2_STORAGE','Não foi possível ler a tentativa preservada.');}
   if(raw===null){if(memory?.operations.length)throw fail('AB_V2_STORAGE','O registro local desapareceu. Não repita a operação.');return {version:1,revision:0,operations:[]};}
   try{const j=JSON.parse(raw);if(j.version!==1||!Number.isSafeInteger(j.revision)||j.revision<0||!Array.isArray(j.operations)||j.operations.length>1000)throw Error();const ids=new Set();
    for(const op of j.operations){if(!uuid(op.id)||ids.has(op.id)||!/^panel:[a-f0-9]{64}$/.test(op.actor)||typeof op.endpoint!=='string'||!['pending','unknown','confirmed','rejected'].includes(op.phase)||typeof op.applied!=='boolean'||!Number.isFinite(op.started_at)||!same(C.request(op.request_payload),op.request_payload)||!same(C.protocol(op.protocol),op.protocol)||op.protocol.test_id!==op.request_payload.test_id||op.protocol.brand!==op.request_payload.brand||C.action(op.request_payload)==='prepare'&&!same(op.protocol,op.request_payload)||['confirmed','rejected'].includes(op.phase)&&!op.receipt)throw Error();if(op.applied&&!['confirmed','rejected'].includes(op.phase)||op.receipt&&((op.receipt.status===200)!==(op.phase==='confirmed')||!['confirmed','rejected'].includes(op.phase)))throw Error();if(op.receipt)validateResult(op,op.receipt);ids.add(op.id);}
    memory=clone(j);return j;
   }catch{throw fail('AB_V2_STORAGE','O registro local precisa de conciliação. Nenhuma nova tentativa será enviada.');}
  }
  function legacyPending(){let raw;try{raw=storage.getItem(LEGACY_SLOT);if(raw===null)return false;const j=JSON.parse(raw);if(j.version!==1||!Array.isArray(j.operations)||j.operations.some(op=>!['pending','uncertain','accepted','confirmed','rejected'].includes(op.phase)))throw Error();return j.operations.some(op=>['pending','uncertain','accepted'].includes(op.phase));}catch{throw fail('AB_V2_LEGACY','Confira a tentativa anterior do cadastro A/B antes de iniciar o experimento.');}}
  function persist(j){const next={...j,revision:j.revision+1},raw=JSON.stringify(next);try{storage.setItem(SLOT,raw);if(storage.getItem(SLOT)!==raw)throw Error();memory=clone(next);j.revision=next.revision;}catch{throw fail('AB_V2_STORAGE','Não foi possível preservar a tentativa. Nenhuma nova operação será enviada.');}}
  function inspect(){try{const j=readJournal(),pending=j.operations.find(o=>o.applied!==true),legacy=legacyPending();return {...clone(j),pending:pending?clone(pending):null,available:available(),blocked:!available()||!!pending||legacy,legacy,message:pending?UNKNOWN:legacy?'Concilie a tentativa anterior no cadastro A/B.':!available()?'Armazenamento local e proteção entre abas são necessários.':''};}catch(e){return {operations:[],pending:null,available:false,blocked:true,message:e.message};}}
  async function exclusive(fn){if(!available())throw fail('AB_V2_STORAGE','Armazenamento local e proteção entre abas são necessários.');return locks.request(SLOT,{mode:'exclusive',ifAvailable:true},lock=>{if(!lock)throw fail('AB_V2_BUSY','Outra aba está conferindo o experimento.');return fn();});}
  async function call(method,data,key=access()){
   const target=new URL(url.href),write=method==='mutate';let init={method:write?'POST':'GET',credentials:'omit',redirect:'error',cache:'no-store',headers:write?{'Content-Type':'application/json'}:{'X-AB-Write-Key':key},signal:typeof AbortSignal!=='undefined'&&AbortSignal.timeout?AbortSignal.timeout(write?90000:20000):undefined};
   if(write)init.body=JSON.stringify({method,k:key,...data});else for(const [name,value]of Object.entries({method,...data}))target.searchParams.set(name,value);
   try{const response=await fetcher(target.href,init);return {status:response.status,body:await response.json()};}catch{throw fail('AB_V2_NETWORK',UNKNOWN);}
  }
  const lookup=(op,key)=>call('operation',{brand:op.request_payload.brand,operation_id:op.id,action:C.action(op.request_payload)},key);
  function validateResult(op,result){
   const p=op.request_payload,action=C.action(p);if(!result||!Number.isInteger(result.status)||!result.body||typeof result.body!=='object'||Array.isArray(result.body))throw fail('AB_V2_UNKNOWN',UNKNOWN);
   if(result.status===200){snapshot(result.body.experiment,p,op.protocol,action);
    if(['review','schedule'].includes(action)){const r=result.body.review;if(!uuid(r?.review_id)||r.version!==p.expected_version||!Array.isArray(r.arms)||r.arms.length!==2||!Number.isFinite(Date.parse(r.checked_at))||Date.parse(r.expires_at)-Date.parse(r.checked_at)!==300000||!Number.isFinite(Date.parse(r.send_at)))throw fail('AB_V2_UNKNOWN',UNKNOWN);
     for(let i=0;i<2;i++){const a=r.arms[i],count=a?.counts,allocated=result.body.experiment.arms[i].allocated;if(a?.arm!==['a','b'][i]||a.campaign_id!==op.protocol.arms[i].campaign_id||!uuid(a.source_review_id)||count?.allocated!==allocated||!Number.isInteger(count.eligible)||count.eligible<0||count.eligible>allocated||count.excluded!==allocated-count.eligible||action==='review'&&a.source_review_id!==p.source_reviews[a.arm])throw fail('AB_V2_UNKNOWN',UNKNOWN);}
     if(action==='schedule'&&(r.review_id!==p.review_id||Date.parse(result.body.experiment.window_start)!==Date.parse(r.send_at)))throw fail('AB_V2_UNKNOWN',UNKNOWN);
    }
   }
   else if(![403,409,422].includes(result.status)||typeof result.body.error!=='string'||!/^AB_V2_[A-Z_]+$/.test(result.body.error))throw fail('AB_V2_UNKNOWN',UNKNOWN);
   return clone(result);
  }
  function receipt(op,r){
   const o=r?.body?.operation,p=op.request_payload,action=C.action(p);
   if(r?.status!==200||r.body.contract!=='crm-ab-email-operation-v2'||o?.operation_id!==op.id||o.actor!==op.actor||o.brand!==p.brand||o.action!==action||o.state!=='completed'||!same(o.request_payload,p))throw fail('AB_V2_UNKNOWN',UNKNOWN);
   return validateResult(op,o.response);
  }
  async function settle(j,op,key){
   let r;try{r=receipt(op,await lookup(op,key));}catch{op.phase='unknown';try{persist(j);}catch{}throw fail('AB_V2_UNKNOWN',UNKNOWN);}
   const next={...op,receipt:r,phase:r.status===200?'confirmed':'rejected',completed_at:now()},updated={...j,operations:j.operations.map(x=>x.id===op.id?next:x)};
   persist(updated);return {operation_id:op.id,...clone(r)};
  }
  async function mutate(input,protocol,{guard=()=>true}={}){
   const p=C.request(input),cfg=C.protocol(protocol),action=C.action(p),key=access();
   if(p.brand!==brand||cfg.test_id!==p.test_id||cfg.brand!==brand||action==='prepare'&&!same(cfg,p))throw fail('AB_V2_CONTEXT','A configuração ou a marca mudou.');
   return exclusive(async()=>{
    const j=readJournal();if(j.operations.length>=1000)throw fail('AB_V2_CAPACITY','O histórico local atingiu o limite. Preserve os registros e solicite conciliação antes de uma nova operação.');if(j.operations.some(o=>!o.applied)||legacyPending())throw fail('AB_V2_PENDING',UNKNOWN);
    const cap=await call('capabilities',{brand},key),required={prepare:'configure',review:'review',schedule:'schedule',cancel:'cancel',close:'close'}[action];
    if(cap.status!==200||cap.body.contract!==C.CONTRACT||cap.body.brand!==brand||cap.body.operation!==true||cap.body[required]!==true)throw fail('AB_V2_PREFLIGHT','Esta ação ainda não está disponível para o seu acesso. Nenhuma tentativa foi enviada.');
    const id=makeId();if(!uuid(id)||j.operations.some(o=>o.id===id))throw fail('AB_V2_IDENTITY','Não foi possível preparar uma identidade nova.');
    const op={id,endpoint:url.href,request_payload:p,protocol:cfg,phase:'pending',applied:false,started_at:now()};
    const preflight=await lookup(op,key),o=preflight?.body?.operation;
    if(preflight.status!==200||preflight.body.contract!=='crm-ab-email-operation-v2'||o?.state!=='missing'||o.operation_id!==id||o.action!==action||o.brand!==brand||!/^panel:[a-f0-9]{64}$/.test(o.actor)||o.request_payload!==null||o.response!==null)throw fail('AB_V2_PREFLIGHT','O acesso ou o recibo não foi confirmado. Nada foi enviado.');
    if(getKey()!==key||guard()!==true)throw fail('AB_V2_CHANGED','A confirmação ou o acesso mudou. Nada foi enviado.');
    op.actor=o.actor;j.operations.push(op);persist(j); // Only durable state precedes the single POST.
    try{await call('mutate',{brand,operation_id:id,request_payload:p},key);}catch{} // Timeout never proves failure.
    return settle(j,op,key);
   });
  }
  async function reconcile(){return exclusive(async()=>{const j=readJournal(),op=j.operations.find(o=>!o.applied);if(!op)return null;if(op.endpoint!==url.href)throw fail('AB_V2_ENDPOINT','A origem da tentativa mudou. Preserve o registro.');return op.receipt?{operation_id:op.id,...clone(op.receipt)}:settle(j,op,access());});}
  async function apply(id,restore){return exclusive(async()=>{const j=readJournal(),op=j.operations.find(o=>o.id===id);if(!op?.receipt||await restore(clone(op))!==true)throw fail('AB_V2_RESTORE','O recibo está confirmado, mas o rascunho ainda precisa ser recuperado.');const next={...j,operations:j.operations.map(o=>o.id===id?{...o,applied:true,applied_at:now()}:o)};persist(next);return true;});}
  async function read(method,data={}){if(!['capabilities','list','get','campaigns'].includes(method))throw fail('AB_V2_REQUEST','Consulta indisponível.');const r=await call(method,{...data,brand});if(r.status!==200||r.body?.contract!==C.CONTRACT)throw fail('AB_V2_READ','Consulta não confirmada. Tente novamente; seus dados foram preservados.');if(method==='get'){snapshot(r.body.experiment,{test_id:data.test_id,brand},C.protocol(r.body.experiment.protocol));r.body.result=C.result(r.body.experiment.protocol,r.body.measurement);}return r.body;}
  return Object.freeze({inspect,mutate,reconcile,apply,read});
 }
 return Object.freeze({SLOT,LEGACY_SLOT,create});
});
