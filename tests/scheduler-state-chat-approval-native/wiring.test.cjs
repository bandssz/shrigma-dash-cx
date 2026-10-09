'use strict';
const test=require('node:test'),a=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const runtime=process.env.SCHEDULER_STATE_RUNTIME||path.resolve(__dirname,'../../services/dashboard-operational');
const {createSchedulerStateConsent}=require(runtime+'/native-scheduler-state-consent.cjs');
const {createSchedulerStateChatApproval}=require(runtime+'/native-scheduler-state-chat-approval.cjs');
const {createNativeMcp}=require(runtime+'/crm-native-mcp.cjs');
const {queryHash,resourceHash}=require(runtime+'/native-scheduler-state.cjs');
const connectionId='11111111-1111-4111-8111-111111111111',bearer='a'.repeat(43),host='gerencial.shrigma.com.br';
const mac=x=>crypto.createHmac('sha256','isolated-chat-integration-key').update(x).digest('hex');
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec('PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE crm_native_connections_v1(id TEXT PRIMARY KEY);');
 db.prepare('INSERT INTO users VALUES(?)').run('isolated-owner');db.prepare('INSERT INTO crm_native_connections_v1 VALUES(?)').run(connectionId);
 let allowed=true,callback=0,checks=0,revokeOnCheck=0;
 const authority={ownerId:'isolated-owner',ownerRevision:'1'.repeat(64),connectionHash:'2'.repeat(64),crmBindingHash:'3'.repeat(64),profileRevision:'4'.repeat(64),credentialBindingHash:'5'.repeat(64),resourceHash,queryHash};
 const post={nativeBearer:bearer,method:'POST',host,origin:'https://'+host,csrf:'isolated-actual-context'},get={...post,method:'GET'};
 const current=(context,id,browser)=>{if(browser===true||!allowed||id!==connectionId||context.nativeBearer!==bearer)throw Error('CURRENT refused');return {...authority};};
 const trusted=new WeakSet();
 const consent=createSchedulerStateConsent({db,current,mac,admitNativeApproval:args=>{checks++;if(revokeOnCheck&&checks>=revokeOnCheck)allowed=false;return allowed&&trusted.has(args);}});
 const chat=createSchedulerStateChatApproval({db,current,mac,authorizeBoundApproval:args=>{callback++;trusted.add(args);try{return consent.authorizeNativeBound(args);}finally{trusted.delete(args);}}});
 return {db,post,get,authority,consent,chat,callback:()=>callback,checks:()=>checks,revoke:()=>{allowed=false;},revokeDuringWrite:n=>{revokeOnCheck=n;}};
}
test('native fields or boolean approval cannot bypass private admission, old browser guard is intact',t=>{
 const f=fixture(t);
 a.throws(()=>f.consent.authorize({context:f.post,connectionId,consent:true}),{code:'SCHEDULER_STATE_BROWSER_CONSENT_REQUIRED'});
 a.throws(()=>f.consent.authorizeNativeBound({context:f.post,connectionId,authority:f.authority,approvalId:crypto.randomUUID()}),{code:'SCHEDULER_STATE_NATIVE_APPROVAL_REQUIRED'});
 a.throws(()=>f.consent.authorizeNativeBound({context:f.post,connectionId,authority:f.authority,approvalId:crypto.randomUUID(),approved:true}),{code:'SCHEDULER_STATE_ARGUMENTS_REFUSED'});
 a.equal(f.db.prepare('SELECT count(*) n FROM crm_scheduler_state_consent_v1').get().n,0);
});
test('durable exact-intent confirmation registers consent once; preparation/status never grant it',async t=>{
 const f=fixture(t),intent=f.chat.prepare({context:f.post,connectionId});
 a.equal(intent.state,'prepared');a.equal(intent.authorizesSend,false);
 a.throws(()=>f.consent.require({context:f.get,connectionId}),{code:'SCHEDULER_STATE_SEPARATE_CONSENT_REQUIRED'});
 a.equal(f.chat.status({context:f.get,connectionId,approvalId:intent.approvalId}).authorized,false);
 const approved=await f.chat.confirm({context:f.post,connectionId,approvalId:intent.approvalId,intentHash:intent.intentHash,decision:'approve'});
 a.equal(approved.state,'approved');a.equal(approved.authorized,true);a.equal(approved.authorizesRecovery,false);a.equal(approved.operational,false);
 a.deepEqual(f.consent.require({context:f.get,connectionId}),f.authority);
 for(let i=0;i<2;i++)await f.chat.confirm({context:f.post,connectionId,approvalId:intent.approvalId,intentHash:intent.intentHash,decision:'approve'});
 a.equal(f.callback(),1);a.equal(f.db.prepare('SELECT count(*) n FROM crm_scheduler_state_consent_v1').get().n,1);
 a.equal(JSON.stringify(approved).includes(bearer),false);a.equal(Object.hasOwn(approved,'authority'),false);
});
test('revocation during consent transaction rolls it back and consumes the approval as uncertain',async t=>{
 const f=fixture(t),intent=f.chat.prepare({context:f.post,connectionId});f.revokeDuringWrite(3);
 await a.rejects(f.chat.confirm({context:f.post,connectionId,approvalId:intent.approvalId,intentHash:intent.intentHash,decision:'approve'}));
 a.equal(f.callback(),1);a.equal(f.db.prepare('SELECT count(*) n FROM crm_scheduler_state_consent_v1').get().n,0);
 a.equal(f.db.prepare('SELECT state FROM crm_scheduler_state_chat_intent_v1').get().state,'uncertain');
});
test('changing original credential binding invalidates both the approval and recorded purpose consent',async t=>{
 const f=fixture(t),intent=f.chat.prepare({context:f.post,connectionId});
 await f.chat.confirm({context:f.post,connectionId,approvalId:intent.approvalId,intentHash:intent.intentHash,decision:'approve'});
 f.authority.credentialBindingHash='6'.repeat(64);
 a.throws(()=>f.chat.status({context:f.get,connectionId,approvalId:intent.approvalId}),{code:'SCHEDULER_CHAT_BINDING_CHANGED'});
 a.throws(()=>f.consent.require({context:f.get,connectionId}),{code:'SCHEDULER_STATE_SEPARATE_CONSENT_REQUIRED'});
 a.equal(f.callback(),1);
});
function mcpFixture({enabled=true,bridge=true,scopes=['crm.read','crm.iam'],revokeAfter=false}={}){
 const calls=[];let revoked=false;
 const store={authenticate:(_token,{scope}={})=>{if(revoked||scope&&!scopes.includes(scope))throw Object.assign(Error('NATIVE_SCOPE_DENIED'),{code:'NATIVE_SCOPE_DENIED'});return {id:connectionId,userId:'isolated-owner',brands:['fish','aristo'],scopes,host};},context:()=>({nativeBearer:bearer,host,origin:'https://'+host,csrf:'original-context',method:'GET'})};
 const mcp=createNativeMcp({auth:{nativeConnections:store,...(bridge?{nativeSchedulerStateChatApproval:{}}:{})},managerHost:host,schedulerStateEnabled:enabled,invoke:async q=>{calls.push(q);if(revokeAfter)revoked=true;return {status:200,body:{purpose:'crm.scheduler-state-read',operational:false}};}});
 return {mcp,calls};
}
test('approval MCP tools are unavailable when capability or actual bridge is absent',async()=>{
 for(const options of [{enabled:false},{bridge:false}]){const f=mcpFixture(options);await a.rejects(f.mcp.call('crm_scheduler_state_approval_prepare',{},bearer),{code:'NATIVE_TOOL_NOT_FOUND'});a.equal(f.calls.length,0);}
});
test('native preparation/confirmation/status use only fixed routes and original delegation context',async()=>{
 const f=mcpFixture(),approvalId=crypto.randomUUID(),intentHash='1'.repeat(64);
 await f.mcp.call('crm_scheduler_state_approval_prepare',{},bearer);
 await f.mcp.call('crm_scheduler_state_approval_confirm',{approvalId,intentHash,decision:'approve'},bearer);
 await f.mcp.call('crm_scheduler_state_approval_status',{approvalId},bearer);
 a.deepEqual(f.calls.map(q=>q.method),['POST','POST','GET']);
 a.deepEqual(f.calls.slice(0,2).map(q=>q.body),[{action:'prepare'},{action:'confirm',approvalId,intentHash,decision:'approve'}]);
 a(f.calls.every(q=>q.path.startsWith('/api/scheduler-state-approval')&&q.context.nativeBearer===bearer&&q.context.csrf==='original-context'));
 a(f.calls.every(q=>q.path!=='/api/scheduler-state-receipt'));
});
test('extra scope/SQL/actor/connection selectors and missing IAM or READ fail before dispatch',async()=>{
 for(const scopes of [['crm.read'],['crm.iam']]){const f=mcpFixture({scopes});await a.rejects(f.mcp.call('crm_scheduler_state_approval_prepare',{},bearer),{code:'NATIVE_SCOPE_DENIED'});a.equal(f.calls.length,0);}
 for(const args of [{connectionId},{sql:'SELECT private'}, {actor:'owner'}, {approved:true},{purpose:'crm.send'}]){const f=mcpFixture();await a.rejects(f.mcp.call('crm_scheduler_state_approval_prepare',args,bearer),{code:'NATIVE_ARGUMENTS_INVALID'});a.equal(f.calls.length,0);}
 const f=mcpFixture({revokeAfter:true});await a.rejects(f.mcp.call('crm_scheduler_state_approval_prepare',{},bearer),{code:'NATIVE_SCOPE_DENIED'});a.equal(f.calls.length,1);
});

