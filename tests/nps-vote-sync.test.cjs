const test=require('node:test'),assert=require('node:assert/strict');
const {syncNpsVote}=require('../n8n/growth/nps-vote-sync');
const job={sync_id:'fixture',payload:{brand:'fish',order:'123',score:9,bucket:'promotor',email:'fixture@example.invalid',date:'2026-09-16'}};
const config={CU_TOKEN:'fixture',LISTS:{fish:'fixture'}};
test('searches beyond the first page and does not match order prefixes',async()=>{
 const calls=[];
 const http=async q=>{calls.push(q);if(q.method==='GET')return q.url.endsWith('page=0')?{tasks:Array.from({length:100},()=>({id:'wrong',name:'NPS 9 · Pedido 1234'}))}:{tasks:[{id:'right',name:'NPS 5 · Pedido 123'}]};return {};};
 const r=await syncNpsVote(job,config,http);
 assert.equal(r.ok,true);assert.equal(r.task_id,'right');assert.equal(calls.filter(q=>q.method==='GET').length,2);
 assert.equal(calls.some(q=>q.method==='POST'&&q.url.includes('/list/')),false);
 assert.equal(calls.some(q=>q.url.includes('/subscribers')),false);
});
test('uncertain task creation is returned without an automatic retry',async()=>{
 let writes=0;const r=await syncNpsVote(job,config,async q=>{if(q.method==='GET')return {tasks:[]};writes++;throw Error('timeout');});
 assert.equal(r.ok,false);assert.equal(r.task_id,null);assert.equal(writes,1);
});
test('retains a known task ID when its follow-up comment fails',async()=>{
 const r=await syncNpsVote({...job,payload:{...job.payload,task_id:'known'}},config,async q=>{if(q.method==='POST')throw Error('timeout');return {};});
 assert.equal(r.ok,false);assert.equal(r.task_id,'known');
});
