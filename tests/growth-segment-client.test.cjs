'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture,definition,api,Client}=require('./growth-segment-fixture.cjs');
test('segments are OFF by default and require exact contract, brands, operation and secure endpoint',()=>{
 assert.equal(Client.caps({}).read,false);assert.equal(Client.caps(api).send,false);
 for(const change of [p=>p.capabilities.segments.contract_version='wrong',p=>delete p.capabilities.segments.brands,p=>p.capabilities.endpoints.segments='http://plain.test',p=>p.capabilities.endpoints.segments='https://safe.test?k=secret']){const p=structuredClone(api);change(p);assert.equal(Client.caps(p).read,false);}
 const p=structuredClone(api);delete p.capabilities.segments.operation;assert.equal(Client.caps(p).read,true);assert.equal(Client.caps(p).save,false);
});
test('create, edit, archive use exact positive versions; count remains a separate informational read',async()=>{
 for(const brand of ['fish','aristo']){const f=fixture(),c=f.create(brand);await c.list();const s=await c.save(definition(brand));assert.equal(s.segment.version,1);assert.equal(s.operation.phase,'confirmed');assert.equal(f.calls.at(-1).body.expected_version,undefined);
  const d=definition(brand,'Atualizado');const s2=await c.save(d,s.segment);assert.equal(s2.segment.id,s.segment.id);assert.equal(s2.segment.version,2);assert.equal(f.calls.at(-1).body.expected_version,1);
  const counted=await c.count(d,s2.segment);assert.equal(counted.eligible_count,7);assert.equal(counted.transport_supported,false);assert.equal(counted.version,2);
  const s3=await c.archive(s2.segment);assert.equal(s3.segment.archived,true);assert.equal(s3.segment.version,3);assert.ok(f.calls.every(x=>x.body.brand===brand));assert.ok([...f.store.values()].every(x=>!x.includes('synthetic-actor-one')));
 }
});
test('unconfirmed create survives reload; one operation lookup and current readback resolve it without replay',async()=>{
 const f=fixture(),c=f.create();await c.list();f.control.lose=true;await assert.rejects(c.save(definition()),{code:'SEGMENT_OPERATION_UNCONFIRMED'});const op=c.snapshot().operation;assert.equal(op.phase,'uncertain');
 const restored=f.create();assert.equal(restored.pending(),true);await restored.list();await assert.rejects(restored.save(definition()),{code:'SEGMENT_OPERATION_PENDING'});f.control.lose=false;const s=await restored.consult();assert.equal(s.operation.phase,'confirmed');assert.equal(s.segment.version,1);assert.equal(s.operation.request.idempotency_key,op.request.idempotency_key);assert.equal(f.calls.filter(x=>x.method==='POST').length,1);assert.deepEqual(f.calls.slice(-2).map(x=>x.body.acao),['segmento_operacao','segmento_obter']);
});
test('unknown operation, wrong actor and missing current readback cannot unlock an uncertain write',async()=>{
 const f=fixture(),c=f.create();await c.list();f.control.lose=true;await assert.rejects(c.save(definition()));const saved=f.store.get(Client.SLOT+'fish');
 f.control.unconfirmed=true;await assert.rejects(c.consult(),{code:'SEGMENT_OPERATION_UNCONFIRMED'});assert.equal(f.store.get(Client.SLOT+'fish'),saved);
 const other=f.create('fish',()=> 'synthetic-other-actor');const before=f.calls.length;await assert.rejects(other.consult(),{code:'SEGMENT_OPERATION_ACTOR_CHANGED'});assert.equal(f.calls.length,before);
 f.control.unconfirmed=false;f.control.failCurrent=true;await assert.rejects(c.consult());assert.equal(c.pending(),true);assert.equal(f.store.get(Client.SLOT+'fish'),saved);
});
test('version conflict remains pending until its durable rejection is looked up, then preserves original preparation',async()=>{
 const f=fixture(),c=f.create();await c.list();const first=await c.save(definition());f.rows.get(first.segment.id).version=4;await assert.rejects(c.save(definition('fish','Ainda local'),first.segment));assert.equal(c.pending(),true);
 const s=await c.consult();assert.equal(s.operation.phase,'rejected');assert.equal(s.segment.version,1);assert.equal(s.operation.request.definition.name,'Ainda local');assert.equal(f.rows.size,1);assert.equal(f.calls.filter(x=>x.body.acao==='segmento_criar').length,1);
});
test('no storage or cross-tab lock prevents mutation transport',async()=>{
 for(const mode of ['storage','locks']){const f=fixture(),c=f.create('fish',()=> 'synthetic-actor-one',mode==='locks'?{locks:null}:{storage:{getItem:()=>null,setItem(){throw Error('blocked');}}});await c.list();await assert.rejects(c.save(definition()),{code:mode==='locks'?'SEGMENT_LOCK_UNAVAILABLE':'SEGMENT_STORAGE_UNAVAILABLE'});assert.equal(f.calls.filter(x=>x.method==='POST').length,0);}
});
test('two tabs share the brand journal and reject stale create or parallel reset',async()=>{
 const f=fixture(),a=f.create(),b=f.create();await a.list();await b.list();let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);f.control.before=async p=>{if(p.acao==='segmento_criar'){entered();await gate;}};
 const first=a.save(definition());await started;await assert.rejects(b.newDraft(),{code:'SEGMENT_BUSY'});release();await first;await assert.rejects(b.save(definition()),{code:'SEGMENT_SELECTION_CHANGED'});assert.equal(f.calls.filter(x=>x.method==='POST').length,1);
});
test('catalog and credential context prevent cross-brand lists, stale actor and withdrawn capability writes',async()=>{
 const f=fixture();let key='synthetic-actor-one';const c=f.create('fish',()=>key);await c.list();await assert.rejects(async()=>c.save(definition('aristo')),{code:'SEGMENT_CATALOG_UNCONFIRMED'});await assert.rejects(async()=>c.save({...definition(),rule:{op:'in_list',list_id:999}}),{code:'SEGMENT_LIST_UNAVAILABLE'});
 key='synthetic-replacement';await assert.rejects(c.save(definition()),{code:'SEGMENT_ACCESS_CHANGED'});assert.equal(f.calls.length,1);key='synthetic-actor-one';c.update({});await assert.rejects(async()=>c.save(definition()));assert.equal(f.calls.length,1);
});
test('source-unconfirmed count is null and mismatched definition is rejected',async()=>{
 const f=fixture(),c=f.create();await c.list();f.control.countUnknown=true;const result=await c.count(definition());assert.equal(result.eligible_count,null);assert.equal(result.source_confirmed,false);assert.equal(c.snapshot().operation,null);
 f.control.countMismatch=true;await assert.rejects(c.count(definition()),{code:'SEGMENT_COUNT_UNCONFIRMED'});
});
test('malformed successful mutation stays locked and endpoint change cannot hide its journal',async()=>{
 const f=fixture(),c=f.create();await c.list();f.control.malformed=true;await assert.rejects(c.save(definition()));assert.equal(c.pending(),true);const p=structuredClone(api);p.capabilities.endpoints.segments='https://replacement.example.test/api';assert.throws(()=>f.create('fish',()=> 'synthetic-actor-one',{api:p}),{code:'SEGMENT_JOURNAL_INVALID'});
});
test('a journal cannot promote pending to confirmed without its matching durable receipt or accept corrupt operation fields',async()=>{
 const f=fixture(),c=f.create();await c.list();f.control.lose=true;await assert.rejects(c.save(definition()));const original=f.store.get(Client.SLOT+'fish');
 for(const tamper of [s=>s.operation.phase='confirmed',s=>s.operation.phase='rejected',s=>s.operation.actor='unbound',s=>s.operation.request.idempotency_key='short',s=>s.operation.request.actor='invented',s=>s.operation.request.definition.rule={op:'sql',query:'arbitrary'},s=>s.operation.before={id:'wrong'}]){
  const value=JSON.parse(original);tamper(value);f.store.set(Client.SLOT+'fish',JSON.stringify(value));assert.throws(()=>f.create(),{code:'SEGMENT_JOURNAL_INVALID'});
 }
 f.store.set(Client.SLOT+'fish',original);f.control.lose=false;await c.consult();const good=JSON.parse(f.store.get(Client.SLOT+'fish'));good.operation.receipt.body.segment.version++;f.store.set(Client.SLOT+'fish',JSON.stringify(good));assert.throws(()=>f.create(),{code:'SEGMENT_JOURNAL_INVALID'});
});
async function legacyMigration(f,mode='absent'){
 const Audience=require('../n8n/growth/segment-audience-contract.js'),actor=await Client.fingerprint('synthetic-actor-one'),draft={schema_version:Audience.VERSION,brand:'fish',name:'Legado',rule:{op:'and',rules:[{op:'in_list',list_id:11}]}},old={version:1,brand:'fish',endpoint:f.api.capabilities.endpoints.segments,actor,draft,base:structuredClone(draft),server:null};if(mode==='null')old.draft_catalog_hash=null;if(mode==='malformed')old.draft_catalog_hash='bad';
 const expectedRaw=JSON.stringify(old),fresh={schema_version:Audience.VERSION,brand:'fish',name:'',rule:{op:'and',rules:[{op:'in_list',list_id:0}]}},nextRaw=JSON.stringify({version:1,brand:'fish',endpoint:f.api.capabilities.endpoints.segments,actor,draft:fresh,base:structuredClone(fresh),server:null,draft_catalog_hash:'a'.repeat(64),draft_currency:'BRL',draft_timezone:null}),backupSlot='shrigma_segment_editor_v1:fish:preserved:'+await Client.fingerprint(expectedRaw);return {expectedRaw,nextRaw,backupSlot,draft};
}
const preservation=m=>({expectedRaw:m.expectedRaw,nextRaw:m.nextRaw,backupSlot:m.backupSlot});
test('legacy draft replacement is one locked exact-byte backup followed by an empty current-context editor',async()=>{
 const Audience=require('../n8n/growth/segment-audience-contract.js');for(const mode of ['absent','null']){const f=fixture({version:Audience.VERSION}),c=f.create(),migration=await legacyMigration(f,mode),slot='shrigma_segment_editor_v1:fish';f.store.set(slot,migration.expectedRaw);await c.list();await c.newDraft({preserveDraft:preservation(migration)});assert.equal(f.store.get(migration.backupSlot),migration.expectedRaw);assert.equal(f.store.get(slot),migration.nextRaw);assert.equal(c.snapshot().segment,null);assert.equal(f.calls.filter(x=>x.method==='POST').length,0);}
});
test('legacy replacement rejects malformed context, active-byte drift, conflicting backup and lock contention without overwrite',async()=>{
 const Audience=require('../n8n/growth/segment-audience-contract.js');
 {const f=fixture({version:Audience.VERSION}),c=f.create(),migration=await legacyMigration(f,'malformed'),slot='shrigma_segment_editor_v1:fish';f.store.set(slot,migration.expectedRaw);await c.list();await assert.rejects(c.newDraft({preserveDraft:preservation(migration)}),{code:'SEGMENT_CATALOG_UNCONFIRMED'});assert.equal(f.store.get(slot),migration.expectedRaw);assert.equal(f.store.has(migration.backupSlot),false);}
 for(const kind of ['active','backup','lock']){const f=fixture({version:Audience.VERSION}),c=f.create(),migration=await legacyMigration(f),slot='shrigma_segment_editor_v1:fish';f.store.set(slot,migration.expectedRaw);await c.list();if(kind==='active')f.store.set(slot,migration.expectedRaw+' ');if(kind==='backup')f.store.set(migration.backupSlot,'other bytes');const before=f.store.get(slot),run=()=>c.newDraft({preserveDraft:preservation(migration)});if(kind==='lock')await f.locks.request(Client.SLOT+'fish',{mode:'exclusive',ifAvailable:true},async()=>assert.rejects(run(),{code:'SEGMENT_BUSY'}));else await assert.rejects(run(),{code:kind==='active'?'SEGMENT_SELECTION_CHANGED':'SEGMENT_STORAGE_UNAVAILABLE'});assert.equal(f.store.get(slot),before);assert.equal(f.store.get(migration.backupSlot)??null,kind==='backup'?'other bytes':null);assert.equal(f.calls.filter(x=>x.method==='POST').length,0);}
});
test('a pending operation or failed backup write cannot migrate the active editor',async()=>{
 const Audience=require('../n8n/growth/segment-audience-contract.js');
 {const f=fixture({version:Audience.VERSION}),c=f.create(),migration=await legacyMigration(f),slot='shrigma_segment_editor_v1:fish';f.store.set(slot,migration.expectedRaw);await c.list();f.control.lose=true;await assert.rejects(c.save(migration.draft));const before=f.store.get(slot);await assert.rejects(c.newDraft({preserveDraft:preservation(migration)}),{code:'SEGMENT_OPERATION_PENDING'});assert.equal(f.store.get(slot),before);assert.equal(f.store.has(migration.backupSlot),false);assert.equal(f.calls.filter(x=>x.method==='POST').length,1);}
 {const f=fixture({version:Audience.VERSION}),migration=await legacyMigration(f),slot='shrigma_segment_editor_v1:fish';f.store.set(slot,migration.expectedRaw);const storage={getItem:key=>f.storage.getItem(key),setItem(key,value){if(key===migration.backupSlot)throw Error('blocked');f.storage.setItem(key,value);}},c=f.create('fish',()=> 'synthetic-actor-one',{storage});await c.list();await assert.rejects(c.newDraft({preserveDraft:preservation(migration)}),{code:'SEGMENT_STORAGE_UNAVAILABLE'});assert.equal(f.store.get(slot),migration.expectedRaw);assert.equal(f.store.has(migration.backupSlot),false);assert.equal(f.calls.filter(x=>x.method==='POST').length,0);}
});
test('client composes with actual authenticated SQL bridge, including lost acknowledgement and OFF historical reads',async()=>{
 const {PGlite}=require('@electric-sql/pglite'),Fixture=require('./segment-api-fixture.cjs'),db=new PGlite();
 try{const bridge=await Fixture.setup(db),f=fixture();let lose=false,posts=0;
  const fetch=async(url,init)=>{const p=init.method==='GET'?Object.fromEntries(new URL(url).searchParams):JSON.parse(init.body);const response=await bridge.call(p,init.headers.Authorization.slice(7));if(init.method==='POST'&&p.acao!=='segmento_contar'){posts++;if(lose)throw Error('lost acknowledgement');}return {status:response.status,json:async()=>response.body};};
  for(const brand of ['fish','aristo']){const c=f.create(brand,()=> 'synthetic-manager-key',{fetch});await c.list();lose=true;await assert.rejects(c.save(Fixture.definition(brand)),{code:'SEGMENT_OPERATION_UNCONFIRMED'});lose=false;const saved=await c.consult();assert.equal(saved.segment.version,1);const counted=await c.count(saved.segment.definition,saved.segment);assert.equal(counted.eligible_count,1);assert.equal(counted.transport_supported,false);}
  assert.equal(posts,2);await db.exec('UPDATE shrigma_segment_config SET enabled=false');const c=f.create('fish',()=> 'synthetic-manager-key',{fetch}),listed=await c.list();assert.equal(listed.segments.length,1);assert.equal(listed.catalog.current,false);assert.equal(listed.capabilities.draft,false);assert.equal(listed.capabilities.count,false);await assert.rejects(async()=>c.save(Fixture.definition(),listed.segments[0]),{code:'SEGMENT_CATALOG_UNCONFIRMED'});assert.equal(posts,2);
 }finally{await db.close();}
});
