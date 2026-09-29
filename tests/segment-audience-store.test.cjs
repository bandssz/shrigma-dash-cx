'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const F=require('./segment-audience-store-fixture.cjs'),S=require('../n8n/growth/segment-audience-store.cjs'),API=require('../n8n/growth/segment-audience-api.cjs'),H=require('../n8n/growth/segment-audience-review.cjs');
const {countAudience}=require('../n8n/growth/segment-audience-listmonk.cjs');
const list=brand=>({acao:'segmentos_listar',brand,limit:50,offset:0}),get=(brand,id)=>({acao:'segmento_obter',brand,id});
async function fixture(t,options){const db=new PGlite();t.after(()=>db.close());return F.setup(db,options);}
const rows=async(f,table)=>(await f.db.query('SELECT * FROM crm_audience_v2.'+table)).rows;

test('both brands create, list, reopen, CAS save, archive and preserve immutable revisions/semantic pins',async t=>{
 const f=await fixture(t),contacts=(await f.db.query('SELECT * FROM subscriber_lists ORDER BY subscriber_id,list_id')).rows;
 for(const brand of ['fish','aristo']){
  const payload=f.create(brand,'create-'+brand),created=await f.call(payload);assert.equal(created.status,201);const first=created.body.segment;
  assert.equal(first.definition.schema_version,'crm-audience-v2');assert.equal(first.version,1);assert.equal(first.updated_by,'panel:manager');assert.equal(created.body.transport_supported,false);
  const l=await f.call(list(brand));assert.equal(l.status,200);assert.deepEqual(l.body.capabilities,{draft:true,count:false,send:false});assert.equal(l.body.catalog.coverage,'unconfirmed');assert.equal(l.body.segments.length,1);
  assert.deepEqual((await f.call(get(brand,first.id))).body.segment,first);
  const d=F.definition(brand,{op:'or',rules:[{op:'condition',field:'purchase.amount',operator:'gte',value:'10.5'},{op:'condition',field:'signup.origin',operator:'is',value:'popup'}]});
  const saved=await f.call({acao:'segmento_salvar',brand,expected_catalog_hash:f.catalogHashes[brand],id:first.id,expected_version:1,definition:d,idempotency_key:'save-'+brand});assert.equal(saved.status,200);assert.equal(saved.body.segment.version,2);
  const archived=await f.call({acao:'segmento_arquivar',brand,id:first.id,expected_version:2,idempotency_key:'archive-'+brand});assert.equal(archived.status,200);assert.equal(archived.body.segment.version,3);assert.equal(archived.body.segment.archived,true);
  const versions=(await f.db.query('SELECT * FROM crm_audience_v2.revision WHERE audience_id=$1 ORDER BY version',[first.id])).rows;
  assert.equal(versions.length,3);assert.deepEqual(versions[0].definition,first.definition);assert.deepEqual(versions[1].definition,versions[2].definition);assert.deepEqual(versions[1].context,versions[2].context);
  const purchase=versions[1].context.rules.find(x=>x.source==='shopify'),origin=versions[1].context.rules.find(x=>x.source==='crm');assert.equal(purchase.currency,'BRL');assert.equal(purchase.timezone,'America/Sao_Paulo');assert.match(origin.origin_provenance_hash,/^[a-f0-9]{64}$/);
  assert.equal(versions[1].definition_hash,H.digest(versions[1].definition));assert.equal(versions[1].context_hash,H.digest(versions[1].context));
  assert.equal((await f.call(get(brand==='fish'?'aristo':'fish',first.id))).status,404);
 }
 assert.deepEqual((await f.db.query('SELECT * FROM subscriber_lists ORDER BY subscriber_id,list_id')).rows,contacts);
 assert.equal((await f.db.query("SELECT to_regclass('public.shrigma_segment') AS v1")).rows[0].v1,null);
 await assert.rejects(f.db.query("UPDATE crm_audience_v2.revision SET archived=false"),/AUDIENCE_HISTORY_IMMUTABLE/);await assert.rejects(f.db.query('DELETE FROM crm_audience_v2.request'),/AUDIENCE_HISTORY_IMMUTABLE/);
 await assert.rejects(f.db.exec(F.read('n8n/growth/segment-audience-store.sql')),/AUDIENCE_STORE_INSTALL_COLLISION/);assert.equal((await rows(f,'audience')).length,2);
});

