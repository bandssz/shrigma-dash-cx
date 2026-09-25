'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const AB=require('../growth-ab-experiment-contract.js');
const config=()=>({contract:AB.CONTRACT,test_id:'00000000-0000-4000-8000-000000000001',brand:'fish',channel:'email',name:'Synthetic A/B',hypothesis:'Compare complete messages',arms:[{arm:'a',campaign_id:1,expected_version:'v1'},{arm:'b',campaign_id:2,expected_version:'v2'}],allocation:{method:'random-permutation-v1',a_basis_points:5000},rule:{method:AB.RULE,metric:'unique_tracked_click_per_allocated',window_hours:24,minimum_per_arm:100,minimum_effect_pp:1,alpha:0.05}});
function evidence(){return {contract:AB.CONTRACT,test_id:config().test_id,protocol:config(),integrity:{allocation_complete:true,assignment_disjoint:true,transport_bound:true,tracking_continuous:true,source_complete:true},arms:[{arm:'a',campaign_id:1,allocated:10000,unique_clickers:100,native_sent:9990,revoked:10,unknown:0,finished_before_deadline:true},{arm:'b',campaign_id:2,allocated:10000,unique_clickers:2000,native_sent:9800,revoked:200,unknown:0,finished_before_deadline:true}],window_start:'2026-09-25T12:00:00Z',window_end:'2026-09-26T12:00:00Z',as_of:'2026-09-26T12:00:00Z'};}
test('two distinct email arms, fixed allocation and predeclared supported rule only',()=>{
 assert.deepEqual(AB.protocol(config()),config());
 for(const mutate of [p=>p.brand='olivas',p=>p.channel='whatsapp',p=>p.arms[1].campaign_id=1,p=>p.rule.metric='utm_conversion',p=>p.rule.alpha=.1,p=>p.rule.window_hours=0,p=>p.allocation.a_basis_points=9999,p=>p.seed='caller-selected',p=>p.rule.minimum_effect_pp=NaN]){const p=config();mutate(p);assert.throws(()=>AB.protocol(p));}
});
test('fixed mature evidence can declare a rule-based winner, with no automatic sends',()=>{
 const p=config(),s=evidence(),before=JSON.stringify(s),r=AB.result(p,s);assert.equal(r.winner,'b');assert.equal(r.can_declare_winner,true);assert.equal(r.automatic_send,false);assert.equal(r.arms[1].rate,.2);assert.equal(r.arms[0].rate,.01);assert.equal(JSON.stringify(s),before);
 // Native sent is not the ITT denominator, and opt-out does not shrink allocation.
 assert.notEqual(r.arms[1].rate,s.arms[1].unique_clickers/s.arms[1].native_sent);
 const flip=evidence();[flip.arms[0].unique_clickers,flip.arms[1].unique_clickers]=[2000,100];assert.equal(AB.result(p,flip).winner,'a');
});
test('immature, tied, underpowered, interrupted or practically small results stay inconclusive',()=>{
 const cases=[s=>s.as_of='2026-09-26T11:59:59.999Z',s=>s.arms[1].unique_clickers=100,s=>s.arms[1].finished_before_deadline=false];
 for(const mutate of cases){const s=evidence();mutate(s);const r=AB.result(config(),s);assert.equal(r.winner,null);assert.equal(r.can_declare_winner,false);}
 const p=config();p.rule.minimum_per_arm=20000;assert.equal(AB.result(p,{...evidence(),protocol:p}).reason,'minimum_not_reached');p.rule.minimum_per_arm=100;p.rule.minimum_effect_pp=30;assert.equal(AB.result(p,{...evidence(),protocol:p}).winner,null);
});
test('missing/anonymous/cross-arm/deleted/out-of-range data never become zero or a winner',()=>{
 for(const mutate of [s=>s.integrity.transport_bound=false,s=>s.integrity.assignment_disjoint=false,s=>s.integrity.tracking_continuous=false,s=>s.integrity.source_complete=false,s=>s.arms[1].unknown=1,s=>s.arms[1].allocated=0,s=>s.arms[1].unique_clickers=null,s=>s.arms[0].native_sent=10001,s=>s.arms[1].native_sent=0,s=>s.window_end='2026-09-27T12:00:00Z',s=>s.protocol.rule.minimum_effect_pp=99]){
  const s=evidence();mutate(s);const r=AB.result(config(),s);assert.equal(r.status,'unknown');assert.equal(r.winner,null);assert.equal(r.arms,null);
 }
});
module.exports={config,evidence};
test('Fisher matches an independent integer-combination oracle, including zeros and unequal arms',()=>{
 const choose=(n,k)=>{let x=1n;for(let j=1;j<=k;j++)x=x*BigInt(n-j+1)/BigInt(j);return x;};
 const exact=(nA,xA,nB,xB)=>{const s=xA+xB,observed=choose(nA,xA)*choose(nB,xB);let tail=0n;for(let x=Math.max(0,s-nB);x<=Math.min(s,nA);x++){const w=choose(nA,x)*choose(nB,s-x);if(w<=observed)tail+=w;}return Number(tail)/Number(choose(nA+nB,s));};
 for(const nA of [1,5,10,20])for(const nB of [1,6,11,20])for(let xA=0;xA<=nA;xA++)for(let xB=0;xB<=nB;xB++)assert.ok(Math.abs(AB.fisher(nA,xA,nB,xB)-exact(nA,xA,nB,xB))<1e-10);
 assert.ok(Math.abs(AB.fisher(8,6,5,1)-.10256410256410256)<1e-12);
 assert.equal(AB.fisher(100000,0,100000,0),1);assert.ok(AB.fisher(100000,1000,100000,1500)<.05);
});
