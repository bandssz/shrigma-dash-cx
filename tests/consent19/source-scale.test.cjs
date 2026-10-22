'use strict';
const test=require('node:test'),a=require('node:assert/strict'),crypto=require('node:crypto'),S=require('./source.cjs');
const uid=n=>String(n).padStart(8,'0')+'-0000-4000-8000-000000000000',sha=x=>crypto.createHash('sha256').update(S.canonical(x)).digest('hex'),ok=x=>({status:200,body:{data:x}});
function fixture(brand='aristo',count=100001){
 const base=brand==='aristo'?16:17,origin=base+100,calls=[],states=new Map(Array.from({length:count},(_,i)=>[i+1,i%2?'unconfirmed':'confirmed'])),originStates=new Map([[base,'confirmed'],[origin,'confirmed']]),members=Array.from({length:count},(_,i)=>({id:i+1,uuid:uid(i+1)})),origins=[{id:base,uuid:uid(base),optin:'single',status:'active'},{id:origin,uuid:uid(origin),optin:'double',status:'active'}],createKey='bff-'+'a'.repeat(64),freezeKey=uid(42);
 const freeze={contract:'crm-native-frozen-list-v3',brand,audience_id:uid(41),audience_version:3,definition_hash:'d'.repeat(64),list_id:281,list_uuid:uid(281),list_optin:'single',eligible_count:count,members_sha256:sha(members.map(m=>m.id)),members_identity_sha256:sha(members.map(m=>[m.id,m.uuid])),members_state_sha256:sha([...states]),members_meta_sha256:'e'.repeat(64),base:structuredClone(origins[0]),origins:structuredClone(origins),checked_at:'2026-10-19T04:00:00.000Z',frozen_at:'2026-10-19T04:00:01.000Z',source_operation_sha256:null,sends:false,schedules:false};
 const campaign={id:211,uuid:uid(211),attribs:{crm:{policy:'crm-campaign-v1',brand,created_operation_id:uid(10)}},lists:[{id:281}]},operation={id:uid(10),operation_key:createKey,brand,action:'salvar',state:'succeeded',providerId:211,response:{status:201,body:{operation_id:uid(10),campaign:{id:211,status:'draft',sent:0,started_at:null,send_at:null,definition:{brand,list_ids:[281],send_at:null}}}}};
 const secret=crypto.randomBytes(32),sign=s=>crypto.createHmac('sha256',secret).update(s).digest('hex');
 const source=S.createSource({scope:async q=>{calls.push('scope');return{confirmed:true,list_id:281,list_uuid:uid(281),campaign_uuid:uid(211),created_operation_id:uid(10),freeze_key:freezeKey,eligible_count:count,members_sha256:sha(members.map(m=>m.id)),members_identity_sha256:sha(members.map(m=>[m.id,m.uuid])),members_state_sha256:sha([...states]),members_meta_sha256:'e'.repeat(64),member_uuid:q.subscriberId?uid(q.subscriberId):null};},sign,verify:(s,mac)=>sign(s)===mac,campaignRead:async()=>({status:200,body:{operation:structuredClone(operation)}}),audienceRead:async q=>{calls.push(q.acao);a.equal(q.acao,'segmento_congelamento_nativo_obter','V3 must not rebuild from the current audience head/catalog');return{status:200,body:structuredClone(freeze)};},audienceCount:async()=>{throw Error('V3_MUST_NOT_COUNT_CURRENT_PUBLIC');},api:async q=>{
  calls.push(q.resource);if(q.resource==='campaign')return ok(structuredClone(campaign));
  if(q.resource==='list')return ok(q.id===281?{id:281,uuid:uid(281),optin:'single',status:'active'}:structuredClone(origins.find(l=>l.id===q.id)));
  if(q.resource==='members'){const selected=members.filter(m=>!q.subscriptionStatus||states.get(m.id)===q.subscriptionStatus);return ok({results:selected.slice((q.page-1)*q.perPage,q.page*q.perPage).map(m=>({...m,lists:[{id:281,uuid:uid(281),subscription_status:states.get(m.id)}],email:'synthetic-'+m.id+'@example.invalid'})),page:q.page,per_page:q.perPage,total:selected.length});}
  if(q.resource==='subscriber'){const m=members.find(m=>m.id===q.id);return ok({...m,status:'enabled',email:'synthetic-'+m.id+'@example.invalid',lists:[{id:281,uuid:uid(281),subscription_status:states.get(m.id)},...origins.map(l=>({id:l.id,uuid:l.uuid,subscription_status:originStates.get(l.id)}))]});}
  if(q.resource==='unsubscribe'){a.equal(q.subscriberId,11);a(origins.some(l=>l.id===q.originId));originStates.set(q.originId,'unsubscribed');return ok(true);}throw Error('SYNTHETIC_ONLY_RESOURCE');
 }});
 return{source,calls,freeze,members,origins,states,originStates,campaign,operation,args:{brand,createKey,freezeKey}};
}


for(const brand of ['aristo','fish'])test('100001 frozen recipients keep compact provenance and zero member reads at registration; withdrawal retained '+brand,async()=>{
 const f=fixture(brand),p=await f.source.register(f.args);
 a.equal(p.members,undefined);a.equal(p.memberScope,'server');a.equal(p.freeze.eligible_count,100001);a.equal(f.calls.filter(x=>x==='members').length,0);a.equal(f.calls.filter(x=>x==='subscriber').length,0);
 a(Buffer.byteLength(JSON.stringify(p))<4096);a(!JSON.stringify(p).includes('email'));
 f.states.set(11,'unsubscribed');a.deepEqual((await f.source.plan(p)).member_ids,[11]);
 a.equal(f.calls.filter(x=>x==='unsubscribe').length,0);
});
test('historical large provenance remains readable and backup/confirm preserve the original record',t=>{
 const f=require('./store-fixture.cjs').fixture(t);
 f.p.members=Array.from({length:100001},(_,i)=>({id:i+1,uuid:uid(i+1)}));
 a(f.store.register(f.record,f.p));a.equal(f.store.list()[0].provenance.members.length,100001);
 a(f.store.backup(f.record,f.backup));a(f.store.confirm(f.record,{key:f.backup.key,scope:f.backup.scope,confirmedAt:4000,status:'unsubscribed'}));
 a.equal(f.store.list()[0].provenance.members.length,100001);a.equal(f.db.prepare('SELECT receipt_sha256 FROM crm_campaign_create_v1').get().receipt_sha256,f.prior.receipt_sha256);
});
