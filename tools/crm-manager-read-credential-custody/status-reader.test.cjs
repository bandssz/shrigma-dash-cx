'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{EventEmitter}=require('node:events');
const S=require('./status-reader.cjs'),R=require('./remote-operator.cjs'),P=require('./public-postcondition.cjs'),C=require('../crm-manager-read-activation-review/compose/build-compose.cjs');
const sources=Object.fromEntries(Object.keys(C.PINS).map(n=>[n,fs.readFileSync(path.join(__dirname,'../crm-manager-read-activation-review/runtime',n),'utf8')]));
function plan(){return R.buildStagePlan({suffix:crypto.randomBytes(6).toString('hex'),sources,intent:{schema:'crm-manager-read-runtime-intent-v1',operationId:crypto.randomUUID(),credentialIntentId:crypto.randomUUID(),action:'stage',fromPhase:'empty'},domainId:crypto.randomUUID()});}
function request(p,post=true){return{schema:post?'crm-manager-read-public-postcondition-request-v1':'crm-manager-read-public-status-request-v1',planSha256:p.planSha256,url:'https://'+p.descriptor.domain.host+'/status',method:'GET',maxBytes:post?4096:2048,timeoutMs:35000};}
const denied=e=>e?.message==='READ_STATUS_READER_REFUSED'&&e.cause===undefined;
function post(p){return{schema:'crm-manager-read-public-postcondition-v1',mode:p.mode,planSha256:p.planSha256,sourcePinsSha256:crypto.createHash('sha256').update(JSON.stringify(C.PINS)).digest('hex'),nineSourcesPinned:true,sourceReadOnly:true,sourceRootOwned:true,sourceModesVerified:true,ledgerPhase:'empty',ledgerEmpty:true,originalIntentHeld:false,ledgerPrivateOwned:true,uid1000:true,noNewPrivileges:true,capabilitiesEmpty:true,rootReadOnly:true,privateEnvironmentAbsent:true,postgresConnected:false,runtimeExecuted:false};}
function status(state='verified'){return{schema:'crm-manager-read-supervisor-v1',action:'stage',state,childExitConfirmed:state==='verified',proofBarrierConfirmed:state==='verified',proof:state==='verified'?{schema:'crm-manager-read-runtime-result-v1',action:'stage',state:'confirmed',phase:'staged',coreVerified:true,credentialBound:true,commitAck:true}:null};}
function wire(body,{code=200,headers,broken,error,splits}={}){
 const seen={calls:0,options:null,destroyed:0};
 const transport={request(options,callback){seen.calls++;seen.options=options;const req=new EventEmitter();req.destroy=()=>{seen.destroyed++;};req.end=()=>setImmediate(()=>{
  if(error){req.emit('error',Error('SYNTHETIC_RAW_SECRET'));return;}
  const res=new EventEmitter();res.statusCode=code;res.headers=headers||{'content-type':'application/json'};res.complete=false;res.destroy=()=>{seen.destroyed++;};callback(res);
  if(broken){res.emit('aborted');res.emit('error',Error('SYNTHETIC_RAW_SECRET'));return;}
  const b=Buffer.isBuffer(body)?body:Buffer.from(body);for(const chunk of(splits||[b]))res.emit('data',chunk);res.complete=true;res.emit('end');res.emit('close');
 });return req;}};return{transport,seen};
}
test('OFF does not read transport/getters or make network requests',async()=>{
 const t=new Proxy({}, {get(){throw Error('SHOULD_NOT_READ');},ownKeys(){throw Error('SHOULD_NOT_READ');}}),s=S.createStatusReader({enabled:false},t);assert.equal(s.enabled,false);await assert.rejects(s.observe({}),denied);
 let called=0;assert.throws(()=>S.createStatusReader({get enabled(){called++;return false;}}),denied);assert.equal(called,0);
});
test('literal GET uses TLS hostname verification and no cookies, authorization, redirect or body',async()=>{
 const p=plan(),w=wire(JSON.stringify(post(p))),s=S.createStatusReader({enabled:true,plan:p},w.transport),body=await s.observe(request(p));
 assert.deepEqual(P.acceptPostcondition(body,p),post(p));assert.equal(w.seen.calls,1);assert.equal(w.seen.options.hostname,p.descriptor.domain.host);assert.equal(w.seen.options.path,'/status');assert.equal(w.seen.options.method,'GET');assert.equal(w.seen.options.rejectUnauthorized,true);assert.equal(w.seen.options.servername,p.descriptor.domain.host);assert.equal(w.seen.options.agent,false);assert.deepEqual(Object.keys(w.seen.options.headers).sort(),['Accept','Connection','Host']);
});
test('foreign URL/SHA/schema/method/budget/timeout and extra fields are refused before request',async()=>{
 const p=plan(),w=wire(''),s=S.createStatusReader({enabled:true,plan:p},w.transport);
 for(const delta of[{url:'https://comando.shrigma.com.br/status'},{url:'https://'+p.descriptor.domain.host+'/status?secret=x'},{planSha256:'0'.repeat(64)},{schema:'arbitrary'},{method:'POST'},{maxBytes:8192},{timeoutMs:60000},{Authorization:'SYNTHETIC_ONLY'}])await assert.rejects(s.observe({...request(p),...delta}),denied);
 assert.equal(w.seen.calls,0);assert.throws(()=>S.createStatusReader({enabled:true,plan:{...p}},w.transport));
});
test('redirect, bad content metadata, oversized declared/streamed body and malformed UTF8 fail closed once',async()=>{
 const p=plan();for(const opt of[{code:302,headers:{'content-type':'application/json',location:'https://other.invalid'}},{headers:{'content-type':'text/html'}},{headers:{'content-type':'application/json','content-encoding':'gzip'}},{headers:{'content-type':'application/json','content-length':'4097'}},{headers:{'content-type':'application/json','content-length':'-1'}}]){const w=wire('{}',opt);await assert.rejects(S.createStatusReader({enabled:true,plan:p},w.transport).observe(request(p)),denied);assert.equal(w.seen.calls,1);}
 for(const body of [Buffer.alloc(4097,120),Buffer.from([0xff,10])]){const w=wire(body);await assert.rejects(S.createStatusReader({enabled:true,plan:p},w.transport).observe(request(p)),denied);assert.equal(w.seen.calls,1);}
});
test('unparsed errors, aborted streams and late errors do not expose upstream content or retry',async()=>{
 const p=plan();for(const opt of[{error:true},{broken:true}]){const w=wire('SYNTHETIC_RAW_SECRET',opt);await assert.rejects(S.createStatusReader({enabled:true,plan:p},w.transport).observe(request(p)),denied);assert.equal(w.seen.calls,1);assert.ok(w.seen.destroyed>0);}
});
test('status remains verified only with child exit and admitted proof; pending/unknown are not acceptance',async()=>{
 const p=plan();for(const state of['verified','pending','outcome_unknown','proof_refused']){const w=wire(JSON.stringify(status(state))),v=await S.createStatusReader({enabled:true,plan:p},w.transport).observe(request(p,false));assert.deepEqual(v,status(state));}
 for(const delta of[{childExitConfirmed:false},{proofBarrierConfirmed:false},{proof:{...status().proof,phase:'active'}},{credential:'SYNTHETIC_ONLY'}]){const w=wire(JSON.stringify({...status(),...delta}));await assert.rejects(S.createStatusReader({enabled:true,plan:p},w.transport).observe(request(p,false)),denied);}
});
test('duplicate overwritten JSON values are never returned from either public contract',async()=>{
 const p=plan(),raw=JSON.stringify(post(p)).replace('{','{"mode":"SYNTHETIC_RAW_SECRET",'),w=wire(raw),s=S.createStatusReader({enabled:true,plan:p},w.transport),out=await s.observe(request(p));assert.ok(!out.includes('SYNTHETIC_RAW_SECRET'));assert.deepEqual(JSON.parse(out),post(p));
 const rawStatus=JSON.stringify(status()).replace('{','{"state":"SYNTHETIC_RAW_SECRET",'),v=await S.createStatusReader({enabled:true,plan:p},wire(rawStatus).transport).observe(request(p,false));assert.ok(!JSON.stringify(v).includes('SYNTHETIC_RAW_SECRET'));
});
