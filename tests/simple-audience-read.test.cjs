'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const runtime=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational');
const {createReader}=require(runtime+'/simple-dashboard-read.cjs'),P=require(runtime+'/proxy.cjs');
const KEY='synthetic-service-read-key',STAMP='2026-10-13T09:00:00.000Z',ID='00000000-0000-4000-8000-000000000001';
function fixture({brand='fish',front='growth',mixed=false,refused=false,revoke=false,missing=false}={}){
 let calls=0,active=true;
 const user={id:'synthetic-reader',role:'manager',areas:[front],permissions:{growth:{read:true,edit:false}},productFronts:[front],brands:[brand],jobTitle:'gestor de CRM'};
 const auth={authorize(){return user},authorizeBrand(_ctx,b){if(!active||front!=='growth'||b!==brand)throw Object.assign(Error('ACCESS_DENIED'),{code:'ACCESS_DENIED',status:403});return user}};
 const row={id:ID,brand,name:'Público sintético',definition:{schema_version:'crm-audience-v2',brand,name:'Público sintético',rule:{op:'in_list',list_id:17}},version:1,archived:false,created_at:STAMP,updated_at:STAMP,updated_by:'panel:'+KEY,semantic_context:{currency:'BRL',timezone:'America/Sao_Paulo',current:true}};
 const catalog={brand,current:true,currency:'BRL',timezone:'America/Sao_Paulo',shop_id:null,fields:[],products:[],origins:[],lists:[{id:17,brand,name:'Lista sintética',available:true}],coverage:'unconfirmed',checked_at:STAMP,catalog_hash:'a'.repeat(64)};
 const upstreams={segments:new URL(P.REVIEWED_DYNAMIC.routes.segments),'crm-read':new URL(P.FIXED_DESTINATIONS['crm-read'])};
 const reader=createReader({auth,upstreams,keys:{growth:'synthetic-cache-only-key',...(!missing?{audiences:KEY}:{})},projectGrowth:()=>({brand}),fetchImpl:async(url,options)=>{
  calls++;assert.equal(options.method,'GET');const q=new URL(url).searchParams;assert.equal(options.headers.Authorization,'Bearer '+(q.get('action')==='cache_growth'?'synthetic-cache-only-key':KEY));
  if(q.get('action')==='cache_growth')return new Response('{}',{headers:{'content-type':'application/json'}});
  if(refused)return new Response(JSON.stringify({error:'SEGMENT_ACCESS_DENIED'}),{status:403,headers:{'content-type':'application/json'}});
  const body=q.get('acao')==='segmento_obter'?{segment:{...row}}:{segments:[{...row}],limit:Number(q.get('limit')),offset:Number(q.get('offset')),catalog,capabilities:{draft:true,count:true,send:false}};
  if(mixed)(body.segment||body.segments[0]).brand=brand==='fish'?'aristo':'fish';if(revoke)active=false;
  return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
 }});
 return {reader,calls:()=>calls,brand};
}
const request=(f,action='segmentos_listar',extra={})=>f.reader.read({context:{},route:'segments',method:'GET',query:new URLSearchParams({acao:action,brand:f.brand,...(action==='segmentos_listar'?{limit:'50',offset:'0'}:{id:ID}),...extra}),origin:'https://crm.synthetic.invalid'});
test('both brands load and reopen actual definitions through service READ without promoting writes',async()=>{for(const brand of ['fish','aristo']){const f=fixture({brand}),list=await request(f),get=await request(f,'segmento_obter');assert.equal(list.status,200);assert.equal(get.status,200);assert.equal(get.body.segment.id,list.body.segments[0].id);assert.deepEqual(list.body.capabilities,{draft:false,count:false,send:false});assert.equal(list.body.segments[0].updated_by,'Equipe CRM');assert(!JSON.stringify(list.body).includes(KEY));assert.equal(f.calls(),2);}});
test('wrong front, crossed brand and all mutations are refused before source contact',async()=>{const f=fixture({front:'afiliados'});await assert.rejects(request(f),e=>e.status===403);assert.equal(f.calls(),0);const g=fixture();await assert.rejects(request(g,'segmento_contar'),e=>e.code==='READ_ONLY');await assert.rejects(g.reader.read({context:{},route:'segments',method:'POST',query:new URLSearchParams(),body:{acao:'segmento_salvar'},origin:'https://crm.synthetic.invalid'}),e=>e.code==='READ_ONLY');assert.equal(g.calls(),0);await assert.rejects(request(g,'segmentos_listar',{brand:'aristo'}));assert.equal(g.calls(),0);});
test('mixed source rows and source refusals remain failures, never empty public lists',async()=>{const mixed=await request(fixture({mixed:true}));assert.equal(mixed.status,502);assert(!Object.hasOwn(mixed.body,'segments'));const refused=await request(fixture({refused:true}));assert.equal(refused.status,403);assert.equal(refused.body.error,'SEGMENT_ACCESS_DENIED');});
test('revocation during the read discards the response',async()=>{await assert.rejects(request(fixture({revoke:true})),e=>e.status===403);});
test('cache key alone cannot authenticate public READ or be promoted to an operator',async()=>{const f=fixture({missing:true});await assert.rejects(request(f),e=>e.code==='AUDIENCE_READ_SOURCE_NOT_LINKED');assert.equal(f.calls(),0);const r=await f.reader.read({context:{},route:'crm-read',method:'GET',query:new URLSearchParams({action:'cache_growth',painel:'growth'}),viewBrand:'fish',origin:'https://crm.synthetic.invalid'});assert.equal(r.body.capabilities.segments.read,false);});
test('dashboard advertises only per-brand public READ with the same-origin endpoint',async()=>{const f=fixture(),r=await f.reader.read({context:{},route:'crm-read',method:'GET',query:new URLSearchParams({action:'cache_growth',painel:'growth'}),viewBrand:'fish',origin:'https://crm.synthetic.invalid'});assert.equal(r.status,200);assert.deepEqual(r.body.capabilities.segments.brands,['fish']);assert.equal(r.body.capabilities.segments.read,true);for(const x of ['save','count','operation','send'])assert.equal(r.body.capabilities.segments[x],false);assert.equal(r.body.capabilities.endpoints.segments,'https://crm.synthetic.invalid/api/segments');});
test('existing browser client lists and reopens service READ DTOs in both brands',async()=>{
 const Client=require('../growth-segment-client.js');
 for(const brand of ['fish','aristo']){const f=fixture({brand}),api={capabilities:{segments:{contract_version:'crm-audience-v2',brands:[brand],read:true,save:false,count:false,operation:false},endpoints:{segments:'https://crm.synthetic.invalid/api/segments'}}},values=new Map();
  const client=Client.create({api,brand,key:'synthetic-browser-actor',storage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)},locks:{request:async(_k,_opts,fn)=>fn({})},fetch:async(url,options)=>{assert.equal(options.method,'GET');const result=await f.reader.read({context:{},route:'segments',method:'GET',query:new URL(url).searchParams,origin:'https://crm.synthetic.invalid'});return {status:result.status,json:async()=>result.body};}});
  const listed=await client.list();const opened=await client.open(listed.segments[0].id);assert.equal(opened.segment.id,ID);assert.equal(opened.segment.brand,brand);assert.equal(client.capabilities().save,false);assert.equal(f.calls(),2);
 }
});

