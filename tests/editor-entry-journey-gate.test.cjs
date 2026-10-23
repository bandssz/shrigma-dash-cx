'use strict';
const test=require('node:test'),a=require('node:assert/strict'),{admitRequest}=require('../tools/crm-qa/editor-entry-journey.cjs'),{allow}=require('../tools/crm-qa/read-policy.cjs'),id='33333333-3333-4333-8333-333333333333',name='ci-synthetic',brand='aristo';
test('entry QA browser gate confines writes to the new synthetic definition and reviewed public',()=>{
 const q={action:'create',brand,expected_revision:0,mutationId:id,name:'[QA] Entradas CI '+name+' '+brand+' · público',kind:'audience_entry',days:90,waitMinutes:[0,4320],audienceId:'reviewed-public',audienceVersion:1},proof=()=>({expectedAction:'create',posts:[],expectedPublicId:'reviewed-public'}),p=proof();admitRequest(q,p,{brand,name});a.equal(p.posts.length,1);a.throws(()=>admitRequest(q,p,{brand,name}));
 for(const change of [{audienceId:'other-public'},{name:'Commercial'},{brand:'fish'},{days:89},{waitMinutes:[0,60]},{send:true},{context:{role:'superadmin'}},{personId:'real-customer'}])a.throws(()=>admitRequest({...q,...change},proof(),{brand,name}));
});
test('entry QA browser gate admits only frozen round advances without transport or customer evidence',()=>{
 const q={action:'advance',brand,expected_revision:3,mutationId:id,roundId:'new-round',minutes:1440,membership:'entered',payment:'paid',mailEvidence:'empty',afterEntry:'none',result:'simulated'},proof=()=>({expectedAction:'advance',posts:[],currentRound:'new-round'});admitRequest(q,proof(),{brand,name});
 for(const change of [{roundId:'old-round'},{minutes:5},{result:'sent'},{mailEvidence:'unknown'},{payment:'new-paid'}])a.throws(()=>admitRequest({...q,...change},proof(),{brand,name}));
 const base='https://crm.shrigma.com.br/api/journey-entry-qa';a(allow('GET',base+'?brand=aristo'));a(allow('GET',base+'?brand=aristo&mutationId='+id));for(const u of [base+'?brand=aristo&send=true',base+'?brand=aristo&brand=fish',base+'?brand=olivas','https://influs.shrigma.com.br/api/journey-entry-qa?brand=fish'])a.equal(allow('GET',u),false);a.equal(allow('POST',base,q),false);
});