test('idempotent receipts bind principal, exact payload, and brand; replay never creates a second revision',async t=>{
 const f=await fixture(t),p=f.create(),first=await f.call(p);
 assert.deepEqual(await f.call(p),first);assert.deepEqual(await f.call(p,'synshort'),first);
 assert.deepEqual(await f.call({acao:'segmento_operacao',brand:'fish',idempotency_key:p.idempotency_key}),first);
 assert.equal((await f.call({...p,definition:{...p.definition,name:'different'}})).body.error,'SEGMENT_OPERATION_MISMATCH');
 assert.equal((await f.call({...f.create('aristo'),idempotency_key:p.idempotency_key})).body.error,'SEGMENT_OPERATION_MISMATCH');
 assert.equal((await f.call({acao:'segmento_operacao',brand:'aristo',idempotency_key:p.idempotency_key})).status,409);
 assert.equal((await f.call({acao:'segmento_operacao',brand:'fish',idempotency_key:p.idempotency_key},'synthetic-other-key')).body.error,'SEGMENT_OPERATION_UNCONFIRMED');
 assert.equal((await rows(f,'audience')).length,1);assert.equal((await rows(f,'revision')).length,1);assert.equal((await rows(f,'request')).length,1);
 assert.equal((await f.call(p,'synthetic-other-key')).status,201);assert.equal((await rows(f,'audience')).length,2);
});

test('conflicts, archived rows, disabled catalog and invalid definitions have durable rejection receipts',async t=>{
 const f=await fixture(t),first=(await f.call(f.create())).body.segment;
 const save={acao:'segmento_salvar',brand:'fish',expected_catalog_hash:f.catalogHashes.fish,id:first.id,expected_version:1,definition:{...first.definition,name:'new'},idempotency_key:'save-winner'};assert.equal((await f.call(save)).status,200);
 const loser={...save,idempotency_key:'save-conflict'},conflict=await f.call(loser);assert.equal(conflict.status,409);assert.deepEqual(conflict.body,{error:'SEGMENT_VERSION_CONFLICT',current_version:2});
 assert.deepEqual(await f.call({acao:'segmento_operacao',brand:'fish',idempotency_key:loser.idempotency_key}),conflict);
 await f.call({acao:'segmento_arquivar',brand:'fish',id:first.id,expected_version:2,idempotency_key:'archive-once'});
 const archived=await f.call({...save,expected_version:3,idempotency_key:'save-archived'});assert.equal(archived.body.error,'SEGMENT_ARCHIVED');
 const malformed=f.create('fish','bad-definition');malformed.definition.rule={op:'raw_sql',text:'DROP TABLE subscribers'};const invalid=await f.call(malformed);assert.equal(invalid.status,422);assert.equal(invalid.body.error,'SEGMENT_SHAPE');assert.deepEqual(await f.call({acao:'segmento_operacao',brand:'fish',idempotency_key:malformed.idempotency_key}),invalid);
 await f.db.query("UPDATE crm_audience_v2.config SET enabled=false WHERE brand='fish'");const unavailable=await f.call(f.create('fish','catalog-disabled'));assert.equal(unavailable.status,503);assert.equal(unavailable.body.error,'SEGMENT_UNAVAILABLE');
 const history=await f.call(list('fish'));assert.equal(history.status,200);assert.equal(history.body.segments.length,1);assert.equal(history.body.catalog.current,false);assert.deepEqual(history.body.capabilities,{draft:false,count:false,send:false});
 assert.equal((await rows(f,'audience')).length,1);assert.equal((await rows(f,'revision')).length,3);
});

