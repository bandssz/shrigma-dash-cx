'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{webcrypto}=require('node:crypto');
const {parseHTML}=require('linkedom'),root=path.resolve(__dirname,'..');
function boot({readFailure=false,readVersion=null,prepareError='REGULAR_ADMISSION_SENDER_UNAVAILABLE'}={}){
 const {document}=parseHTML('<section id="audience"></section>'),store=new Map(),calls=[],version='a'.repeat(32),flags={selector_ready:false,execution_blocked:true,authorizes_selection:false,authorizes_send:false};
 const binding={contract:'crm-audience-campaign-binding-v1',brand:'fish',campaign_id:100,campaign_version:version,binding_version:1,audience_id:'00000000-0000-4000-8000-000000000001',audience_revision:1,definition_hash:'b'.repeat(64),context_hash:'c'.repeat(64),base_list_id:17,catalog_hash:'d'.repeat(64),binding_hash:'e'.repeat(64),campaign_current:true,semantic_context:{currency:'BRL',timezone:'America/Sao_Paulo',current:true},...flags};
 const api={capabilities:{campaign_audience:{contract_version:binding.contract,brands:['fish'],read:true,inspect:true,bind:true,release:true,operation:true,validate:true,regular:{contract_version:'crm-audience-regular-admission-v1',prepare:true,schedule:true,operation:true}},segments:{contract_version:'crm-audience-v2',brands:['fish'],read:true},endpoints:{campaign_audience:'https://fixture.example.test/binding',segments:'https://fixture.example.test/segments'}}};
 const campaign={id:100,status:'draft',sent:0,started_at:null,version,send_at:'2030-10-12T15:00:00Z',definition:{name:'Synthetic campaign'}};
 const context=vm.createContext({URL,URLSearchParams,AbortController,TextEncoder,TextDecoder,crypto:webcrypto,setTimeout,clearTimeout,Intl,document,localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v)},navigator:{locks:{request:async(_key,_options,fn)=>fn({})}},fetch:async(url,init)=>{
  const request=init.method==='POST'?JSON.parse(init.body):Object.fromEntries(new URL(url).searchParams);calls.push({method:init.method,action:request.acao});
  const result=new URL(url).pathname==='/segments'?{status:503,body:{error:'SEGMENT_LIST_UNAVAILABLE'}}:init.method==='GET'?readFailure?{status:403,body:{error:'SEGMENT_ACCESS_DENIED'}}:{status:200,body:{binding,campaign_id:100,campaign_version:readVersion||version,...flags}}:{status:409,body:{error:prepareError}};
  return {status:result.status,json:async()=>structuredClone(result.body),text:async()=>JSON.stringify(result.body)};
 }});
 for(const file of ['n8n/growth/segment-contract.js','n8n/growth/segment-audience-contract.js','growth-segment-client.js','growth-campaign-audience-client.js','growth-campaign-regular-client.js','growth-campaign-audience-ui.js'])vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context,{filename:file});
 const ui=vm.runInContext('GCAudienceUI.create({element:document.getElementById("audience"),key:()=>"synthetic-access"})',context);
 assert.equal(ui.sync({brand:'fish',campaign,clean:true,api,blocked:false}),true);
 return {ui,calls,document,store,context:{brand:'fish',campaign,clean:true,api,blocked:false}};
}
test('sender refusal remains a preparation error after the first successful binding GET',async t=>{
 const x=boot();t.after(()=>x.ui.destroy());assert.equal(await x.ui.confirmBindingRead(),true);await x.ui.validate();
 const s=x.ui.contextStatus();assert.equal(s.readConfirmed,true);assert.equal(s.readError,false);assert.equal(s.errorPhase,'action');assert.match(s.errorMessage,/REGULAR_ADMISSION_SENDER_UNAVAILABLE/);
 assert.equal(s.bound,true);assert.equal(s.legacyBlocked,true);assert.equal(s.canSchedule,false);
 assert.deepEqual(x.calls,[{method:'GET',action:'campanha_publico_obter'},{method:'POST',action:'campanha_publico_preparar_envio'}]);
 assert.equal(await x.ui.confirmBindingRead(),true);assert.equal(x.ui.contextStatus().errorMessage,null);assert.equal(x.calls.filter(c=>c.action==='campanha_publico_preparar_envio').length,1);
});
test('failed binding GET still blocks preparation and scheduling',async t=>{
 const x=boot({readFailure:true});t.after(()=>x.ui.destroy());assert.equal(await x.ui.confirmBindingRead(),false);await x.ui.validate();
 const s=x.ui.contextStatus();assert.equal(s.readError,true);assert.equal(s.errorPhase,'binding-read');assert.equal(s.readConfirmed,false);assert.equal(s.canValidate,false);assert.equal(s.canSchedule,false);assert.equal(s.legacyBlocked,true);assert.equal(x.calls.length,1);
});
test('campaign version mismatch never becomes a confirmed binding',async t=>{
 const x=boot({readVersion:'f'.repeat(32)});t.after(()=>x.ui.destroy());assert.equal(await x.ui.confirmBindingRead(),false);
 assert.equal(x.ui.contextStatus().readError,true);assert.equal(x.ui.contextStatus().canValidate,false);assert.equal(x.calls.length,1);
});
test('unrecognized server text is not displayed and does not enable a fallback send',async t=>{
 const x=boot({prepareError:'private-do-not-display'});t.after(()=>x.ui.destroy());await x.ui.confirmBindingRead();await x.ui.validate();
 const s=x.ui.contextStatus();assert.equal(s.readError,false);assert.doesNotMatch(s.errorMessage,/private-do-not-display/);assert.equal(s.legacyBlocked,true);assert.equal(s.canSchedule,false);assert.equal(x.calls.length,2);
});
test('listing failure after a confirmed binding does not report a failed binding GET',async t=>{
 const x=boot();t.after(()=>x.ui.destroy());x.document.querySelector('[data-ca="load"]').click();
 for(let n=0;n<100&&x.ui.contextStatus().activeOperation;n++)await new Promise(setImmediate);
 const s=x.ui.contextStatus();assert.equal(s.readConfirmed,true);assert.equal(s.readError,false);assert.match(s.errorMessage,/não puderam ser listados/);assert.equal(s.canSchedule,false);assert.equal(s.legacyBlocked,true);
});
test('a reopened revision clears old feedback while requiring a new binding GET',async t=>{
 const x=boot();t.after(()=>x.ui.destroy());await x.ui.confirmBindingRead();await x.ui.validate();assert.match(x.ui.contextStatus().errorMessage,/SENDER_UNAVAILABLE/);
 assert.equal(x.ui.sync({...x.context,campaign:{...x.context.campaign,version:'f'.repeat(32)}}),true);
 const s=x.ui.contextStatus();assert.equal(s.errorMessage,null);assert.equal(s.readError,false);assert.equal(s.readConfirmed,false);assert.equal(s.canValidate,false);assert.equal(s.canSchedule,false);assert.equal(s.legacyBlocked,true);assert.equal(x.calls.length,2);
});
