/* PostgreSQL 17 isolated proof. Synthetic only; no HTTP, campaign or transport. */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {Pool}=require('pg');
const root=path.join(__dirname,'..');
const migration=fs.readFileSync(path.join(root,'n8n/growth/journey-graph-cache-identity.sql'),'utf8');
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sha=c=>c.repeat(64);

const bootstrap=String.raw`
CREATE EXTENSION pgcrypto;
CREATE SCHEMA crm_graph_candidate;
CREATE ROLE crm_audience_api NOLOGIN NOINHERIT;
CREATE ROLE crm_graph_worker NOLOGIN NOINHERIT;
CREATE TABLE public.templates(id integer PRIMARY KEY,type text NOT NULL,subject text NOT NULL,body text NOT NULL,body_source text);
CREATE TABLE public.shrigma_email_dispatch(dispatch_id uuid PRIMARY KEY,brand text NOT NULL,flow text NOT NULL,piece text NOT NULL,transport_state text NOT NULL,claim_token uuid);
CREATE TABLE crm_graph_candidate.native_template_v1(id uuid PRIMARY KEY,cache_target text NOT NULL,state text NOT NULL,clone_template_id integer,native_sha256 text NOT NULL,snapshot jsonb NOT NULL);
CREATE TABLE crm_graph_candidate.cart_epoch_v1(id uuid PRIMARY KEY,brand text NOT NULL,native_id uuid NOT NULL,starts_at timestamptz NOT NULL DEFAULT clock_timestamp(),ends_at timestamptz);
CREATE TABLE crm_graph_candidate.cart_owner_v1(source_ref uuid PRIMARY KEY,epoch_id uuid NOT NULL,brand text NOT NULL,subscriber_id integer NOT NULL);
CREATE TABLE crm_graph_candidate.cart_delivery_v1(intent_id uuid PRIMARY KEY,entry_id uuid NOT NULL UNIQUE,brand text NOT NULL,revision integer NOT NULL,node_id text NOT NULL,attempt_key text NOT NULL UNIQUE,source_ref uuid NOT NULL UNIQUE,dispatch_id uuid NOT NULL UNIQUE,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE FUNCTION crm_graph_candidate.native_clone_check_v1(n crm_graph_candidate.native_template_v1,clone integer) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$SELECT n.clone_template_id=clone$$;
CREATE FUNCTION crm_graph_candidate.cart_immutable_v1() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $f$
BEGIN
 IF TG_TABLE_NAME='cart_epoch_v1' AND TG_OP='UPDATE' AND OLD.ends_at IS NULL AND NEW.ends_at IS NOT NULL AND NEW.ends_at>=OLD.starts_at
 AND to_jsonb(NEW)-'ends_at'=to_jsonb(OLD)-'ends_at' THEN RETURN NEW;END IF;
 RAISE EXCEPTION 'GRAPH_CART_IMMUTABLE';
END $f$;
CREATE TRIGGER graph_cart_epoch_immutable BEFORE UPDATE OR DELETE ON crm_graph_candidate.cart_epoch_v1 FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.cart_immutable_v1();
CREATE TRIGGER graph_cart_owner_immutable BEFORE UPDATE OR DELETE ON crm_graph_candidate.cart_owner_v1 FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.cart_immutable_v1();
CREATE TRIGGER graph_cart_delivery_immutable BEFORE UPDATE OR DELETE ON crm_graph_candidate.cart_delivery_v1 FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.cart_immutable_v1();
`;

