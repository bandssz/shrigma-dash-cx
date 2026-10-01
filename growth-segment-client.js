(function(root,factory){'use strict';if(typeof module==='object'&&module.exports)module.exports=factory(require('./n8n/growth/segment-contract.js'),require('./n8n/growth/segment-audience-contract.js'));else root.GSC=factory(root.SegmentContract,root.SegmentAudienceContract);})(typeof globalThis==='undefined'?this:globalThis,function(ListContract,AudienceContract){
 'use strict';
 const VERSION='crm-segment-v1',SLOT='shrigma_segment_operation_v1:',clone=x=>JSON.parse(JSON.stringify(x));
 const fail=code=>{throw Object.assign(new Error(code),{code});},positive=n=>Number.isSafeInteger(n)&&n>0,uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(x);
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),contractFor=api=>api?.capabilities?.segments?.contract_version===AudienceContract?.VERSION?AudienceContract:ListContract;
 const exact=(o,keys)=>!!o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));
 const rejectionCodes=new Set(['SEGMENT_CATALOG_CHANGED','SEGMENT_VERSION_CONFLICT','SEGMENT_ARCHIVED','SEGMENT_NOT_FOUND','SEGMENT_UNAVAILABLE','SEGMENT_LIST_UNAVAILABLE','SEGMENT_SHAPE','SEGMENT_FIELDS','SEGMENT_NAME','SEGMENT_RULE','SEGMENT_LIMIT','SEGMENT_VERSION','SEGMENT_BRAND_MISMATCH','SEGMENT_VERSION_REQUIRED','SEGMENT_LIST_ID']);
 const rejected=r=>!!r&&[404,409,422,503].includes(r.status)&&rejectionCodes.has(r.body?.error)&&Object.keys(r.body).every(k=>['error','current_version','transport_supported'].includes(k))&&(!Object.hasOwn(r.body,'current_version')||positive(r.body.current_version))&&(!Object.hasOwn(r.body,'transport_supported')||r.body.transport_supported===false);
 function caps(api){const c=api?.capabilities?.segments;let endpoint=null;try{const u=new URL(api.capabilities.endpoints.segments);if(u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash)endpoint=u.href;}catch{}
  const ok=[VERSION,AudienceContract?.VERSION].filter(Boolean).includes(c?.contract_version)&&Array.isArray(c.brands)&&endpoint;return {contract_version:ok?c.contract_version:null,endpoint:ok?endpoint:null,brands:ok?c.brands.filter(b=>['fish','aristo'].includes(b)):[],read:!!ok&&c.read===true,operation:!!ok&&c.operation===true,save:!!ok&&c.read===true&&c.save===true&&c.operation===true,count:!!ok&&c.read===true&&c.count===true,send:false};}
 async function fingerprint(key){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key)))].map(x=>x.toString(16).padStart(2,'0')).join('');}
 function create({api,brand,key,storage=localStorage,fetch:fetcher=fetch,locks=globalThis.navigator?.locks,identity=fingerprint,id=()=>crypto.randomUUID()}={}){
  const Contract=contractFor(api),normalized=x=>Contract.normalize(x),definitionSame=(a,b)=>same(normalized(a),normalized(b));
  if(!Contract||!['fish','aristo'].includes(brand))fail('SEGMENT_CONTEXT');
  let availability=caps(api),catalog=null,permissions=null,busy=false;
  const endpoint=availability.endpoint,slot=SLOT+brand,actor=typeof key==='function'?key():key;
  let state={version:1,brand,endpoint,segment:null,operation:null};
  function validSegment(s){try{return exact(s,['id','brand','name','definition','version','archived','created_at','updated_at','updated_by',...(Contract.FIELDS?['semantic_context']:[])])&&(!Contract.FIELDS||exact(s.semantic_context,['currency','timezone','current'])&&typeof s.semantic_context.current==='boolean'&&(s.semantic_context.currency===null||typeof s.semantic_context.currency==='string'&&/^[A-Z]{3}$/.test(s.semantic_context.currency))&&(s.semantic_context.timezone===null||typeof s.semantic_context.timezone==='string'&&s.semantic_context.timezone.length<=100))&&uuid(s.id)&&s.brand===brand&&positive(s.version)&&typeof s.archived==='boolean'&&s.name===normalized(s.definition).name&&s.definition.brand===brand&&Number.isFinite(Date.parse(s.created_at))&&Number.isFinite(Date.parse(s.updated_at))&&typeof s.updated_by==='string'&&s.updated_by.length<=200;}catch{return false;}}
  function validState(s){try{
   if(!exact(s,['version','brand','endpoint','segment','operation'])||s.version!==1||s.brand!==brand||s.endpoint!==endpoint||s.segment!==null&&!validSegment(s.segment))return false;
   const op=s.operation;if(op===null)return true;
   if(!['pending','uncertain','confirmed','rejected'].includes(op.phase)||!exact(op,['phase','actor','request','before',...(['confirmed','rejected'].includes(op.phase)?['receipt']:[])])||!/^[a-f0-9]{64}$/.test(op.actor))return false;
   const p=op.request,create=p?.acao==='segmento_criar',save=p?.acao==='segmento_salvar';
   if(!['segmento_criar','segmento_salvar','segmento_arquivar'].includes(p?.acao)||!exact(p,['acao','brand','idempotency_key',...(create?['definition']:save?['id','expected_version','definition']:['id','expected_version']),...(Contract.FIELDS&&(create||save)?['expected_catalog_hash']:[])])||p.brand!==brand||!/^[A-Za-z0-9_.:-]{8,128}$/.test(p.idempotency_key))return false;
   if(Contract.FIELDS&&(create||save)&&!/^[a-f0-9]{64}$/.test(p.expected_catalog_hash))return false;
   if(create?op.before!==null:!validSegment(op.before)||op.before.archived||p.id!==op.before.id||p.expected_version!==op.before.version)return false;
   if((create||save)&&normalized(p.definition).brand!==brand)return false;
   return op.phase==='confirmed'?receipt(op.receipt,op):op.phase==='rejected'?rejected(op.receipt):true;
  }catch{return false;}}
  function refresh(){let saved;try{saved=JSON.parse(storage.getItem(slot)||'null');}catch{fail('SEGMENT_JOURNAL_INVALID');}if(saved){if(!validState(saved))fail('SEGMENT_JOURNAL_INVALID');state=saved;}}
  refresh();const snapshot=()=>clone(state),pending=()=>['pending','uncertain'].includes(state.operation?.phase);
  function persist(next){if(!validState(next))fail('SEGMENT_JOURNAL_INVALID');const raw=JSON.stringify(next);try{storage.setItem(slot,raw);if(storage.getItem(slot)!==raw)throw Error();state=clone(next);}catch{fail('SEGMENT_STORAGE_UNAVAILABLE');}}
  function access(flag){if(typeof actor!=='string'||!actor||actor!==(typeof key==='function'?key():key))fail('SEGMENT_ACCESS_CHANGED');if(!endpoint||availability.endpoint!==endpoint||availability.contract_version!==Contract.VERSION||!availability.brands.includes(brand)||availability[flag]!==true)fail('SEGMENT_CAPABILITY_UNAVAILABLE');return actor;}
  async function call(method,request,flag){const token=access(flag),url=new URL(endpoint),init={method,cache:'no-store',credentials:'omit',redirect:'error',headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(method==='POST'?90000:20000)};
   if(method==='GET')url.search=new URLSearchParams(request).toString();else{init.headers['Content-Type']='application/json';init.body=JSON.stringify(request);}
   try{const response=await fetcher(url.href,init),body=await response.json();return {status:response.status,body};}catch{return {status:0,body:null};}}
  function ok(r){return r.status>=200&&r.status<300;}
  function requireOK(r){if(!ok(r))fail(['SEGMENT_CATALOG_CHANGED','SEGMENT_VERSION_CONFLICT','SEGMENT_ARCHIVED','SEGMENT_LIST_UNAVAILABLE','SEGMENT_UNAVAILABLE'].includes(r.body?.error)?r.body.error:'SEGMENT_READ_UNCONFIRMED');return r.body;}
  async function exclusive(work){if(typeof locks?.request!=='function')fail('SEGMENT_LOCK_UNAVAILABLE');return locks.request(slot,{mode:'exclusive',ifAvailable:true},async lock=>{if(!lock||busy)fail('SEGMENT_BUSY');busy=true;try{refresh();return await work();}finally{busy=false;}});}
  function writable(){access('save');if(pending())fail('SEGMENT_OPERATION_PENDING');if(!catalog||permissions?.draft!==true)fail('SEGMENT_CATALOG_UNCONFIRMED');}
  function checkDefinition(input){const d=normalized(input);if(d.brand!==brand||!catalog||catalog.brand!==brand||catalog.current!==true)fail('SEGMENT_CATALOG_UNCONFIRMED');if(Contract.checkCatalog){if(!Contract.checkCatalog(d,catalog).ok)fail('SEGMENT_CATALOG_UNCONFIRMED');return d;}const walk=r=>{if(r.op==='in_list'){const matches=catalog.lists.filter(l=>l.id===r.list_id);if(matches.length!==1||matches[0].available!==true||matches[0].brand!==brand)fail('SEGMENT_LIST_UNAVAILABLE');}else r.rules.forEach(walk);};walk(d.rule);return d;}
  function shopifySnapshot(c){
   if(!Object.hasOwn(c,'shopify_snapshot'))return true;const v=c.shopify_snapshot;
   return !!v&&typeof v.current==='boolean'&&(exact(v,['current'])&&!v.current||exact(v,['current','started_at','observed_at','expires_at'])
    &&[v.started_at,v.observed_at,v.expires_at].every(x=>typeof x==='string'&&Number.isFinite(Date.parse(x)))
    &&Date.parse(v.started_at)<=Date.parse(v.observed_at)&&Date.parse(v.expires_at)-Date.parse(v.started_at)===93600000);
  }
  function typedCatalog(c){if(!Contract.FIELDS)return true;return Contract.recordedOriginsValid(Object.hasOwn(c,'recorded_origins')?c.recorded_origins:[],brand)&&shopifySnapshot(c)&&typeof c.catalog_hash==='string'&&/^[a-f0-9]{64}$/.test(c.catalog_hash)&&Array.isArray(c.fields)&&c.fields.length<=Object.keys(Contract.FIELDS).length&&c.fields.every(f=>Object.hasOwn(Contract.FIELDS,f.key)&&typeof f.available==='boolean')&&new Set(c.fields.map(f=>f.key)).size===c.fields.length&&Array.isArray(c.products)&&c.products.length<=1000&&c.products.every(p=>/^gid:\/\/shopify\/Product\/[1-9]\d{0,19}$/.test(p.id)&&p.brand===brand&&typeof p.name==='string'&&typeof p.available==='boolean')&&new Set(c.products.map(p=>p.id)).size===c.products.length&&Array.isArray(c.origins)&&c.origins.every(o=>['popup','vip_alma','vip_desodorante'].includes(o.key)&&o.brand===brand&&typeof o.name==='string'&&typeof o.available==='boolean')&&new Set(c.origins.map(o=>o.key)).size===c.origins.length;}
  function receipt(r,op){try{const s=r?.body?.segment,p=op.request;if(!r||!ok(r)||!exact(r.body,['segment','transport_supported'])||r.body.transport_supported!==false||!validSegment(s))return false;
   if(p.acao==='segmento_criar')return r.status===201&&s.version===1&&!s.archived&&definitionSame(s.definition,p.definition);
   if(r.status!==200)return false;
   if(s.id!==p.id||s.version!==p.expected_version+1)return false;
   return p.acao==='segmento_arquivar'?s.archived&&definitionSame(s.definition,op.before.definition):!s.archived&&definitionSame(s.definition,p.definition);
  }catch{return false;}
  }
  function selected(expected){const current=state.segment;if((current?.id??null)!==(expected?.id??null)||(current?.version??null)!==(expected?.version??null))fail('SEGMENT_SELECTION_CHANGED');if(current?.archived)fail('SEGMENT_ARCHIVED');}
  async function write(action,input,expected){return exclusive(async()=>{writable();selected(expected);const request={acao:action,brand,...input,idempotency_key:id()},before=state.segment,actorHash=await identity(actor);access('save');refresh();writable();selected(expected);
   if(!/^[A-Za-z0-9_.:-]{8,128}$/.test(request.idempotency_key))fail('SEGMENT_OPERATION_ID_INVALID');
   const operation={phase:'pending',actor:actorHash,request,before};persist({...state,operation});const r=await call('POST',request,'save');
   if(receipt(r,operation)){persist({...state,segment:r.body.segment,operation:{...operation,phase:'confirmed',receipt:r}});return snapshot();}
   persist({...state,operation:{...operation,phase:'uncertain'}});fail('SEGMENT_OPERATION_UNCONFIRMED');
  });}
  return {
   snapshot,pending,canWrite:()=>typeof locks?.request==='function',catalog:()=>catalog?clone(catalog):null,capabilities:()=>clone(availability),
   update(api){const next=caps(api);if(!same(availability,next)){catalog=null;permissions=null;}availability=next;},
   async list({offset=0,limit=50}={}){if(!Number.isInteger(offset)||offset<0||offset>10000||!Number.isInteger(limit)||limit<1||limit>100)fail('SEGMENT_PAGE_INVALID');catalog=null;permissions=null;const b=requireOK(await call('GET',{acao:'segmentos_listar',brand,offset,limit},'read'));
    if(!Array.isArray(b.segments)||!b.segments.every(validSegment)||b.offset!==offset||b.limit!==limit||b.capabilities?.send!==false||typeof b.capabilities?.draft!=='boolean'||typeof b.capabilities?.count!=='boolean'||b.catalog?.brand!==brand||typeof b.catalog.current!=='boolean'||(!b.catalog.current&&(b.capabilities.draft||b.capabilities.count))||!Array.isArray(b.catalog.lists)||b.catalog.lists.some(l=>!positive(l.id)||l.brand!==brand||typeof l.name!=='string'||typeof l.available!=='boolean')||new Set(b.catalog.lists.map(l=>l.id)).size!==b.catalog.lists.length||!typedCatalog(b.catalog))fail('SEGMENT_CATALOG_UNCONFIRMED');
    access('read');catalog=clone(b.catalog);permissions=clone(b.capabilities);return clone(b);},
   async open(id){if(!uuid(id))fail('SEGMENT_ID_INVALID');return exclusive(async()=>{if(pending())fail('SEGMENT_OPERATION_PENDING');const b=requireOK(await call('GET',{acao:'segmento_obter',brand,id},'read'));if(!validSegment(b.segment)||b.segment.id!==id)fail('SEGMENT_READ_UNCONFIRMED');persist({...state,segment:b.segment});return snapshot();});},
   async newDraft({preserveDraft}={}){return exclusive(async()=>{
    access('read');if(pending())fail('SEGMENT_OPERATION_PENDING');
    if(preserveDraft){
     // Only an explicitly confirmed legacy preparation may move to a fresh slot.
     // Keep its exact bytes before replacing the active editor, under its journal lock.
     const p=preserveDraft,editorSlot='shrigma_segment_editor_v1:'+brand;
     if(!exact(p,['expectedRaw','nextRaw','backupSlot'])||typeof p.expectedRaw!=='string'||p.expectedRaw.length>200000||typeof p.nextRaw!=='string'||p.nextRaw.length>200000)fail('SEGMENT_STORAGE_UNAVAILABLE');
     let old,next;try{old=JSON.parse(p.expectedRaw);next=JSON.parse(p.nextRaw);}catch{fail('SEGMENT_JOURNAL_INVALID');}
     const actorHash=await identity(actor),backupHash=await identity(p.expectedRaw);access('save');refresh();if(pending())fail('SEGMENT_OPERATION_PENDING');
     if(!catalog||catalog.current!==true||permissions?.draft!==true||old.version!==1||old.brand!==brand||old.endpoint!==endpoint||old.actor!==actorHash||old.draft?.brand!==brand||old.draft.schema_version!==Contract.VERSION||old.draft_catalog_hash!=null
      ||!exact(next,['version','brand','endpoint','actor','draft','base','server','draft_catalog_hash','draft_currency','draft_timezone'])||next.version!==1||next.brand!==brand||next.endpoint!==endpoint||next.actor!==actorHash||next.server!==null||next.draft_catalog_hash!==catalog.catalog_hash||next.draft_currency!==(catalog.currency??null)||next.draft_timezone!==(catalog.timezone??null)
      ||!same(next.draft,{schema_version:Contract.VERSION,brand,name:'',rule:{op:'and',rules:[{op:'in_list',list_id:0}]}})||!same(next.base,next.draft)||p.backupSlot!==editorSlot+':preserved:'+backupHash)fail('SEGMENT_CATALOG_UNCONFIRMED');
     try{
      if(storage.getItem(editorSlot)!==p.expectedRaw)fail('SEGMENT_SELECTION_CHANGED');
      const backup=storage.getItem(p.backupSlot);if(backup!==null&&backup!==p.expectedRaw)fail('SEGMENT_STORAGE_UNAVAILABLE');
      if(backup===null)storage.setItem(p.backupSlot,p.expectedRaw);
      if(storage.getItem(p.backupSlot)!==p.expectedRaw||storage.getItem(editorSlot)!==p.expectedRaw)fail('SEGMENT_STORAGE_UNAVAILABLE');
      storage.setItem(editorSlot,p.nextRaw);if(storage.getItem(editorSlot)!==p.nextRaw)fail('SEGMENT_STORAGE_UNAVAILABLE');
     }catch(e){fail(e.code||'SEGMENT_STORAGE_UNAVAILABLE');}
    }
    try{persist({...state,segment:null});}catch(e){
     if(preserveDraft)try{const slot='shrigma_segment_editor_v1:'+brand;if(storage.getItem(slot)===preserveDraft.nextRaw)storage.setItem(slot,preserveDraft.expectedRaw);}catch{}
     throw e;
    }return snapshot();
   });},
   save(input,expected=null){const d=checkDefinition(input);return write(expected?'segmento_salvar':'segmento_criar',{definition:d,...(expected?{id:expected.id,expected_version:expected.version}:{}),...(Contract.FIELDS?{expected_catalog_hash:catalog.catalog_hash}:{})},expected);},
   archive(expected){if(!uuid(expected?.id)||!positive(expected?.version))fail('SEGMENT_VERSION_REQUIRED');return write('segmento_arquivar',{id:expected.id,expected_version:expected.version},expected);},
   async count(input,expected=null){access('count');if(permissions?.count!==true)fail('SEGMENT_CAPABILITY_UNAVAILABLE');refresh();if(pending())fail('SEGMENT_OPERATION_PENDING');const d=checkDefinition(input);if(expected){selected(expected);if(!definitionSame(d,state.segment.definition))fail('SEGMENT_UNSAVED_COUNT');}
    const b=requireOK(await call('POST',{acao:'segmento_contar',brand,...(expected?{id:expected.id,expected_version:expected.version}:{definition:d}),...(Contract.FIELDS?{expected_catalog_hash:catalog.catalog_hash}:{})},'count'));access('count');
    if(b.transport_supported!==false||typeof b.source_confirmed!=='boolean'||(b.source_confirmed?!Number.isSafeInteger(b.eligible_count)||b.eligible_count<0:b.eligible_count!==null)||!Number.isFinite(Date.parse(b.checked_at))||!/^[a-f0-9]{64}$/.test(b.definition_hash)||!definitionSame(b.definition,d)||b.segment_id!==(expected?.id??null)||b.version!==(expected?.version??null))fail('SEGMENT_COUNT_UNCONFIRMED');return clone(b);},
   async consult(){return exclusive(async()=>{access('operation');if(!pending())fail('SEGMENT_OPERATION_MISSING');const op=clone(state.operation);if(await identity(actor)!==op.actor)fail('SEGMENT_OPERATION_ACTOR_CHANGED');access('operation');refresh();if(!same(state.operation,op))fail('SEGMENT_OPERATION_CHANGED');const r=await call('GET',{acao:'segmento_operacao',brand,idempotency_key:op.request.idempotency_key},'operation');
    if(receipt(r,op)){const b=requireOK(await call('GET',{acao:'segmento_obter',brand,id:r.body.segment.id},'read'));if(!validSegment(b.segment)||b.segment.id!==r.body.segment.id||b.segment.version<r.body.segment.version||(b.segment.version===r.body.segment.version&&(!definitionSame(b.segment.definition,r.body.segment.definition)||b.segment.archived!==r.body.segment.archived)))fail('SEGMENT_READ_UNCONFIRMED');persist({...state,segment:b.segment,operation:{...op,phase:'confirmed',receipt:r}});return snapshot();}
    if(rejected(r)){persist({...state,operation:{...op,phase:'rejected',receipt:r}});return snapshot();}
    fail('SEGMENT_OPERATION_UNCONFIRMED');});}
  };
 }
 return {VERSION,SLOT,Contract:ListContract,contractFor,caps,create,fingerprint};
});
