'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),API=require('../n8n/growth/ab-audience-admission-api.cjs'),D=require('../n8n/growth/ab-audience-admission-contract.cjs');
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),hash=n=>String(n).repeat(64),md5='a'.repeat(32);
function fixture(brand='fish'){
 const request={acao:D.ACTION,brand,test_id:id(1),expected_version:1,expected_scope_hash:hash(1),review_id:id(2)};
 const raw={test_id:id(1),brand,experiment_version:1,scope_hash:hash(1),review_id:id(2),checked_at:'2026-09-28T20:00:00.000Z',expires_at:'2026-09-28T20:05:00.000Z',send_at:'2026-09-28T21:00:00.000Z',audience:{audience_id:id(3),audience_revision:1,checked_at:'2026-09-28T19:59:59.900Z',snapshot_only:true,cohort_hash:hash(2),eligible_fingerprint:hash(3),arms:['a','b'].map((arm,i)=>({arm,campaign_id:100+i,allocated:2,eligible:2,excluded:0,revoked:0,missing:0})),minimum_reached:true},materials:['a','b'].map((arm,i)=>({arm,campaign_id:100+i,campaign_version:md5,material_hash:hash(i+4)})),blockers:['external_material_unconfirmed','execution_path_not_installed']};
 const input={method:'GET',request:{headers:{Authorization:'Bearer synthetic-manager-key'},query:request}};
 return {request,raw,input,body:D.seal(raw)};
}
const copy=v=>JSON.parse(JSON.stringify(v));
for(const brand of ['fish','aristo'])test(brand+': HTTP reader projects only the exact blocked inspection for the requested pins',async()=>{
 const f=fixture(brand);let called;const api=API.createAdmissionInspectionAPI({store:{execute:async args=>{called=args;return {_http:200,_body:f.body};}}});const r=await api.handle(f.input);
 assert.equal(r.status,200);assert.deepEqual(r.body,f.body);assert.equal(r.headers['Cache-Control'],'no-store');assert.equal(called.key,'synthetic-manager-key');assert.deepEqual(called.request,f.request);assert.equal(r.body.authorizes_send,false);
});
test('HTTP rejects writes, ambiguous credentials/origin and client-controlled private claims before store call',async()=>{
 let calls=0;const api=API.createAdmissionInspectionAPI({store:{execute:async()=>{calls++;throw Error();}}});
 for(const change of [v=>v.method='POST',v=>v.request.headers.authorization='Bearer another-valid-key',v=>v.request.headers.Origin='https://example.invalid',v=>v.request.query.actor='panel:manager',v=>v.request.query.material_hash=hash(1),v=>v.request.query.operation_id=id(9),v=>v.request.body={confirm:'schedule_both'},v=>delete v.request.headers.Authorization]){const v=copy(fixture().input);change(v);assert.ok([400,401,403,405].includes((await api.handle(v)).status));}assert.equal(calls,0);
});
test('HTTP suppresses any extra material, changed identity/hash, activated flag or fabricated write receipt',async()=>{
 const f=fixture();for(const mutate of [v=>v._body.inspection.secret='private',v=>v._body.inspection.materials[0].body='<html>private</html>',v=>v._body.authorizes_send=true,v=>v._body.inspection.inspection_hash=hash(9),v=>v._body=D.seal({...f.raw,brand:'aristo'}),v=>{v._http=202;v._body={error:'AB_ADMISSION_UNCONFIRMED',operation_id:id(5)};},v=>{v._http=409;v._body={error:'private exception'};},v=>{v._http=201;}]){
  const value={_http:200,_body:copy(f.body)};mutate(value);const api=API.createAdmissionInspectionAPI({store:{execute:async()=>value}});assert.deepEqual(await api.handle(f.input),{status:503,headers:{'Cache-Control':'no-store'},body:{error:'AB_ADMISSION_UNCONFIRMED'}});
 }
});
test('HTTP preserves enumerated read failures and maps uncertain response to 503 without retry state',async()=>{
 for(const [code,status]of [['SEGMENT_UNAUTHORIZED',401],['SEGMENT_ACCESS_DENIED',403],['AB_ADMISSION_REVIEW_EXPIRED',409],['AB_ADMISSION_MINIMUM',422],['AB_ADMISSION_SOURCE_UNAVAILABLE',503]]){const api=API.createAdmissionInspectionAPI({store:{execute:async()=>({_http:status,_body:{error:code}})}});assert.equal((await api.handle(fixture().input)).status,status);}
 const api=API.createAdmissionInspectionAPI({store:{execute:async()=>{throw Error('private secret');}}});assert.deepEqual((await api.handle(fixture().input)).body,{error:'AB_ADMISSION_UNCONFIRMED'});
});
