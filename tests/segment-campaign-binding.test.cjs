'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const F=require('./segment-campaign-binding-fixture.cjs'),B=require('../n8n/growth/segment-campaign-binding.cjs'),S=require('../n8n/growth/segment-audience-store.cjs'),A=require('./segment-audience-store-fixture.cjs'),H=require('../n8n/growth/segment-audience-review.cjs'),Shopify=require('../n8n/growth/segment-shopify-facts.cjs');
async function fixture(t){const db=new PGlite();t.after(()=>db.close());return F.setup(db);}
const count=async(f,table)=>(await f.db.query('SELECT count(*)::int AS n FROM crm_audience_v2.'+table)).rows[0].n;
test('wire is separate, exact and bounded, with no actor/capabilities/unlink/send command',()=>{
 const p={acao:B.ACTIONS.inspect,brand:'fish',campaign_id:100,audience_id:'00000000-0000-4000-8000-000000000001',audience_revision:1};assert.deepEqual(B.request(p),p);assert.equal(B.ENABLED,false);
 for(const x of [{...p,brand:'olivas'},{...p,campaign_id:'100'},{...p,audience_revision:0},{...p,actor:'panel:fake'},{...p,acao:'campanha_agendar'},{...p,acao:'campanha_publico_desvincular'},{...p,caps:['draft']}])assert.throws(()=>B.request(x),{code:'SEGMENT_BINDING_INPUT'});
});

test('both brands bind immutable audience revision/base/context to exact native campaign and durable CAS history',async t=>{
 const f=await fixture(t),contactBefore=(await f.db.query('SELECT * FROM subscriber_lists ORDER BY subscriber_id,list_id')).rows,listsBefore=(await f.db.query('SELECT * FROM campaign_lists ORDER BY id')).rows;
 for(const [brand,id]of [['fish',100],['aristo',200]]){
  const a=await f.createAudience(brand,'audience-'+brand),preview=await f.inspect(brand,id,a);assert.equal(preview.status,200);const intent=preview.body.intent;
  const oldXmin=(await f.db.query('SELECT xmin::text AS x FROM campaigns WHERE id=$1',[id])).rows[0].x;
  const result=await f.bind(intent,'bind-'+brand);assert.equal(result.status,201);const b=result.body.binding;
  assert.equal(b.audience_id,a.id);assert.equal(b.audience_revision,1);assert.equal(b.base_list_id,brand==='fish'?17:16);assert.equal(b.execution_blocked,true);assert.equal(b.authorizes_send,false);assert.equal(b.authorizes_selection,false);assert.equal(b.selector_ready,false);
  const stored=await f.bound(id);assert.equal(stored.binding_hash,H.digest(stored.binding));assert.deepEqual(stored.binding.definition,a.definition);assert.equal(stored.campaign_version,(await f.current(id)).version);
  assert.notEqual((await f.db.query('SELECT xmin::text AS x FROM campaigns WHERE id=$1',[id])).rows[0].x,oldXmin);
  const view=await f.bindingCall({acao:B.ACTIONS.read,brand,campaign_id:id});assert.equal(view.body.binding.campaign_current,true);assert.equal(view.body.binding.semantic_context.current,true);
  const changed={...a.definition,name:'New head '+brand},saved=await f.call({acao:'segmento_salvar',brand,id:a.id,expected_version:1,definition:changed,expected_catalog_hash:f.catalogHashes[brand],idempotency_key:'save-audience-'+brand});assert.equal(saved.status,200);
  assert.equal((await f.bound(id)).audience_revision,1);assert.deepEqual((await f.bound(id)).binding.definition,a.definition);
  const second=await f.inspect(brand,id,saved.body.segment);assert.equal(second.body.intent.expected_binding_version,1);assert.equal((await f.bind(second.body.intent,'bind-new-head-'+brand)).status,200);
  assert.equal((await f.bound(id)).audience_revision,2);assert.equal((await f.bound(id)).binding_version,2);
 }
 assert.equal(await count(f,'campaign_binding_revision'),4);assert.deepEqual((await f.db.query('SELECT * FROM subscriber_lists ORDER BY subscriber_id,list_id')).rows,contactBefore);assert.deepEqual((await f.db.query('SELECT * FROM campaign_lists ORDER BY id')).rows,listsBefore);
 await assert.rejects(f.db.query('UPDATE crm_audience_v2.campaign_binding_revision SET actor=actor'),/AUDIENCE_HISTORY_IMMUTABLE/);await assert.rejects(f.db.query('DELETE FROM crm_audience_v2.campaign_binding_request'),/AUDIENCE_HISTORY_IMMUTABLE/);await assert.rejects(f.db.query('DELETE FROM crm_audience_v2.campaign_binding WHERE campaign_id=100'),/SEGMENT_BINDING_UNLINK_UNAVAILABLE/);
 await assert.rejects(f.db.exec(A.read('n8n/growth/segment-campaign-binding.sql')),/SEGMENT_BINDING_INSTALL_COLLISION/);
});

