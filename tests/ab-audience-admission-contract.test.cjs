'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../n8n/growth/ab-audience-admission-contract.cjs');
const H=require('../n8n/growth/segment-audience-review.cjs');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const clone=v=>JSON.parse(JSON.stringify(v));
const request=(brand='fish')=>({acao:C.ACTION,brand,test_id:id(1),expected_version:2,expected_scope_hash:'a'.repeat(64),review_id:id(2)});
function raw(brand='fish'){
 const start=brand==='fish'?100:200;
 return {test_id:id(1),brand,experiment_version:2,scope_hash:'a'.repeat(64),review_id:id(2),checked_at:'2026-09-28T15:00:00.000Z',expires_at:'2026-09-28T15:05:00.000Z',send_at:'2026-09-28T15:15:00.000Z',audience:{audience_id:id(3),audience_revision:3,cohort_hash:'b'.repeat(64),eligible_fingerprint:'c'.repeat(64),arms:['a','b'].map((arm,i)=>({arm,campaign_id:start+i,allocated:10,eligible:8,excluded:2,revoked:1,missing:1})),minimum_reached:true,checked_at:'2026-09-28T14:59:59.000Z',snapshot_only:true},materials:['a','b'].map((arm,i)=>({arm,campaign_id:start+i,campaign_version:String(i+1).repeat(32),material_hash:String(i+1).repeat(64)})),blockers:[...C.BLOCKERS]};
}
const rejects=(fn,code)=>assert.throws(fn,e=>e.code===code&&e.message===code&&e.status===C.ERROR_STATUS[code]);
for(const brand of ['fish','aristo'])test(`${brand}: exact request and sealed DTO remain inspection-only`,()=>{
 const p=request(brand),v=raw(brand),r=C.request(p),s=C.seal(v);
 assert.deepEqual(r,p);assert.notEqual(r,p);assert.equal(C.ENABLED,false);assert.equal(s.contract,C.VERSION);
 assert.deepEqual(C.inspection(v),v);assert.equal(s.inspection.inspection_hash,H.digest({contract:C.VERSION,inspection:v}));
 for(const [k,value]of Object.entries(C.FLAGS))assert.equal(s[k],value);
 assert.deepEqual(Object.keys(s).sort(),['contract','inspection',...Object.keys(C.FLAGS)].sort());
 assert.deepEqual(Object.keys(s.inspection).sort(),[...Object.keys(v),'inspection_hash'].sort());
 assert.equal(Object.isFrozen(s),true);assert.equal(Object.isFrozen(s.inspection.audience.arms[0]),true);assert.equal(Object.isFrozen(s.inspection.materials),true);assert.equal(Object.isFrozen(s.inspection.blockers),true);assert.equal(Object.isFrozen(r),true);
 v.audience.arms[0].eligible=0;p.expected_version=99;assert.equal(s.inspection.audience.arms[0].eligible,8);assert.equal(r.expected_version,2);
 assert.throws(()=>{s.authorizes_send=true;},TypeError);assert.throws(()=>{s.inspection.materials[0].material_hash='f'.repeat(64);},TypeError);
});
test('request rejects extra fields, missing fields, other actions and noncanonical identity',()=>{
 for(const key of ['authorization','key','token','sql','subscriber_ids','campaign_ids','materials','actor','inspection','authorizes_send']){const p=request();p[key]='secret';rejects(()=>C.request(p),'AB_ADMISSION_INPUT');}
 for(const key of Object.keys(request())){const p=request();delete p[key];rejects(()=>C.request(p),'AB_ADMISSION_INPUT');}
 const cases={acao:['ab_agendar',null],brand:['olivas','Fish',null],test_id:[id(1).replace('-4000-','-1000-'),id(1).replace('-8000-','-7000-'),null,1],review_id:[[],null,'not-a-uuid'],expected_version:[0,-1,1.5,'2',1000000000,NaN,Infinity],expected_scope_hash:['A'.repeat(64),'a'.repeat(63),null]};
 for(const [key,values]of Object.entries(cases))for(const v of values){const p=request();p[key]=v;rejects(()=>C.request(p),'AB_ADMISSION_INPUT');}
 assert.equal(C.request({...request(),expected_version:999999999}).expected_version,999999999);
});
test('inspection rejects raw content, flags, missing properties and nested leaks',()=>{
 for(const key of ['body','body_source','sql','subscribers','subscriber_ids','token','authorizes_send','execution_blocked','inspection_hash','contract']){const v=raw();v[key]='sensitive';rejects(()=>C.inspection(v),'AB_ADMISSION_CORRUPT');}
 for(const key of Object.keys(raw())){const v=raw();delete v[key];rejects(()=>C.inspection(v),'AB_ADMISSION_CORRUPT');}
 for(const path of ['audience','arm','material']){const v=raw(),target=path==='audience'?v.audience:path==='arm'?v.audience.arms[0]:v.materials[0];target.body='private';rejects(()=>C.seal(v),'AB_ADMISSION_CORRUPT');}
});
test('inspection identities, versions and every nested field are required',()=>{
 const cases={test_id:[null,id(1).replace('-4000-','-5000-')],review_id:[null,'not-an-id'],brand:['olivas','Fish',null],experiment_version:[0,1000000000,1.5,'2'],scope_hash:['A'.repeat(64),'a'.repeat(63),null]};
 for(const [key,values]of Object.entries(cases))for(const value of values){const v=raw();v[key]=value;rejects(()=>C.inspection(v),'AB_ADMISSION_CORRUPT');}
 for(const path of ['audience','arm','material']){const original=raw(),target=path==='audience'?original.audience:path==='arm'?original.audience.arms[0]:original.materials[0];for(const key of Object.keys(target)){const v=raw(),copyTarget=path==='audience'?v.audience:path==='arm'?v.audience.arms[0]:v.materials[0];delete copyTarget[key];rejects(()=>C.inspection(v),'AB_ADMISSION_CORRUPT');}}
 const v=raw();v.experiment_version=999999999;v.audience.audience_revision=999999999;assert.equal(C.inspection(v).experiment_version,999999999);
});
test('inspection enforces canonical UTC timestamps, review expiry and exact scheduling lead',()=>{
 for(const key of ['checked_at','expires_at','send_at'])for(const stamp of ['2026-09-28T15:00:00Z','2026-09-28T12:00:00.000-03:00','2026-02-30T15:00:00.000Z','2026-09-28T15:00:00.000z',0,null,[],new Date()]){const v=raw();v[key]=stamp;rejects(()=>C.inspection(v),'AB_ADMISSION_CORRUPT');}
 for(const stamp of ['2026-09-28T15:00:00.000Z','2026-09-28T14:59:59.999Z','2026-09-28T15:05:00.001Z']){const v=raw();v.expires_at=stamp;rejects(()=>C.inspection(v),'AB_ADMISSION_CORRUPT');}
 for(const stamp of ['2026-09-28T15:14:59.999Z','2026-09-28T14:00:00.000Z']){const v=raw();v.send_at=stamp;rejects(()=>C.inspection(v),'AB_ADMISSION_CORRUPT');}
 const v=raw();v.expires_at='2026-09-28T15:00:00.001Z';assert.equal(C.inspection(v).expires_at,v.expires_at);
});
test('audience counters retain review equations, allocation caps and positive identity',()=>{
 for(const [key,values]of Object.entries({allocated:[0,50001,'10',null],eligible:[-1,100001,1.5,NaN,-0],excluded:[-1,100001],revoked:[-1,100001],missing:[-1,100001],campaign_id:[0,2147483648,'100']}))for(const value of values){const v=raw();v.audience.arms[0][key]=value;rejects(()=>C.inspection(v),'AB_ADMISSION_CORRUPT');}
 for(const change of [a=>{a.eligible=7;},a=>{a.revoked=2;},a=>{a.missing=2;},a=>{a.arm='b';}]){const v=raw();change(v.audience.arms[0]);rejects(()=>C.inspection(v),'AB_ADMISSION_CORRUPT');}
 for(const value of [false,null,1,'true']){const v=raw();v.audience.minimum_reached=value;rejects(()=>C.inspection(v),'AB_ADMISSION_CORRUPT');}
 for(const key of ['audience_id','cohort_hash','eligible_fingerprint']){const v=raw();v.audience[key]='invalid';rejects(()=>C.inspection(v),'AB_ADMISSION_CORRUPT');}
 for(const value of [0,1000000000,1.5,'3']){const v=raw();v.audience.audience_revision=value;rejects(()=>C.inspection(v),'AB_ADMISSION_CORRUPT');}
 const max=raw();for(const a of max.audience.arms)Object.assign(a,{allocated:50000,eligible:50000,excluded:0,revoked:0,missing:0});assert.equal(C.inspection(max).audience.arms[0].allocated,50000);
});
test('audience explicitly retains its statement snapshot time rather than a serializable cutoff',()=>{
 for(const value of ['2026-09-28T15:00:00.001Z','2026-09-28T14:54:59.999Z','2026-09-28T14:59:59Z','2026-09-28T11:59:59.000-03:00','2026-02-30T14:59:59.000Z',null,0,[]]){const v=raw();v.audience.checked_at=value;rejects(()=>C.inspection(v),'AB_ADMISSION_CORRUPT');}
 for(const value of [false,null,1,'true']){const v=raw();v.audience.snapshot_only=value;rejects(()=>C.inspection(v),'AB_ADMISSION_CORRUPT');}
 for(const value of ['2026-09-28T14:55:00.000Z','2026-09-28T15:00:00.000Z']){const v=raw();v.audience.checked_at=value;assert.equal(C.inspection(v).audience.checked_at,value);}
 const v=raw(),before=C.seal(v).inspection.inspection_hash;v.audience.checked_at='2026-09-28T14:59:58.999Z';assert.notEqual(C.seal(v).inspection.inspection_hash,before);
});
test('both materials are mapped to the ordered unique campaign arms',()=>{
 const cases=[v=>{v.audience.arms.reverse();},v=>{v.audience.arms.pop();},v=>{v.audience.arms[1].campaign_id=v.audience.arms[0].campaign_id;},v=>{v.materials.reverse();},v=>{v.materials.pop();},v=>{v.materials.push(clone(v.materials[0]));},v=>{v.materials[0].campaign_id=999;},v=>{v.materials[0].arm='c';}];
 for(const change of cases){const v=raw();change(v);rejects(()=>C.inspection(v),'AB_ADMISSION_CORRUPT');}
 for(const key of ['campaign_version','material_hash'])for(const value of ['A'.repeat(key==='campaign_version'?32:64),'1'.repeat(key==='campaign_version'?31:63),null,1]){const v=raw();v.materials[0][key]=value;rejects(()=>C.inspection(v),'AB_ADMISSION_CORRUPT');}
});
test('blockers are fixed and cannot be omitted, reordered or used to claim readiness',()=>{
 for(const blockers of [[],[C.BLOCKERS[0]],[...C.BLOCKERS].reverse(),[...C.BLOCKERS,'extra'],[C.BLOCKERS[0],C.BLOCKERS[0]],null,'ready']){const v=raw();v.blockers=blockers;rejects(()=>C.seal(v),'AB_ADMISSION_CORRUPT');}
 assert.equal(Object.isFrozen(C.FLAGS),true);assert.equal(Object.isFrozen(C.BLOCKERS),true);
});
test('inspection hash pins valid dynamic values and ignores input object key order only',()=>{
 const original=raw(),s=C.seal(original),reordered=Object.fromEntries(Object.entries(original).reverse());assert.equal(C.seal(reordered).inspection.inspection_hash,s.inspection.inspection_hash);
 const changes=[v=>{v.test_id=id(4);},v=>{v.brand='aristo';},v=>{v.experiment_version++;},v=>{v.scope_hash='d'.repeat(64);},v=>{v.review_id=id(5);},v=>{v.checked_at='2026-09-28T14:59:59.999Z';v.expires_at='2026-09-28T15:04:59.999Z';},v=>{v.expires_at='2026-09-28T15:04:59.999Z';},v=>{v.send_at='2026-09-28T15:16:00.000Z';},v=>{v.audience.audience_id=id(6);},v=>{v.audience.audience_revision++;},v=>{v.audience.cohort_hash='d'.repeat(64);},v=>{v.audience.eligible_fingerprint='d'.repeat(64);},v=>{v.audience.arms[0].eligible--;v.audience.arms[0].excluded++;},v=>{v.materials[0].material_hash='d'.repeat(64);},v=>{v.materials[0].campaign_version='d'.repeat(32);},v=>{v.audience.arms[0].campaign_id=102;v.materials[0].campaign_id=102;}];
 for(const change of changes){const v=raw();change(v);assert.notEqual(C.seal(v).inspection.inspection_hash,s.inspection.inspection_hash);}
});
test('non-JSON inputs and excessive payloads fail with static errors without executing accessors',()=>{
 let invoked=0;const getter=request();Object.defineProperty(getter,'test_id',{enumerable:true,get(){invoked++;throw Error('secret');}});
 const proxy=new Proxy(request(),{ownKeys(){invoked++;throw Error('secret');}});
 const cyclic=request();cyclic.extra=cyclic;
 for(const v of [getter,proxy,cyclic,undefined,null,()=>{},new Date(),new Map(),{...request(),extra:'x'.repeat(20001)}])rejects(()=>C.request(v),'AB_ADMISSION_INPUT');
 assert.equal(invoked,0);
 const symbol=request();symbol[Symbol('secret')]='secret';rejects(()=>C.request(symbol),'AB_ADMISSION_INPUT');
 const sparse=raw();sparse.materials=new Array(2);rejects(()=>C.inspection(sparse),'AB_ADMISSION_CORRUPT');
 const hidden=raw();Object.defineProperty(hidden,'private',{value:'secret'});rejects(()=>C.inspection(hidden),'AB_ADMISSION_CORRUPT');
 const v=raw();v.audience.arms[0]=new Proxy(v.audience.arms[0],{getPrototypeOf(){invoked++;throw Error('secret');}});rejects(()=>C.seal(v),'AB_ADMISSION_CORRUPT');assert.equal(invoked,0);
});
