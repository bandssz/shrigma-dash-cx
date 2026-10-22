'use strict';
const test=require('node:test'),a=require('node:assert/strict'),{fixture,uid}=require('./source-fixture.cjs'),{createConsentExecutor}=require('./transport.cjs');
for(const interruption of ['revocation','scope-change','disconnect'])test('rechecks immediately before PUT: '+interruption,async()=>{
 const f=fixture(),p=await f.source.register(f.args);f.setFrozen('unsubscribed');let changed=false,puts=0,identityReads=0;
 const executor=createConsentExecutor({enabled:true,pool:{query:async()=>{identityReads++;return{rows:[{auth:{actor:'panel:synthetic-actor',caps:changed&&interruption==='revocation'?['read_content']:['read_content','draft','validate','submit'],...(changed&&interruption==='scope-change'?{brand:'fish'}:{})}}]};}},campaignExecutor:({command})=>f.adapters.campaignRead(command),nativeConsent:{sign:f.adapters.sign,verify:f.adapters.verify,api:async q=>{if(q.resource==='unsubscribe')puts++;const result=await f.adapters.api(q);if(q.resource==='subscriber')changed=true;return result;}}});
 const r=await executor({key:'synthetic-original-key',command:{kind:'unsubscribe',brand:'aristo',provenance:p,member:{id:26948228,uuid:uid(11),originId:16,originUuid:uid(16),expectedOriginStatus:'confirmed'}},interrupted:()=>changed&&interruption==='disconnect'});
 a.equal(puts,0);a.equal(r.status===200,false);a(identityReads>=1);
});
test('unchanged original authority admits only the exact member origin and rechecks afterward',async()=>{
 const f=fixture(),p=await f.source.register(f.args);f.setFrozen('unsubscribed');let puts=0,identityReads=0;
 const executor=createConsentExecutor({enabled:true,pool:{query:async()=>{identityReads++;return{rows:[{auth:{actor:'panel:synthetic-actor',caps:['read_content','draft','validate','submit']}}]};}},campaignExecutor:({command})=>f.adapters.campaignRead(command),nativeConsent:{sign:f.adapters.sign,verify:f.adapters.verify,api:async q=>{if(q.resource==='unsubscribe')puts++;return f.adapters.api(q);}}});
 const r=await executor({key:'synthetic-original-key',command:{kind:'unsubscribe',brand:'aristo',provenance:p,member:{id:26948228,uuid:uid(11),originId:16,originUuid:uid(16),expectedOriginStatus:'confirmed'}}});
 a.equal(r.status,200);a.equal(puts,1);a.equal(identityReads,3);a(!JSON.stringify(r).includes('synthetic-original-key'));
});
