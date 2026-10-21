'use strict';
const test=require('node:test'),a=require('node:assert/strict');
const {verifyOriginalCampaignBearer,CampaignWriterAttestationError,IDENTITY_URL}=require('../services/dashboard-operational/crm-campaign-writer-attestation.cjs');
const readerCaps=['read_content','list_history','submission'];
function identity(caps=readerCaps){return {schema:'shrigma_access_identity_v1',role:'manager',panel:'growth',owner:'reader@synthetic.invalid',allowedPanels:['growth'],permissions:{growth:{who:'panel:synthetic-original-reader',label:'reader@synthetic.invalid',caps},influs:null}};}
function source(value,seen=[]){return async(url,init)=>{seen.push({url,method:init.method,bearer:init.headers.Authorization});const r=new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});Object.defineProperties(r,{url:{value:IDENTITY_URL},type:{value:'basic'}});return r;};}
test('original READ actor/caps survive without writer promotion or bearer replacement',async()=>{
 const seen=[],r=await verifyOriginalCampaignBearer({bearer:'synthetic-original-key'},{fetchImpl:source(identity(),seen)});
 a.equal(r.actor,'panel:synthetic-original-reader');a.deepEqual(r.caps,readerCaps);a(!r.caps.some(x=>['draft','validate','submit'].includes(x)));a(Object.isFrozen(r.caps));
 a.deepEqual(seen,[{url:IDENTITY_URL,method:'GET',bearer:'Bearer synthetic-original-key'}]);
});
test('attestation retains original cap strings; downstream action chooses capability',async()=>{
 const caps=['read_content','submission','issuer_extension'];const r=await verifyOriginalCampaignBearer({bearer:'synthetic-original-key'},{fetchImpl:source(identity(caps))});a.deepEqual(r.caps,caps);a(!r.caps.includes('draft'));
});
test('panel writer keeps its original actor and caps',async()=>{
 const caps=['read_content','draft','validate','submit'];const r=await verifyOriginalCampaignBearer({bearer:'synthetic-original-key'},{fetchImpl:source(identity(caps))});a.deepEqual(r.caps,caps);a.equal(r.actor,'panel:synthetic-original-reader');
});
test('missing panel grant does not fabricate template-key or legacy READ authority',async()=>{
 const value=identity();value.permissions.growth=null;await a.rejects(verifyOriginalCampaignBearer({bearer:'synthetic-original-key'},{fetchImpl:source(value)}),CampaignWriterAttestationError);
});
test('malformed actor or nonstring capabilities fail closed',async()=>{
 for(const change of [v=>v.permissions.growth.caps.push(7),v=>v.permissions.growth.who='template:other-actor']){const value=identity([...readerCaps]);change(value);await a.rejects(verifyOriginalCampaignBearer({bearer:'synthetic-original-key'},{fetchImpl:source(value)}),CampaignWriterAttestationError);}
});