test('authorization is server-side, current after locks, and replay never bypasses revoked permissions',async t=>{
 const f=await fixture(t);
 for(const key of ['synthetic-reader-key','synthetic-cx-key','not-real-key']){const result=await f.call(f.create('fish','denied-'+key),key);assert.ok([401,403].includes(result.status));}
 assert.equal((await f.call(list('fish'),'synthetic-writer-key')).status,403);assert.equal((await rows(f,'request')).length,0);
 const p=f.create('fish','auth-replay'),first=await f.call(p);assert.equal(first.status,201);
 await f.db.query("UPDATE shrigma_panel_permission_v1 SET caps='[]' WHERE principal_id='manager'");assert.equal((await f.call(p)).status,403);assert.equal((await f.call({acao:'segmento_operacao',brand:'fish',idempotency_key:p.idempotency_key})).status,403);
 await f.db.query("UPDATE shrigma_panel_permission_v1 SET caps='[\"draft\",\"read_content\"]' WHERE principal_id='manager'");
 let changed=false;f.control.afterQuery=async(text,_v,tx)=>{if(text===S.SQL.lock&&!changed){changed=true;await tx.query("UPDATE shrigma_panel_permission_v1 SET caps='[]' WHERE principal_id='manager'");}};
 assert.equal((await f.call(f.create('fish','revoked-after-lock'))).status,403);assert.equal((await rows(f,'audience')).length,1);assert.equal((await rows(f,'request')).length,1);
 // Synthetic same-transaction revocation rolls back too; this demonstrates the
 // reauthorization branch, not multi-connection lock scheduling in PostgreSQL.
 f.control.afterQuery=null;assert.deepEqual(await f.call(p),first);
});

test('server normalization cannot be bypassed through execute; SQL text is fixed and values are parameters',async t=>{
 const f=await fixture(t),p=f.create();p.definition.name="Audience '; DROP TABLE subscribers; --";
 const r=await f.store.execute({key:'synthetic-manager-key',request:p});assert.equal(r._http,201);assert.equal(r._body.segment.name,p.definition.name);
 const invalid=f.create('fish','direct-invalid');invalid.definition.rule={op:'condition',field:'purchase.count',operator:'gt',value:'0 OR TRUE'};
 assert.equal((await f.store.execute({key:'synthetic-manager-key',request:invalid}))._body.error,'SEGMENT_SHAPE');
 assert.equal((await f.store.execute({key:'synthetic-manager-key',request:{...f.create('fish','actor-injection'),actor:'panel:other'}}))._body.error,'SEGMENT_FIELDS');
 assert.ok(f.trace.every(x=>!x.text.includes('DROP TABLE')));assert.equal((await f.db.query('SELECT count(*)::int AS n FROM subscribers')).rows[0].n,5);
});

test('catalog scopes, base/brand and semantic pins are trusted and fresh; changed semantics require a new saved revision',async t=>{
 const f=await fixture(t,{countProvider:countAudience}),p=f.create('fish','context-first'),s=(await f.call(p)).body.segment;
 const wrong=f.create('fish','wrong-list',{op:'in_list',list_id:201});assert.equal((await f.call(wrong)).body.error,'SEGMENT_LIST_UNAVAILABLE');
 await f.db.query("UPDATE crm_audience_v2.config SET catalog=jsonb_set(catalog,'{currency}','\"USD\"'),revision=revision+1 WHERE brand='fish'");
 const count=await f.call({acao:'segmento_contar',brand:'fish',expected_catalog_hash:f.catalogHashes.fish,id:s.id,expected_version:s.version});assert.equal(count.status,409);assert.equal(count.body.error,'SEGMENT_CATALOG_CHANGED');
 assert.equal((await f.call(get('fish',s.id))).body.segment.definition.name,s.name);assert.equal((await f.call({...p,idempotency_key:'context-second',expected_catalog_hash:(await f.call(list('fish'))).body.catalog.catalog_hash})).status,201);
 await f.db.query("UPDATE crm_audience_v2.config SET checked_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '6 minutes' WHERE brand='fish'");
 assert.equal((await f.call(list('fish'))).body.catalog.current,false);assert.equal((await f.call(f.create('fish','stale-catalog'))).status,503);
 await f.refresh('fish');await f.db.query("UPDATE crm_audience_v2.config SET base_list_id=16 WHERE brand='fish'");assert.equal((await f.call(list('fish'))).body.catalog.current,false);
});

