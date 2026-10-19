'use strict';
const {test,after}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs');
const {createFixture,closeAll}=require('/delta/native-transition-fixture.cjs'),{Pool}=require('/v3/pg-driver.cjs');
const Source=require('/current-source/n8n/growth/segment-audience-store.cjs'),{createTransaction}=require('/current-source/services/crm-audience/transaction.cjs'),Freeze=require('/v3/audience-freeze.cjs');
const Audience=require('/current-source/n8n/growth/segment-audience-contract.js');
after(closeAll);
const sha=Freeze.digest,authKey='synthetic-native-owner';
let f,freeze,transaction,pool;after(async()=>pool?.end());
function definition(brand,list,suffix){const domain=brand==='aristo'?'oaristocrata.com':'fishermans.com.br';return{schema_version:'crm-campaign-v1',brand,channel:'email',name:'Synthetic campaign '+brand+' '+suffix,subject:'Synthetic subject',from_email:'avisos@'+domain,reply_to:'contato@'+domain,initiative:{key:'synthetic-'+suffix,name:'Synthetic '+suffix},utm_campaign:'synthetic-'+suffix,list_ids:[list],template_id:brand==='aristo'?3:1,html:'<a href="https://'+domain+'/products/qa">QA</a> {{ UnsubscribeURL }}',text:'https://'+domain+'/products/qa {{ UnsubscribeURL }}',tags:['qa-native19'],send_at:null};}
async function create(brand,snap,suffix,legacy=false){const d=definition(brand,snap.list_id,suffix);if(legacy)d.name='[QA SAB17] Agenda nativa '+brand+' '+suffix;const r=await f.run({acao:'campanha_salvar',brand,idempotency_key:'synthetic-create-'+brand+'-'+suffix,definition:d});a.equal(r.status,201,JSON.stringify(r));return r.body.campaign;}
async function schedule(brand,c,suffix){let r=await f.run({acao:'campanha_salvar',brand,id:c.id,expected_version:c.version,idempotency_key:'synthetic-save-'+brand+'-'+suffix,definition:{...c.definition,send_at:new Date(Date.now()+30*60000).toISOString()}});a.equal(r.status,200,JSON.stringify(r));c=r.body.campaign;r=await f.run({acao:'campanha_validar',brand,id:c.id,expected_version:c.version,idempotency_key:'synthetic-review-'+brand+'-'+suffix});a.equal(r.status,200,JSON.stringify(r));const q={acao:'campanha_agendar',brand,id:c.id,expected_version:c.version,idempotency_key:'synthetic-schedule-'+brand+'-'+suffix,confirm:'agendar',audience_review_id:r.body.validation.audience.review_id};r=await f.run(q);a.equal(r.status,200,JSON.stringify({r,events:f.events.slice(-4)}));a.equal(r.body.campaign.status,'scheduled');return{q,r};}
async function cancel(brand,c,suffix){const q={acao:'campanha_cancelar',brand,id:c.id,expected_version:c.version,idempotency_key:'synthetic-cancel-'+brand+'-'+suffix,confirm:'cancelar'},r=await f.run(q);a.equal(r.status,200,JSON.stringify({r,events:f.events.slice(-4)}));a.equal(r.body.campaign.status,'draft');a.equal(r.body.campaign.send_at,null);return{q,r};}
async function snapshot(cid){return(await f.admin.query('SELECT crm_audience_v2.native_internal_snapshot_v1($1) live,crm_audience_v2.native_internal_snapshot_history_v1($1) history',[cid])).rows[0];}
async function newPublic(brand,suffix){const id=brand==='aristo'?'30000000-0000-4000-8000-000000000001':'30000000-0000-4000-8000-000000000002',base=brand==='aristo'?16:17,extra=brand==='aristo'?116:117,d=Audience.normalize({schema_version:'crm-audience-v2',brand,name:'Synthetic generic '+brand+' '+suffix,rule:{op:'or',rules:[{op:'in_list',list_id:base},{op:'in_list',list_id:extra}]}});
 const current=await transaction(async tx=>{await tx.query(Source.SQL.setup);return Source.readCatalog(tx.query,brand);}),context=Source.pins(d,current);
 await f.admin.query('INSERT INTO crm_audience_v2.audience(id,brand,version,definition,definition_hash,context,context_hash,archived,name) VALUES($1,$2,1,$3,$4,$5,$6,false,$7)',[id,brand,d,sha(d),context,sha(context),d.name]);
 return{id,request:{acao:Freeze.ACTION,brand,id,expected_version:1,expected_definition_hash:sha(d),expected_context_hash:sha(context),expected_catalog_hash:current.catalog.catalog_hash,idempotency_key:'synthetic-freeze-'+brand+'-'+suffix}};
}
test('selected-list-first consent lifecycle preserves every guard and compatible return, both brands',async t=>{
 f=await createFixture(process.env.SHRIGMA_LOCAL_TEST_DB);await f.admin.query(fs.readFileSync('/delta/native-recovery-install.prepared.sql','utf8'));
 await f.admin.query("ALTER TABLE public.subscriber_lists ADD COLUMN meta jsonb NOT NULL DEFAULT '{}',ADD COLUMN created_at timestamptz,ADD COLUMN updated_at timestamptz");
 await f.admin.query("CREATE TYPE public.list_optin AS ENUM('single','double');CREATE TYPE public.list_status AS ENUM('active','archived');ALTER TYPE public.frozen_list_type RENAME TO list_type;ALTER TYPE public.frozen_membership_status RENAME TO subscription_status;ALTER TABLE public.lists ALTER COLUMN optin TYPE public.list_optin USING optin::public.list_optin,ALTER COLUMN status TYPE public.list_status USING status::public.list_status,ALTER COLUMN optin SET NOT NULL,ALTER COLUMN status SET NOT NULL;ALTER TABLE public.subscriber_lists ALTER COLUMN status SET NOT NULL");
 const legacy={};
 for(const brand of ['aristo','fish']){const receipt=await f.freezeBrand(brand,'synthetic-legacy-freeze-'+brand),c=await create(brand,receipt,'legacy',true);legacy[brand]={receipt,c,s:await snapshot(c.id)};}
 await f.admin.query(fs.readFileSync('/v3/install.owner.sql','utf8'));
 const selectedBefore=(await f.admin.query("SELECT count(*)::integer n FROM pg_proc WHERE pronamespace='crm_audience_v2'::regnamespace")).rows[0].n;
 await f.admin.query("CREATE OR REPLACE FUNCTION crm_audience_v2.native_internal_snapshot_v1(pid integer) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $snapshot$"+fs.readFileSync('/v3/consent-live19/candidate.body.sql','utf8')+"$snapshot$;");
 a.equal((await f.admin.query("SELECT md5(prosrc) body_md5 FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.native_internal_snapshot_v1(integer)')")).rows[0].body_md5,'e2034c34dfc4832cb8ad4e2423d5f3b8');
 a.equal((await f.admin.query("SELECT count(*)::integer n FROM pg_proc WHERE pronamespace='crm_audience_v2'::regnamespace")).rows[0].n,selectedBefore);

 await t.test('v2 live and history JSON remain identical; commercial stays boolean false',async()=>{for(const brand of ['aristo','fish']){const x=legacy[brand];a.deepEqual(await snapshot(x.c.id),x.s);const r=await f.run({acao:'campanha_nativa_contexto',brand,id:x.c.id});a.equal(r.body.commercial,false);a.equal(r.body.internal_test,true);}});
 pool=new Pool({host:'127.0.0.1',user:'crm_audience_api',database:process.env.SHRIGMA_LOCAL_TEST_DB,max:2});transaction=createTransaction({pool,statementTimeoutMs:8000});freeze=Freeze.createInternalFreeze({transaction,source:Source});
 const saved={};
 for(const brand of ['aristo','fish'])await t.test(brand+' preserves original consent, opt-in and nested meta; native schedule/cancel uses one frozen list',async()=>{
  const base=brand==='aristo'?16:17,member=brand==='aristo'?11:31;
  await f.admin.query("UPDATE public.subscriber_lists SET status='unconfirmed',meta=$3 WHERE subscriber_id=$1 AND list_id=$2",[member,base,{nested:{z:2,a:['c',null,4]},purpose:'synthetic-only'}]);
  const p=await newPublic(brand,'general'),full=await freeze.execute({key:authKey,request:p.request}),r=full._body;a.equal(r.contract,'crm-native-frozen-list-v3');a.equal(r.list_optin,'single');a(r.eligible_count>1);a.deepEqual(r.origins.map(l=>l.id),[base,base+100]);
  const row=(await f.admin.query('SELECT l.optin,sl.status,sl.meta FROM public.lists l JOIN public.subscriber_lists sl ON sl.list_id=l.id WHERE l.id=$1 AND sl.subscriber_id=$2',[r.list_id,member])).rows[0];a.equal(row.optin,'single');a.equal(row.status,'unconfirmed');a.deepEqual(row.meta,{nested:{z:2,a:['c',null,4]},purpose:'synthetic-only'});
  const ids=(await f.admin.query('SELECT sl.subscriber_id id,sl.status,s.uuid FROM public.subscriber_lists sl JOIN public.subscribers s ON s.id=sl.subscriber_id WHERE sl.list_id=$1 ORDER BY sl.subscriber_id',[r.list_id])).rows;
  a.equal(r.members_sha256,sha(ids.map(x=>x.id)));a.equal(r.members_state_sha256,sha(ids.map(x=>[x.id,x.status])));a.equal(r.members_identity_sha256,sha(ids.map(x=>[x.id,x.uuid])));
  a.deepEqual(await freeze.execute({key:authKey,request:p.request}),full);a.deepEqual(await freeze.recover({key:authKey,request:{acao:Freeze.RECOVER,brand,idempotency_key:p.request.idempotency_key}}),full);
  const c=await create(brand,r,'general');const s=await snapshot(c.id);a.equal(s.history.freeze_contract,r.contract);a.equal(s.live.freeze_contract,r.contract);
  const context=await f.run({acao:'campanha_nativa_contexto',brand,id:c.id});a.equal(context.body.commercial,true);a.equal(context.body.internal_test,false);a.equal(context.body.eligible,true);
  const scheduled=await schedule(brand,c,'general');const end=await cancel(brand,scheduled.r.body.campaign,'general');const native=await f.currentNative(c.id);a.equal(native.lists.length,1);a.equal(native.lists[0].id,r.list_id);a.equal(native.status,'draft');a.equal(native.send_at,null);a.equal(native.sent,0);saved[brand]={p,full,c:end.r.body.campaign,member,base};
 });
 a(saved.aristo&&saved.fish,'Both serial brand paths must pass before dependent cases');
 await t.test('v3 lost clear acknowledgement is recovered from the same operation without another PUT',async()=>{
  const x=saved.fish,scheduled=await schedule('fish',x.c,'lost-clear'),c=scheduled.r.body.campaign,q={acao:'campanha_cancelar',brand:'fish',id:c.id,expected_version:c.version,idempotency_key:'synthetic-cancel-fish-lost-clear',confirm:'cancelar'};
  f.setAfterCommitHook(({input,res})=>{if(input?.send_at===null)res.destroy();});let first;try{first=await f.run(q);}finally{f.setAfterCommitHook(null);}a.equal(first.status,502);
  const op=await f.run({acao:'campanha_operacao',brand:'fish',idempotency_key:q.idempotency_key});a.equal(op.body.operation.state,'succeeded');a.equal(op.body.operation.response.body.campaign.send_at,null);const n=f.events.length,again=await f.run(q);a.equal(again.status,200);a.equal(f.events.length,n);x.c=again.body.campaign;
 });
 await t.test('creation receipt list is authoritative; attaching a list later is refused',async()=>{
  const x=saved.aristo,c=x.c,op=(await f.admin.query("SELECT id,response FROM public.shrigma_campaign_operation WHERE provider_id=$1 AND action='salvar' AND response->'status'='201'::jsonb",[c.id])).rows[0];
  await f.admin.query("UPDATE public.shrigma_campaign_operation SET response=jsonb_set(response,'{body,campaign,definition,list_ids}','[16]'::jsonb) WHERE id=$1",[op.id]);a.equal((await snapshot(c.id)).history,null);
  await f.admin.query('UPDATE public.shrigma_campaign_operation SET response=$2 WHERE id=$1',[op.id,op.response]);a.equal((await snapshot(c.id)).history.freeze_contract,'crm-native-frozen-list-v3');
 });
 await t.test('live changes after withdrawal while history remains for cancellation',async()=>{
  const x=saved.aristo,scheduled=await schedule('aristo',x.c,'consent-change');await f.admin.query("UPDATE public.subscriber_lists SET status='unsubscribed' WHERE list_id=$1 AND subscriber_id=$2",[x.base,x.member]);a.equal((await snapshot(x.c.id)).live,null);a.equal((await snapshot(x.c.id)).history.freeze_contract,'crm-native-frozen-list-v3');
  x.c=(await cancel('aristo',scheduled.r.body.campaign,'consent-change')).r.body.campaign;
 });
 await t.test('compatible return closes new v3 schedule/freeze but keeps replay and native cancellation',async()=>{
  const x=saved.fish,scheduled=await schedule('fish',x.c,'return');await f.admin.query(fs.readFileSync('/v3/consent-live19/return-compatible.owner.sql','utf8'));
  a.deepEqual(await freeze.execute({key:authKey,request:x.p.request}),x.full);
  await a.rejects(freeze.execute({key:authKey,request:{...x.p.request,idempotency_key:'synthetic-freeze-fish-after-return'}}),e=>e.message==='NATIVE_V3_NEW_FREEZE_CLOSED');
  const done=await cancel('fish',scheduled.r.body.campaign,'return');a.equal(done.r.body.campaign.send_at,null);const before=f.events.length;
  await a.rejects(schedule('fish',done.r.body.campaign,'closed'));a.equal(f.events.slice(before).some(e=>e.method==='PUT'&&e.status==='scheduled'),false);
 });
});
