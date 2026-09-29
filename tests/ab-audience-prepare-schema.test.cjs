'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite'),F=require('./ab-audience-prepare-fixture.cjs');
const H=require('../n8n/growth/segment-audience-review.cjs');
const SQL=F.read('n8n/growth/ab-audience-prepare.sql');
async function init(t){const db=new PGlite();t.after(()=>db.close());return F.setup(db);}
async function material(x,brand='fish'){
 await x.bindBoth(brand);const p=await x.protocol(brand),heads=await Promise.all(p.arms.map(a=>x.bound(a.campaign_id))),b=heads[0];
 const scope={contract:'crm-ab-audience-scope-v1',test_id:p.test_id,brand,audience_id:b.audience_id,audience_revision:b.audience_revision,definition:b.binding.definition,definition_hash:b.definition_hash,context:b.binding.context,context_hash:b.context_hash,base_list_id:b.base_list_id,catalog_hash:b.catalog_hash,bindings:heads.map((h,i)=>({arm:['a','b'][i],campaign_id:h.campaign_id,binding_version:h.binding_version,binding_hash:h.binding_hash,campaign_version:h.campaign_version}))};
 return {p,scope,members:[1,2,3,4]};
}
async function assemble(x,m,{scope=m.scope,cohortHash=H.digest(m.members),skipArms=false,skipCounts=false,wrongAssignment=false,swapped=false,afterInsert=null,receipt=true}={}){
 return x.db.transaction(async tx=>{
  const {seed}=(await tx.query('INSERT INTO public.crm_ab_experiment_v2(test_id,brand,protocol,source_list_ids,source_complete) VALUES($1,$2,$3,$4,false) RETURNING seed',[m.p.test_id,m.p.brand,JSON.stringify(m.p),[m.scope.base_list_id]])).rows[0];
  await tx.query('INSERT INTO crm_audience_v2.ab_scope(test_id,brand,scope,scope_hash,cohort_hash,actor,created_xid) VALUES($1,$2,$3,$4,$5,$6,CAST(1::text AS xid8))',[m.p.test_id,m.p.brand,JSON.stringify(scope),H.digest(scope),cohortHash,'panel:manager']);
  const row=(await tx.query('SELECT created_xid::text=pg_current_xact_id()::text AS same FROM crm_audience_v2.ab_scope WHERE test_id=$1',[m.p.test_id])).rows[0];assert.equal(row.same,true,'created_xid must be assigned by the database');
  if(!skipArms){
   await tx.query("INSERT INTO crm_ab_arm_v2(test_id,arm,campaign_id,campaign_version) SELECT $1,a->>'arm',(a->>'campaign_id')::integer,a->>'expected_version' FROM jsonb_array_elements($2::jsonb) a",[m.p.test_id,JSON.stringify(m.p.arms)]);
   await tx.query("INSERT INTO crm_ab_member_v2(test_id,subscriber_id,arm) SELECT $1,id,CASE WHEN row_number() OVER(ORDER BY sha256(convert_to($2::text||':'||id::text,'UTF8')),id)<=floor(cardinality($3::integer[])/2.0) THEN CASE WHEN $4::boolean THEN 'b' ELSE 'a' END ELSE CASE WHEN $4::boolean THEN 'a' ELSE 'b' END END FROM unnest($3::integer[]) id",[m.p.test_id,seed,m.members,swapped]);
   if(wrongAssignment)await tx.query("INSERT INTO crm_ab_member_v2(test_id,subscriber_id,arm) VALUES($1,99,'a')",[m.p.test_id]);
   if(!skipCounts)await tx.query('UPDATE crm_ab_arm_v2 a SET allocated_count=(SELECT count(*) FROM crm_ab_member_v2 m WHERE m.test_id=a.test_id AND m.arm=a.arm) WHERE a.test_id=$1',[m.p.test_id]);
  }
  if(receipt)await tx.query('INSERT INTO crm_audience_v2.ab_request(actor,operation_key,brand,payload,payload_hash,response) VALUES($1,$2,$3,$4,$5,$6)',['panel:manager',F.uuid(900),m.p.brand,JSON.stringify({test_id:m.p.test_id}),H.digest({test_id:m.p.test_id}),JSON.stringify({_http:201,_body:{test_id:m.p.test_id}})]);
  if(afterInsert)await afterInsert(tx);
 });
}
async function empty(x){for(const table of ['crm_ab_experiment_v2','crm_ab_arm_v2','crm_ab_member_v2','crm_audience_v2.ab_scope','crm_audience_v2.ab_request'])assert.equal((await x.db.query('SELECT count(*)::integer n FROM '+table)).rows[0].n,0,table);}
for(const brand of ['fish','aristo'])test(brand+': real binding/core commit scope, original receipt and immutable assignments, with send still blocked',async t=>{
 const x=await init(t),m=await material(x,brand);await assemble(x,m);
 const original=(await x.db.query('SELECT * FROM crm_audience_v2.ab_scope')).rows;
 const receipt=(await x.db.query('SELECT * FROM crm_audience_v2.ab_request')).rows;
 for(const q of ["UPDATE crm_audience_v2.ab_scope SET cohort_hash=repeat('a',64)","DELETE FROM crm_audience_v2.ab_scope","UPDATE crm_audience_v2.ab_request SET response='{}'","DELETE FROM crm_audience_v2.ab_request"])await assert.rejects(x.db.query(q),/IMMUTABLE/);
 for(const q of ["UPDATE crm_ab_experiment_v2 SET state='scheduled'","UPDATE crm_ab_experiment_v2 SET transport_bound=true"])await assert.rejects(x.db.query(q),/AB_AUDIENCE_SHADOW_ONLY/);
 for(const q of ["UPDATE crm_ab_experiment_v2 SET seed=gen_random_uuid()","UPDATE crm_ab_experiment_v2 SET protocol=jsonb_set(protocol,'{name}','\"Different\"')","UPDATE crm_ab_experiment_v2 SET source_list_ids=ARRAY[999]","DELETE FROM crm_ab_experiment_v2"])await assert.rejects(x.db.query(q),/AB_AUDIENCE_SCOPE_IMMUTABLE/);
 for(const q of ["UPDATE crm_ab_arm_v2 SET allocated_count=allocated_count+1","UPDATE crm_ab_arm_v2 SET campaign_id=300 WHERE arm='a'","DELETE FROM crm_ab_arm_v2","UPDATE crm_ab_member_v2 SET arm=CASE arm WHEN 'a' THEN 'b' ELSE 'a' END","DELETE FROM crm_ab_member_v2"])await assert.rejects(x.db.query(q),/AB_AUDIENCE_ASSIGNMENT_IMMUTABLE/);
 await assert.rejects(x.db.query("INSERT INTO crm_ab_member_v2 VALUES($1,99,'a',null,null)",[m.p.test_id]),/AB_AUDIENCE_ASSIGNMENT_IMMUTABLE/);
 await assert.rejects(x.db.query('UPDATE crm_audience_v2.campaign_binding SET binding_version=binding_version+1 WHERE campaign_id=$1',[m.p.arms[0].campaign_id]),/AB_AUDIENCE_BINDING_FROZEN/);
 await x.db.query("UPDATE subscribers SET status='enabled' WHERE status='disabled'");
 await assert.rejects(x.legacySchedule(m.p.arms[0].campaign_id),/AB_V2_SCHEDULE_REQUIRED/);
 assert.equal((await x.db.query('SELECT status FROM campaigns WHERE id=$1',[m.p.arms[0].campaign_id])).rows[0].status,'draft');
 await x.db.query("UPDATE crm_ab_member_v2 SET revoked_at=clock_timestamp(),revoked_reason='consent_removed' WHERE subscriber_id=1");
 for(const q of ["UPDATE crm_ab_member_v2 SET revoked_at=null WHERE subscriber_id=1","UPDATE crm_ab_member_v2 SET revoked_reason='rewrite' WHERE subscriber_id=1"])await assert.rejects(x.db.query(q),/AB_AUDIENCE_ASSIGNMENT_IMMUTABLE/);
 assert.deepEqual((await x.db.query('SELECT * FROM crm_audience_v2.ab_scope')).rows,original);assert.deepEqual((await x.db.query('SELECT * FROM crm_audience_v2.ab_request')).rows,receipt);
 await x.db.query("UPDATE crm_ab_experiment_v2 SET state='cancelled',version=version+1");
 await assert.rejects(x.db.query("UPDATE crm_ab_experiment_v2 SET state='scheduled'"),/AB_AUDIENCE_SHADOW_ONLY/);
 // Closing/cancelling is not sending and is not blocked by the shadow fence.
 await x.db.query("UPDATE crm_ab_experiment_v2 SET state='closed',version=version+1");
 assert.equal((await x.db.query('SELECT transport_bound FROM crm_ab_experiment_v2')).rows[0].transport_bound,false);
});
test('scope admits only pinned head/history and exact ordered arms; all malformed insertions roll back',async t=>{
 const x=await init(t),m=await material(x);
 for(const change of [s=>s.bindings[0].binding_hash='f'.repeat(64),s=>s.bindings[0].campaign_version='f'.repeat(32),s=>s.bindings.reverse(),s=>s.context_hash='f'.repeat(64),s=>s.bindings[0].extra=true,s=>s.brand='aristo']){
  const scope=structuredClone(m.scope);change(scope);await assert.rejects(assemble(x,m,{scope}),/AB_AUDIENCE_(SCOPE|BINDING_CHANGED)/);await empty(x);
 }
});
test('deferred whole-cohort proof rejects missing arms, wrong denominator or changed membership and commits nothing',async t=>{
 const x=await init(t),m=await material(x);
 for(const opts of [{skipArms:true},{skipCounts:true},{cohortHash:'f'.repeat(64)},{wrongAssignment:true},{swapped:true}]){await assert.rejects(assemble(x,m,opts),/AB_AUDIENCE_COHORT_UNCONFIRMED/);await empty(x);}
 // The creating transaction cannot rewrite a member after insertion either.
 await assert.rejects(assemble(x,m,{afterInsert:async tx=>{
  // Updates are immutable even in the creating transaction: no reassignment shortcut.
  await tx.query("UPDATE crm_ab_member_v2 SET arm=CASE arm WHEN 'a' THEN 'b' ELSE 'a' END");
 }}),/AB_AUDIENCE_ASSIGNMENT_IMMUTABLE/);await empty(x);
});
test('an experiment from an earlier transaction cannot acquire a scope by attaching metadata later',async t=>{
 const x=await init(t),m=await material(x);
 await x.db.query('INSERT INTO crm_ab_experiment_v2(test_id,brand,protocol,source_list_ids) VALUES($1,$2,$3,$4)',[m.p.test_id,m.p.brand,JSON.stringify(m.p),[m.scope.base_list_id]]);
 await assert.rejects(x.db.query('INSERT INTO crm_audience_v2.ab_scope(test_id,brand,scope,scope_hash,cohort_hash,actor) VALUES($1,$2,$3,$4,$5,$6)',[m.p.test_id,m.p.brand,JSON.stringify(m.scope),H.digest(m.scope),H.digest(m.members),'panel:manager']),/AB_AUDIENCE_EXPERIMENT/);
 assert.equal((await x.db.query('SELECT count(*)::int n FROM crm_audience_v2.ab_scope')).rows[0].n,0);
});
test('legacy preparation cannot silently allocate a bound audience, while unrelated legacy RC operation is preserved',async t=>{
 const x=await init(t);await x.bindBoth('fish');await x.db.query("UPDATE subscribers SET status='enabled'");
 const p=await x.protocol('fish');await assert.rejects(x.db.query('SELECT crm_ab_prepare_v2($1,$2,$3,$4)',['panel:manager','["draft"]',F.uuid(901),JSON.stringify(p)]),/AB_AUDIENCE_SCOPE_REQUIRED/);await empty(x);
 const legacy=await x.protocol('aristo');const r=(await x.db.query('SELECT crm_ab_prepare_v2($1,$2,$3,$4) AS result',['panel:manager','["draft"]',F.uuid(902),JSON.stringify(legacy)])).rows[0].result;
 assert.equal(r.brand,'aristo');assert.equal(r.state,'prepared');assert.equal((await x.db.query('SELECT count(*)::int n FROM crm_audience_v2.ab_scope')).rows[0].n,0);
});
test('repeatable-read assignment writes fail before invisible-scope/legacy fallback; no bypass GUC',async t=>{
 const x=await init(t),m=await material(x);await assemble(x,m);
 await assert.rejects(x.db.transaction(async tx=>{await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await tx.query("SELECT set_config('shrigma.campaign_writer','100',true)");await tx.query("INSERT INTO crm_ab_member_v2 VALUES($1,99,'a',null,null)",[m.p.test_id]);}),/AB_AUDIENCE_ISOLATION/);
 await assert.rejects(x.db.transaction(async tx=>{await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await tx.query('UPDATE crm_audience_v2.campaign_binding SET binding_version=binding_version+1');}),/AB_AUDIENCE_ISOLATION/);
 assert.equal((await x.db.query('SELECT count(*)::int n FROM crm_ab_member_v2')).rows[0].n,4);
});
test('fresh-only installation is atomic, adds no runtime grant or enabled state, and cannot replace installed guards',async t=>{
 const emptyDB=new PGlite();t.after(()=>emptyDB.close());await assert.rejects(emptyDB.exec(SQL),/AB_AUDIENCE_DEPENDENCY/);assert.equal((await emptyDB.query("SELECT to_regclass('crm_audience_v2.ab_scope') AS relation")).rows[0].relation,null);
 const x=await init(t);const before=(await x.db.query("SELECT oid,proname,prosrc FROM pg_proc WHERE pronamespace='crm_audience_v2'::regnamespace AND proname LIKE 'ab_%' ORDER BY oid")).rows;
 await assert.rejects(x.db.exec(SQL),/AB_AUDIENCE_INSTALL_COLLISION/);
 assert.deepEqual((await x.db.query("SELECT oid,proname,prosrc FROM pg_proc WHERE pronamespace='crm_audience_v2'::regnamespace AND proname LIKE 'ab_%' ORDER BY oid")).rows,before);
 assert.deepEqual((await x.db.query("SELECT relname FROM pg_class WHERE relnamespace='crm_audience_v2'::regnamespace AND relname IN ('ab_scope','ab_request') AND EXISTS(SELECT 1 FROM aclexplode(relacl) WHERE grantee=0)")).rows,[]);
 assert.equal((await x.db.query('SELECT enabled FROM crm_ab_runtime_v2')).rows[0].enabled,false);
});