test('optional count provider: native list E/OU/consent counts both brands, external conditions remain null, no transport',async t=>{
 const f=await fixture(t,{countProvider:countAudience});
 for(const brand of ['fish','aristo']){
  const definition=F.definition(brand,{op:'in_list',list_id:brand==='fish'?101:201}),r=await f.call({acao:'segmento_contar',brand,expected_catalog_hash:f.catalogHashes[brand],definition});
  assert.equal(r.status,200);assert.equal(r.body.source_confirmed,true);assert.equal(r.body.eligible_count,1);assert.equal(r.body.transport_supported,false);assert.equal(r.body.unknown_reason,null);assert.equal(r.body.segment_id,null);
  assert.equal((await f.call(list(brand))).body.capabilities.count,true);
  const external=await f.call({acao:'segmento_contar',brand,expected_catalog_hash:f.catalogHashes[brand],definition:F.definition(brand)});assert.equal(external.status,200);assert.equal(external.body.source_confirmed,false);assert.equal(external.body.eligible_count,null);assert.equal(external.body.unknown_reason,'external_source_unavailable');
 }
 assert.equal((await rows(f,'request')).length,0);assert.equal((await rows(f,'audience')).length,0);
 const absent=await fixture(t);assert.equal((await absent.call({acao:'segmento_contar',brand:'fish',expected_catalog_hash:absent.catalogHashes.fish,definition:F.definition()})).status,503);assert.equal((await absent.call(list('fish'))).body.capabilities.count,false);
});

test('failure after inserting audience rolls back audience, revision and receipt and leaves connection healthy',async t=>{
 const f=await fixture(t);let injected=false;f.control.afterQuery=async(text)=>{if(text===S.SQL.create&&!injected){injected=true;throw Error('synthetic secret error');}};
 const p=f.create('fish','rollback-operation'),result=await f.call(p);assert.equal(result.status,202);assert.equal(result.body.state,'unconfirmed');assert.doesNotMatch(JSON.stringify(result),/secret/);
 f.control.afterQuery=null;assert.equal((await rows(f,'audience')).length,0);assert.equal((await rows(f,'revision')).length,0);assert.equal((await rows(f,'request')).length,0);
 assert.equal((await f.call({acao:'segmento_operacao',brand:'fish',idempotency_key:p.idempotency_key})).body.error,'SEGMENT_OPERATION_UNCONFIRMED');
 assert.equal((await f.call(f.create('fish','separate-new-operation'))).status,201);
});

test('lost acknowledgement recovers exact durable receipt without resending the mutation',async t=>{
 const f=await fixture(t);let once=true;f.control.afterCommit=async()=>{if(once){once=false;throw Error('connection lost after commit');}};
 const p=f.create('fish','lost-ack-operation'),uncertain=await f.call(p);assert.equal(uncertain.status,202);const writeCount=f.trace.filter(x=>x.text===S.SQL.create).length;
 const receipt=await f.call({acao:'segmento_operacao',brand:'fish',idempotency_key:p.idempotency_key});assert.equal(receipt.status,201);assert.equal((await rows(f,'audience')).length,1);assert.equal(f.trace.filter(x=>x.text===S.SQL.create).length,writeCount);
 assert.deepEqual((await f.call(get('fish',receipt.body.segment.id))).body.segment,receipt.body.segment);
});

