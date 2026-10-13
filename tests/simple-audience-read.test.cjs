'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const runtime=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational');
const {createReader}=require(runtime+'/simple-dashboard-read.cjs'),P=require(runtime+'/proxy.cjs');
const KEY='synthetic-service-read-key',STAMP='2026-10-13T09:00:00.000Z',ID='00000000-0000-4000-8000-000000000001';
function fixture({brand='fish',front='growth',mixed=false,refused=false,revoke=false}={}){
 let calls=0,active=true;
 const user={id:'synthetic-reader',role:'manager',areas:[front],permissions:{growth:{read:true,edit:false}},productFronts:[front],brands:[brand],jobTitle:'gestor de CRM'};
 const auth={authorize(){return user},authorizeBrand(_ctx,b){if(!active||front!=='growth'||b!==brand)throw Object.assign(Error('ACCESS_DENIED'),{code:'ACCESS_DENIED',status:403});return user}};
 const row={id:ID,brand,name:'Público sintético',definition:{schema_version:'crm-audience-v2',brand,name:'Público sintético',rule:{op:'in_list',list_id:17}},version:1,archived:false,created_at:STAMP,updated_at:STAMP,updated_by:'panel:'+KEY,semantic_context:{currency:'BRL',timezone:'America/Sao_Paulo',current:true}};
 const catalog={brand,current:true,currency:'BRL',timezone:'America/Sao_Paulo',shop_id:null,fields:[],products:[],origins:[],lists:[{id:17,brand,name:'Lista sintética',available:true}],coverage:'unconfirmed',checked_at:STAMP,catalog_hash:'a'.repeat(64)};
 const upstreams={segments:new URL(P.REVIEWED_DYNAMIC.routes.segments),'crm-read':new URL(P.FIXED_DESTINATIONS['crm-read'])};
 const reader=createReader({auth,upstreams,keys:{growth:KEY},projectGrowth:()=>({brand}),fetchImpl:async(url,options)=>{
  calls++;assert.equal(options.method,'GET');assert.equal(options.headers.Authorization,'Bearer '+KEY);const q=new URL(url).searchParams;
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
test('dashboard advertises only per-brand public READ with the same-origin endpoint',async()=>{const f=fixture(),r=await f.reader.read({context:{},route:'crm-read',method:'GET',query:new URLSearchParams({action:'cache_growth',painel:'growth'}),viewBrand:'fish',origin:'https://crm.synthetic.invalid'});assert.equal(r.status,200);assert.deepEqual(r.body.capabilities.segments.brands,['fish']);assert.equal(r.body.capabilities.segments.read,true);for(const x of ['save','count','operation','send'])assert.equal(r.body.capabilities.segments[x],false);assert.equal(r.body.capabilities.endpoints.segments,'https://crm.synthetic.invalid/api/segments');});
test('existing browser client lists and reopens service READ DTOs in both brands',async()=>{
 const Client=require('../growth-segment-client.js');
 for(const brand of ['fish','aristo']){const f=fixture({brand}),api={capabilities:{segments:{contract_version:'crm-audience-v2',brands:[brand],read:true,save:false,count:false,operation:false},endpoints:{segments:'https://crm.synthetic.invalid/api/segments'}}},values=new Map();
  const client=Client.create({api,brand,key:'synthetic-browser-actor',storage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)},locks:{request:async(_k,_opts,fn)=>fn({})},fetch:async(url,options)=>{assert.equal(options.method,'GET');const result=await f.reader.read({context:{},route:'segments',method:'GET',query:new URL(url).searchParams,origin:'https://crm.synthetic.invalid'});return {status:result.status,json:async()=>result.body};}});
  const listed=await client.list();const opened=await client.open(listed.segments[0].id);assert.equal(opened.segment.id,ID);assert.equal(opened.segment.brand,brand);assert.equal(client.capabilities().save,false);assert.equal(f.calls(),2);
 }
});