function diagnosticFixture(fetchImpl,projectionError){
 const events=[],user={id:'synthetic-admin',role:'superadmin',areas:['growth'],productFronts:['growth'],brands:['aristo']};
 const auth={authorize:()=>user,authorizeBrand:()=>user};
 const reader=createReader({auth,upstreams:{'crm-read':new URL(P.FIXED_DESTINATIONS['crm-read'])},keys:{growth:KEY},fetchImpl,projectGrowth:()=>{if(projectionError)throw projectionError;return {brand:'aristo'};},onReadFailure:e=>events.push(e)});
 const request=()=>reader.read({context:{},route:'crm-read',method:'GET',query:new URLSearchParams({action:'cache_growth',painel:'growth'}),viewBrand:'aristo',origin:'https://crm.synthetic.invalid'});
 return {request,events,reader};
}
test('CRM refusal records actual HTTP, original code and SQLSTATE without raw messages',async()=>{
 const f=diagnosticFixture(async()=>new Response(JSON.stringify({error:'CACHE_READ_REFUSED',sqlstate:'55P03',message:'private@synthetic.invalid password=secret',detail:KEY}),{status:503,headers:{'content-type':'application/json'}}));
 await assert.rejects(f.request(),e=>e.code==='SERVICE_READ_SOURCE_REFUSED');assert.equal(f.events.length,1);
 const e=f.events[0];assert.equal(e.brand,'aristo');assert.equal(e.sourceStatus,503);assert.equal(e.sourceCode,'CACHE_READ_REFUSED');assert.equal(e.sqlState,'55P03');assert.equal(e.stage,'source-response');assert(!JSON.stringify(e).includes(KEY));assert(!JSON.stringify(e).includes('private@'));assert(!JSON.stringify(e).includes('secret'));
});
test('CRM transport refusal retains cause code and drops connection strings and stack',async()=>{
 const f=diagnosticFixture(async()=>{throw Object.assign(new TypeError('postgresql://private:secret@host/db'),{cause:{code:'ECONNRESET'},stack:'private-stack'});});
 await assert.rejects(f.request(),e=>e.code==='UPSTREAM_UNAVAILABLE');assert.equal(f.events[0].transportCode,'ECONNRESET');assert.equal(f.events[0].errorType,'TypeError');assert.equal(f.events[0].stage,'transport');assert(!JSON.stringify(f.events).includes('private'));assert(!JSON.stringify(f.events).includes('postgresql'));
});
test('CRM malformed response records stage and source HTTP without response contents',async()=>{
 const f=diagnosticFixture(async()=>new Response('private@synthetic.invalid not-json',{status:200,headers:{'content-type':'application/json'}}));await assert.rejects(f.request(),e=>e.code==='UPSTREAM_INVALID_JSON');assert.equal(f.events[0].stage,'json');assert.equal(f.events[0].sourceStatus,200);assert(!JSON.stringify(f.events).includes('private@'));
});
test('CRM projection failure records exact closed section and field',async()=>{
 const e=Object.assign(Error('BRAND_RESPONSE_UNSCOPED'),{status:502,code:'BRAND_RESPONSE_UNSCOPED',projectionIssue:{section:'crm_carrinho',reason:'field_type_invalid',field:'receita'}});
 const f=diagnosticFixture(async()=>new Response('{}',{headers:{'content-type':'application/json'}}),e);await assert.rejects(f.request());assert.deepEqual(f.events[0].projection,{section:'crm_carrinho',reason:'field_type_invalid',field:'receita'});assert.equal(f.events[0].stage,'projection');
});

test('native source summary returns only refusal metadata for the delegated brands',async()=>{const f=diagnosticFixture(async()=>new Response(JSON.stringify({error:'CACHE_READ_REFUSED'}),{status:503,headers:{'content-type':'application/json'}}));await assert.rejects(f.request());const r=await f.reader.summary({},['fish'],'https://crm.synthetic.invalid');assert(r.readFailures.length>0);assert(r.readFailures.every(x=>x.brand==='fish'));assert(f.events.some(x=>x.brand==='aristo'));});
