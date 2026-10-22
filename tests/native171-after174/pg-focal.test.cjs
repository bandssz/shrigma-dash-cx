 'use strict';
// Integration test contract: Root injects isolated synthetic PG fixture and authentic public
// functions. This module has no connection discovery, bootstrap, actor/issuer or original executor.
const assert=require('node:assert/strict'),{prepare}=require('./prepare.cjs');
async function run({db,fixture}){
 if(!db||typeof db.query!=='function'||!fixture||fixture.synthetic!==true||typeof fixture.reset!=='function'||typeof fixture.envelope!=='function')throw Error('SYNTHETIC_PG_FIXTURE_REQUIRED');
 let cases=0;
 async function execute(prepared,envelope){await db.query('SAVEPOINT focal_attempt');try{for(const sql of prepared.statements.slice(1,-1))await db.query(sql,sql.includes('$1::text')?[JSON.stringify(envelope)]:[]);await db.query('RELEASE SAVEPOINT focal_attempt');}catch(e){await db.query('ROLLBACK TO SAVEPOINT focal_attempt');await db.query('RELEASE SAVEPOINT focal_attempt');throw e;}}
 async function snapshot(p){return (await db.query(p.snapshotReadSQL)).rows[0].jsonb_build_object;}
 const equal=(a,b)=>assert.deepEqual(a,b);
 async function reset(count=2373){const input=await fixture.reset({finished174Count:count,target171Sent:15,target171Cursor:146});const p=prepare(input);const before=await snapshot(p);assert.equal(before.campaigns.find(c=>c.id===174).status,'finished');assert.equal(before.campaigns.find(c=>c.id===174).sent,count);return {p,before,envelope:await fixture.envelope(p,before)};}
 for(const count of [50,2373,2391]){const {p,before,envelope}=await reset(count);await execute(p,envelope);const after=await snapshot(p);const expected=JSON.parse(JSON.stringify(before));expected.campaigns.find(c=>c.id===171).status='scheduled';expected.controls.find(c=>c.campaign_id===171).suspended=false;equal(after,expected);equal(after.dispatch,before.dispatch);cases++;
  await assert.rejects(()=>execute(p,envelope));equal(await snapshot(p),after);cases++;
 }
 for(const [name,sql]of [
 ['174 not finished',null],
 ['changed175',"UPDATE public.campaigns SET updated_at=clock_timestamp() WHERE id=175"],
 ['active176',"UPDATE public.campaigns SET status='running' WHERE id=176"],
 ['oldaccepted changed',"UPDATE public.shrigma_email_dispatch SET error_code='SYNTHETIC_DRIFT' WHERE dispatch_id=(SELECT dispatch_id FROM public.shrigma_email_dispatch WHERE piece='audience-regular-v1:174' ORDER BY dispatch_id LIMIT 1)"],
 ['unknown',"UPDATE public.shrigma_email_dispatch SET transport_state='outcome_unknown' WHERE dispatch_id=(SELECT dispatch_id FROM public.shrigma_email_dispatch WHERE piece='audience-regular-v1:174' ORDER BY dispatch_id LIMIT 1)"],
 ['inflight',"UPDATE public.shrigma_email_dispatch SET transport_state='in_flight' WHERE dispatch_id=(SELECT dispatch_id FROM public.shrigma_email_dispatch WHERE piece='audience-regular-v1:174' ORDER BY dispatch_id LIMIT 1)"]]){
  const {p,before,envelope}=await reset();if(sql)await db.query(sql);else await fixture.applyNegative('fresh-174-paused',{db});const changed=await snapshot(p);await assert.rejects(()=>execute(p,envelope),name);equal(await snapshot(p),changed);cases++;
 }
 for(const name of ['wrong-purpose','wrong-binding','wrong-function','wrong-trigger','171-ack-drift','new-regular-running']){
  if(typeof fixture.applyNegative!=='function')throw Error('FOCAL_MUTATOR_REQUIRED');
  const {p,envelope}=await reset();await fixture.applyNegative(name,{db,envelope});const before=await snapshot(p);await assert.rejects(()=>execute(p,envelope),name);equal(await snapshot(p),before);cases++;
 }
 // Fresh authorized snapshot cannot hide uncertain/active state: test branch beyond CAS.
 for(const name of ['fresh-174-paused','fresh-176-running','fresh-unknown','fresh-inflight','fresh-wrong-function','fresh-wrong-trigger','fresh-wrong-binding','fresh-171-progress']){
  const {p}=await reset();await fixture.applyNegative(name,{db});const before=await snapshot(p);const envelope=await fixture.envelope(p,before);await assert.rejects(()=>execute(p,envelope),name);equal(await snapshot(p),before);cases++;
 }
 return {cases,synthetic:true,pg:(await db.query('SHOW server_version')).rows[0],originalCalls:0,acceptedLedgerPreserved:true,fixtureCommits:false,rollbackOnly:true};
}
module.exports=Object.freeze({run});
