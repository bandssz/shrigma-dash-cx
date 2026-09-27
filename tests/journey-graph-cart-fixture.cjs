'use strict';
const fs=require('node:fs'),{fixture}=require('./journey-graph-material-fixture.cjs'),{id}=require('./journey-graph-source-fixture.cjs');
const N=require('../n8n/growth/journey-graph-native.cjs'),C=require('../n8n/growth/journey-graph-cart.cjs'),{createMessagePreflight,createMessageClaim}=require('../n8n/growth/journey-graph-message.cjs');
const read=name=>fs.readFileSync(require.resolve(name),'utf8');
async function install(t,db,pool){
 const x=await fixture(t,db,pool),q=x.query,cacheTarget='synthetic-instance';
 await x.db.exec(`CREATE SCHEMA crm_maintenance_candidate;CREATE TABLE crm_maintenance_candidate.control(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),version integer NOT NULL DEFAULT 1,enabled boolean NOT NULL DEFAULT false,mode text NOT NULL DEFAULT 'closed');INSERT INTO crm_maintenance_candidate.control VALUES(true,1,true,'open');
 ALTER TABLE subscribers ADD COLUMN updated_at timestamptz;
 ALTER TABLE templates ADD COLUMN is_default boolean NOT NULL DEFAULT false;ALTER TABLE templates ADD COLUMN updated_at timestamptz DEFAULT clock_timestamp();
 ALTER TABLE shrigma_flow_definition ADD COLUMN enabled boolean NOT NULL DEFAULT true;
 ALTER TABLE shrigma_email_dispatch ADD COLUMN payload_sha256 text,ADD COLUMN account_id text,ADD COLUMN region text,ADD COLUMN configuration_set text,ADD COLUMN recipient_key text,ADD COLUMN recipient_key_version text,ADD COLUMN reserved_at timestamptz DEFAULT clock_timestamp(),ADD COLUMN started_at timestamptz,ADD COLUMN accepted_at timestamptz,ADD COLUMN outcome_at timestamptz,ADD COLUMN claim_token uuid,ADD COLUMN error_code text,ADD COLUMN send_log_id bigint,ADD UNIQUE(brand,flow,piece,dedupe_key);
 CREATE SEQUENCE synthetic_cart_send_log;ALTER TABLE shrigma_send_log ALTER COLUMN id SET DEFAULT nextval('synthetic_cart_send_log');ALTER TABLE shrigma_send_log ADD COLUMN email text,ADD COLUMN kind text,ADD COLUMN template_id integer;
 CREATE TABLE shrigma_exposure_7d(subscriber_id integer PRIMARY KEY,marketing_7d integer);
 CREATE FUNCTION digest(data bytea,algorithm text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$SELECT sha256(data)$$;
 CREATE FUNCTION shrigma_email_recipient_key(email text) RETURNS TABLE(recipient_key text,key_version text) LANGUAGE sql IMMUTABLE AS $$SELECT md5(lower(email)),'fixture'$$;`);
 const helpers=read('./sql/journey-cart-fixture.sql');await x.db.exec(helpers.slice(helpers.indexOf('CREATE FUNCTION shrigma_flow_slot'),helpers.indexOf('CREATE FUNCTION shrigma_email_claim_cart')));
 await x.db.exec(read('./journey-graph-cart-legacy-fixture.sql'));
 await x.db.exec(read('../n8n/growth/journey-graph-native.sql'));
 const originalFinish=(await q("SELECT md5(pg_get_functiondef('shrigma_email_finish_cart(uuid,uuid,text,jsonb)'::regprocedure)) hash")).rows[0].hash;
 await x.db.exec(read('../n8n/growth/journey-graph-cart.sql'));
 let seq=15000;const bridge=C.createCartBridge({query:q,cacheTarget});
 return {...x,bridge,cacheTarget,originalFinish,async prepare(brand='fish',{ownership=true,cohort=true}={}){
  const f=await x.prepare(brand,true),e=await f.atMessage(),intent=await f.api.step(f.request({entry_id:e.entry_id,expected_version:e.version}));
  const options={query:q,cacheTarget,nativeRead:async()=>{throw Error('NO_HTTP');},nativeCreate:async b=>({status:200,body:{data:(await q('INSERT INTO templates(id,name,type,subject,body,body_source) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[seq++,b.name,b.type,b.subject,b.body,b.body_source])).rows[0]}})};
  const provider=N.createNativeProvider(options),reserved=await provider.prepare('panel:synthetic',{request_id:id(seq++),brand,release_id:f.release.id,expected_material_sha256:f.release.material_sha256}),preparedClone=await provider.create(brand,reserved.native_id);
  const settings={pool:x.pool,cacheTarget,readSource:f.settings.readSource,resolveNative:({query,...a})=>N.createNativeProvider({...options,query}).resolve(a.brand,a.release_id,a.material_sha256)};
  const request={brand,intent_id:intent.intent_id,expected_entry_version:intent.version};
  await q('UPDATE crm_graph_candidate.cart_control_v1 SET enabled=true,cache_target=$1 WHERE brand=$2',[cacheTarget,brand]);
  // Fixture-only historical clock: a real epoch cannot adopt carts predating activation.
  // This direct synthetic setup exercises the due 30-minute claim without sleeping.
  const entry=(await q('SELECT * FROM crm_graph_candidate.entry WHERE id=$1',[intent.entry_id])).rows[0];
  const epoch=cohort?(await q("INSERT INTO crm_graph_candidate.cart_epoch_v1(brand,journey_id,revision,release_id,material_sha256,native_id,cache_target,starts_at,actor) VALUES($1,$2,$3,$4,$5,$6,$7,$8::timestamptz-interval '1 minute','panel:synthetic') RETURNING id",[brand,entry.journey_id,entry.revision,f.release.id,f.release.material_sha256,preparedClone.native_id,cacheTarget,x.ref])).rows[0].id:null;
  if(ownership)await bridge.enroll(brand,entry.id);
  const preflight=createMessagePreflight(settings),claim=createMessageClaim(settings);
  return {...f,runtimeRequest:f.request,entry,intent,epoch,settings,request,preparedClone,preflight,claim,bridge,
   async proof(){return preflight.prepare({brand,intent_id:intent.intent_id});},
   async finish(grant,outcome='accepted'){return (await q('SELECT * FROM shrigma_email_finish_cart($1,$2,$3,$4)',[grant.dispatch_id,grant.claim_token,outcome,grant.context])).rows[0];},
   async legacy(){const p=await this.proof(),tid=brand==='fish'?60:95,b={brand,toque:'t05',piece:'carrinho-30min',chave:'cart_t05_at',subscriber_id:1,email:p.recipient.email,ref:p.ref,template_id:tid,tx:{...p.message,template_id:tid,content_type:'html'}};return {body:b,result:(await q('SELECT * FROM shrigma_email_claim_cart($1)',[b])).rows[0]};}
  };
 }};
}
module.exports={install,id};
