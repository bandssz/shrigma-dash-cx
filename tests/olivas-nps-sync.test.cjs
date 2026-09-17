const test=require('node:test'),assert=require('node:assert/strict');
const {syncOlivasNps}=require('../n8n/growth/olivas-nps-sync');
const config={CU_TOKEN:'fixture',LISTS:{olivas:'olivas-list'}};
const job={sync_id:'job',payload:{brand:'olivas',order:'#12',score:9,bucket:'promotor',email:'fixture@example.invalid'}};
test('finds existing order and never creates a duplicate task',async()=>{
 const calls=[];const r=await syncOlivasNps(job,config,async r=>{calls.push(r);return r.method==='GET'?{tasks:[{id:'existing',name:'NPS 8 · Pedido #12'}]}:{};});
 assert.equal(r.task_id,'existing');assert.equal(r.ok,true);assert.equal(calls.length,3);assert.ok(!calls.some(r=>r.method==='POST'&&r.url.endsWith('/task')));
});
test('comment does not overwrite a later score',async()=>{
 const calls=[];const r=await syncOlivasNps({...job,payload:{...job.payload,task_id:'existing',sync_kind:'comment',comment:'Muito bom'}},config,async r=>{calls.push(r);return {};});
 assert.equal(r.ok,true);assert.equal(calls.length,1);assert.equal(calls[0].method,'POST');assert.match(calls[0].body.comment_text,/Muito bom/);
});
test('uncertain external result is preserved and wrong brand never calls ClickUp',async()=>{
 let calls=0;const http=async()=>{calls++;throw Error('timeout');};
 assert.equal((await syncOlivasNps({...job,payload:{...job.payload,task_id:'existing'}},config,http)).ok,false);assert.equal(calls,1);
 assert.equal((await syncOlivasNps({...job,payload:{...job.payload,brand:'fish'}},config,http)).ok,false);assert.equal(calls,1);
});