test('binding barrier blocks real legacy schedule and direct native transitions even with legacy writer GUC; unbound/Olivas unchanged',async t=>{
 const f=await fixture(t),a=await f.createAudience(),p=(await f.inspect('fish',100,a)).body.intent;assert.equal((await f.bind(p)).status,201);
 await assert.rejects(f.legacySchedule(100),/SEGMENT_CAMPAIGN_SELECTOR_REQUIRED/);assert.equal((await f.current(100)).status,'draft');
 for(const sql of ["status='scheduled'","status='running'","sent=1","started_at=clock_timestamp()","attribs=jsonb_set(attribs,'{crm,brand}','\"olivas\"')","type='optin'","id=999"]){
  await assert.rejects(f.db.transaction(async tx=>{await tx.query("SELECT set_config('shrigma.campaign_writer','100',true)");await tx.query('UPDATE campaigns SET '+sql+' WHERE id=100');}),/SEGMENT_CAMPAIGN_SELECTOR_REQUIRED/);
 }
 await assert.rejects(f.db.query('DELETE FROM campaigns WHERE id=100'),/SEGMENT_CAMPAIGN_SELECTOR_REQUIRED/);
 const before=await f.bound(100);await f.db.transaction(async tx=>{await tx.query("SELECT set_config('shrigma.campaign_writer','100',true)");await tx.query("UPDATE campaigns SET subject='Edited safely',updated_at=clock_timestamp() WHERE id=100");});
 assert.equal((await f.bindingCall({acao:B.ACTIONS.read,brand:'fish',campaign_id:100})).body.binding.campaign_current,false);assert.deepEqual(await f.bound(100),before);
 assert.equal((await f.legacySchedule(300)).status,'scheduled');
 await f.db.query("UPDATE campaigns SET status='running',sent=7,started_at=clock_timestamp() WHERE id=400");const olivas=(await f.db.query('SELECT status,sent FROM campaigns WHERE id=400')).rows[0];assert.deepEqual(olivas,{status:'running',sent:7});assert.equal(await count(f,'campaign_binding'),1);
 // Future timing remains merely draft data; no trigger changes the schedule of
 // an unbound campaign or inspects any subscriber rows.
 assert.equal((await f.current(100)).status,'draft');assert.equal((await f.current(100)).sent,0);
});

test('campaign, binding, audience and catalog drift produce durable rejections; no brand crossover or implicit newer revision',async t=>{
 const f=await fixture(t),a=await f.createAudience(),preview=(await f.inspect('fish',100,a)).body.intent;
 assert.equal((await f.bind(preview,'first-binding')).status,201);const stale=await f.bind(preview,'stale-binding');assert.equal(stale.status,409);assert.equal(stale.body.error,'SEGMENT_BINDING_VERSION_CONFLICT');assert.deepEqual(await f.operation('fish','stale-binding'),stale);
 const refreshed=(await f.inspect('fish',100,a)).body.intent;await f.db.transaction(async tx=>{await tx.query("SELECT set_config('shrigma.campaign_writer','100',true)");await tx.query("UPDATE campaigns SET subject='another',updated_at=clock_timestamp() WHERE id=100");});
 assert.equal((await f.bind(refreshed,'stale-campaign')).status,409);
 const p=(await f.inspect('fish',100,a)).body.intent,changed=(await f.db.query("SELECT catalog FROM crm_audience_v2.config WHERE brand='fish'")).rows[0].catalog;changed.currency='USD';
 for(const field of changed.fields)if(Shopify.FIELDS.includes(field.key))field.source_hash=Shopify.sourceHash('fish',field.key,changed);
 await f.db.query("UPDATE crm_audience_v2.config SET catalog=$1::jsonb WHERE brand='fish'",[JSON.stringify(changed)]);assert.equal((await f.bind(p,'stale-catalog')).status,409);
 await f.refresh('fish');const foreign=await f.createAudience('aristo','other-brand');assert.equal((await f.inspect('fish',100,foreign)).status,404);assert.equal((await f.inspect('fish',200,a)).status,404);assert.equal((await f.inspect('fish',400,a)).status,404);
 const latest=(await f.inspect('fish',100,a)).body.intent;await f.call({acao:'segmento_arquivar',brand:'fish',id:a.id,expected_version:1,idempotency_key:'archive-bound-audience'});assert.equal((await f.bind(latest,'archived-audience')).body.error,'SEGMENT_BINDING_AUDIENCE_CHANGED');assert.equal(await count(f,'campaign_binding_revision'),1);
});

