'use strict';
const {test}=require('node:test'),a=require('node:assert/strict'),path=require('node:path');
const root=process.env.EDITORIAL_SOURCE_RUNTIME||path.join(__dirname,'source-candidate'),A=require(root+'/services/crm-campaign/editorial-admission.cjs'),C=require(root+'/n8n/growth/campaign-contract.js'),T=require(root+'/n8n/growth/campaign-tracking.js'),{createService}=require(root+'/n8n/growth/campaign-service.js');
const key='bff-'+ 'a'.repeat(64),auth={actor:'panel:synthetic-actor',caps:['read_content','draft','validate','submit']};
const definition=brand=>({schema_version:C.VERSION,brand,channel:'email',initiative:{key:'fixture',name:'Fixture'},utm_campaign:'fixture',name:'Fixture',subject:'Fixture',from_email:'contato@'+C.BRANDS[brand],reply_to:'contato@'+C.BRANDS[brand],list_ids:[17],template_id:1,html:'<form>Oferta</form><a href="https://'+C.STORES[brand]+'/discount/fixture">Oferta</a>',text:'Oferta',tags:[],send_at:null});
const catalog=brand=>({brand,current:true,lists:[{id:17,brand,available:true}],templates:[{id:1,type:'campaign',available:true}],initiatives:[]});
function reply(q,mode='gateway'){return new Response(JSON.stringify({schema:'crm-editorial-admission-v1',brand:q.brand,operationKey:q.operationKey,commandSha256:q.commandSha256,mode,diagnostics:[]}),{headers:{'content-type':'application/json'}});}
for(const brand of ['aristo','fish'])test(brand+': technical preparation keeps byte limits, sender, list, real ID and legacy editorial admission',()=>{
 const d=definition(brand),opts={catalog:catalog(brand),tracking:T,trackingId:701,editorialMode:'gateway'};
 a.throws(()=>C.preflightDraft(d,{...opts,editorialMode:'legacy'}),{code:'UNSUBSCRIBE_MISSING'});
 a.equal(C.preflightDraft(d,opts).html,d.html);const p=C.prepareSchedule(d,opts);a.equal(p.definition.html,d.html);a.equal(p.tracking.term,'lm-701-l17');
 for(const change of [{from_email:'private@outside.invalid'},{list_ids:[99]},{html:'x'.repeat(300001)}])a.throws(()=>C.prepareDraft({...d,...change},opts));
 a.throws(()=>C.prepareDraft(d,{...opts,trackingId:null}),{code:'TRACKING_ID_REQUIRED'});
});
test('one execution memoizes the same authenticated command, including replay, and cannot accept an echo for another hash',async()=>{
 let calls=0;const cmd={acao:'campanha_salvar',brand:'fish',definition:definition('fish'),idempotency_key:key},admit=A.createAdmission({key:'synthetic-bearer',actor:auth.actor,fetchImpl:async(url,o)=>{calls++;a.equal(url,A.DESTINATION);a.equal(o.headers.Authorization,'Bearer synthetic-bearer');a.equal(o.redirect,'manual');const q=JSON.parse(o.body);a.equal(q.sourceActor,auth.actor);a.equal(q.commandSha256,A.hash(cmd));return reply(q);}});
 a.deepEqual(await Promise.all([admit(auth,cmd),admit(auth,structuredClone(cmd))]),['gateway','gateway']);a.equal(calls,1);
 const invalid=A.createAdmission({key:'synthetic',actor:auth.actor,fetchImpl:async(_url,o)=>reply({...JSON.parse(o.body),commandSha256:'f'.repeat(64)})});await a.rejects(invalid(auth,cmd),{code:'EDITORIAL_ADMISSION_UNAVAILABLE'});
});
test('timeout/revocation/malformed responses never downgrade to legacy; a direct key remains legacy without a callback',async()=>{
 const cmd={acao:'campanha_salvar',brand:'fish',definition:definition('fish'),idempotency_key:key};
 for(const fetchImpl of [async()=>new Response('{}',{status:403}),async()=>new Response('not json'),async(_url,o)=>{throw Object.assign(Error('aborted'),{name:'AbortError'});}]){let calls=0;const admit=A.createAdmission({key:'synthetic',actor:auth.actor,fetchImpl:async(...args)=>{calls++;return fetchImpl(...args);}});await a.rejects(admit(auth,cmd));await a.rejects(admit(auth,cmd));a.equal(calls,1);a.equal(await admit(auth,{...cmd,idempotency_key:'direct_client_valid_key'}),'legacy');a.equal(calls,1);}
});
for(const mode of ['denied','offline'])test('source '+mode+' decision is rejected after original claim and before every provider mutation',async()=>{
 const events=[],store={claim:async p=>{events.push('claim');return{acquired:true,id:'operation',lease:'lease',hash:p.hash};},finish:async(_id,_lease,r)=>{events.push('finish');a.equal(r.state,'rejected');}},provider={createDraft:async()=>{events.push('CREATE');throw Error('MUST_NOT_WRITE');},updateDraft:async()=>{events.push('UPDATE');throw Error('MUST_NOT_WRITE');}};
 const admitEditorial=async()=>{events.push('gateway');throw Object.assign(Error('refused'),{code:mode==='denied'?'EDITORIAL_CONTENT_BLOCKED':'EDITORIAL_ADMISSION_UNAVAILABLE',status:mode==='denied'?422:503});};
 const s=createService({store,provider,admitEditorial}),r=await s.handle(auth,{acao:'campanha_salvar',brand:'fish',definition:definition('fish'),idempotency_key:key});a.equal(r.status,mode==='denied'?422:503);a.deepEqual(events,['claim','gateway','finish']);
});
test('current source definition is read and version checked before admitting VALIDATE or SCHEDULE',async()=>{
 for(const acao of ['campanha_validar','campanha_agendar']){const events=[],cmd={acao,brand:'fish',id:701,expected_version:'a'.repeat(32),idempotency_key:key},store={claim:async p=>({acquired:true,id:'operation',lease:'lease',hash:p.hash}),finish:async()=>{}},provider={get:async()=>{events.push('native-read');return{id:701,version:'b'.repeat(32),definition:definition('fish')};}};
 const r=await createService({store,provider,admitEditorial:async()=>{events.push('gateway');return'gateway';}}).handle(auth,cmd);a.equal(r.status,409);a.deepEqual(events,['native-read']);}
});
