'use strict';
// Isolated PostgreSQL only. Synthetic recipients; no HTTP or mail transport.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const sql=fs.readFileSync(path.join(__dirname,'../n8n/growth/vip-consent.sql'),'utf8');
const fixtureSQL=`
CREATE TYPE subscriber_status AS ENUM('enabled','disabled','blocklisted');
CREATE TYPE subscription_status AS ENUM('unconfirmed','confirmed','unsubscribed');
CREATE TABLE public.subscribers(id serial PRIMARY KEY,uuid uuid UNIQUE NOT NULL,email text UNIQUE NOT NULL,name text NOT NULL,status subscriber_status NOT NULL,attribs jsonb NOT NULL DEFAULT '{}',created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
CREATE TABLE public.lists(id integer PRIMARY KEY,uuid uuid UNIQUE NOT NULL DEFAULT gen_random_uuid());
CREATE TABLE public.subscriber_lists(subscriber_id integer REFERENCES public.subscribers(id),list_id integer REFERENCES public.lists(id),meta jsonb NOT NULL DEFAULT '{}',status subscription_status NOT NULL,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),PRIMARY KEY(subscriber_id,list_id));
CREATE TABLE public.campaigns(id integer PRIMARY KEY,uuid uuid UNIQUE NOT NULL DEFAULT gen_random_uuid());
CREATE TABLE public.campaign_lists(campaign_id integer REFERENCES campaigns(id),list_id integer REFERENCES lists(id));
INSERT INTO public.lists(id) VALUES(16),(19),(99);
INSERT INTO public.campaigns(id) VALUES(1);
INSERT INTO public.campaign_lists VALUES(1,19);
-- Exact retained user-trigger semantics (definition md5 fb561e84eb6caebfd317ac9ee0008950).
CREATE FUNCTION public.fix_attribs_array() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF jsonb_typeof(NEW.attribs) = 'array' THEN
    NEW.attribs := '{}'::jsonb;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER trg_fix_attribs BEFORE INSERT OR UPDATE ON public.subscribers FOR EACH ROW EXECUTE FUNCTION fix_attribs_array();
`;
// Official Listmonk v6.1.0 queries/subscribers.sql:238–264, unchanged statements.
// https://github.com/knadh/listmonk/blob/v6.1.0/queries/subscribers.sql
const NATIVE_LIST_UNSUB=`WITH listIDs AS (
    SELECT ARRAY(
        SELECT id FROM lists WHERE
        (CASE WHEN CARDINALITY($2::INT[]) > 0 THEN id=ANY($2) ELSE uuid=ANY($3::UUID[]) END)
    ) id
)
UPDATE subscriber_lists SET status='unsubscribed', updated_at=NOW()
    WHERE (subscriber_id, list_id) = ANY(SELECT a, b FROM UNNEST($1::INT[]) a, UNNEST((SELECT id FROM listIDs)) b);`;
const NATIVE_CAMPAIGN_UNSUB=`WITH lists AS (
    SELECT list_id FROM campaign_lists
    LEFT JOIN campaigns ON (campaign_lists.campaign_id = campaigns.id)
    WHERE campaigns.uuid = $1
),
sub AS (
    UPDATE subscribers SET status = (CASE WHEN $3 IS TRUE THEN 'blocklisted' ELSE status END)
    WHERE uuid = $2 RETURNING id
)
UPDATE subscriber_lists SET status = 'unsubscribed', updated_at=NOW() WHERE
    subscriber_id = (SELECT id FROM sub) AND status != 'unsubscribed' AND
    CASE WHEN $3 IS FALSE THEN list_id = ANY(SELECT list_id FROM lists) ELSE list_id != 0 END;`;
