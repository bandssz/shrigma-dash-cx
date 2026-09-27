'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite'),N=require('../n8n/growth/journey-graph-native.cjs'),{install,sql,id}=require('./journey-graph-native-fixture.cjs');
async function setup(t){const db=new PGlite();t.after(()=>db.close());return install(db);}
test('Fish and Aristo clone exactly the immutable graph release; strict receipts resolve without source edits or transport',async t=>{
 const f=await setup(t),before=(await f.query('SELECT * FROM templates ORDER BY id')).rows;
 for(const brand of ['fish','aristo']){
  const {release,request,receipt}=await f.prepared(brand);assert.equal(receipt.state,'reserved');assert.deepEqual(Object.keys(receipt).sort(),N.RECEIPT_KEYS);assert.ok(!('send'in f.native));
  await f.query('UPDATE templates SET subject=$1 WHERE id=$2',['Editable original changed',release.source_template_id]);
  const ready=await f.native.create(brand,receipt.native_id);assert.equal(ready.state,'ready');assert.equal(ready.material_sha256,release.material_sha256);
  assert.deepEqual(await f.native.resolve(brand,release.id,release.material_sha256),ready);assert.deepEqual(await f.native.operation('panel:synthetic',request),ready);
  const clone=(await f.query('SELECT * FROM templates WHERE id=$1',[ready.clone_template_id])).rows[0];assert.equal(clone.body,release.material.native.body);assert.equal(clone.subject,release.material.native.subject);assert.equal(clone.is_default,false);assert.equal(f.cache.get(clone.id).body,clone.body);
  assert.deepEqual(await f.native.create(brand,receipt.native_id),ready);assert.equal((await f.native.reconcile(brand,receipt.native_id)).diagnosis,'ready');
 }
 assert.equal(f.calls.create,2);assert.equal(before.length,2);assert.equal((await f.query('SELECT count(*)::int n FROM shrigma_template_email_registry')).rows[0].n,2);
});
test('brand, cache, actor, request and release hashes are bound; malformed input makes zero native calls',async t=>{
 const f=await setup(t),{release,receipt,request}=await f.prepared();
 assert.deepEqual(await f.native.prepare('panel:synthetic',request),receipt);
 for(const p of [{...request,brand:'aristo'},{...request,expected_material_sha256:'0'.repeat(64)}])await assert.rejects(f.native.prepare('panel:synthetic',p),/REPLAY_MISMATCH/);
 await assert.rejects(f.native.prepare('panel:other',request),/REPLAY_MISMATCH/);
 await assert.rejects(f.native.prepare('panel:synthetic',{...f.requestFor(release),brand:'aristo'}),/RELEASE_MISMATCH/);
 for(const method of ['create','inspect','reconcile'])await assert.rejects(f.native[method]('aristo',receipt.native_id),/NOT_FOUND/);
 await assert.rejects(f.native.resolve('aristo',release.id,release.material_sha256),/NOT_READY/);
 await assert.rejects(f.newProvider({cacheTarget:'another-instance'}).create('fish',receipt.native_id),/NOT_FOUND/);
 for(const p of [{...request,body:'not allowed'},{...request,request_id:'not UUID'},{...request,brand:'olivas'}])await assert.rejects(f.native.prepare('panel:synthetic',p),/REQUEST_INVALID/);
 assert.equal(await f.native.operation('panel:synthetic',{...request,request_id:id(9999)}),null);assert.equal(f.calls.create,0);
});
test('reserved prefix is protected at INSERT; clone and registration immutable while original/default/B06 namespace remain independent',async t=>{
 const f=await setup(t),{receipt}=await f.prepared(),name=N.PREFIX+receipt.native_id;
 await assert.rejects(f.query("INSERT INTO templates(name,type,subject,body) VALUES($1,'tx','Other','Other')",[name]),/RESERVED_CONTENT_REQUIRED/);
 const ready=await f.native.create('fish',receipt.native_id),tid=ready.clone_template_id;
 for(const [col,v]of [['subject','Other'],['body','Other'],['body_source','Other'],['name','Ordinary'],['id',999],['type','campaign'],['is_default',true]])await assert.rejects(f.query('UPDATE templates SET '+col+'=$1 WHERE id=$2',[v,tid]),/IMMUTABLE/);
 await assert.rejects(f.query('DELETE FROM templates WHERE id=$1',[tid]),/IMMUTABLE/);await assert.rejects(f.query('UPDATE templates SET name=$1 WHERE id=60',[name]),/CREATE_REQUIRED/);
 await assert.rejects(f.query("INSERT INTO shrigma_template_email_registry VALUES($1,'fish')",[tid]),/NOT_EDITABLE_CATALOG/);
 await f.query("UPDATE templates SET subject='Original changed',is_default=true WHERE id=60");await f.query('UPDATE templates SET is_default=false,updated_at=clock_timestamp() WHERE id=$1',[tid]);
 await f.query("INSERT INTO templates(name,type,subject,body) VALUES('__shrigma_journey_tx_v1_synthetic','tx','Old namespace','Independent')");
 for(const q of ['DELETE FROM crm_graph_candidate.native_request_v1','UPDATE crm_graph_candidate.native_request_v1 SET actor=actor','UPDATE crm_graph_candidate.native_template_v1 SET brand=brand','DELETE FROM crm_graph_candidate.native_template_v1'])await assert.rejects(f.query(q),/IMMUTABLE/);
});
test('lost native response preserves one clone and no token replay; reconciliation is diagnostic even for exact GET',async t=>{
 const f=await setup(t),{receipt,release}=await f.prepared();
 const uncertain=f.newProvider({nativeCreate:async(...args)=>{await f.settings.nativeCreate(...args);throw Error('Synthetic lost response including private details');}});
 await assert.rejects(uncertain.create('fish',receipt.native_id),e=>e.code==='GRAPH_NATIVE_OUTCOME_UNKNOWN'&&!e.message.includes('private'));
 for(const provider of [uncertain,f.native,f.newProvider({})]){assert.equal((await provider.create('fish',receipt.native_id)).state,'creating');await assert.rejects(provider.confirm('fish',receipt.native_id),/ACK_REQUIRED/);}
 const diagnostic=await f.native.reconcile('fish',receipt.native_id);assert.equal(diagnostic.diagnosis,'native_exists_cache_unconfirmed');assert.equal(diagnostic.receipt.state,'creating');assert.equal(f.calls.create,1);
 await assert.rejects(f.native.resolve('fish',release.id,release.material_sha256),/NOT_READY/);
 const begin=(await f.query('SELECT crm_graph_candidate.native_begin_v1($1,$2,$3) result',['fish',receipt.native_id,f.settings.cacheTarget])).rows[0].result;assert.deepEqual(Object.keys(begin).sort(),['receipt','should_create']);assert.equal(begin.should_create,false);
});
test('exact native ACK followed by SQL response loss permits only same in-memory confirm; inspect reconciles committed ready',async t=>{
 const f=await setup(t),{receipt}=await f.prepared();let lose=true,confirms=0;
 const provider=f.newProvider({query:async(q,a)=>{const r=await f.query(q,a);if(q.includes('native_confirm_v1')){confirms++;if(lose){lose=false;throw Error('Synthetic receipt loss');}}return r;}});
 await assert.rejects(provider.create('fish',receipt.native_id),/OUTCOME_UNKNOWN/);const ready=await f.native.inspect('fish',receipt.native_id);assert.equal(ready.state,'ready');assert.deepEqual(await provider.confirm('fish',receipt.native_id),ready);
 assert.equal(f.calls.create,1);assert.equal(confirms,2);await assert.rejects(provider.confirm('fish',receipt.native_id),/ACK_REQUIRED/);
});
test('confirm rollback after exact ACK leaves creating and same in-memory token can confirm without repeating POST',async t=>{
 const f=await setup(t),{receipt}=await f.prepared();let lose=true;
 const provider=f.newProvider({query:async(q,a)=>{if(q.includes('native_confirm_v1')&&lose){lose=false;throw Error('Synthetic before commit');}return f.query(q,a);}});
 await assert.rejects(provider.create('fish',receipt.native_id),/OUTCOME_UNKNOWN/);assert.equal((await provider.inspect('fish',receipt.native_id)).state,'creating');assert.equal((await provider.confirm('fish',receipt.native_id)).state,'ready');assert.equal(f.calls.create,1);
});
test('native mismatch, empty response and timeout fail closed without confirm or retry; abort is passed to adapter',async t=>{
 const f=await setup(t);let aborted=false,sequence=0;
 for(const nativeCreate of [async()=>undefined,async()=>({status:200,body:{data:true}}),async(body,options)=>{const r=await f.settings.nativeCreate(body,options);r.body.data.body+='wrong';return r;},async(body,options)=>new Promise(()=>options.signal.addEventListener('abort',()=>{aborted=true;}))]){
  await f.query('UPDATE templates SET subject=$1 WHERE id=60',['Synthetic failure '+(++sequence)]);
  const {receipt:r}=await f.prepared('fish'),p=f.newProvider({nativeCreate,timeoutMs:15});
  await assert.rejects(p.create('fish',r.native_id),/OUTCOME_UNKNOWN/);assert.equal((await p.inspect('fish',r.native_id)).state,'creating');assert.equal((await p.create('fish',r.native_id)).state,'creating');
 }
 assert.equal(aborted,true);
});
test('ready resolution rechecks native bytes, registry and enabled guards instead of trusting stored ready flag',async t=>{
 const f=await setup(t),{receipt,release}=await f.prepared(),ready=await f.native.create('fish',receipt.native_id);
 await f.query('ALTER TABLE templates DISABLE TRIGGER graph_native_template_guard_v1');await assert.rejects(f.native.resolve('fish',release.id,release.material_sha256),/GUARD_UNAVAILABLE/);
 await f.query('UPDATE templates SET body=$1 WHERE id=$2',['Synthetic tamper',ready.clone_template_id]);await f.query('ALTER TABLE templates ENABLE TRIGGER graph_native_template_guard_v1');await assert.rejects(f.native.resolve('fish',release.id,release.material_sha256),/CLONE_MISMATCH/);
});
test('request receipt failure is atomic; install collisions preserve state; explicit PUBLIC revokes cover own functions only',async t=>{
 const f=await setup(t),release=await f.release();await f.db.exec("CREATE FUNCTION crm_graph_candidate.native_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic failure';END$$;CREATE TRIGGER synthetic_fail BEFORE INSERT ON crm_graph_candidate.native_request_v1 FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.native_test_fault();");
 await assert.rejects(f.native.prepare('panel:synthetic',f.requestFor(release)),/OUTCOME_UNKNOWN/);assert.equal((await f.query('SELECT count(*)::int n FROM crm_graph_candidate.native_template_v1')).rows[0].n,0);
 await f.query('DROP TRIGGER synthetic_fail ON crm_graph_candidate.native_request_v1');const p=await f.native.prepare('panel:synthetic',f.requestFor(release));
 await assert.rejects(f.db.exec(sql),/COLLISION/);await f.db.exec('ROLLBACK');assert.equal((await f.native.inspect('fish',p.native_id)).state,'reserved');
 const publicFns=(await f.query("SELECT p.proname FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.pronamespace='crm_graph_candidate'::regnamespace AND p.proname LIKE 'native_%' AND p.proname<>'native_test_fault' AND a.grantee=0 AND a.privilege_type='EXECUTE'")).rows;assert.deepEqual(publicFns,[]);
 assert.ok(!sql.includes('REVOKE ALL ON ALL'));assert.equal(N.ENABLED,false);
});
test('receipt parser rejects extra fields, identity mismatch, stale state shapes and native API is not reachable with forged operation',()=>{
 const r={contract:N.VERSION,native_id:id(1),brand:'fish',release_id:id(2),material_sha256:'a'.repeat(64),native_sha256:'b'.repeat(64),cache_target:'fixture',state:'reserved',clone_template_id:null,cache_ack_at:null};
 assert.deepEqual(N.validateReceipt(r),r);for(const edit of [x=>x.claim_token=id(3),x=>x.clone_template_id=5,x=>x.state='ready',x=>x.brand='olivas']){const x={...r};edit(x);assert.throws(()=>N.validateReceipt(x),/RECEIPT_INVALID/);}assert.throws(()=>N.validateReceipt(r,{release_id:id(99)}),/RECEIPT_INVALID/);
});
test('B06 and graph namespace guards coexist; each provider creates only its reserved clone',async t=>{
 const f=await setup(t),oldSql=fs.readFileSync(require.resolve('../n8n/growth/journey-template-release.sql'),'utf8');
 await f.db.exec("CREATE FUNCTION public.digest(bytea,text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$SELECT sha256($1)$$;");await f.db.exec(oldSql);
 const old=require('../n8n/growth/journey-template-provider.cjs').createTemplateReleaseProvider({query:f.query,nativeCreate:body=>f.settings.nativeCreate(body,{cacheTarget:f.settings.cacheTarget}),cacheTarget:f.settings.cacheTarget});
 const legacy=await old.prepare(60);const legacyReady=await old.create(legacy.id);assert.equal(legacyReady.state,'ready');
 const {receipt,release}=await f.prepared('aristo'),ready=await f.native.create('aristo',receipt.native_id);assert.equal(ready.state,'ready');assert.equal((await f.native.resolve('aristo',release.id,release.material_sha256)).clone_template_id,ready.clone_template_id);
 await assert.rejects(f.query('DELETE FROM templates WHERE id=$1',[legacyReady.release.clone_template_id]),/IMMUTABLE/);await assert.rejects(f.query('DELETE FROM templates WHERE id=$1',[ready.clone_template_id]),/IMMUTABLE/);
 assert.equal(f.calls.create,2);
});
test('lost begin receipt never calls native API or returns the persisted token on a later create',async t=>{
 const f=await setup(t),{receipt}=await f.prepared();let lost=true;
 const provider=f.newProvider({query:async(q,a)=>{const r=await f.query(q,a);if(q.includes('native_begin_v1')&&lost){lost=false;throw Error('Synthetic lost begin reply');}return r;}});
 await assert.rejects(provider.create('fish',receipt.native_id),/OUTCOME_UNKNOWN/);assert.equal((await f.native.create('fish',receipt.native_id)).state,'creating');assert.equal(f.calls.create,0);assert.equal((await f.native.reconcile('fish',receipt.native_id)).diagnosis,'native_missing');
});
