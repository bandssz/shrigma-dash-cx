'use strict';
const test=require('node:test'),a=require('node:assert/strict'),path=require('node:path');
const base=process.env.SCALE_AUDIENCE_RUNTIME||path.join(__dirname,'gateway/ops/releases/freeze-scale20/audience-source');
const F=require(base+'/segment-audience-native-freeze.cjs'),{createNativeAudienceAPI}=require(base+'/segment-audience-native-freeze-api.cjs');
test('new explicit reconciliation uses original receipt identity; never dispatches old freeze POST',async()=>{
 const id='40000000-0000-4000-8000-000000000001',key='40000000-0000-4000-8000-000000000002',q={acao:F.RECONCILE,brand:'aristo',id,expected_version:1,expected_definition_hash:'a'.repeat(64),expected_context_hash:'b'.repeat(64),expected_catalog_hash:'c'.repeat(64),idempotency_key:key,confirm:'reconciliar_intencao_original'};
 let reconciliations=0,oldPosts=0;const result={_http:200,_body:{contract:'crm-native-frozen-internal-list-v2',brand:'aristo',audience_id:id,audience_version:1,definition_hash:q.expected_definition_hash,list_id:281,list_uuid:'40000000-0000-4000-8000-000000000003',eligible_count:1,members_sha256:F.digest([26948228]),checked_at:new Date().toISOString(),schedules:false,sends:false,internal_test:true,source_operation_sha256:null}};
 const api=createNativeAudienceAPI({enabled:true,legacy:{handle(){throw Error('UNEXPECTED_LEGACY');}},freeze:{execute(){oldPosts++;throw Error('ORIGINAL_POST_FORBIDDEN');},recover(){throw Error('UNEXPECTED_READ');},reconcile:async({request})=>{a.deepEqual(request,q);reconciliations++;return result;}}});
 const input={method:'POST',request:{headers:{Authorization:'Bearer synthetic-key',Origin:'https://bandssz.github.io'},body:q}},r=await api.handle(input);a.equal(r.status,200);a.equal(r.body.list_id,281);a.equal(reconciliations,1);a.equal(oldPosts,0);
 const denied=await api.handle({...input,request:{...input.request,body:{...q,confirm:'wrong'}}});a.equal(denied.status,400);a.equal(reconciliations,1);
 const get=await api.handle({method:'GET',request:{headers:input.request.headers,query:q}});a.equal(get.status,405);a.equal(reconciliations,1);a.equal(oldPosts,0);
});