test('native timestamp triggers are captured in post-bind version without allowing any semantic campaign mutation',async t=>{
 const f=await fixture(t),a=await f.createAudience();
 await f.db.exec("CREATE FUNCTION fixture_campaign_timestamp() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.updated_at=clock_timestamp();RETURN NEW;END$$;CREATE TRIGGER fixture_campaign_timestamp BEFORE UPDATE ON campaigns FOR EACH ROW EXECUTE FUNCTION fixture_campaign_timestamp();");
 const p=(await f.inspect('fish',100,a)).body.intent,r=await f.bind(p,'timestamp-bind');assert.equal(r.status,201);assert.notEqual(r.body.binding.campaign_version,p.expected_campaign_version);assert.equal(r.body.binding.campaign_version,(await f.current(100)).version);
 const aristo=await f.createAudience('aristo','aristo-touch');await f.db.exec("CREATE OR REPLACE FUNCTION fixture_campaign_timestamp() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.subject='unexpected side effect';RETURN NEW;END$$;");
 const q=(await f.inspect('aristo',200,aristo)).body.intent,failed=await f.bind(q,'semantic-touch-rejected');assert.equal(failed.status,202);assert.equal(await f.bound(200),undefined);assert.notEqual((await f.current(200)).definition.subject,'unexpected side effect');
});

test('receipt scope, replay, lost ACK and rollback are atomic with binding barrier; no automatic retry',async t=>{
 const f=await fixture(t),a=await f.createAudience(),p=(await f.inspect('fish',100,a)).body.intent;let once=true;f.control.afterCommit=async()=>{if(once){once=false;throw Error('private transport error');}};
 const lost=await f.bind(p,'lost-binding-ack');assert.equal(lost.status,202);const writes=f.trace.filter(x=>x.text===B.SQL.insert).length;
 const receipt=await f.operation('fish','lost-binding-ack');assert.equal(receipt.status,201);assert.deepEqual(await f.bind(p,'lost-binding-ack','synshort'),receipt);assert.equal(f.trace.filter(x=>x.text===B.SQL.insert).length,writes);
 assert.equal((await f.operation('fish','lost-binding-ack','synthetic-other-key')).status,404);assert.equal((await f.operation('aristo','lost-binding-ack')).status,409);assert.equal((await f.bind({...p,expected_binding_version:1},'lost-binding-ack')).body.error,'SEGMENT_BINDING_OPERATION_MISMATCH');
 const b=await f.createAudience('aristo','rollback-audience'),q=(await f.inspect('aristo',200,b)).body.intent;f.control.afterQuery=async text=>{if(text===B.SQL.insert)throw Error('after private insert');};
 const rollback=await f.bind(q,'rollback-binding');assert.equal(rollback.status,202);f.control.afterQuery=null;assert.equal(await f.bound(200),undefined);assert.equal((await f.operation('aristo','rollback-binding')).body.error,'SEGMENT_BINDING_OPERATION_UNCONFIRMED');assert.equal(await count(f,'campaign_binding_revision'),1);
 assert.equal((await f.legacySchedule(200)).status,'scheduled');
});

test('fresh long/short auth, expiry after lock/receipt, catalog expiry and absent permission never authorize a binding',async t=>{
 const f=await fixture(t),a=await f.createAudience(),p=(await f.inspect('fish',100,a)).body.intent;
 for(const key of ['synthetic-reader-key','synthetic-writer-key','synthetic-cx-key','unknown-key'])assert.ok([401,403].includes((await f.bind(p,'access-'+key,key)).status));assert.equal(await count(f,'campaign_binding'),0);
 for(const stage of [B.SQL.lock,B.SQL.receipt]){
  await f.db.query("UPDATE crm_dash_chave SET expira_em=clock_timestamp()+interval '100 milliseconds' WHERE chave='manager'");let waited=false;f.control.afterQuery=async text=>{if(text===stage&&!waited){waited=true;await new Promise(resolve=>setTimeout(resolve,200));}};
  assert.equal((await f.bind(p,stage===B.SQL.lock?'expired-bind-lock':'expired-bind-receipt','synshort')).status,401);f.control.afterQuery=null;await f.db.query("UPDATE crm_dash_chave SET expira_em=NULL WHERE chave='manager'");assert.equal(await count(f,'campaign_binding'),0);assert.equal(await count(f,'campaign_binding_request'),0);
 }
 await f.db.query("UPDATE crm_audience_v2.config SET checked_at=clock_timestamp()-interval '1 second',expires_at=clock_timestamp()+interval '100 milliseconds' WHERE brand='fish'");let waited=false;f.control.afterQuery=async text=>{if(text===B.SQL.receipt&&!waited){waited=true;await new Promise(resolve=>setTimeout(resolve,200));}};
 assert.equal((await f.bind(p,'expired-bind-catalog')).status,202);f.control.afterQuery=null;assert.equal(await count(f,'campaign_binding'),0);assert.equal(await count(f,'campaign_binding_request'),0);
 await f.refresh('fish');assert.equal((await f.bind(p,'new-valid-binding')).status,201);await f.db.query("UPDATE shrigma_panel_permission_v1 SET caps='[]' WHERE principal_id='manager'");assert.equal((await f.operation('fish','new-valid-binding')).status,403);
});

