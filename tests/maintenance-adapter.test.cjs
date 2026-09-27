'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {createMaintenanceAdapter}=require('../n8n/growth/maintenance-adapter.cjs');
test('no receipt/ack until the single parameterized DB call commits; no extra calls',async()=>{
 let finish,calls=0;const id=randomUUID(),receipt={contract:'growth-maintenance-retention-v1',persisted:true,authorizes_send:false,brand:'fish',event_id:id};
 const a=createMaintenanceAdapter({query(sql,args){calls++;assert.match(sql,/\$3::jsonb/);assert.deepEqual(args,['fish','transactional','{"order_id":"synthetic"}']);return new Promise(resolve=>{finish=()=>resolve({rows:[{receipt}]});});}});
 let acknowledged=false;const pending=a.admit('fish','transactional',{order_id:'synthetic'}).then(r=>{acknowledged=true;return r;});
 await Promise.resolve();assert.equal(acknowledged,false);finish();assert.deepEqual(await pending,receipt);assert.equal(calls,1);
});
test('lost receipt/claim response has no blind retry, leaked error or invented token',async()=>{
 let calls=0;const a=createMaintenanceAdapter({async query(){calls++;throw Object.assign(Error('password=synthetic-secret'),{code:'ECONNRESET'});}});
 await assert.rejects(a.admit('fish','transactional',{}),e=>e.code==='MAINTENANCE_UNCONFIRMED'&&!JSON.stringify(e).includes('synthetic-secret'));
 await assert.rejects(a.claim(randomUUID()),{code:'MAINTENANCE_UNCONFIRMED'});assert.equal(calls,2);
});
test('only known static database refusal escapes; malformed grant fails closed',async()=>{
 let a=createMaintenanceAdapter({async query(){throw Object.assign(Error('MAINTENANCE_REPLAY_MISMATCH'),{code:'P0001'});}});
 await assert.rejects(a.admit('fish','transactional',{}),{code:'MAINTENANCE_REPLAY_MISMATCH'});
 const id=randomUUID();a=createMaintenanceAdapter({async query(){return {rows:[{event_id:id,should_send:false,claim_token:'secret',payload:null,context:null}]};}});
 await assert.rejects(a.claim(id),{code:'MAINTENANCE_UNCONFIRMED'});
});
