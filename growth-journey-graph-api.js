/* Draft-only client. Durable attempts never authorize publication or sending. */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.GJGApi=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const CONTRACT='journey_graph_draft_api_v1',SLOT='shrigma_graph_draft_operations_v1';
 const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
 const clone=x=>JSON.parse(JSON.stringify(x));
 const stable=x=>Array.isArray(x)?x.map(stable):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,stable(x[k])])):x;
 const same=(a,b)=>JSON.stringify(stable(a))===JSON.stringify(stable(b));
 const fail=(code,message)=>Object.assign(Error(message),{code});
 const messages={GRAPH_UNAUTHORIZED:'Entre com o acesso de gestor CRM.',GRAPH_PERMISSION_REQUIRED:'Seu acesso não permite salvar fluxos.',GRAPH_VERSION_CONFLICT:'Outra pessoa salvou uma versão mais recente. Sua edição foi preservada; confira a versão salva.',GRAPH_CATALOG_CHANGED:'As opções deste fluxo mudaram. Atualize o catálogo antes de salvar.',GRAPH_NOT_FOUND:'O fluxo não foi encontrado nesta marca.',GRAPH_REPLAY_MISMATCH:'A tentativa não corresponde à gravação original. Preserve a edição e consulte o recibo.',GRAPH_SERVICE_UNAVAILABLE:'Não foi possível confirmar a gravação. Consulte a mesma tentativa.'};
 const unresolved=op=>['pending','unknown'].includes(op.phase)||op.phase==='confirmed'&&op.applied!==true;
 const unknown=()=>fail('GRAPH_UNKNOWN','Salvamento sem confirmação. Consulte a mesma tentativa; não crie outra cópia.');
 function validRequest(p){
  const fields=['action','brand','request_id','definition',...(p?.action==='save'?['journey_id','expected_version']:[])];
  return p&&['create','save'].includes(p.action)&&['fish','aristo'].includes(p.brand)&&UUID.test(p.request_id||'')&&same(Object.keys(p).sort(),fields.sort())&&p.definition?.brand===p.brand&&p.definition?.version==='journey_graph_v1'&&Array.isArray(p.definition.nodes)&&Array.isArray(p.definition.edges)&&(p.action==='create'||UUID.test(p.journey_id||'')&&Number.isSafeInteger(p.expected_version)&&p.expected_version>0&&p.expected_version<2147483647)&&unescape(encodeURIComponent(JSON.stringify(p))).length<=196608;
 }
 function create({endpoint,key,storage=globalThis.localStorage,locks=globalThis.navigator?.locks,crypto=globalThis.crypto,fetch:request=globalThis.fetch}={}){
  let url;try{url=new URL(endpoint);}catch{throw fail('GRAPH_ENDPOINT','O construtor não está disponível.');}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw fail('GRAPH_ENDPOINT','O construtor não está disponível.');
  const origin=url.href;let seen=null;
  function access(){const k=typeof key==='function'?key():key;if(typeof k!=='string'||!k||/\s/.test(k))throw fail('GRAPH_ACCESS','Entre com o acesso de gestor CRM.');return k;}
  function read(){
   try{const raw=storage.getItem(SLOT);if(raw===null){if(seen?.operations.length)throw Error();return {version:1,operations:[]};}
    const j=JSON.parse(raw),ids=new Set();if(j.version!==1||!Array.isArray(j.operations))throw Error();
    if(Object.keys(j).sort().join(',')!=='operations,version')throw Error();
    for(const op of j.operations){if(!op||Array.isArray(op)||Object.keys(op).some(k=>!['payload','actor','endpoint','phase','applied','at','receipt','error'].includes(k))||!validRequest(op.payload)||ids.has(op.payload.request_id)||!['pending','unknown','confirmed','rejected'].includes(op.phase)||typeof op.endpoint!=='string'||!/^panel:[A-Za-z0-9_.:-]{1,122}$/.test(op.actor||'')||!Number.isFinite(op.at)||op.at<0||typeof op.applied!=='boolean')throw Error();const savedUrl=new URL(op.endpoint);if(savedUrl.protocol!=='https:'||savedUrl.username||savedUrl.password||savedUrl.search||savedUrl.hash||savedUrl.href!==op.endpoint)throw Error();
     if(op.phase==='confirmed'){if(!op.receipt||Object.hasOwn(op,'error'))throw Error();confirmed(op,{status:200,body:{state:'succeeded',actor:op.actor,request_id:op.payload.request_id,request_payload:op.payload,receipt:op.receipt}});}
     else if(op.applied||Object.hasOwn(op,'receipt')||(op.phase==='rejected'?typeof op.error!=='string'||!/^GRAPH_[A-Z_]+$/.test(op.error):Object.hasOwn(op,'error')))throw Error();
     ids.add(op.payload.request_id);}
    for(const previous of seen?.operations||[]){const current=j.operations.find(x=>x.payload.request_id===previous.payload.request_id);if(!current||!same(current.payload,previous.payload)||current.actor!==previous.actor||current.endpoint!==previous.endpoint||current.at!==previous.at||previous.applied&&!current.applied||previous.phase==='confirmed'&&(current.phase!=='confirmed'||!same(current.receipt,previous.receipt))||previous.phase==='rejected'&&!same(current,previous)||previous.phase==='unknown'&&['pending','rejected'].includes(current.phase))throw Error();}
    seen=clone(j);return j;
   }catch{throw fail('GRAPH_STORAGE','O registro de salvamento precisa ser preservado. Nenhuma nova gravação será feita.');}
  }
  function persist(j){try{const raw=JSON.stringify(j);storage.setItem(SLOT,raw);if(storage.getItem(SLOT)!==raw)throw Error();seen=clone(j);}catch{throw fail('GRAPH_STORAGE','Não foi possível guardar a tentativa neste navegador. Preserve a edição.');}}
  function inspect(){try{const j=read(),pending=j.operations.find(unresolved);return {...clone(j),pending:pending?clone(pending):null,blocked:!!pending||!locks?.request||!crypto?.randomUUID};}catch(e){return {operations:[],pending:null,blocked:true,error:e.message};}}
  async function exclusive(fn){if(!locks?.request||!crypto?.randomUUID)throw fail('GRAPH_STORAGE','Use um navegador com armazenamento e proteção entre abas para salvar.');return locks.request(SLOT,{mode:'exclusive',ifAvailable:true},l=>{if(!l)throw fail('GRAPH_BUSY','Outra aba está salvando um fluxo. Aguarde.');return fn();});}
  async function call(p,k,post=false){
   const target=new URL(origin);if(!post)for(const [name,value]of Object.entries(p))target.searchParams.set(name,value===null?'':value);
   try{const r=await request(target.href,{method:post?'POST':'GET',headers:{Authorization:'Bearer '+k,...(post?{'Content-Type':'application/json'}:{})},...(post?{body:JSON.stringify(p)}:{}),credentials:'omit',redirect:'error',cache:'no-store',signal:typeof AbortSignal!=='undefined'&&AbortSignal.timeout?AbortSignal.timeout(20000):undefined});const body=await r.json();if(body?.contract!==CONTRACT||body.authorizes_send!==false||body.authorizes_publish!==false)throw Error();return {status:r.status,body};}catch{throw unknown();}
  }
  const lookup=(p,k)=>call({action:'operation',brand:p.brand,request_id:p.request_id},k);
  function confirmed(op,r){
   const b=r.body,v=b?.receipt,p=op.payload;
   if(![200,201].includes(r.status)||b?.state!=='succeeded'||b.actor!==op.actor||b.request_id!==p.request_id||!same(b.request_payload,p)||v?.contract!=='journey_graph_store_v1'||v.operation_id!==p.request_id||v.brand!==p.brand||!UUID.test(v.journey_id||'')||!Number.isSafeInteger(v.version)||v.version<1||!Number.isSafeInteger(v.revision)||v.revision<1||v.revision>v.version||p.action==='create'&&(v.version!==1||v.revision!==1)||v.published_revision!==null||v.paused!==true||v.authorizes_send!==false||p.action==='save'&&(v.journey_id!==p.journey_id||v.version!==p.expected_version+1)||op.phase==='confirmed'&&!same(v,op.receipt))throw unknown();
   return clone(v);
  }
  async function recoverInside(j,op,k){
   const r=await lookup(op.payload,k);
   if(r.status===202&&r.body.state==='unconfirmed'&&r.body.request_id===op.payload.request_id&&r.body.actor===op.actor&&r.body.retry_same_request_only===true){if(op.phase==='confirmed'||op.phase==='rejected')throw unknown();op.phase='unknown';persist(j);return {state:'unconfirmed',request_id:op.payload.request_id};}
   op.receipt=confirmed(op,r);op.phase='confirmed';persist(j);return {state:'succeeded',receipt:clone(op.receipt),request_payload:clone(op.payload)};
  }
  async function postInside(j,op,k){
   const wasUncertain=op.phase==='unknown';let result;try{result=await call(op.payload,k,true);}catch{}
   if(result&&[200,201].includes(result.status)){op.receipt=confirmed(op,result);op.phase='confirmed';persist(j);return {state:'succeeded',receipt:clone(op.receipt),request_payload:clone(op.payload)};}
   if(!wasUncertain&&result&&[400,401,403,404,409,413,422].includes(result.status)&&result.body.state!=='unconfirmed'&&typeof result.body.error==='string'&&result.body.error.startsWith('GRAPH_')){op.phase='rejected';op.error=result.body.error;persist(j);throw fail(op.error,messages[op.error]||'Confira as etapas e os campos deste fluxo antes de salvar.');}
   op.phase='unknown';persist(j);try{return await recoverInside(j,op,k);}catch{throw unknown();}
  }
  async function run(input){
   const p={...clone(input),request_id:crypto?.randomUUID?.()};if(!validRequest(p)||Object.hasOwn(input,'request_id'))throw fail('GRAPH_INPUT','Confira a marca, o fluxo e a versão antes de salvar.');const k=access();
   return exclusive(async()=>{const j=read();if(j.operations.some(unresolved))throw unknown();
    if(j.operations.some(o=>o.payload.request_id===p.request_id))throw fail('GRAPH_INPUT','Não foi possível identificar esta gravação.');
    const pre=await lookup(p,k);if(pre.status!==202||pre.body.state!=='unconfirmed'||pre.body.request_id!==p.request_id||!/^panel:[A-Za-z0-9_.:-]{1,122}$/.test(pre.body.actor||'')||pre.body.retry_same_request_only!==true)throw unknown();
    const op={payload:p,actor:pre.body.actor,endpoint:origin,phase:'pending',applied:false,at:Date.now()};j.operations.push(op);persist(j);return postInside(j,op,k);
   });
  }
  async function recover(id,{resume=false}={}){const k=access();return exclusive(async()=>{const j=read(),op=j.operations.find(o=>o.payload.request_id===id);if(!op||op.endpoint!==origin)throw fail('GRAPH_ORIGIN','Abra a origem da tentativa para recuperá-la.');if(op.phase==='rejected')throw fail('GRAPH_REJECTED','Esta tentativa foi recusada. Preserve o recibo e revise a edição antes de salvar.');const r=await recoverInside(j,op,k);if(r.state==='succeeded'||!resume)return r;return postInside(j,op,k);});}
  async function get(action,brand,params={}){const fields={capabilities:[],catalog:[],list:['after','limit'],get:['journey_id']};if(!Object.hasOwn(fields,action)||!['fish','aristo'].includes(brand)||!params||Array.isArray(params)||Object.keys(params).some(k=>!fields[action].includes(k)))throw fail('GRAPH_INPUT','Escolha Fishermans ou O Aristocrata.');const r=await call({action,brand,...params},access());if(r.status!==200)throw fail(r.body.error||'GRAPH_READ',messages[r.body.error]||'Não foi possível carregar os fluxos. Tente atualizar.');if(action==='catalog'&&r.body.catalog?.brand!==brand||action==='get'&&(r.body.server?.brand!==brand||r.body.definition?.brand!==brand||r.body.catalog?.brand!==brand||r.body.server?.journey_id!==params.journey_id)||action==='list'&&(!Array.isArray(r.body.journeys)||r.body.journeys.some(j=>j.brand!==brand)))throw fail('GRAPH_READ','A resposta não corresponde à marca selecionada. Atualize sem substituir sua edição.');return clone(r.body);}
  async function acknowledge(id){return exclusive(async()=>{const j=read(),op=j.operations.find(o=>o.payload.request_id===id);if(!op||op.endpoint!==origin||op.phase!=='confirmed'||!op.receipt)throw unknown();op.applied=true;persist(j);return true;});}
  return Object.freeze({get,run,recover,inspect,acknowledge});
 }
 return Object.freeze({CONTRACT,SLOT,create,validRequest});
});
