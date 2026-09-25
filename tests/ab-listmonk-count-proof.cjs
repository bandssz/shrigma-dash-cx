'use strict';
// Full pinned upstream DML equivalence in disposable PGlite only. No DB URL/transport.
const assert=require('node:assert/strict'),fs=require('node:fs'),{createHash}=require('node:crypto');
const {fixture,read}=require('./ab-experiment-fixture.cjs');
const {patchSource,section}=require('../n8n/growth/ab-listmonk-cohort-patch.cjs');
const sha=s=>createHash('sha256').update(s).digest('hex');
// Historical 9ec0722 comparison, deliberately NOT the newly accepted build digest.
const BASELINE_9EC_SHA='b1a3dafd0502622d70a1b28b8ff09956acc48541bb883ff0e0894089ea42c817';
function baseline9ec(source){
 let result=source;
 for(const [name,phase] of [['next-campaigns','count'],['next-campaign-subscribers','batch']]){
  const s=section(result,name),cid=phase==='count'?'camps.id':'$1',anchor=phase==='count'?"JOIN subscribers s ON (s.id = sl.subscriber_id AND s.status != 'blocklisted')":"AND s.status != 'blocklisted'";
  assert.equal(s.text.split(anchor).length,2);
  const predicate=`(${cid} NOT IN (SELECT campaign_id FROM public.crm_ab_arm_v2) OR public.crm_ab_delivery_allowed_v2(${cid}, s.id))`;
  const next=s.text.replace(anchor,phase==='count'?anchor.slice(0,-1)+' AND '+predicate+')':anchor+'\n                    AND '+predicate);
  result=result.slice(0,s.start)+next+result.slice(s.end);
 }
 assert.equal(sha(result),BASELINE_9EC_SHA,'historical baseline must remain byte-exact');return result;
}
async function proof(source){
 const next=patchSource(source),prior=baseline9ec(source);
 const oldCount=section(prior,'next-campaigns').text,newCount=section(next.source,'next-campaigns').text;
 assert.equal(section(next.source,'next-campaign-subscribers').text,section(prior,'next-campaign-subscribers').text,'batch must remain byte-exact');
 assert.equal(next.source.replace(newCount,'__COUNT__'),prior.replace(oldCount,'__COUNT__'),'all sections outside count remain byte-exact');
 const x=await fixture(),checks=[];
 try{
  await x.db.exec(`ALTER TABLE templates ADD COLUMN is_default boolean DEFAULT true;
   ALTER TABLE campaigns ADD COLUMN to_send integer DEFAULT 0;ALTER TABLE campaigns ADD COLUMN max_subscriber_id integer DEFAULT 0;ALTER TABLE campaigns ADD COLUMN last_subscriber_id integer DEFAULT 0;`);
  await x.prepare(await x.protocol());await x.db.exec(read('n8n/growth/ab-experiment-selection.sql'));
  const expectedBuild=read('n8n/growth/ab-experiment-selection.sql').match(/native_query_sha256='([a-f0-9]{64})'/)[1];
  await x.db.query('UPDATE crm_ab_runtime_v2 SET enabled=true,native_query_sha256=$1,verified_at=now()',[expectedBuild]);
  await x.db.exec(`UPDATE crm_ab_experiment_v2 SET state='scheduled',window_start=now()-interval '1 hour',window_end=now()+interval '23 hours',transport_bound=true,tracking_continuous=true;
   SELECT set_config('shrigma.ab_schedule_v2',(SELECT test_id::text FROM crm_ab_experiment_v2),false);
   UPDATE campaigns SET status='running',started_at='2026-01-01T00:00:00Z',send_at='2026-01-01T00:00:00Z';
   SELECT set_config('shrigma.ab_schedule_v2','',false);`);
  const mutations=[
   ['ready','SELECT 1',[],[]],
   ['off','UPDATE crm_ab_runtime_v2 SET enabled=false',[],[]],
   ['invalid_receipt',"UPDATE crm_ab_runtime_v2 SET native_query_sha256=repeat('b',64)",[],[]],
   ['future_receipt',"UPDATE crm_ab_runtime_v2 SET verified_at=now()+interval '1 hour'",[],[]],
   ['source_incomplete','UPDATE crm_ab_experiment_v2 SET source_complete=false',[],[]],
   ['tracking_off','UPDATE crm_ab_experiment_v2 SET tracking_continuous=false',[],[]],
   ['no_members',"DELETE FROM crm_ab_member_v2 WHERE arm='a'",[],[]],
   ['probe_native_optout',"UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=(SELECT min(subscriber_id) FROM crm_ab_member_v2 WHERE arm='a') AND list_id IN(3,17)",[],[]],
   ['source_suppression',"UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id%7=0;UPDATE subscribers SET status='disabled' WHERE id%11=0;UPDATE subscribers SET status='blocklisted' WHERE id%13=0;UPDATE crm_ab_member_v2 SET revoked_at=now() WHERE subscriber_id%17=0",[],[]],
   ['ordinary_only_and_active_counters','SELECT 1',[100,101],[7,9]],
   ['one_arm_admitted','SELECT 1',[100,200,201],[2,3,4]],
   ['all_already_active','SELECT 1',[100,101,200,201],[1,2,3,4]],
  ];
  for(const [name,mutation,ids,sent]of mutations){
   await x.db.exec('BEGIN');try{
    await x.db.exec(mutation);await x.db.exec('SAVEPOINT before_query');
    const oldRows=(await x.db.query(oldCount,[ids,sent])).rows;
    const oldState=(await x.db.query('SELECT * FROM campaigns ORDER BY id')).rows;
    await x.db.exec('ROLLBACK TO SAVEPOINT before_query');
    const newRows=(await x.db.query(newCount,[ids,sent])).rows;
    const newState=(await x.db.query('SELECT * FROM campaigns ORDER BY id')).rows;
    assert.deepEqual(newRows,oldRows,name+': returned native rows');
    assert.deepEqual(newState,oldState,name+': every native campaign field and counter');
    checks.push(name);
   }finally{await x.db.exec('ROLLBACK');}
  }
  return {status:'PASS',engine:'PGlite full pinned upstream SQL; not performance evidence',baseline_9ec_sha256:BASELINE_9EC_SHA,new_query_sha256:next.patched_sha256,
   batch_byte_identical:true,other_sections_byte_identical:true,canonical_build_receipt_used:expectedBuild,checks,transport_calls:0,real_recipients:0};
 }finally{await x.db.close();}
}
module.exports={baseline9ec,proof};
if(require.main===module)(async()=>{if(process.env.TEST_DATABASE_URL||!process.env.AB_UPSTREAM_SOURCE)throw Error('Pinned AB_UPSTREAM_SOURCE required; no database URL accepted');console.log(JSON.stringify(await proof(fs.readFileSync(process.env.AB_UPSTREAM_SOURCE,'utf8')),null,2));})().catch(e=>{console.error(e.message);process.exitCode=1;});