const NATIVE_BLOCKLIST=`WITH b AS (
    UPDATE subscribers SET status='blocklisted', updated_at=NOW() WHERE id=ANY($1::INT[])
)
UPDATE subscriber_lists SET status='unsubscribed', updated_at=NOW() WHERE subscriber_id=ANY($1::INT[]);`;
const email=label=>label+'@example.invalid';
const call=async(db,label,source='alma',origin='lp-alma-da-roca',corrected=false)=>(await db.query('SELECT * FROM public.shrigma_crm_vip_subscribe_v1($1,$2,$3,$4)',[email(label),origin,corrected,source])).rows[0];
async function seed(db,label,status='enabled',members={16:'confirmed',19:'confirmed'}){
 const r=(await db.query("INSERT INTO subscribers(uuid,email,name,status,attribs) VALUES(gen_random_uuid(),$1,'Synthetic',$2,'{\"keep\":true,\"origem\":\"existing\"}') RETURNING id",[email(label),status])).rows[0];
 for(const [lid,ms] of Object.entries(members))await db.query("INSERT INTO subscriber_lists(subscriber_id,list_id,status,meta) VALUES($1,$2,$3,'{\"keep\":true}')",[r.id,Number(lid),ms]);return r.id;
}
const snapshot=async(db,label)=>(await db.query("SELECT jsonb_build_object('subscriber',(SELECT to_jsonb(s) FROM subscribers s WHERE email=$1),'lists',(SELECT jsonb_agg(to_jsonb(sl) ORDER BY list_id) FROM subscriber_lists sl JOIN subscribers s ON s.id=sl.subscriber_id WHERE s.email=$1)) value",[email(label)])).rows[0].value;
async function runCases(db,install=()=>db.exec(sql)){
 await db.exec(fixtureSQL);await install();
 for(const source of ['alma','desodorante']){
  const label='new-'+source,r=await call(db,label,source,source==='alma'?'lp-alma-da-roca':'lp-desodorante-frescor',true);assert.deepEqual(r,{eligible:true,reason:'created'});
  const s=await snapshot(db,label);assert.equal(s.subscriber.status,'enabled');assert.equal(s.subscriber.attribs.email_corrigido,true);assert.equal(s.subscriber.attribs[source==='alma'?'vip_alma_da_roca':'vip_desodorante'],true);assert.deepEqual(s.lists.map(x=>[x.list_id,x.status]),[[16,'confirmed'],[19,'confirmed']]);
 }
 console.log('PASS new recognized forms: two confirmed lists, correct origin flag, no transport.');
 await seed(db,'existing','enabled',{16:'confirmed',19:'confirmed',99:'unsubscribed'});const before=await snapshot(db,'existing');assert.equal((await call(db,'existing','alma','lp-desodorante-frescor')).eligible,true);let after=await snapshot(db,'existing');assert.deepEqual(after.lists,before.lists);assert.deepEqual(after.subscriber.attribs,{keep:true,origem:'existing',vip_desodorante:true});assert.equal(after.subscriber.status,'enabled');
 assert.equal((await call(db,'existing','alma','another-legacy-origin')).eligible,true);after=await snapshot(db,'existing');assert.equal(after.subscriber.attribs.vip_alma_da_roca,true);assert.equal(after.subscriber.attribs.vip_desodorante,true);
 console.log('PASS existing confirmed subscriber preserves lists/attributes and historical Alma origin semantics.');
 for(const status of ['disabled','blocklisted']){await seed(db,status,status);const b=await snapshot(db,status);assert.deepEqual(await call(db,status),{eligible:false,reason:'subscriber_unavailable'});assert.deepEqual(await snapshot(db,status),b);}
 for(const lid of [16,19])for(const status of ['unconfirmed','unsubscribed']){const label=`blocked-${lid}-${status}`;await seed(db,label,'enabled',{16:'confirmed',19:'confirmed',[lid]:status});const b=await snapshot(db,label);assert.deepEqual(await call(db,label),{eligible:false,reason:'list_'+status});assert.deepEqual(await snapshot(db,label),b);}
 console.log('PASS disabled, blocklisted and every unconfirmed/unsubscribed list16/19 preserve entire blocked rows.');
 await seed(db,'missing-allowed','enabled',{99:'confirmed'});assert.equal((await call(db,'missing-allowed')).eligible,true);assert.equal((await snapshot(db,'missing-allowed')).lists.length,3);
 await seed(db,'partial-blocked','enabled',{19:'unsubscribed'});const b=await snapshot(db,'partial-blocked');assert.equal((await call(db,'partial-blocked')).eligible,false);assert.deepEqual(await snapshot(db,'partial-blocked'),b);
 console.log('PASS missing allowed links are added; later denial rolls back newly inserted earlier membership.');
 await db.exec("CREATE FUNCTION synthetic_reject_vip_membership() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.list_id=19 THEN RAISE EXCEPTION 'SYNTHETIC_FAILURE';END IF;RETURN NEW;END$$;CREATE TRIGGER synthetic_reject_vip_membership BEFORE INSERT ON subscriber_lists FOR EACH ROW EXECUTE FUNCTION synthetic_reject_vip_membership()");
 await assert.rejects(call(db,'atomic-error'),/SYNTHETIC_FAILURE/);assert.equal((await snapshot(db,'atomic-error')).subscriber,null);await db.exec('DROP TRIGGER synthetic_reject_vip_membership ON subscriber_lists');
 await db.query("INSERT INTO subscribers(uuid,email,name,status,attribs) VALUES(gen_random_uuid(),$1,'Synthetic','enabled','[]')",[email('trigger-array')]);assert.deepEqual((await snapshot(db,'trigger-array')).subscriber.attribs,{});assert.equal((await call(db,'trigger-array')).eligible,true);assert.equal((await snapshot(db,'trigger-array')).subscriber.attribs.vip_alma_da_roca,true);
 console.log('PASS native attribute trigger is retained and an unexpected failure rolls back subscriber and both memberships.');
 for(const [e,o,c,s] of [[email('invalid-source'),'lp',false,'fish'],[email('invalid-origin'),'\r\n',false,'alma'],['UPPER@example.invalid','lp',false,'alma'],['not-an-email','lp',false,'alma'],[email('invalid-flag'),'lp',null,'alma']]){
  const r=(await db.query('SELECT * FROM shrigma_crm_vip_subscribe_v1($1,$2,$3,$4)',[e,o,c,s])).rows[0];assert.equal(r.eligible,false);assert.deepEqual(Object.keys(r).sort(),['eligible','reason']);assert.equal(Number((await db.query('SELECT count(*) n FROM subscribers WHERE email=$1',[e])).rows[0].n),0);
 }
 const f=(await db.query("SELECT prosecdef,provolatile,EXISTS(SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public_execute FROM pg_proc WHERE oid='public.shrigma_crm_vip_subscribe_v1(text,text,boolean,text)'::regprocedure")).rows[0];assert.equal(f.prosecdef,false);assert.equal(f.provolatile,'v');assert.equal(f.public_execute,false);
 console.log('PASS malformed inputs create nothing; invoker function exposes only boolean/reason and revokes PUBLIC.');
}
async function run(){
 const u=new URL(process.env.TEST_POSTGRES_URL||'postgres://invalid');assert.equal(process.env.VIP_TEST_DATABASE_ISOLATED,'1');assert.ok(['localhost','127.0.0.1'].includes(u.hostname));assert.equal(u.username,'synthetic');assert.equal(u.password,'');assert.equal(u.port,'5432');assert.equal(u.pathname,'/vip_consent_test');assert.equal(u.search,'');assert.equal(u.hash,'');
 const {Pool}=require('pg'),pool=new Pool({connectionString:u.toString(),max:6,connectionTimeoutMillis:3000,statement_timeout:10000,application_name:'vip-consent-synthetic'});let blocker,worker,pending,workerTx=false;
 const db={query:(...a)=>pool.query(...a),exec:q=>pool.query(q)};
 async function waitForLock(label){worker=await pool.connect();const pid=(await worker.query('SELECT pg_backend_pid() id')).rows[0].id;pending=call(worker,label).then(value=>({value}),error=>({error}));let seen=false;for(let i=0;i<100&&!seen;i++){seen=(await pool.query("SELECT wait_event_type='Lock' blocked FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.blocked===true;if(!seen)await new Promise(r=>setTimeout(r,20));}assert.equal(seen,true,'real PostgreSQL lock wait required');}
 async function releaseAndResult(){await blocker.query('COMMIT');blocker.release();blocker=null;const r=await pending;pending=null;worker.release();worker=null;if(r.error)throw r.error;return r.value;}
 try{
  assert.equal((await pool.query('SHOW server_version_num')).rows[0].server_version_num,'170010');assert.equal((await pool.query("SELECT to_regclass('public.subscribers') s")).rows[0].s,null);
  await runCases(db,async()=>{
   const {atomicInstallSQL}=require('../tools/vip-consent-install.cjs'),c=await pool.connect();
   try{
    await assert.rejects(c.query(atomicInstallSQL(sql,"RAISE EXCEPTION 'SYNTHETIC_INSTALL_GUARD';")),e=>e.code==='P0001');
    const clean=(await c.query("SELECT 1 ok,to_regprocedure('public.shrigma_crm_vip_subscribe_v1(text,text,boolean,text)') installed")).rows[0];assert.equal(clean.ok,1);assert.equal(clean.installed,null);
    await c.query(atomicInstallSQL(sql,"IF to_regprocedure('public.shrigma_crm_vip_subscribe_v1(text,text,boolean,text)') IS NOT NULL THEN RAISE EXCEPTION 'SYNTHETIC_ALREADY_INSTALLED';END IF;"));
   }finally{c.release();}
   console.log('PASS implicit atomic installer rejects guard with zero DDL and the same PostgreSQL session remains healthy.');
  });
  const r=await Promise.all([call(db,'concurrent-new'),call(db,'concurrent-new')]);assert.equal(r.filter(x=>x.reason==='created').length,1);assert.ok(r.every(x=>x.eligible));assert.equal(Number((await pool.query('SELECT count(*) n FROM subscribers WHERE email=$1',[email('concurrent-new')])).rows[0].n),1);assert.equal((await snapshot(db,'concurrent-new')).lists.length,2);
  console.log('PASS simultaneous form arrivals: one subscriber and two memberships, no duplicate insert.');
  await seed(db,'wait-global');const campaignUUID=(await pool.query('SELECT uuid FROM campaigns WHERE id=1')).rows[0].uuid,subscriberUUID=(await snapshot(db,'wait-global')).subscriber.uuid;blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query(NATIVE_CAMPAIGN_UNSUB,[campaignUUID,subscriberUUID,true]);await waitForLock('wait-global');assert.deepEqual(await releaseAndResult(),{eligible:false,reason:'subscriber_unavailable'});assert.deepEqual((await snapshot(db,'wait-global')).subscriber.attribs,{keep:true,origem:'existing'});
  console.log('PASS native global opt-out committed during subscriber wait prevents attributes/membership changes.');
  for(const lid of [16,19]){
   const label='wait-list-'+lid,sid=await seed(db,label,'enabled',lid===19?{19:'confirmed'}:{16:'confirmed',19:'confirmed'});const before=await snapshot(db,label);
   blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query(NATIVE_LIST_UNSUB,[[sid],[lid],[]]);assert.deepEqual(await call(db,label),{eligible:false,reason:'consent_busy'});await blocker.query('COMMIT');blocker.release();blocker=null;assert.deepEqual(await call(db,label),{eligible:false,reason:'list_unsubscribed'});
   const after=await snapshot(db,label);assert.deepEqual(after.subscriber,before.subscriber);assert.deepEqual(after.lists.map(x=>[x.list_id,x.status]),before.lists.map(x=>[x.list_id,x.list_id===lid?'unsubscribed':x.status]));
  }
  console.log('PASS both native list opt-outs win; VIP yields without mutation and rolls back tentative list16.');
  // Exact bulk blocklist has an unreferenced CTE: native list locks can precede
  // subscriber. Hold the subscriber as VIP does, observe native waiting, then
  // call the real function on that connection: it must yield its list request.
  const sid=await seed(db,'native-bulk');worker=await pool.connect();await worker.query('BEGIN');workerTx=true;await worker.query('SELECT id FROM subscribers WHERE id=$1 FOR UPDATE',[sid]);
  blocker=await pool.connect();await blocker.query('BEGIN');const pid=(await blocker.query('SELECT pg_backend_pid() id')).rows[0].id;
  pending=blocker.query(NATIVE_BLOCKLIST,[[sid]]).then(value=>({value}),error=>({error}));let seen=false;for(let i=0;i<100&&!seen;i++){seen=(await pool.query("SELECT wait_event_type='Lock' blocked FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.blocked===true;if(!seen)await new Promise(r=>setTimeout(r,20));}assert.equal(seen,true);
  await assert.rejects(pool.query('SELECT subscriber_id FROM subscriber_lists WHERE subscriber_id=$1 AND list_id=19 FOR UPDATE NOWAIT',[sid]),e=>e.code==='55P03');
  assert.deepEqual(await call(worker,'native-bulk'),{eligible:false,reason:'consent_busy'});await worker.query('COMMIT');workerTx=false;worker.release();worker=null;
  const native=await pending;pending=null;if(native.error)throw native.error;await blocker.query('COMMIT');blocker.release();blocker=null;
  const final=await snapshot(db,'native-bulk');assert.equal(final.subscriber.status,'blocklisted');assert.ok(final.lists.every(l=>l.status==='unsubscribed'));assert.deepEqual(final.subscriber.attribs,{keep:true,origem:'existing'});
  console.log('PASS native bulk blocklist lists→subscriber completes without deadlock; VIP cedes and changes nothing.');
 }finally{
  // In the native-bulk case worker owns the subscriber lock while blocker is
  // waiting. In other cases blocker owns the lock and worker has a pending call.
  if(worker&&workerTx){await worker.query('ROLLBACK');workerTx=false;}
  if(blocker){try{await blocker.query('ROLLBACK');}finally{blocker.release();}}
  if(pending)await pending;if(worker)worker.release();await pool.end();
 }
}
module.exports={sql,fixtureSQL,runCases};
if(require.main===module)run().catch(e=>{console.error('FAIL VIP consent:',e.code||'',e.message);process.exitCode=1;});
