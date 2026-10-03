'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createCampaignBffClient}=require('./crm-campaign-bff-client.cjs');
const A='a'.repeat(32),B='b'.repeat(32),CSRF='c'.repeat(43),REVIEW='10000000-0000-4000-8000-000000000001';
const fields=(brand='fish',key='browser-attempt-key-0001')=>({brand,id:7,expected_version:A,idempotency_key:key,confirm:'agendar',audience_review_id:REVIEW});
function fixture(){
 const rows=new Map(),calls=[];let user='a',enabled=true,response='pending',transport;
 const getSession=()=>({authenticated:true,uiKey:'ui-'+user.repeat(32),csrf:CSRF,user:{role:'manager',areas:['growth'],permissions:{growth:{read:true,edit:true}}},features:{campaignSubmitWrite:enabled}});
 const id=q=>q.uiKey+':'+q.brand;
 const readJournal=q=>rows.get(id(q))??null,writeJournal=(q,row)=>rows.set(id(q),structuredClone(row));
 const answer=(action,key,state='pending',campaign=null,validation=null)=>({status:{pending:202,succeeded:200,rejected:409}[state],body:{schema:'crm-campaign-bff-operation-v1',action,attemptKey:key,state,campaign,validation}});
 const request=async q=>{
  calls.push(q);assert.equal(q.headers['X-CSRF-Token'],CSRF);assert.equal(q.path.startsWith('/'),true);assert.equal(q.path.includes('://'),false);
  const row=rows.get('ui-'+user.repeat(32)+':'+(q.body?.brand??new URL(q.path,'https://fixture.invalid').searchParams.get('brand')));
  if(q.method==='POST')assert.equal(row.phase,'pending','durable browser intent precedes request');
  if(transport)return transport(q,row);
  return answer(row.action,row.attemptKey,response,response==='succeeded'?{id:7,version:B,status:'scheduled',sent:0,startedAt:null,sendAt:'2026-10-03T14:00:00.000Z'}:null);
 };
 const make=()=>createCampaignBffClient({request,readJournal,writeJournal,getSession});
 return {rows,calls,make,answer,user:v=>{user=v;},enabled:v=>{enabled=v;},response:v=>{response=v;},transport:v=>{transport=v;},getSession,readJournal,writeJournal,request};
}
test('one POST after persisted intent; explicit repeats consult the same local key and pending never means ready',async()=>{
 const f=fixture(),c=f.make(),q=fields();const first=await c.schedule(q);assert.equal(first.state,'pending');assert.equal(first.campaign,null);assert.equal(f.calls[0].method,'POST');
 assert.equal(f.rows.get('ui-'+A+':fish').phase,'uncertain');await c.schedule(q);await c.consult('fish');assert.deepEqual(f.calls.map(v=>v.method),['POST','GET','GET']);
 await assert.rejects(c.schedule(fields('fish','browser-attempt-key-0002')),{code:'CAMPAIGN_BFF_PENDING'});assert.equal(f.calls.length,3);
 f.response('succeeded');const completed=await c.consult('fish');assert.equal(completed.state,'succeeded');assert.equal(f.rows.get('ui-'+A+':fish').phase,'succeeded');assert.equal(Object.isFrozen(completed.campaign),true);
});
test('timeout and404 preserve uncertainty after adapter restart; malformed replies never unlock another POST',async()=>{
 for(const output of [()=>{throw Error('PRIVATE_TIMEOUT');},()=>({status:404,body:{error:'NOT_FOUND',key:'PRIVATE_REPLY'}}),()=>({status:200,body:{schema:'crm-campaign-bff-operation-v1',state:'succeeded',key:'PRIVATE_REPLY'}})]){
  const f=fixture(),q=fields();f.transport(output);let error;try{await f.make().schedule(q);}catch(e){error=e;}assert.equal(error.code,'CAMPAIGN_BFF_UNCERTAIN');assert.equal(String(error).includes('PRIVATE'),false);
  await assert.rejects(f.make().consult('fish'),{code:'CAMPAIGN_BFF_UNCERTAIN'});await assert.rejects(f.make().schedule(fields('fish','browser-attempt-key-0002')),{code:'CAMPAIGN_BFF_PENDING'});assert.deepEqual(f.calls.map(v=>v.method),['POST','GET']);assert.equal(f.rows.get('ui-'+A+':fish').phase,'uncertain');
 }
});
test('A→B→A and Fish→Aristo→Fish conserve independent journal namespaces',async()=>{
 const f=fixture(),c=f.make();await c.schedule(fields());await c.schedule(fields('aristo'));f.user('b');await c.schedule(fields());
 assert.equal(f.rows.size,3);f.user('a');await c.consult('fish');assert.equal(f.calls.at(-1).method,'GET');assert.equal(f.calls.filter(q=>q.method==='POST').length,3);
 for(const [scope,row]of f.rows){assert.equal(row.phase,'uncertain');assert.equal(row.brand,scope.split(':')[1]);}
});
test('identity switches during an awaited response cannot commit success into the other user journal',async()=>{
 const f=fixture(),c=f.make();f.transport((q,row)=>{f.user('b');return f.answer(row.action,row.attemptKey,'succeeded',{id:7,version:B,status:'scheduled',sent:0,startedAt:null,sendAt:null});});
 await assert.rejects(c.schedule(fields()),{code:'CAMPAIGN_BFF_UNCERTAIN'});assert.equal(f.rows.get('ui-'+A+':fish').phase,'uncertain');assert.equal(f.rows.has('ui-'+B+':fish'),false);
});
test('four verbs use exact closed bodies; no bearer/k/endpoints can come from the caller',async()=>{
 const f=fixture();f.response('rejected');const c=f.make(),base={brand:'fish',id:7,expected_version:A};
 await c.save({...base,idempotency_key:'browser-save-existing-01',definition:{brand:'fish',send_at:'2026-10-03T14:00:00.000Z'}});
 await c.validate({...base,idempotency_key:'browser-review-existing-01'});await c.schedule(fields());await c.cancel({...base,idempotency_key:'browser-cancel-existing-01',confirm:'cancelar'});
 assert.deepEqual(f.calls.map(q=>q.body.acao),['campanha_salvar','campanha_validar','campanha_agendar','campanha_cancelar']);
 await assert.rejects(c.schedule({...fields(),k:'PRIVATE_KEY'}),{code:'CAMPAIGN_BFF_INPUT'});await assert.rejects(c.schedule({...fields(),endpoint:'https://outside.invalid'}),{code:'CAMPAIGN_BFF_INPUT'});
 f.enabled(false);await assert.rejects(c.consult('fish'),{code:'CAMPAIGN_BFF_DENIED'});assert.equal(f.calls.length,4);
});
test('validation DTO can supply review ID only for its own current campaign version; raw fields are refused',async()=>{
 const f=fixture(),c=f.make(),q={brand:'fish',id:7,expected_version:A,idempotency_key:'browser-review-existing-01'};
 const audience={policy:'listmonk-6.1-regular-v1',brand:'fish',list_ids:[125],eligible_count:2,unique_members_count:3,excluded_blocklisted_count:1,excluded_subscription_count:0,native_disabled_count:0,review_id:REVIEW,campaign_id:7,campaign_version:A,frozen:false,checked_at:'2026-10-03T12:00:00.000Z',expires_at:'2026-10-03T12:05:00.000Z'};
 f.transport((r,row)=>f.answer(row.action,row.attemptKey,'succeeded',{id:7,version:A,status:'draft',sent:0,startedAt:null,sendAt:'2026-10-03T14:00:00.000Z'},{policy:'crm-campaign-v1',version:A,ok:true,validatedAt:audience.checked_at,audience}));
 const v=await c.validate(q);assert.equal(v.validation.audience.review_id,REVIEW);assert.equal(Object.isFrozen(v.validation.audience.list_ids),true);
 f.transport((r,row)=>{const bad=f.answer(row.action,row.attemptKey,'succeeded',{id:7,version:B,status:'draft',sent:0,startedAt:null,sendAt:null},{policy:'crm-campaign-v1',version:A,ok:true,validatedAt:audience.checked_at,audience});return bad;});
 await assert.rejects(c.consult('fish'),{code:'CAMPAIGN_BFF_UNCERTAIN'});assert.equal(f.rows.get('ui-'+A+':fish').phase,'uncertain');
});
test('storage refusal prevents POST; same-owner calls coalesce until one request settles',async()=>{
 const f=fixture(),c=createCampaignBffClient({...f,writeJournal:()=>{throw Error('PRIVATE_QUOTA');}});await assert.rejects(c.schedule(fields()),{code:'CAMPAIGN_BFF_STORAGE'});assert.equal(f.calls.length,0);
 let release;const barrier=new Promise(r=>{release=r;});f.transport(async(q,row)=>{await barrier;return f.answer(row.action,row.attemptKey);});
 const g=f.make(),a=g.schedule(fields()),b=g.schedule(fields());release();await Promise.all([a,b]);assert.equal(f.calls.length,1);
});
test('false, no-op and partial journal writes cannot dispatch; void requires an exact persisted read-back',async()=>{
 for(const behavior of ['false','noop','partial']){
  const f=fixture(),writeJournal=(scope,row)=>{
   if(behavior==='false'){f.writeJournal(scope,row);return false;}
   if(behavior==='partial')f.writeJournal(scope,{...row,phase:'succeeded'});
  };
  const c=createCampaignBffClient({...f,writeJournal});
  await assert.rejects(c.schedule(fields()),{code:'CAMPAIGN_BFF_STORAGE'});assert.equal(f.calls.length,0);
 }
 const f=fixture(),c=createCampaignBffClient({...f,writeJournal:(scope,row)=>{f.writeJournal(scope,row);}});
 assert.equal((await c.schedule(fields())).state,'pending');assert.equal(f.calls.length,1);
});
test('historical validation with null proof closes the old attempt and permits a new explicit review',async()=>{
 const f=fixture(),q={brand:'fish',id:7,expected_version:A,idempotency_key:'browser-review-existing-01'};
 assert.equal((await f.make().validate(q)).state,'pending');
 f.transport((r,row)=>f.answer(row.action,row.attemptKey,'succeeded',{id:7,version:A,status:'draft',sent:0,startedAt:null,sendAt:'2026-10-03T14:00:00.000Z'},null));
 const historical=await f.make().consult('fish');
 assert.equal(historical.state,'succeeded');assert.equal(historical.validation,null);assert.equal(f.rows.get('ui-'+A+':fish').phase,'succeeded');
 f.transport((r,row)=>f.answer(row.action,row.attemptKey));
 assert.equal((await f.make().validate({...q,idempotency_key:'browser-review-existing-02'})).state,'pending');
 assert.deepEqual(f.calls.map(value=>value.method),['POST','GET','POST']);
 assert.equal(f.rows.get('ui-'+A+':fish').attemptKey,'browser-review-existing-02');
});
test('browser-compatible script loads without module/Buffer/timers/network/storage and makes no request at construction',()=>{
 const f=fixture(),context=vm.createContext({TextEncoder});vm.runInContext(fs.readFileSync(require.resolve('./crm-campaign-bff-client.cjs'),'utf8'),context);
 assert.equal(typeof context.ShrigmaCampaignBffClient.createCampaignBffClient,'function');context.ShrigmaCampaignBffClient.createCampaignBffClient(f);assert.equal(f.calls.length,0);
});