(async()=>{
 const u=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid');
 assert.equal(process.env.GRAPH_CACHE_TEST_DATABASE_ISOLATED,'1');
 assert.ok(['localhost','127.0.0.1'].includes(u.hostname));
 assert.equal(u.pathname,'/postgres');
 assert.equal(u.username,'postgres');
 assert.equal(u.password,'');
 const pool=new Pool({connectionString:u.toString(),max:3,statement_timeout:10000,connectionTimeoutMillis:3000,application_name:'graph-cache-identity-synthetic-proof'});
 const q=(sql,args)=>pool.query(sql,args);
 try{
  await q(bootstrap);
  assert.equal((await q("SELECT md5(pg_get_functiondef('crm_graph_candidate.cart_immutable_v1()'::regprocedure)) h")).rows[0].h,'a03dc95d1acff46c78638c3f96f585bc');
  await q(migration);
  const acl=(await q("SELECT has_function_privilege('crm_graph_worker','crm_graph_candidate.cache_identity_issue_v1(text,uuid,uuid,text)','EXECUTE') worker_issue,has_function_privilege('crm_graph_worker','crm_graph_candidate.cache_identity_consume_v1(jsonb)','EXECUTE') worker_consume,has_function_privilege('crm_audience_api','crm_graph_candidate.cache_identity_readiness_v1(text)','EXECUTE') api_readiness")).rows[0];
  assert.deepEqual(acl,{worker_issue:true,worker_consume:false,api_readiness:true});
  const snapshot={type:'tx',subject:'Synthetic',body:'{{ define "content" }}one{{ end }}',body_source:'source'};
  await q('INSERT INTO public.templates VALUES(71,$1,$2,$3,$4)',[snapshot.type,snapshot.subject,snapshot.body,snapshot.body_source]);
  await q('INSERT INTO crm_graph_candidate.native_template_v1 VALUES($1,$2,$3,71,$4,$5)',[uuid(1),'listmonk-primary','ready',sha('d'),snapshot]);
  await q("INSERT INTO crm_graph_candidate.cache_identity_deployment_v1(cache_target,enabled,executable_sha256,runtime_sha256,expected_role,heartbeat_seconds,lease_seconds,action_key) VALUES('listmonk-primary',true,$1,$2,'postgres',5,15,$3)",[sha('e'),sha('f'),uuid(2)]);

  const heartbeatRaw=async(raw,instance=uuid(3),token=uuid(4))=>{
   return (await q('SELECT crm_graph_candidate.cache_identity_heartbeat_v1($1,$2,$3,$4,$5,$6::jsonb) r',['listmonk-primary',instance,token,sha('e'),sha('f'),JSON.stringify(raw)])).rows[0].r;
  };
  const heartbeat=async(instance=uuid(3),token=uuid(4),body=snapshot)=>heartbeatRaw([{template_id:71,...body}],instance,token);
  const first=await heartbeat();
  assert.equal(first.ready,true);assert.equal(first.template_count,1);assert.equal(first.snapshots.length,1);
  assert.equal((await q("SELECT crm_graph_candidate.cache_identity_readiness_v1('listmonk-primary') r")).rows[0].r.ready,true);

  const addAction=async n=>{
   const epoch=uuid(100+n),source=uuid(200+n),intent=uuid(300+n),entry=uuid(400+n),dispatch=uuid(500+n),claim=uuid(600+n);
   await q('INSERT INTO crm_graph_candidate.cart_epoch_v1(id,brand,native_id) VALUES($1,$2,$3)',[epoch,'fish',uuid(1)]);
   await q('INSERT INTO crm_graph_candidate.cart_owner_v1 VALUES($1,$2,$3,$4)',[source,epoch,'fish',7]);
   await q("INSERT INTO public.shrigma_email_dispatch VALUES($1,'fish','carrinho','carrinho-30min','in_flight',$2)",[dispatch,claim]);
   await q("INSERT INTO crm_graph_candidate.cart_delivery_v1(intent_id,entry_id,brand,revision,node_id,attempt_key,source_ref,dispatch_id) VALUES($1,$2,'fish',1,'message',$3,$4,$5)",[intent,entry,`attempt-${n}`,source,dispatch]);
   const guard=(await q("SELECT crm_graph_candidate.cache_identity_issue_v1('fish',$1,$2,'listmonk-primary') r",[intent,dispatch])).rows[0].r;
   return {guard,dispatch,source};
  };

  const one=await addAction(1);
  for(const key of ['contract','cache_target','instance_id','template_id','subscriber_id','native_sha256','snapshot_sha256','dispatch_id','token','expires_at']){
   const malformed=structuredClone(one.guard);malformed[key]=null;
   assert.equal((await q('SELECT crm_graph_candidate.cache_identity_consume_v1($1) ok',[malformed])).rows[0].ok,false,`NULL ${key} must fail closed`);
  }
  for(const [key,value] of [['cache_target','bad target'],['instance_id','not-a-uuid'],['template_id','71'],['subscriber_id','7'],
   ['native_sha256',sha('D')],['snapshot_sha256','short'],['dispatch_id','not-a-uuid'],['token',sha('A')],['expires_at','2026-09-30T00:00:00Z']]){
   const malformed=structuredClone(one.guard);malformed[key]=value;
   assert.equal((await q('SELECT crm_graph_candidate.cache_identity_consume_v1($1) ok',[malformed])).rows[0].ok,false,`invalid ${key} type/format must fail closed`);
  }
  const missingToken=structuredClone(one.guard);delete missingToken.token;
  assert.equal((await q('SELECT crm_graph_candidate.cache_identity_consume_v1($1) ok',[missingToken])).rows[0].ok,false,'missing token must fail closed');
  const missingDelivery={...one.guard,dispatch_id:uuid(999)};
  assert.equal((await q('SELECT crm_graph_candidate.cache_identity_consume_v1($1) ok',[missingDelivery])).rows[0].ok,false,'missing cart delivery/dispatch must fail closed');
  assert.equal((await q('SELECT cache_action_consumed_at IS NULL untouched FROM crm_graph_candidate.cart_delivery_v1 WHERE dispatch_id=$1',[one.dispatch])).rows[0].untouched,true);
  assert.equal((await q('SELECT crm_graph_candidate.cache_identity_consume_v1($1) ok',[one.guard])).rows[0].ok,true);
  assert.equal((await q('SELECT crm_graph_candidate.cache_identity_consume_v1($1) ok',[one.guard])).rows[0].ok,false,'consumed action must not replay');

  await heartbeat();
  const absentDispatch=await addAction(5);
  await q('DELETE FROM public.shrigma_email_dispatch WHERE dispatch_id=$1',[absentDispatch.dispatch]);
  assert.equal((await q('SELECT crm_graph_candidate.cache_identity_consume_v1($1) ok',[absentDispatch.guard])).rows[0].ok,false,'existing cart action without dispatch must fail closed');
  const dispatchWithoutCart=uuid(998);
  await q("INSERT INTO public.shrigma_email_dispatch VALUES($1,'fish','carrinho','carrinho-30min','in_flight',$2)",[dispatchWithoutCart,uuid(997)]);
  assert.equal((await q('SELECT crm_graph_candidate.cache_identity_consume_v1($1) ok',[{...one.guard,dispatch_id:dispatchWithoutCart}])).rows[0].ok,false,'existing dispatch without cart action must fail closed');

  await heartbeat();
  const two=await addAction(2);
  await q("UPDATE public.templates SET body='{{ define \"content\" }}changed{{ end }}' WHERE id=71");
  assert.equal((await q('SELECT crm_graph_candidate.cache_identity_consume_v1($1) ok',[two.guard])).rows[0].ok,false,'DB/cache mismatch must reject before transport');
  await q('UPDATE public.templates SET body=$1 WHERE id=71',[snapshot.body]);
  await heartbeat();
  const three=await addAction(3);
  await q("UPDATE crm_graph_candidate.cache_identity_lease_v1 SET expires_at=clock_timestamp()+interval '1 second';UPDATE crm_graph_candidate.cache_identity_snapshot_v1 SET expires_at=clock_timestamp()+interval '1 second'");
  assert.equal((await q('SELECT crm_graph_candidate.cache_identity_consume_v1($1) ok',[three.guard])).rows[0].ok,false,'near-expired action must reject');

  await heartbeat();
  await q("UPDATE crm_graph_candidate.cache_identity_lease_v1 SET expires_at=clock_timestamp()+interval '4 seconds';UPDATE crm_graph_candidate.cache_identity_snapshot_v1 SET expires_at=clock_timestamp()+interval '4 seconds'");
  const four=await addAction(4);
  const deliveryLocker=await pool.connect(),ownerLocker=await pool.connect();
  try{
   await deliveryLocker.query('BEGIN');await ownerLocker.query('BEGIN');
   await deliveryLocker.query('SELECT 1 FROM crm_graph_candidate.cart_delivery_v1 WHERE dispatch_id=$1 FOR UPDATE',[four.dispatch]);
   await ownerLocker.query('SELECT 1 FROM crm_graph_candidate.cart_owner_v1 WHERE source_ref=$1 FOR UPDATE',[four.source]);
   const blocked=q('SELECT crm_graph_candidate.cache_identity_consume_v1($1) ok',[four.guard]);
   await new Promise(resolve=>setTimeout(resolve,2200));
   await deliveryLocker.query('COMMIT');
   await new Promise(resolve=>setTimeout(resolve,2200));
   await ownerLocker.query('COMMIT');
   assert.equal((await blocked).rows[0].ok,false,'expiry while waiting on a row lock must reject after the lock');
  }finally{
   try{await deliveryLocker.query('ROLLBACK');}catch{}try{await ownerLocker.query('ROLLBACK');}catch{}
   deliveryLocker.release();ownerLocker.release();
  }

  await heartbeat();
  const competing=await heartbeat(uuid(7),uuid(8));
  assert.equal(competing.ready,false);assert.equal(competing.code,'concurrent_instance');
  assert.equal((await q("SELECT crm_graph_candidate.cache_identity_readiness_v1('listmonk-primary') r")).rows[0].r.ready,false);

  await q("DELETE FROM crm_graph_candidate.cache_identity_snapshot_v1;DELETE FROM crm_graph_candidate.cache_identity_lease_v1");
  await q('INSERT INTO public.templates VALUES(72,$1,$2,$3,$4)',[snapshot.type,snapshot.subject,snapshot.body,snapshot.body_source]);
  await q('INSERT INTO crm_graph_candidate.native_template_v1 VALUES($1,$2,$3,72,$4,$5)',[uuid(9),'listmonk-primary','ready',sha('a'),snapshot]);
  const duplicated=await heartbeatRaw([{template_id:71,...snapshot},{template_id:71,...snapshot}]);
  assert.equal(duplicated.ready,false);assert.equal(duplicated.code,'template_set_drift');
  assert.equal((await q("SELECT crm_graph_candidate.cache_identity_readiness_v1('listmonk-primary') r")).rows[0].r.ready,false);
  assert.equal((await q("SELECT count(*)::int n FROM crm_graph_candidate.cache_identity_snapshot_v1 WHERE cache_target='listmonk-primary'")).rows[0].n,0,'duplicate heartbeat must leave no usable snapshot');

  const rows=(await q("SELECT (SELECT count(*)::int FROM crm_graph_candidate.cart_delivery_v1) deliveries,(SELECT count(*)::int FROM public.shrigma_email_dispatch) dispatches,(SELECT count(*)::int FROM crm_graph_candidate.cache_identity_deployment_v1 WHERE enabled) enabled")).rows[0];
  assert.deepEqual(rows,{deliveries:5,dispatches:5,enabled:1});
  console.log(JSON.stringify({success:true,postgres_major:17,outcomes:['off_install_and_exact_guard','heartbeat_same_manager_contract','consume_once','replay_blocked','null_and_missing_rows_fail_closed','database_cache_mismatch_blocked','ttl_blocked','lock_wait_expiry_rechecked','concurrent_cache_suspends','duplicate_template_heartbeat_suspends'],no_transport:true}));
 }finally{await pool.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