test('SQL insert guard refuses non-draft/foreign campaigns even when bypassing the JS entrypoint',async t=>{
 const f=await fixture(t),a=await f.createAudience(),p=(await f.inspect('fish',100,a)).body.intent;assert.equal((await f.bind(p)).status,201);const b=await f.bound(100);
 await f.db.query("UPDATE campaigns SET status='running' WHERE id=400");
 const clone={...b.binding,campaign_id:400,campaign_version:'a'.repeat(32)},hash=H.digest(clone);
 const params=[400,'fish',1,clone.campaign_version,clone.audience_id,clone.audience_revision,clone.definition_hash,clone.context_hash,clone.base_list_id,clone.catalog_hash,JSON.stringify(clone),hash,'panel:manager'];
 await assert.rejects(f.db.query(B.SQL.insert,params),/SEGMENT_BINDING_CAMPAIGN/);assert.equal(await count(f,'campaign_binding'),1);
 await assert.rejects(f.db.query("UPDATE crm_audience_v2.campaign_binding SET binding_version=3 WHERE campaign_id=100"),/SEGMENT_BINDING_VERSION/);assert.equal((await f.bound(100)).binding_version,1);
});

test('OR audience requires native campaign scope equal to original base, never an implicit narrowing to one leaf',async t=>{
 const f=await fixture(t);await f.db.exec("INSERT INTO lists VALUES(102,'Only second leaf',ARRAY['fish'],'active','single');INSERT INTO subscribers VALUES(6,'enabled');INSERT INTO subscriber_lists VALUES(6,17,'confirmed'),(6,102,'confirmed');");
 const catalog=(await f.call({acao:'segmentos_listar',brand:'fish',limit:50,offset:0})).body.catalog;f.catalogHashes.fish=catalog.catalog_hash;
 const a=await f.createAudience('fish','or-base-audience',{op:'or',rules:[{op:'in_list',list_id:101},{op:'in_list',list_id:102}]}),good=(await f.inspect('fish',100,a)).body.intent;
 assert.equal((await f.inspect('fish',300,a)).body.error,'SEGMENT_BINDING_BASE_REQUIRED');
 const bad={...good,campaign_id:300,expected_campaign_version:(await f.current(300)).version},rejected=await f.bind(bad,'or-leaf-narrowing');assert.equal(rejected.status,409);assert.equal(rejected.body.error,'SEGMENT_BINDING_BASE_REQUIRED');assert.deepEqual(await f.operation('fish','or-leaf-narrowing'),rejected);
 const counted=await require('../n8n/growth/segment-audience-listmonk.cjs').countAudience({definition:a.definition,baseListId:17,catalog,query:f.db.query.bind(f.db)});
 assert.equal(counted.source_confirmed,true);assert.equal(counted.eligible_count,2);
 assert.equal((await f.db.query('SELECT public.shrigma_campaign_audience(300) AS a')).rows[0].a.eligible_count,1);
 // This is an explicit fixture operator edit via the existing campaign writer;
 // the binding service itself never writes campaign_lists.
 await f.db.transaction(async tx=>{await tx.query("SELECT set_config('shrigma.campaign_writer','300',true)");await tx.query("UPDATE campaign_lists SET list_id=17,list_name='Fish base' WHERE campaign_id=300");});
 const reviewed=await f.inspect('fish',300,a);assert.equal(reviewed.status,200);assert.equal((await f.bind(reviewed.body.intent,'or-base-confirmed')).status,201);
 assert.equal((await f.bound(300)).base_list_id,17);assert.equal((await f.db.query('SELECT list_id FROM campaign_lists WHERE campaign_id=300')).rows[0].list_id,17);
 await assert.rejects(f.legacySchedule(300),/SEGMENT_CAMPAIGN_SELECTOR_REQUIRED/);
});