test('real on-disk PGlite reopen preserves both brands and actor-scoped receipts',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'crm-audience-v2-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));let db=new PGlite(dir);
 try{
  const f=await F.setup(db),saved=[];for(const brand of ['fish','aristo'])saved.push([brand,await f.call(f.create(brand,'durable-'+brand))]);await db.close();db=new PGlite(dir);await db.exec("SET statement_timeout='20s'");
  const store=S.createAudienceStore({transaction:work=>db.transaction(tx=>work({query:(q,v)=>tx.query(q,v)}))}),api=API.createAudienceAPI({store});
  for(const [brand,receipt]of saved){const r=await api.handle({method:'GET',request:{headers:{authorization:'Bearer synthetic-manager-key'},query:{acao:'segmento_operacao',brand,idempotency_key:'durable-'+brand}}});assert.deepEqual(r,receipt);const current=await store.execute({key:'synthetic-manager-key',request:get(brand,r.body.segment.id)});assert.equal(current._body.segment.id,receipt.body.segment.id);}
 }finally{await db.close();}
});

test('zero/excessive statement timeout is refused before mutation; deadline abort is uncertain and never retried',async t=>{
 const f=await fixture(t,{timeoutMs:30});for(const value of ['0','30001ms']){await f.db.query("SELECT set_config('statement_timeout',$1,false)",[value]);const r=await f.call(f.create('fish','timeout-'+value));assert.equal(r.status,503);assert.equal(r.body.error,'SEGMENT_SESSION_BOUNDARY');}assert.equal((await rows(f,'audience')).length,0);
 await f.db.exec("SET statement_timeout='20s'");let release,signal;f.control.beforeQuery=async(text,_v,_tx,options)=>{if(text===S.SQL.create){signal=options.signal;await new Promise(resolve=>{release=resolve;});}};
 const r=await f.call(f.create('fish','deadline-operation'));assert.equal(r.status,202);assert.equal(signal.aborted,true);assert.equal(f.trace.filter(x=>x.text===S.SQL.create).length,1);release();await new Promise(resolve=>setTimeout(resolve,20));f.control.beforeQuery=null;
 assert.equal((await rows(f,'audience')).length,0);assert.equal((await rows(f,'request')).length,0);
});

test('intent pins the displayed catalog; refresh-only dates preserve hash; reopen cannot silently change saved units',async t=>{
 const f=await fixture(t,{countProvider:countAudience}),p=f.create('fish','semantic-original'),saved=(await f.call(p)).body.segment,oldHash=f.catalogHashes.fish;
 assert.deepEqual(saved.semantic_context,{currency:'BRL',timezone:'America/Sao_Paulo',current:true});
 await f.refresh('fish');assert.equal((await f.call(list('fish'))).body.catalog.catalog_hash,oldHash);
 await f.db.query("UPDATE crm_audience_v2.config SET catalog=jsonb_set(catalog,'{currency}','\"USD\"'),revision=revision+1 WHERE brand='fish'");
 const displayed=(await f.call(list('fish'))).body.catalog,changed=await f.call({...p,idempotency_key:'semantic-create-drift'});
 assert.notEqual(displayed.catalog_hash,oldHash);assert.equal(changed.status,409);assert.equal(changed.body.error,'SEGMENT_CATALOG_CHANGED');
 assert.deepEqual(await f.call({acao:'segmento_operacao',brand:'fish',idempotency_key:'semantic-create-drift'}),changed);
 const reopened=(await f.call(get('fish',saved.id))).body.segment;assert.deepEqual(reopened.semantic_context,{currency:'BRL',timezone:'America/Sao_Paulo',current:false});
 for(const action of ['segmento_salvar','segmento_contar']){
  const q={acao:action,brand:'fish',id:saved.id,expected_version:1,expected_catalog_hash:displayed.catalog_hash,...(action==='segmento_salvar'?{definition:saved.definition,idempotency_key:'semantic-save-new-catalog'}:{})};
  const rejected=await f.call(q);assert.equal(rejected.status,409);assert.equal(rejected.body.error,'SEGMENT_CATALOG_CHANGED');
 }
 assert.equal((await rows(f,'revision')).length,1);assert.equal((await f.call({acao:'segmento_arquivar',brand:'fish',id:saved.id,expected_version:1,idempotency_key:'semantic-archive-old'})).status,200);
});

