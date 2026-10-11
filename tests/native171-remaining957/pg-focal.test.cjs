 'use strict';
const assert=require('node:assert/strict'),{prepare}=require('./prepare.cjs');
async function run({db,fixture}){
 if(!fixture?.synthetic||!db?.query)throw Error('ISOLATED_REAL_PG_FIXTURE_REQUIRED');let cases=0;
 const read=async p=>(await db.query(p.snapshotReadSQL)).rows[0].jsonb_build_object;
 const reset=async()=>{const input=await fixture.reset({finished174Count:503,target171Sent:2510,target171Cursor:51635});const p=prepare(input),before=await read(p);return {p,before,envelope:await fixture.envelope(p,before)};};
 async function exec(p,e){await db.query('SAVEPOINT held_attempt');try{for(const sql of p.statements.slice(1,-1))await db.query(sql,sql.includes('$1::text')?[JSON.stringify(e)]:[]);await db.query('RELEASE SAVEPOINT held_attempt');}catch(error){await db.query('ROLLBACK TO SAVEPOINT held_attempt');await db.query('RELEASE SAVEPOINT held_attempt');throw error;}}
 const initial=await reset();assert.equal(initial.before.campaigns.find(c=>c.id===174).status,'paused');assert.equal(initial.before.dispatch.filter(d=>d.piece==='audience-regular-v1:174'&&d.transport_state==='accepted').length,503);
 assert.equal(initial.before.campaigns.find(c=>c.id===171).to_send-initial.before.campaigns.find(c=>c.id===171).sent,957);assert.equal(initial.before.campaigns.find(c=>c.id===176).status,'finished');assert.equal(initial.before.campaigns.find(c=>c.id===177).status,'scheduled');await exec(initial.p,initial.envelope);const after=await read(initial.p),expected=structuredClone(initial.before);expected.campaigns.find(c=>c.id===171).status='scheduled';expected.controls.find(c=>c.campaign_id===171).suspended=false;assert.deepEqual(after,expected);cases++;
 await assert.rejects(()=>exec(initial.p,initial.envelope));assert.deepEqual(await read(initial.p),after);cases++;
 const negatives=[['wrong-purpose',false],['wrong-held-scope',false],['expired',false],['wrong-binding',true],['wrong-function',true],['wrong-trigger',true],['171-ack-drift',true],['new-regular-running',true],['175-priority',true],['171-unknown',true],['held-count',true],['held-uuid',true],['held-inflight',true],['held-accepted-drift',false],['other-fish-unknown',true],['expired-lease',true]];
 for(const [name,fresh]of negatives){const {p,envelope}=await reset();await fixture.applyNegative(name,{db,envelope});const before=await read(p);const e=fresh?await fixture.envelope(p,before):envelope;await assert.rejects(()=>exec(p,e),name);assert.deepEqual(await read(p),before);cases++;}
 return {cases,synthetic:true,pg:(await db.query('SHOW server_version')).rows[0],originalCalls:0,held174Preserved:true};
}
module.exports=Object.freeze({run});
