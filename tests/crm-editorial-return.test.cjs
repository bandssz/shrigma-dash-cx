'use strict';
// Recover an already admitted receipt after swapping to the legacy-write return.
// Uses the original CREATE engine, SQLite/AES journal and a synthetic provider.
const {test}=require('node:test'),a=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto'),fs=require('node:fs'),runtime=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational'),C=require(runtime+'/campaign-write-contract.js'),T=require(runtime+'/campaign-write-tracking.js'),{createCampaignCreator}=require(runtime+'/crm-campaign-create.cjs'),{fixture}=require('./dashboard-operational-campaign-create-fixture.cjs');
const prepared=(d,{catalog,id,now,legacyReceipt=false,editorialReceipt=false})=>{const p=editorialReceipt?C.prepareDraft(d,{catalog,tracking:T,trackingId:id,now,editorialMode:'gateway'}):legacyReceipt?C.prepare(d,{catalog,tracking:{...T,prepare:T.prepareLegacyReceipt},trackingId:id,now}):C.prepareDraft(d,{catalog,tracking:T,trackingId:id,now});return{definition:p.definition,tracking:p.tracking};};
for(const brand of ['aristo','fish'])for(const kind of ['form','iframe','without-unsubscribe','template-url'])test(brand+': legacy-write return recovers '+kind+' by original READ only',async t=>{
 const f=fixture(t),q=f.command('admitted_receipt_0001',brand),domain=C.STORES[brand],unsubscribe=kind==='without-unsubscribe'?'':'{{ UnsubscribeURL }}';q.definition.html=(kind==='form'?'<form action="https://'+domain+'/search"><input name="q"></form>':kind==='iframe'?'<iframe src="https://'+domain+'/pages/black"></iframe>':'')+'<a href="https://'+domain+'/products/synthetic?utm_campaign=old">Oferta</a>'+unsubscribe;q.definition.text='https://'+domain+'/products/synthetic '+unsubscribe;
 let visible=false,tampered=false,operation,campaign;
 if(kind==='template-url'){q.definition.html='<a href="https://'+domain+'/products/{{ .Subscriber.Attribs.handle }}?utm_campaign=old">Oferta</a>'+unsubscribe;q.definition.text='{{ printf "}} https://'+domain+'/pages/%s?utm_campaign=old" .Subscriber.Attribs.page }} '+unsubscribe;}
 f.origin.service={handle:async(_actor,wire)=>{
  if(wire.acao==='campanha_catalogo')return{status:200,body:f.origin.catalog(wire.brand)};
  if(wire.acao==='campanha_salvar'){
   const id=1001,stamp=new Date(f.options().now()).toISOString(),p=C.prepareDraft(wire.definition,{catalog:f.origin.catalog(brand),tracking:T,trackingId:id,editorialMode:'gateway'});campaign={id,version:'a'.repeat(32),status:'draft',sent:0,started_at:null,send_at:null,definition:p.definition};operation={id:crypto.randomUUID(),operation_key:wire.idempotency_key,brand,action:'salvar',state:'succeeded',providerId:id,response:null,created_at:stamp,updated_at:stamp};operation.response={status:201,body:{campaign,tracking:p.tracking,operation_id:operation.id}};throw Error('SYNTHETIC_ACK_LOST');
  }
  if(wire.acao==='campanha_operacao'){if(!visible)return{status:404,body:{error:'NOT_OBSERVED'}};const copy=structuredClone(operation);if(tampered)copy.response.body.tracking.changed_links++;return{status:200,body:{operation:copy}};}
  if(wire.acao==='campanha_obter')return{status:200,body:{campaign:structuredClone(campaign)}};
  throw Error('UNEXPECTED_SYNTHETIC_PROVIDER_ACTION');
 }};
 const admitted=createCampaignCreator({...f.options(),preflightDefinition:(d,{catalog,now})=>C.preflightDraft(d,{catalog,tracking:T,now,editorialMode:'gateway'}),prepareDefinition:prepared});a.equal((await admitted.submit(f.ctx,q)).state,'pending');const original=f.row(),posts=()=>f.calls.filter(x=>x.method==='POST').length;a.equal(posts(),1);a.equal(original.phase,'uncertain');
 const returned=createCampaignCreator({...f.options(),preflightDefinition:(d,{catalog,now})=>C.preflightDraft(d,{catalog,tracking:T,now}),prepareDefinition:prepared}),selector={brand,idempotency_key:q.idempotency_key};visible=true;tampered=true;a.equal((await returned.reconcile(f.ctx,selector)).state,'pending');a.equal(f.row().phase,'uncertain');tampered=false;const recovered=await returned.reconcile(f.ctx,selector);a.equal(recovered.state,'succeeded');a.equal(recovered.campaign.id,1001);a.equal(posts(),1);a.equal((await returned.reconcile(f.ctx,selector)).state,'succeeded');
 for(const key of ['remote_key','input_ciphertext','normalized_ciphertext','normalized_sha256','catalog_ciphertext','catalog_sha256'])a.equal(f.row()[key],original[key]);
 await a.rejects(returned.reconcile({...f.ctx,userId:crypto.randomUUID()},selector),{code:'CAMPAIGN_CREATE_UNKNOWN'});
 if(kind!=='template-url')try{a.equal((await returned.submit(f.ctx,{...q,idempotency_key:'after_return_rejected_0002'})).state,'rejected');}catch(e){a(['HTML_ACTIVE_CONTENT','UNSUBSCRIBE_MISSING'].includes(e.code));}a.equal(posts(),1);
});
test('return auth retains both receipt alternatives privately while all new writes remain legacy',()=>{
 const source=fs.readFileSync(runtime+'/auth.cjs','utf8');a.equal((source.match(/editorialReceipt=false/g)||[]).length,2);a.equal((source.match(/editorialMode:'gateway'/g)||[]).length,2);a.equal(source.includes('campaignEditorialAdmission'),false);a.equal(source.includes('campaignEditorialMode'),false);
 a.equal(C.isInternalTest({id:270,definition:{brand:'fish',tags:['crm-internal-test']}}),true);a.throws(()=>C.schedule({confirm:'agendar'},{id:185,definition:{brand:'aristo'}},{canPublish:true}),{code:'TEST_CAMPAIGN_INTERNAL_ONLY'});
});
