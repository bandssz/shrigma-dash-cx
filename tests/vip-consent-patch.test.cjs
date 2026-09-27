'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const P=require('../n8n/growth/vip-consent-patch.cjs');
const copy=x=>JSON.parse(JSON.stringify(x)),ids=Object.keys(P.TARGETS);
function fixture(id=ids[0]){
 const t=P.TARGETS[id],edge=node=>({node,type:'main',index:0});
 const code="// Synthetic welcome: no real HTML, address, endpoint or credential.\nconst d = $('Checar MX').first().json;\n"+(t.source==='alma'?"  if (d.origem !== 'lp-desodorante-frescor') return [];\n":'')+"return [{json:{recipient:d.email,body:'Synthetic welcome'},pairedItem:{item:0}}];";
 const w={id,name:'Synthetic VIP '+t.source,versionId:'synthetic-v1',activeVersionId:'synthetic-v1',active:true,settings:{executionOrder:'v1',saveDataSuccessExecution:'none',saveDataErrorExecution:'none'},shared:[{projectId:'synthetic-project'}],tags:[{id:'synthetic-tag'}],nodes:[
  {id:'source',name:'Checar MX',type:'n8n-nodes-base.code',parameters:{jsCode:'return $input.all();'},position:[0,0]},
  {id:'upsert',name:t.upsert,type:'n8n-nodes-base.postgres',parameters:{operation:'executeQuery',query:'/* Synthetic previous query. Reviewed by its full node hash. */ SELECT $1,$2,$3;',options:{queryReplacement:P.REPLACEMENT,queryBatching:'independently'}},credentials:{postgres:{id:'synthetic-pg',name:'Synthetic PG'}},position:[200,0]},
  {id:'welcome',name:P.CODE,type:'n8n-nodes-base.code',parameters:{jsCode:code},position:[400,0]},
  {id:'send',name:'Boas-vindas VIP (Listmonk tx)',type:'n8n-nodes-base.httpRequest',parameters:{url:'https://example.invalid/api/tx',method:'POST',jsonBody:'={{ $json }}'},credentials:{httpBasicAuth:{id:'synthetic-http',name:'Synthetic HTTP'}},retryOnFail:false,position:[600,0]}
 ],connections:{'Checar MX':{main:[[edge(t.upsert)]]},[t.upsert]:{main:[[edge(P.CODE)]]},[P.CODE]:{main:[[edge('Boas-vindas VIP (Listmonk tx)')]]}}};
 w.activeVersion={versionId:w.versionId,nodes:copy(w.nodes),connections:copy(w.connections)};return w;
}
function guard(w){return {version:w.versionId,graphHash:P.graphHash(w),nodeHashes:Object.fromEntries(w.nodes.map(n=>[n.name,P.digest(n)]))};}
function output(code,json,origin='lp-desodorante-frescor'){
 let sourceReads=0;const sandbox={$json:json,$:name=>{assert.equal(name,'Checar MX');sourceReads++;return {first:()=>({json:{email:'synthetic@example.invalid',origem:origin}})};}};
 const result=new vm.Script('(function(){'+code+'})()').runInNewContext(sandbox,{timeout:1000,contextCodeGeneration:{strings:false,wasm:false}});
 return {result:copy(result),sourceReads};
}
test('both targets change only the reviewed SQL and one Code prefix, leaving originals/credentials/settings/connections exact',()=>{
 for(const id of ids){
  const w=fixture(id),original=copy(w),t=P.TARGETS[id],patched=P.patchVipConsent(w,guard(w));assert.deepEqual(w,original);
  const expected=copy(original),up=expected.nodes.find(n=>n.name===t.upsert),code=expected.nodes.find(n=>n.name===P.CODE);
  up.parameters.query=`SELECT eligible,reason FROM public.shrigma_crm_vip_subscribe_v1($1,$2,$3::boolean,'${t.source}');`;code.parameters.jsCode=P.PREFIX+code.parameters.jsCode;
  assert.deepEqual(patched,expected);assert.equal(patched.nodes.find(n=>n.name===t.upsert).parameters.options.queryReplacement,P.REPLACEMENT);
  assert.equal(patched.nodes.find(n=>n.name===P.CODE).parameters.jsCode.slice(P.PREFIX.length),original.nodes.find(n=>n.name===P.CODE).parameters.jsCode);
 }
});
test('false/missing/error output and truthy non-booleans emit no item before accessing original source',()=>{
 for(const id of ids){const w=fixture(id),p=P.patchVipConsent(w,guard(w)),code=p.nodes.find(n=>n.name===P.CODE).parameters.jsCode;
  for(const json of [{eligible:false,reason:'optout'}, {},{error:'SYNTHETIC_SQL_ERROR'},{eligible:null},{eligible:'true'},{eligible:1},{eligible:[],reason:'unconfirmed'}])assert.deepEqual(output(code,json),{result:[],sourceReads:0});
  assert.throws(()=>output(code,undefined),/eligible/);assert.throws(()=>output(code,null),/eligible/);
 }
});
test('eligible true preserves original output and Alma origin gate; it cannot bypass that gate',()=>{
 for(const id of ids){const w=fixture(id),original=w.nodes.find(n=>n.name===P.CODE).parameters.jsCode,p=P.patchVipConsent(w,guard(w)),code=p.nodes.find(n=>n.name===P.CODE).parameters.jsCode;
  for(const origin of ['lp-desodorante-frescor','lp-alma-da-roca','unexpected'])assert.deepEqual(output(code,{eligible:true},origin),output(original,{eligible:true},origin));
  assert.equal(output(code,{eligible:true}).result.length,1);
  if(P.TARGETS[id].source==='alma')assert.equal(output(code,{eligible:true},'lp-alma-da-roca').result.length,0);
 }
});
test('wrong target, inactive/foreign version, missing hashes and drift in any node/graph/settings are rejected',()=>{
 const mutate=[w=>{w.id='unrelated';},w=>{w.active=false;},w=>{w.versionId='foreign';},w=>{w.activeVersionId='foreign';},w=>{w.nodes[0].parameters.jsCode+='\n//changed';},w=>{w.connections={};},w=>{w.settings.executionOrder='v0';},w=>{w.nodes[1].credentials.postgres.id='foreign';}];
 for(const change of mutate){const w=fixture(),g=guard(w);change(w);assert.throws(()=>P.patchVipConsent(w,g),/VIP_CONSENT_PATCH_/);}
 for(const change of [g=>delete g.version,g=>delete g.graphHash,g=>delete g.nodeHashes,g=>delete g.nodeHashes[P.CODE],g=>g.nodeHashes[P.CODE]='0'.repeat(64)]){const w=fixture(),g=guard(w);change(g);assert.throws(()=>P.patchVipConsent(w,g),/VIP_CONSENT_PATCH_/);}
 const w=fixture(),g=guard(w);w.activeVersion.nodes=[];assert.throws(()=>P.patchVipConsent(w,g),/PUBLISHED_BODY/);
});
test('even a rehashed export with missing SQL/code, wrong node type/parameters, duplicate names or prior patch is refused',()=>{
 for(const mutate of [w=>delete w.nodes[1].parameters.query,w=>w.nodes[1].parameters.query=' ',w=>delete w.nodes[2].parameters.jsCode,w=>w.nodes[2].parameters.jsCode='',w=>w.nodes[1].type='n8n-nodes-base.code',w=>w.nodes[2].type='n8n-nodes-base.httpRequest',w=>w.nodes[1].parameters.options.queryReplacement='={{ $json.other }}',w=>w.nodes.push(copy(w.nodes[0]))]){
  const w=fixture();mutate(w);delete w.activeVersion;assert.throws(()=>P.patchVipConsent(w,guard(w)),/VIP_CONSENT_PATCH_/);
 }
 const w=fixture(),p=P.patchVipConsent(w,guard(w));delete p.activeVersion;assert.throws(()=>P.patchVipConsent(p,guard(p)),/ALREADY_PATCHED/);
});
