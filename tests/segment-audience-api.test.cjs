'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const API=require('../n8n/growth/segment-audience-api.cjs'),F=require('./segment-audience-store-fixture.cjs');
const headers={authorization:'Bearer synthetic-manager-key'},payload={acao:'segmento_criar',brand:'fish',definition:F.definition(),idempotency_key:'synthetic-create-01',expected_catalog_hash:'a'.repeat(64)};
test('HTTP shape uses a single Bearer credential, strict fields/methods and exact numeric paging',()=>{
 assert.equal(API.parse({method:'POST',request:{headers,body:payload}}).route,'execute');
 const parsed=API.parse({method:'GET',request:{headers,query:{acao:'segmentos_listar',brand:'fish',limit:'10',offset:'0'}}});assert.deepEqual(parsed.request,{acao:'segmentos_listar',brand:'fish',limit:10,offset:0});
 for(const request of [{headers:{...headers,Authorization:headers.authorization},body:payload},{headers,body:{...payload,actor:'panel:other'}},{headers,body:{...payload,caps:['draft']}},{headers,body:payload,query:{brand:'aristo'}},{headers:{...headers,origin:'https://evil.test'},body:payload},{headers:{authorization:['Bearer synthetic-manager-key']},body:payload}])assert.equal(API.parse({method:'POST',request}).route,'response');
 assert.equal(API.parse({method:'GET',request:{headers,query:payload}}).response.status,405);
 for(const limit of ['1e2','01',' 2',0,101])assert.equal(API.parse({method:'GET',request:{headers,query:{acao:'segmentos_listar',brand:'fish',limit}}}).route,'response');
 const getter={};Object.defineProperty(getter,'method',{enumerable:true,get(){throw Error('getter ran');}});assert.equal(API.parse(getter).route,'response');
});
test('local handler projects uncertain writes and static read errors without leaking provider output',async()=>{
 const api=API.createAudienceAPI({store:{execute:async()=>{throw Error('private token');}}});
 const result=await api.handle({method:'POST',request:{headers,body:payload}});assert.equal(result.status,202);assert.deepEqual(result.body,{error:'SEGMENT_SERVICE_UNAVAILABLE',state:'unconfirmed',idempotency_key:payload.idempotency_key});assert.equal(result.headers['Cache-Control'],'no-store');
 assert.equal((await api.handle({method:'GET',request:{headers,query:{acao:'segmento_operacao',brand:'fish',idempotency_key:payload.idempotency_key}}})).status,503);
 assert.equal((await api.handle({method:'GET',request:{headers,query:{acao:'segmento_operacao_v2',brand:'fish',idempotency_key:payload.idempotency_key}}})).status,503);
 assert.equal(api.enabled,false);assert.equal(API.ENABLED,false);
});
test('v2 receipt projection rejects a mismatched action, key, brand or unconfirmed response',async()=>{
 const query={acao:'segmento_operacao_v2',brand:'fish',idempotency_key:'operation-v2-001'};
 const operation={schema:'crm-audience-operation-v2',idempotency_key:query.idempotency_key,brand:'fish',action:'segmento_salvar',actor_sha256:'b'.repeat(64),payload_sha256:'a'.repeat(64),receipt:{status:409,body:{error:'SEGMENT_VERSION_CONFLICT',current_version:2}}};
 let value={_http:200,_body:{operation}};
 const api=API.createAudienceAPI({store:{execute:async()=>value}});
 const read=()=>api.handle({method:'GET',request:{headers,query}});
 assert.equal((await read()).status,200);
 for(const invalid of [{...operation,action:'campanha_agendar'},{...operation,brand:'aristo'},{...operation,idempotency_key:'different-key'},{...operation,receipt:{status:404,body:{error:'SEGMENT_OPERATION_UNCONFIRMED'}}},{...operation,payload_sha256:'invalid'},{...operation,actor_sha256:'invalid'}]){
  value={_http:200,_body:{operation:invalid}};assert.equal((await read()).status,503);
 }
});
test('response projection rejects extra personal fields or a capability that contradicts an OFF catalog',async()=>{
 const api=API.createAudienceAPI({store:{execute:async()=>({_http:200,_body:{segments:[],limit:50,offset:0,catalog:{brand:'fish',current:false,coverage:'unconfirmed',checked_at:new Date().toISOString(),...F.source('fish'),lists:[]},capabilities:{draft:true,count:false,send:false},email:'private@example.test'}})}});
 const r=await api.handle({method:'GET',request:{headers,query:{acao:'segmentos_listar',brand:'fish'}}});assert.equal(r.status,503);assert.doesNotMatch(JSON.stringify(r),/private@example|email/);
});
