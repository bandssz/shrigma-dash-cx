'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const C=require('../audience-slice-contract.js'),K=require('../domain/audience-slices/kernel.cjs'),Boundary=require('../domain/audience-slices/provider-boundary.cjs');
const id=n=>'00000000-0000-4000-8000-'+n.toString(16).padStart(12,'0'),hash=c=>c.repeat(64),NOW=Date.parse('2026-10-06T12:00:00.000Z');
const distribution=(brand='fish')=>({schema:C.VERSION,brand,id:id(1),revision:1,key:hash('1'),identity_contract:K.IDENTITY,algorithm:K.ALGORITHM});
function plan(d=distribution(),ranges=[[0,2000],[2000,5000],[5000,10000]]){return {schema:C.VERSION,brand:d.brand,distribution_id:d.id,distribution_revision:d.revision,key_hash:K.keyHash(d),slices:ranges.map(([from_bp,to_bp],i)=>({id:id(10+i),name:'Etapa '+(i+1),from_bp,to_bp}))};}
const members=Array.from({length:1000},(_,i)=>id(i+100));
function source(d=distribution(),rows=members){return {schema:'crm-audience-slice-source-v1',brand:d.brand,audience_id:id(2),audience_revision:1,definition_hash:hash('2'),snapshot_id:id(3),source_hash:hash('3'),observed_at:new Date(NOW).toISOString(),expires_at:new Date(NOW+60000).toISOString(),complete:true,identity_complete:true,members:rows.slice()};}
function claims(d=distribution(),rows=[]){return {schema:'crm-audience-slice-claims-v1',brand:d.brand,distribution_id:d.id,distribution_revision:d.revision,key_hash:K.keyHash(d),revision:1,complete:true,claims:rows};}
function select(options={}){const d=options.distribution||distribution(),p=options.plan||plan(d);return K.select({plan:p,distribution:d,slice_id:p.slices[0].id,snapshot:source(d),claims:claims(d),now:NOW,...options});}
const campaign=()=>({brand:'fish',campaign_id:4,campaign_version:1,content_hash:hash('4'),audience_definition_hash:hash('2')});
function guards(selection,overrides={}){return {brand:'fish',campaign_id:4,campaign_version:1,content_hash:hash('4'),definition_hash:hash('2'),members_hash:selection.members_hash,observed_at:new Date(NOW).toISOString(),expires_at:new Date(NOW+60000).toISOString(),content_current:true,consent_current:true,bounce_current:true,frequency_current:true,...overrides};}
test('stable identity hashing partitions without overlap, rank or cardinality dependence',()=>{
 const d=distribution(),p=plan(d),parts=p.slices.map(s=>select({slice_id:s.id}));
 const all=parts.flatMap(s=>s.member_ids);assert.equal(all.length,members.length);assert.equal(new Set(all).size,members.length);
 for(const s of parts){assert.equal(s.authorizes_send,false);assert.equal(s.selected_count,s.member_ids.length);}
 const updated=source(d,[id(5000),...members.slice().reverse()]),later=select({snapshot:updated});
 assert.deepEqual(later.member_ids.filter(x=>x!==id(5000)),parts[0].member_ids);
 for(const subject of members.slice(0,20)){
  const bytes=crypto.createHash('sha256').update(JSON.stringify([C.VERSION,'bucket',d.brand,d.id,d.key,d.identity_contract,subject,0])).digest(),threshold=Math.floor(0x100000000/C.SCALE)*C.SCALE;
  const at=[0,4,8,12,16,20,24,28].find(at=>bytes.readUInt32BE(at)<threshold);
  assert.equal(K.bucket(d,subject),bytes.readUInt32BE(at)%C.SCALE);
 }
 assert.throws(()=>K.bucket(d,'user@example.test'),{code:'AUDIENCE_SLICE_IDENTITY'});
 assert.throws(()=>K.bucket(d,123),{code:'AUDIENCE_SLICE_IDENTITY'});
 assert.ok(members.slice(0,30).some(x=>K.bucket(d,x)!==K.bucket(distribution('aristo'),x)));
});
test('half-open intervals accept adjacent boundaries and reject overlap, duplicates and sparse ranges',()=>{
 assert.equal(C.includes({from_bp:0,to_bp:2000},1999),true);assert.equal(C.includes({from_bp:0,to_bp:2000},2000),false);assert.equal(C.includes({from_bp:2000,to_bp:5000},2000),true);
 const p=plan();assert.deepEqual(C.normalize({...p,slices:p.slices.slice().reverse()}),C.normalize(p));
 assert.throws(()=>C.normalize(plan(distribution(),[[0,2001],[2000,5000]])),{code:'AUDIENCE_SLICE_OVERLAP'});
 assert.throws(()=>C.normalize({...p,slices:[p.slices[0],{...p.slices[1],id:p.slices[0].id}]}),{code:'AUDIENCE_SLICE_OVERLAP'});
 assert.throws(()=>C.normalize({...p,slices:[,p.slices[1]]}),{code:'AUDIENCE_SLICE_PLAN'});
 assert.throws(()=>C.normalize({...p,slices:[{...p.slices[0],from_bp:0.5}]}),{code:'AUDIENCE_SLICE_RANGE'});
});
test('missing, expired or incomplete sources stay unavailable; confirmed empty has zero',()=>{
 for(const s of [null,{...source(),complete:false,members:null},{...source(),identity_complete:false,members:null},{...source(),expires_at:new Date(NOW).toISOString()}]){
  const result=select({snapshot:s});assert.equal(result.state,'unavailable');assert.equal(result.selected_count,null);assert.equal(result.member_ids,null);
 }
 assert.equal(select({snapshot:source(distribution(),[])}).selected_count,0);
 assert.throws(()=>select({snapshot:{...source(),members:[members[0],members[0]]}}),{code:'AUDIENCE_SLICE_SOURCE'});
 assert.throws(()=>select({snapshot:{...source(),members:[,members[0]]}}),{code:'AUDIENCE_SLICE_SOURCE'});
 assert.throws(()=>select({snapshot:{...source(),complete:false,members:[]}}),{code:'AUDIENCE_SLICE_SOURCE'});
 const hidden={...source()};Object.defineProperty(hidden,'members',{enumerable:true,get(){throw Error('not read');}});assert.throws(()=>select({snapshot:hidden}),{code:'AUDIENCE_SLICE_SHAPE'});
});
test('accepted, reserved and uncertain claims exclude contacts across manual campaigns; closed rejection needs receipt',()=>{
 const p=plan(distribution(),[[0,10000]]),first=select({plan:p}),states=['accepted','reserved','uncertain','rejected_before_send'];
 const ledger=claims(distribution(),states.map((state,i)=>({subject_id:first.member_ids[i],operation_id:id(50+i),state,receipt_hash:['accepted','rejected_before_send'].includes(state)?hash('5'):null})));
 const result=select({plan:p,claims:ledger});assert.equal(result.selected_count,members.length-3);assert.equal(result.excluded_claimed_count,3);assert.ok(result.member_ids.includes(first.member_ids[3]));
 assert.equal(select({plan:p,claims:{...ledger,complete:false,claims:null}}).selected_count,null);
 assert.throws(()=>select({plan:p,claims:{...ledger,claims:[{...ledger.claims[3],receipt_hash:null}]}}),{code:'AUDIENCE_SLICE_CLAIMS'});
 assert.throws(()=>select({plan:p,claims:{...ledger,claims:[ledger.claims[0],ledger.claims[0]]}}),{code:'AUDIENCE_SLICE_CLAIMS'});
});
test('brand, persisted key or distribution revision cannot silently change a saved plan',()=>{
 const d=distribution(),p=plan(d);
 for(const altered of [{...d,key:hash('6')},{...d,revision:2},distribution('aristo')])assert.throws(()=>select({plan:p,distribution:altered}),{code:'AUDIENCE_SLICE_DISTRIBUTION_CHANGED'});
 assert.throws(()=>select({claims:claims(distribution('aristo'))}),{code:'AUDIENCE_SLICE_CLAIMS'});
 assert.throws(()=>select({snapshot:source(distribution('aristo'))}),{code:'AUDIENCE_SLICE_SOURCE'});
});
test('readmission requires fresh content, consent, bounce and frequency and still cannot grant a send',()=>{
 const before=select(),input={before,current:select(),before_campaign:campaign(),current_campaign:campaign(),guards:guards(before),now:NOW};
 assert.equal(K.readmit(input).ready_for_atomic_claim,true);assert.equal(K.readmit(input).authorizes_send,false);
 for(const field of ['content_current','consent_current','bounce_current','frequency_current'])assert.equal(K.readmit({...input,guards:guards(before,{[field]:false})}).state,'unavailable');
 for(const altered of [{members_hash:hash('9')},{brand:'aristo'},{expires_at:new Date(NOW).toISOString()}])assert.equal(K.readmit({...input,guards:guards(before,altered)}).state,'unavailable');
 assert.equal(K.readmit({...input,now:NOW+60000}).state,'unavailable');
 assert.equal(K.readmit({...input,current_campaign:{...campaign(),content_hash:hash('7')}}).reason,'review_changed');
 assert.equal(K.readmit({...input,current:select({claims:{...claims(),revision:2}})}).reason,'review_changed');
 assert.equal(K.readmit({...input,current:select({snapshot:source(distribution(),[...members,id(5000)])})}).reason,'review_changed');
 const projected=JSON.stringify(K.projection(before));assert.ok(!projected.includes(members[0]));assert.ok(!projected.includes(distribution().key));assert.ok(!projected.includes('member_ids'));assert.ok(!projected.includes('key_hash'));
});
test('uncertain operation recovery only consults the original operation; never allocates or replays',()=>{
 for(const phase of ['reserved','uncertain','accepted','rejected_before_send']){
  const result=K.recoveryAction({brand:'fish',distribution_id:id(1),operation_id:id(70),phase});assert.equal(result.operation_id,id(70));assert.equal(result.automatic_replay,false);assert.equal(result.new_attempt_allowed,false);assert.equal(result.authorizes_send,false);
  if(['reserved','uncertain'].includes(phase))assert.equal(result.action,'consult_original');
 }
});
function persistentFixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'audience-slice-fixture-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const state={distribution:distribution(),source:source(),claims:claims(),campaign:campaign()};let writes=0,calls=[],guardOverrides={};
 const store=(name,v)=>fs.writeFileSync(path.join(dir,name+'.json'),JSON.stringify(v),{mode:0o600});for(const [name,v]of Object.entries(state))store(name,v);
 const read=name=>JSON.parse(fs.readFileSync(path.join(dir,name+'.json'),'utf8'));
 const provider={readDistribution:async r=>{calls.push(['distribution',r]);return read('distribution');},refreshAudience:async r=>{calls.push(['source',r]);return read('source');},readClaims:async r=>{calls.push(['claims',r]);return read('claims');},readCampaign:async r=>{calls.push(['campaign',r]);return read('campaign');},readSendGuards:async r=>{calls.push(['guards',r]);return guards({members_hash:r.members_hash},guardOverrides);},send(){writes++;},claim(){writes++;}};
 const request={brand:'fish',distribution_id:id(1),plan:plan(),slice_id:id(10),audience_id:id(2),audience_revision:1,campaign_id:4,campaign_version:1};
 return {provider,request,calls,store,read,setGuards:value=>{guardOverrides=value;},writes:()=>writes};
}
test('provider boundary is default OFF and makes no read or write even with a fully formed adapter',async t=>{
 const f=persistentFixture(t),service=Boundary.create({provider:f.provider});const result=await service.prepare(f.request);assert.equal(result.reason,'provider_integration_unavailable');assert.equal(result.selected_count,null);assert.equal(f.calls.length,0);assert.equal(f.writes(),0);
});
test('read-only provider preparation survives adapter restart using the persisted key and refreshes base before review',async t=>{
 const f=persistentFixture(t),create=()=>Boundary.create({provider:f.provider,enabled:true,clock:()=>NOW});
 const before=await create().prepare(f.request);assert.equal(before.state,'prepared');assert.equal(before.authorizes_send,false);
 const restarted=await create().prepare(f.request);assert.equal(restarted.selected_count,before.selected_count);assert.ok(f.calls.some(([name])=>name==='source'));assert.equal(f.writes(),0);
 f.store('source',source(distribution(),[...members,id(5000)]));const fresh=await create().prepare(f.request);assert.equal(fresh.selected_count,select({snapshot:f.read('source')}).selected_count);assert.equal(f.writes(),0);
});
test('review cannot be forged, reused or readmitted concurrently; claims remain an explicitly missing atomic write',async t=>{
 const f=persistentFixture(t),service=Boundary.create({provider:f.provider,enabled:true,clock:()=>NOW}),review=await service.prepare(f.request);
 assert.equal((await service.readmit({...review})).reason,'original_review_required');
 const [a,b]=await Promise.all([service.readmit(review),service.readmit(review)]);assert.equal(a.ready_for_atomic_claim,true);assert.equal(a.authorizes_send,false);assert.equal(b.reason,'original_review_required');assert.equal((await service.readmit(review)).reason,'original_review_required');assert.equal(f.writes(),0);assert.equal(f.calls.filter(([name])=>name==='guards').length,1);
});
test('an updated base, changed content or unknown guard invalidates review without any delivery or claim write',async t=>{
 const f=persistentFixture(t),service=Boundary.create({provider:f.provider,enabled:true,clock:()=>NOW});let review=await service.prepare(f.request);
 f.store('source',source(distribution(),[...members,id(5000)]));assert.equal((await service.readmit(review)).reason,'review_changed');
 review=await service.prepare(f.request);f.store('campaign',{...campaign(),content_hash:hash('8')});assert.equal((await service.readmit(review)).reason,'review_changed');
 review=await service.prepare(f.request);f.setGuards({content_hash:hash('8'),bounce_current:false});assert.equal((await service.readmit(review)).reason,'send_guards_unavailable');assert.equal(f.writes(),0);
});