test('catalog expiry after waits rejects before write, and expiry after write rolls back audience plus receipt',async t=>{
 const f=await fixture(t,{timeoutMs:2000});
 const expireSoon=()=>f.db.query("UPDATE crm_audience_v2.config SET checked_at=clock_timestamp()-interval '1 second',expires_at=clock_timestamp()+interval '100 milliseconds' WHERE brand='fish'");
 await expireSoon();let delayed=false;f.control.afterQuery=async text=>{if(text===S.SQL.config&&!delayed){delayed=true;await new Promise(resolve=>setTimeout(resolve,200));}};
 const before=await f.call(f.create('fish','expire-before-write'));assert.equal(before.status,503);assert.equal(before.body.error,'SEGMENT_UNAVAILABLE');assert.equal((await rows(f,'audience')).length,0);assert.equal((await rows(f,'request')).length,1);
 f.control.afterQuery=null;await expireSoon();delayed=false;f.control.afterQuery=async text=>{if(text===S.SQL.create&&!delayed){delayed=true;await new Promise(resolve=>setTimeout(resolve,200));}};
 const after=await f.call(f.create('fish','expire-after-write'));assert.equal(after.status,202);assert.equal((await rows(f,'audience')).length,0);assert.equal((await rows(f,'revision')).length,0);assert.equal((await rows(f,'request')).length,1);
 f.control.afterQuery=null;assert.equal((await f.call({acao:'segmento_operacao',brand:'fish',idempotency_key:'expire-after-write'})).body.error,'SEGMENT_OPERATION_UNCONFIRMED');
 const counted=await fixture(t,{countProvider:async args=>{const result=await countAudience(args);await new Promise(resolve=>setTimeout(resolve,200));return result;},timeoutMs:2000});
 await counted.db.query("UPDATE crm_audience_v2.config SET checked_at=clock_timestamp()-interval '1 second',expires_at=clock_timestamp()+interval '100 milliseconds' WHERE brand='fish'");
 const result=await counted.call({acao:'segmento_contar',brand:'fish',definition:F.definition('fish',{op:'in_list',list_id:101}),expected_catalog_hash:counted.catalogHashes.fish});assert.equal(result.status,503);assert.equal(result.body.error,'SEGMENT_SERVICE_UNAVAILABLE');
});

test('key expiry uses wall clock after lock and before commit for long/short credentials, not frozen now()',async t=>{
 const f=await fixture(t,{timeoutMs:2000});
 for(const [stage,key]of [[S.SQL.lock,'synthetic-manager-key'],[S.SQL.revision,'synshort']]){
  await f.db.query("UPDATE crm_dash_chave SET expira_em=clock_timestamp()+interval '100 milliseconds' WHERE chave='manager'");let delayed=false,helperStillAccepts=false;
  f.control.afterQuery=async(text,_v,tx)=>{if(text===stage&&!delayed){delayed=true;await new Promise(resolve=>setTimeout(resolve,200));helperStillAccepts=!!(await tx.query("SELECT public.shrigma_panel_operator_v1($1,'growth') AS op",[key])).rows[0].op;}};
  const r=await f.call(f.create('fish',stage===S.SQL.lock?'expired-after-lock':'expired-before-commit'),key);assert.equal(helperStillAccepts,true);assert.equal(r.status,401);assert.equal(r.body.error,'SEGMENT_UNAUTHORIZED');
  assert.equal((await rows(f,'audience')).length,0);assert.equal((await rows(f,'revision')).length,0);assert.equal((await rows(f,'request')).length,0);
  f.control.afterQuery=null;await f.db.query("UPDATE crm_dash_chave SET expira_em=NULL WHERE chave='manager'");
 }
 const receipt=await f.call(f.create('fish','identity-match'));assert.equal(receipt.status,201);
 await f.db.query("UPDATE crm_dash_chave SET chave_hash=(SELECT chave_hash FROM crm_dash_chave WHERE chave='manager') WHERE chave='other'");
 assert.equal((await f.call(f.create('fish','ambiguous-key'))).status,401);assert.equal((await rows(f,'audience')).length,1);
});
