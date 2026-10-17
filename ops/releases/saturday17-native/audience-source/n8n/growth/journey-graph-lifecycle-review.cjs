/* Read-only shadow proposal. No query, mutation, transport, timer scheduler or remote default. */
'use strict';
const C=require('./journey-graph-lifecycle-contract.cjs');
const G=require('./journey-graph-contract.js'),R=require('./journey-graph-release.cjs');
const REASONS=C.freeze({
 trigger:'Esta preparação operacional atende somente carrinho abandonado.',
 message_count:'Esta preparação atende uma única mensagem de e-mail do carrinho. Revise fluxos sem mensagem ou com várias mensagens.',
 channel:'Esta preparação atende somente e-mail; WhatsApp ainda não está integrado a este percurso.',
 binding:'A mensagem escolhida precisa ser o primeiro e-mail de carrinho publicado para esta marca.',
 source_changed:'A mensagem ou o catálogo mudou desde o salvamento. Reabra as opções e salve uma nova revisão antes de conferir.',
 graph_invalid:'Há etapas, condições ou caminhos incompatíveis. Confira o desenho e as opções disponíveis para esta marca.',
 material:'Não foi possível comprovar todos os dados, links e configurações exigidos pela mensagem escolhida.',
 version_limit:'A jornada atingiu o limite de versões deste contrato. Nenhuma nova revisão pode ser proposta.',
 time_window:'A espera do fluxo ultrapassa a janela de uma hora deste carrinho. Esta preparação não amplia a validade do evento.'
});
const REMAINING=C.freeze([
 {code:'operational_revision',message:'A nova revisão operacional ainda precisa ser preparada e salva; o rascunho original foi preservado.'},
 {code:'native_cache',message:'A versão imutável da mensagem e o cache da instância de envio ainda precisam de confirmação própria.'},
 {code:'publication',message:'Publicar exige conferir e confirmar a revisão operacional exata. Nada foi publicado.'},
 {code:'activation',message:'Ativar exige conferir controles, entrada de eventos e período de responsabilidade do fluxo. Nada foi ativado.'},
 {code:'eligibility',message:'Compra observada, permissão de e-mail e bloqueios devem ser conferidos novamente antes de cada envio.'}
]);
function createLifecycleReviewer({provider,clock=Date.now,timeoutMs=10000}={}){
 if(!provider||['authenticate','readDraft','readCatalog','readSource'].some(k=>typeof provider[k]!=='function')||typeof clock!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>20000)throw C.fail('GRAPH_LIFECYCLE_ADAPTER');
 const now=()=>{const n=clock();if(!Number.isSafeInteger(n)||n<0)throw C.fail('GRAPH_LIFECYCLE_READ_UNCONFIRMED');return n;};
 function fresh(text){const t=Date.parse(text);if(typeof text!=='string'||!Number.isFinite(t)||new Date(t).toISOString()!==text||t>now()||now()-t>C.MAX_AGE_MS)throw C.fail('GRAPH_LIFECYCLE_READ_UNCONFIRMED');return t;}
 async function review(value,{authorization}={}){
  const p=C.validateRequest(value);if(p.action!=='review')throw C.fail('GRAPH_LIFECYCLE_INPUT');
  if(typeof authorization!=='string'||!/^Bearer [a-z0-9-]{8,128}$/.test(authorization))throw C.fail('GRAPH_LIFECYCLE_ACCESS');
  const controller=new AbortController(),signal=controller.signal,started=now();let timer;
  const read=async(name,args)=>{
   if(signal.aborted)throw C.fail('GRAPH_LIFECYCLE_TIMEOUT');
   try{const r=C.copy(await provider[name]({...args,signal}));if(signal.aborted)throw C.fail('GRAPH_LIFECYCLE_TIMEOUT');fresh(r?.checked_at);return r;}
   catch(e){if(signal.aborted)throw C.fail('GRAPH_LIFECYCLE_TIMEOUT');if(e?.code==='GRAPH_LIFECYCLE_READ_UNCONFIRMED')throw e;throw C.fail('GRAPH_LIFECYCLE_READ_UNCONFIRMED');}
  };
  async function auth(){
   const a=await read('authenticate',{authorization});
   if(!C.exact(a,['actor','caps','checked_at'])||typeof a.actor!=='string'||!/^panel:[A-Za-z0-9_.:-]{1,122}$/.test(a.actor)||!Array.isArray(a.caps)||a.caps.length>32||new Set(a.caps).size!==a.caps.length||a.caps.some(v=>typeof v!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(v))||!C.PERMISSIONS.review.every(cap=>a.caps.includes(cap)))throw C.fail('GRAPH_LIFECYCLE_ACCESS');
   return a;
  }
  function draft(d){
   const s=d?.server;
   if(!C.exact(d,['checked_at','server','definition','catalog','content_hash'])||!C.exact(s,['journey_id','brand','version','revision','published_revision','paused'])||s.journey_id!==p.journey_id||s.brand!==p.brand||d.definition?.brand!==p.brand||d.catalog?.brand!==p.brand||!C.version(s.version)||!C.version(s.revision)||s.revision>s.version||typeof s.paused!=='boolean'||s.published_revision!==null&&(!C.version(s.published_revision)||s.published_revision>s.revision)||!s.paused&&s.published_revision===null||!C.HASH.test(d.content_hash)||C.digest({definition:d.definition,catalog:d.catalog})!==d.content_hash)throw C.fail('GRAPH_LIFECYCLE_CORRUPT');
   if(s.version!==p.expected_version)throw C.fail('GRAPH_LIFECYCLE_VERSION');return d;
  }
  function catalog(c){if(!C.exact(c,['checked_at','catalog'])||c.catalog?.brand!==p.brand)throw C.fail('GRAPH_LIFECYCLE_CORRUPT');return c;}
  const pin=x=>{const {checked_at,...value}=x;return C.digest(value);};
  async function work(){
   const firstAuth=await auth();
   const original=draft(await read('readDraft',{brand:p.brand,journey_id:p.journey_id}));
   const current=catalog(await read('readCatalog',{brand:p.brand})),definition=original.definition,blockers=[];
   const block=code=>{if(!blockers.some(x=>x.code===code))blockers.push({code,message:REASONS[code]});};
   if(!C.version(original.server.version+1)||!C.version(original.server.revision+1))block('version_limit');
   const nodes=Array.isArray(definition.nodes)?definition.nodes:[],messages=nodes.filter(n=>n.type==='message'),triggers=nodes.filter(n=>n.type==='trigger');
   if(triggers.length!==1||triggers[0].event!=='cart.abandoned')block('trigger');
   if(messages.length!==1)block('message_count');
   const binding=messages[0]?.binding,selected=current.catalog.messages?.find(m=>m.key===binding);
   if(messages.length===1){if(selected?.channel&&selected.channel!=='email')block('channel');if(!selected||!/^email\.template\.[1-9][0-9]{0,8}$/.test(binding||''))block('binding');}
   if(C.digest(current.catalog)!==C.digest(original.catalog))block('source_changed');
   const validation=G.validateGraph(definition,{catalog:current.catalog});if(!validation.ok)block('graph_invalid');
   // Bound the longest path, not the sum of mutually exclusive branches. This
   // does not refresh event age: the real owner still expires at event ref+1h.
   if(validation.ok){
    const byId=new Map(nodes.map(n=>[n.id,n])),memo=new Map();
    const duration=id=>{if(memo.has(id))return memo.get(id);const n=byId.get(id),own=n.type==='wait'?n.seconds:n.type==='condition'?n.on_unknown.max_wait_seconds:0;const value=own+Math.max(0,...definition.edges.filter(e=>e.from===id).map(e=>duration(e.to)));memo.set(id,value);return value;};
    if(duration(triggers[0].id)>=3600)block('time_window');
   }
   let sourceRead=null,material=null;
   if(!blockers.length){
    sourceRead=await read('readSource',{brand:p.brand,binding});
    if(!C.exact(sourceRead,['checked_at','source']))throw C.fail('GRAPH_LIFECYCLE_CORRUPT');
    const source=sourceRead.source;
    if(source===null)block('binding');
    else if(!C.exact(source,['brand','template_id','binding','source_snapshot','native','slot','published_version'])||source.brand!==p.brand||source.binding!==binding||!Number.isSafeInteger(source.template_id)||source.template_id<1||binding!=='email.template.'+source.template_id||!Number.isSafeInteger(source.published_version)||source.published_version<1)throw C.fail('GRAPH_LIFECYCLE_CORRUPT');
    else if(source.source_snapshot!==selected.release)block('source_changed');
    else if(source.slot?.key!=='email:carrinho-30min'||source.slot.channel!=='email'||source.slot.flow!=='carrinho'||source.slot.piece!=='carrinho-30min'||source.slot.enabled!==true||String(source.slot.template_id)!==String(source.template_id))block('binding');
    else{try{material=R.prepareMaterial(source,{purchasePolicy:R.PURCHASE_POLICY.version});}catch{block('material');}}
   }
   // Read pins again, never reuse a previous invocation's snapshot. No readmark is written.
   if(sourceRead&&pin(await read('readSource',{brand:p.brand,binding}))!==pin(sourceRead))throw C.fail('GRAPH_LIFECYCLE_DRIFT');
   if(pin(draft(await read('readDraft',{brand:p.brand,journey_id:p.journey_id})))!==pin(original)||pin(catalog(await read('readCatalog',{brand:p.brand})))!==pin(current))throw C.fail('GRAPH_LIFECYCLE_DRIFT');
   if((await auth()).actor!==firstAuth.actor)throw C.fail('GRAPH_LIFECYCLE_ACCESS');
   const completed=now();if(completed<started||completed-started>C.MAX_AGE_MS)throw C.fail('GRAPH_LIFECYCLE_TIMEOUT');
   const base={...original.server,content_hash:original.content_hash};
   const proposal=blockers.length?null:{kind:'new_revision_proposal',base,proposed_revision:original.server.revision+1,revision_reserved:false,definition:C.copy(definition),planning_catalog_hash:C.digest(current.catalog),
    message:{binding,source_snapshot:sourceRead.source.source_snapshot,source_plan_hash:C.digest(sourceRead.source),material_plan_hash:C.digest(material),hash_contract:'canonical_json_sha256_v1',material_version:material.version,purchase_policy:C.copy(material.purchase_policy),required_fields:C.copy(material.required_fields),required_item_fields:C.copy(material.required_item_fields),required_identity:C.copy(material.required_identity)},
    release_id:null,native_id:null,operational_catalog:null};
   const result={contract:C.VERSION,scope:C.SCOPE,mode:'shadow',state:proposal?'compatible_for_preparation':'blocked',checked_at:new Date(completed).toISOString(),expires_at:new Date(completed+C.MAX_AGE_MS).toISOString(),original:base,proposal,blockers,outstanding:C.copy(REMAINING),
    authorizes_prepare:false,authorizes_publish:false,authorizes_activate:false,authorizes_enrollment:false,authorizes_send:false};
   return C.freeze({...result,review_hash:C.digest({actor:firstAuth.actor,request:p,result})});
  }
  try{return await Promise.race([work(),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(C.fail('GRAPH_LIFECYCLE_TIMEOUT'));},timeoutMs);})]);}
  catch(e){if(/^GRAPH_LIFECYCLE_(INPUT|ACCESS|VERSION|READ_UNCONFIRMED|DRIFT|CORRUPT|TIMEOUT)$/.test(e?.code||''))throw C.fail(e.code);throw C.fail('GRAPH_LIFECYCLE_READ_UNCONFIRMED');}
  finally{clearTimeout(timer);controller.abort();}
 }
 return Object.freeze({enabled:false,review});
}
module.exports={createLifecycleReviewer,REASONS,REMAINING,ENABLED:false};
