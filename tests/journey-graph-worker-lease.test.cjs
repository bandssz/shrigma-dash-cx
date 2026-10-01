'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createGraphWorkerLease,runtimeSha256,workerSha256,WORKER_FILES}=require('../n8n/growth/journey-graph-worker-lease.cjs');
const SHA='a'.repeat(64),INSTANCE='11111111-1111-4111-8111-111111111111';
function reply(override={}){return {ready:true,reason:'executor_ready',checked_at:'2026-09-29T12:00:00.000Z',expires_at:'2026-09-29T12:01:00.000Z',authorizes_activate:false,cache_identity_live_verified:false,...override};}
function fakePool(responses){
 const calls=[],released=[];let index=0;
 return {calls,released,pool:{async connect(){return {async query(sql,args){calls.push({sql,args});if(sql==='COMMIT'&&responses.commitError)throw Error('lost commit acknowledgement');if(sql.startsWith('SELECT crm_graph_candidate')){const value=responses.values[index++];if(value instanceof Error)throw value;return {rows:[{result:value}]};}return {command:sql==='COMMIT'?'COMMIT':sql==='ROLLBACK'?'ROLLBACK':undefined,rows:[]};},release(e){released.push(Boolean(e));}};}}};
}
test('disabled lease performs no query and never claims activation authority',async()=>{
 const f=fakePool({values:[]}),lease=createGraphWorkerLease({pool:f.pool,enabled:false,runtimeIdentity:()=>({revision:'x'}),workerSha:SHA,instanceId:INSTANCE});
 assert.deepEqual(await lease.start(),{ready:false,reason:'disabled',authorizes_activate:false});assert.equal(f.calls.length,0);assert.equal(lease.status().executor_ready,false);assert.equal(lease.status().authorizes_activate,false);await lease.stop();
});
test('confirmed COMMIT establishes only bounded local executor health and recomputes runtime identity',async()=>{
 let revision=1,now=1000;const f=fakePool({values:[reply(),reply()]}),lease=createGraphWorkerLease({pool:f.pool,enabled:true,runtimeIdentity:()=>({revision}),clock:()=>now,workerSha:SHA,instanceId:INSTANCE,setTimer:()=>({unref(){}}),clearTimer:()=>{}});
 assert.equal((await lease.start()).ready,true);assert.equal(lease.status().executor_ready,true);const first=f.calls.find(x=>x.args)?.args[2];
 revision=2;await lease.heartbeat();const hashes=f.calls.filter(x=>x.args).map(x=>x.args[2]);assert.notEqual(hashes.at(-1),first);assert.equal(lease.status().cache_identity_live_verified,false);assert.equal(lease.status().authorizes_activate,false);
 now+=60001;assert.equal(lease.status().executor_ready,false);assert.equal(lease.status().reason,'expired');await lease.stop();
});
test('roundtrip consumes the original lease window and runtime drift during the transaction is rejected after confirmed COMMIT',async()=>{
 let now=1000,revision=1;const slow=fakePool({values:[reply()]}),a=createGraphWorkerLease({pool:slow.pool,enabled:true,runtimeIdentity:()=>({revision}),clock:()=>{const v=now;now=61001;return v;},workerSha:SHA,instanceId:INSTANCE,setTimer:()=>({unref(){}}),clearTimer:()=>{}});
 await assert.rejects(a.start(),{code:'GRAPH_WORKER_LEASE_EXPIRED'});assert.equal(a.status().reason,'expired');assert.ok(slow.calls.some(x=>x.sql==='COMMIT'));await a.stop();
 let calls=0;const changed=fakePool({values:[reply()]}),b=createGraphWorkerLease({pool:changed.pool,enabled:true,runtimeIdentity:()=>({revision:++calls}),clock:()=>1000,workerSha:SHA,instanceId:INSTANCE,setTimer:()=>({unref(){}}),clearTimer:()=>{}});
 await assert.rejects(b.start(),{code:'GRAPH_WORKER_LEASE_IDENTITY_CHANGED'});assert.equal(b.status().reason,'identity_changed');assert.ok(changed.calls.some(x=>x.sql==='COMMIT'));await b.stop();
});
test('malformed or contradictory database replies roll back before establishing a lease',async()=>{
 for(const value of [{ready:false,reason:'executor_ready',authorizes_activate:false},{...reply(),extra:true},{...reply(),checked_at:undefined}]){const f=fakePool({values:[value]}),lease=createGraphWorkerLease({pool:f.pool,enabled:true,runtimeIdentity:()=>({revision:1}),workerSha:SHA,instanceId:INSTANCE,setTimer:()=>({unref(){}}),clearTimer:()=>{}});await assert.rejects(lease.start(),{code:'GRAPH_WORKER_LEASE_UNAVAILABLE'});assert.equal(f.calls.some(x=>x.sql==='COMMIT'),false);assert.equal(f.calls.some(x=>x.sql==='ROLLBACK'),true);await lease.stop();}
});
test('ready false is committed while uncertain COMMIT clears local authority and discards the connection',async()=>{
 const off=fakePool({values:[{ready:false,reason:'deployment_unavailable',authorizes_activate:false}]}),a=createGraphWorkerLease({pool:off.pool,enabled:true,runtimeIdentity:()=>({enabled:false}),workerSha:SHA,instanceId:INSTANCE,setTimer:()=>({unref(){}}),clearTimer:()=>{}});
 assert.equal((await a.start()).reason,'deployment_unavailable');assert.equal(a.status().executor_ready,false);assert.ok(off.calls.some(x=>x.sql==='COMMIT'));await a.stop();
 const uncertain=fakePool({values:[reply()],commitError:true}),b=createGraphWorkerLease({pool:uncertain.pool,enabled:true,runtimeIdentity:()=>({enabled:true}),workerSha:SHA,instanceId:INSTANCE,setTimer:()=>({unref(){}}),clearTimer:()=>{}});
 await assert.rejects(b.start(),{code:'GRAPH_WORKER_LEASE_OUTCOME_UNKNOWN'});assert.equal(b.status().executor_ready,false);assert.equal(b.status().reason,'outcome_unknown');assert.deepEqual(uncertain.released,[true]);await b.stop();
});
test('stop is idempotent and waits for an in-flight heartbeat without scheduling another',async()=>{
 let enter,release,scheduled=0;const entered=new Promise(r=>enter=r),hold=new Promise(r=>release=r),client={async query(sql){if(sql.startsWith('SELECT crm_graph_candidate')){enter();await hold;return {rows:[{result:reply()}]};}return {command:sql==='COMMIT'?'COMMIT':sql==='ROLLBACK'?'ROLLBACK':undefined,rows:[]};},release(){}},pool={async connect(){return client;}},lease=createGraphWorkerLease({pool,enabled:true,runtimeIdentity:()=>({revision:1}),workerSha:SHA,instanceId:INSTANCE,setTimer:()=>{scheduled++;return 1;},clearTimer:()=>{}});
 const starting=lease.start();await entered;let done=false;const stopping=lease.stop().then(()=>{done=true;});await new Promise(r=>setImmediate(r));assert.equal(done,false);release();await starting;await stopping;await lease.stop();assert.equal(scheduled,0);assert.equal(lease.status().reason,'stopped');
});
test('identity hashes are deterministic, ordered and change with source or effective runtime',()=>{
 assert.match(workerSha256(),/^[a-f0-9]{64}$/);
 assert.equal(runtimeSha256({b:2,a:1}),runtimeSha256({a:1,b:2}));assert.notEqual(runtimeSha256({a:1}),runtimeSha256({a:2}));
 const read=p=>Buffer.from(p.endsWith('a.cjs')?'A':'B');assert.equal(workerSha256({root:'/synthetic',files:['b.cjs','a.cjs'],readFile:read}),workerSha256({root:'/synthetic',files:['a.cjs','b.cjs'],readFile:read}));
 assert.notEqual(workerSha256({root:'/synthetic',files:['a.cjs'],readFile:()=>Buffer.from('A')}),workerSha256({root:'/synthetic',files:['a.cjs'],readFile:()=>Buffer.from('changed')}));
 assert.throws(()=>runtimeSha256({secret:undefined}),/IDENTITY/);
 const root=path.join(__dirname,'..'),files=new Set(WORKER_FILES);for(const file of files){if(!/\.(?:c?js)$/.test(file))continue;const source=fs.readFileSync(path.join(root,file),'utf8');for(const match of source.matchAll(/require\(['"](\.{1,2}\/[^'"]+)['"]\)/g)){let dependency=path.relative(root,path.resolve(root,path.dirname(file),match[1])).replaceAll('\\','/');if(!path.extname(dependency))dependency+='.js';assert.ok(files.has(dependency),file+' imports unhashed '+dependency);}}
});
