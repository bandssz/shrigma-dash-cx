'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createLifecycleActivation}=require('../n8n/growth/journey-graph-lifecycle-activation.cjs');
const id=n=>'92000000-0000-4000-8000-'+String(n).padStart(12,'0'),hash='a'.repeat(64),authorization='Bearer synthetic-manager';
const base={brand:'fish',journey_id:id(1),expected_version:2,request_id:id(2),published_revision:2,publication_hash:hash};
function setup({lostCommit=false}={}){
 const calls=[];let commits=0,receipt=null;
 const review={contract:'journey_graph_cart_activation_review_v1',state:'ready',...base,version:2,review_hash:'b'.repeat(64),blockers:[],authorizes_activate:false,authorizes_enrollment:false,authorizes_send:false};
 const pool={async connect(){return {async query(sql,args){calls.push({sql,args});if(sql==='COMMIT'){commits++;if(lostCommit)throw Error('lost acknowledgement');return {rows:[]};}if(sql.includes('lifecycle_auth_v1'))return {rows:[{result:{auth:{who:'panel:manager',caps:['read_content','validate','submit']},live_count:1,live_actor:'panel:manager'}}]};if(sql.includes('cart_activation_review_v1'))return {rows:[{result:review}]};if(sql.includes('cart_activation_commit_v1')){receipt={contract:'journey_graph_cart_activation_v1',state:'active',request_id:base.request_id,brand:base.brand,journey_id:base.journey_id,base_version:2,version:3,published_revision:2,publication_hash:hash,review_hash:review.review_hash,epoch_id:id(3),authorizes_activate:false,authorizes_enrollment:false,authorizes_send:false};return {rows:[{result:receipt}]};}if(sql.includes('cart_activation_operation_v1'))return {rows:[{result:receipt?{state:'succeeded',actor:'panel:manager',request_id:base.request_id,receipt}:{state:'reviewed',actor:'panel:manager',request_id:base.request_id,review}}]};return {rows:[]};},release(){}};}};
 return {calls,review,pool,commits:()=>commits};
}
test('reviewed activation uses one request identity and returns a read-only receipt',async()=>{
 const f=setup(),api=createLifecycleActivation({pool:f.pool,enabled:true});
 const reviewed=await api.review({action:'activation_review',...base},{authorization});assert.equal(reviewed.review.review_hash,f.review.review_hash);assert.equal(reviewed.request_id,base.request_id);
 const activated=await api.activate({action:'activate',...base,admission_review_hash:f.review.review_hash,confirm:'ativar'},{authorization});assert.equal(activated.receipt.epoch_id,id(3));assert.equal(activated.receipt.authorizes_send,false);
 const found=await api.operation({action:'activation_operation',brand:'fish',request_id:base.request_id},{authorization});assert.equal(found.state,'succeeded');assert.equal(found.receipt.request_id,base.request_id);assert.equal(f.calls.filter(x=>x.sql.includes('cart_activation_commit_v1')).length,1);
});
test('disabled mutation and lost commit acknowledgement fail closed without an adapter retry',async()=>{
 const f=setup(),off=createLifecycleActivation({pool:f.pool});await assert.rejects(off.review({action:'activation_review',...base},{authorization}),{code:'GRAPH_ACTIVATION_UNAVAILABLE'});assert.equal(f.calls.length,0);
 const uncertain=setup({lostCommit:true}),api=createLifecycleActivation({pool:uncertain.pool,enabled:true});await assert.rejects(api.activate({action:'activate',...base,admission_review_hash:'b'.repeat(64),confirm:'ativar'},{authorization}),{code:'GRAPH_ACTIVATION_OUTCOME_UNKNOWN'});assert.equal(uncertain.calls.filter(x=>x.sql.includes('cart_activation_commit_v1')).length,1);
});
