'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createProvider}=require('../n8n/growth/campaign-provider');
const def=()=>({schema_version:'crm-campaign-v1',brand:'fish',channel:'email',initiative:{key:'week',name:'Week'},utm_campaign:'week',name:'Name',subject:'Subject',from_email:'Fish <contato@fishermans.com.br>',reply_to:'contato@fishermans.com.br',list_ids:[3],template_id:1,html:'<a href="https://fishermans.com.br/products/x">x</a>{{ UnsubscribeURL }}',text:'https://fishermans.com.br/products/x {{ UnsubscribeURL }}',tags:[],send_at:null});
function fixture(){const calls=[];let compile={ok:true,templateVersion:'template-v1'};
 const provider=createProvider({query:async(sql,params)=>{const a=params[0],p=JSON.parse(params[1]);calls.push({a,p});if(a==='catalog')return {rows:[{result:{brand:'fish',current:true,lists:[{id:3,brand:'fish',available:true}],templates:[{id:1,type:'campaign',available:true,version:'template-v1'}],initiatives:[]}}]};return {rows:[{result:{id:1,status:'draft',sent:0,started_at:null,send_at:null,definition:def()}}]};},nativeCreate:async p=>{calls.push({a:'nativeCreate',p});return {id:1};},validateContent:async()=>compile});
 return {provider,calls,setCompile:v=>compile=v};}
test('native creation keeps scheduling off and embeds operation identity',async()=>{const f=fixture();await f.provider.createDraft({...def(),send_at:'2027-01-01T12:00:00Z'},{operationId:'op'});const p=f.calls.find(x=>x.a==='nativeCreate').p;assert.equal(p.send_at,null);assert.equal(p.attribs.crm.created_operation_id,'op');assert.equal(p.type,'regular');});
test('missing or stale content compilation never reaches an atomic write',async()=>{for(const proof of [null,{ok:false},{ok:true,templateVersion:'old'}]){const f=fixture();f.setCompile(proof);await assert.rejects(()=>f.provider.updateDraft(1,{definition:def()},{expectedVersion:'v',operationId:'op'}),e=>e.code==='CONTENT_UNVALIDATED'&&e.nothingChanged);assert.equal(f.calls.some(x=>x.a==='update'),false);}});
test('update binds exact campaign, template and operation versions to parameterized SQL',async()=>{const f=fixture();await f.provider.updateDraft(1,{definition:def()},{expectedVersion:'campaign-v1',operationId:'op'});const p=f.calls.find(x=>x.a==='update').p;assert.equal(p.expectedVersion,'campaign-v1');assert.equal(p.templateVersion,'template-v1');assert.equal(p.operationId,'op');});
test('server rejection is definitive but a timeout remains uncertain',async()=>{for(const error of [Object.assign(Error('VERSION_CONFLICT'),{code:'P0001'}),Error('timeout')]){const provider=createProvider({query:async()=>{throw error;},nativeCreate:async()=>{},validateContent:async()=>{}});await assert.rejects(()=>provider.schedule(1,{expectedVersion:'v',operationId:'op'}),e=>error.code==='P0001'?e.nothingChanged===true&&e.code==='VERSION_CONFLICT':!e.nothingChanged);}});
test('Olivas cannot reserve a new native draft in this stage',async()=>{const f=fixture(),d=def();d.brand='olivas';d.from_email=d.reply_to='sac@olivasdocampo.com';await assert.rejects(()=>f.provider.createDraft(d,{operationId:'op'}),e=>e.code==='BRAND_UNAVAILABLE');assert.equal(f.calls.length,0);});

test('database ownership conflicts return actionable errors without pretending a timeout rolled back',async()=>{
 for(const code of ['CAMPAIGN_EDITOR_REQUIRED','CAMPAIGN_REVIEW_REQUIRED','CAMPAIGN_DEPENDENCY_IN_USE']){
  const provider=createProvider({query:async()=>{throw Object.assign(Error(code),{code:'P0001'});},nativeCreate:async()=>{},validateContent:async()=>{}});
  await assert.rejects(()=>provider.schedule(1,{expectedVersion:'v',operationId:'op'}),e=>e.code===code&&e.status===409&&e.nothingChanged===true&&e.message!==code);
 }
});

test('database lock timeout, deadlock and serialization rollback are explicit conflicts',async()=>{
 for(const code of ['55P03','40P01','40001']){
  const provider=createProvider({query:async()=>{throw Object.assign(Error('database rollback'),{code});},nativeCreate:async()=>{},validateContent:async()=>{}});
  await assert.rejects(()=>provider.schedule(1,{expectedVersion:'v',operationId:'op'}),e=>e.code==='CAMPAIGN_BUSY'&&e.status===409&&e.nothingChanged===true);
 }
});
