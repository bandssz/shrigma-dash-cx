'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const A=require('../n8n/growth/ab-audience-review-api.cjs'),R=require('../n8n/growth/ab-audience-review.cjs');
const uid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const request={acao:R.ACTIONS.review,brand:'fish',test_id:uid(1),expected_version:1,expected_scope_hash:'a'.repeat(64),operation_id:uid(2)};
const wire=(p=request,method='POST')=>({method,request:{headers:{Authorization:'Bearer synthetic-manager-key',Origin:'https://bandssz.github.io'},[method==='GET'?'query':'body']:p}});
const evidence=()=>({review_id:uid(3),test_id:uid(1),brand:'fish',experiment_version:1,scope_hash:'a'.repeat(64),cohort_hash:'b'.repeat(64),status:'confirmed',reason:null,checked_at:'2026-09-28T12:00:00.000Z',expires_at:'2026-09-28T12:05:00.000Z',arms:['a','b'].map((arm,i)=>({arm,campaign_id:100+i,allocated:2,eligible:2,excluded:0,revoked:0,missing:0})),minimum_reached:true,eligible_fingerprint:'c'.repeat(64),snapshot_only:true});
const success=()=>({_http:201,_body:{review:evidence(),...R.FLAGS}});
test('HTTP only takes credentials from the header, returns a closed snapshot and never enables execution',async()=>{
 let got;const api=A.createAudienceReviewAPI({store:{execute:async v=>{got=v;return success();}}}),r=await api.handle(wire());
 assert.equal(r.status,201);assert.deepEqual(got.request,request);assert.equal(got.key,'synthetic-manager-key');assert.equal(r.headers['Cache-Control'],'no-store');assert.equal(api.enabled,false);assert.equal(r.body.authorizes_send,false);
 assert.doesNotMatch(JSON.stringify(r),/subscriber_id|synthetic-manager-key/);
});
test('invalid input, injected identities, wrong methods and foreign origins never reach the store',async()=>{
 let calls=0;const api=A.createAudienceReviewAPI({store:{execute:async()=>{calls++;return success();}}});
 const cases=[wire({...request,actor:'panel:other'}),wire({...request,members:[1]}),wire({...request,test_id:[uid(1)]}),wire({...request,expected_scope_hash:['a'.repeat(64)]}),wire({...request,acao:[R.ACTIONS.review]}),wire({acao:[R.ACTIONS.get],brand:'fish',test_id:uid(1)},'GET'),wire({...request,brand:'olivas'}),wire(request,'GET'),wire({...request,operation_id:'bad'}),wire({...request,acao:'ab_agendar'}),{...wire(),method:'PUT'},wire({...request,extra:'x'.repeat(21000)})];
 const noauth=wire();delete noauth.request.headers.Authorization;cases.push(noauth);
 const double=wire();double.request.headers.authorization='Bearer synthetic-other-key';cases.push(double);
 const foreign=wire();foreign.request.headers.Origin='https://evil.invalid';cases.push(foreign);
 const query=wire();query.request.query={brand:'aristo'};cases.push(query);
 for(const item of cases){const r=await api.handle(item);assert.ok([400,401,403,405,413].includes(r.status),JSON.stringify(r));}
 assert.equal(calls,0);
});
test('bad service output remains uncertain without retry, including coercible IDs and hashes',async()=>{
 const changes=[r=>r._body.member_ids=[1],r=>r._body.authorizes_send=true,r=>r._body.review.subscriber_id=1,r=>r._body.review.review_id=[uid(3)],r=>r._body.review.test_id=[uid(1)],r=>r._body.review.scope_hash=['a'.repeat(64)],r=>r._body.review.cohort_hash=['b'.repeat(64)],r=>r._body.review.eligible_fingerprint=['c'.repeat(64)],r=>r._body.review.test_id=uid(99),r=>r._body.review.brand='aristo',r=>r._body.review.experiment_version=2,r=>r._body.review.arms[0].excluded=1,r=>r._body.review.arms[0].allocated=3,r=>r._body.review.checked_at='2026-02-30T12:00:00.000Z',r=>r._body.review.expires_at='2026-09-28T12:06:00.000Z',r=>r._http=200,r=>r._body.review.eligible_fingerprint='x'.repeat(64001)];
 for(const change of changes){const value=success();change(value);let calls=0;const api=A.createAudienceReviewAPI({store:{execute:async()=>{calls++;return value;}}}),r=await api.handle(wire());assert.equal(calls,1);assert.equal(r.status,202);assert.deepEqual(r.body,{error:'AB_AUDIENCE_REVIEW_UNCONFIRMED',state:'unconfirmed',operation_id:uid(2),automatic_retry:false});}
});
test('unavailable review has null derived counts and zero validity duration',async()=>{
 const unavailable=()=>{const r=success(),v=r._body.review;v.status='unavailable';v.reason='source_expired';v.expires_at=v.checked_at;v.minimum_reached=null;v.eligible_fingerprint=null;for(const a of v.arms)for(const k of ['eligible','excluded','revoked','missing'])a[k]=null;return r;};
 const value=unavailable(),api=A.createAudienceReviewAPI({store:{execute:async()=>value}});assert.equal((await api.handle(wire())).status,201);
 for(const change of [r=>r._body.review.expires_at='2026-09-28T12:01:00.000Z',r=>r._body.review.arms[0].eligible=0,r=>r._body.review.minimum_reached=false,r=>r._body.review.reason='secret-source-error']){const bad=unavailable();change(bad);assert.equal((await A.createAudienceReviewAPI({store:{execute:async()=>bad}}).handle(wire())).status,202);}
});
test('reads expose historical snapshots, empty latest and known errors; malformed readback returns 503',async()=>{
 const get={acao:R.ACTIONS.get,brand:'fish',test_id:uid(1)},operation={acao:R.ACTIONS.operation,brand:'fish',operation_id:uid(2)};
 for(const [p,result,status]of [[get,{_http:200,_body:{review:evidence(),...R.FLAGS}},200],[get,{_http:200,_body:{review:null,...R.FLAGS}},200],[operation,success(),201],[operation,{_http:404,_body:{error:'AB_AUDIENCE_REVIEW_OPERATION_UNCONFIRMED'}},404]]){const r=await A.createAudienceReviewAPI({store:{execute:async()=>result}}).handle(wire(p,'GET'));assert.equal(r.status,status);}
 for(const result of [{_http:200,_body:{review:{...evidence(),test_id:uid(9)},...R.FLAGS}},{_http:503,_body:{error:'connection-secret'}},{_http:202,_body:{error:'AB_AUDIENCE_REVIEW_UNCONFIRMED',state:'unconfirmed',operation_id:uid(2),automatic_retry:false}}])assert.deepEqual((await A.createAudienceReviewAPI({store:{execute:async()=>result}}).handle(wire(get,'GET'))).body,{error:'AB_AUDIENCE_REVIEW_UNCONFIRMED'});
});
