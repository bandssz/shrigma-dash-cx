'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const P=require('../n8n/access/panel-auth-patch.cjs');
test('read authentication rejects malformed, cross-origin and ambiguous header inputs without normalizing secrets',()=>{
 const good='synthetic-reader-key';
 assert.equal(P.requestAccess({headers:{authorization:'Bearer '+good},query:{painel:'growth'}},'shared').k,good);
 for(const raw of [good.toUpperCase(),good+'!',good+' ',"' OR true--",['x']])assert.equal(P.requestAccess({headers:{authorization:'Bearer '+raw},query:{k:good}},'shared').k,'');
 assert.equal(P.requestAccess({headers:{authorization:'Basic fake'},query:{k:good}},'shared').k,'');
 assert.equal(P.requestAccess({headers:{origin:'https://untrusted.invalid',authorization:'Bearer '+good}},'shared').k,'');
 assert.equal(P.requestAccess({body:{k:good}},'tts').pedido,'influs');
 assert.equal(P.requestAccess({query:{k:good}},'cache').pedido,'cx');
});
test('memory-only reader storage migrates only one legacy credential and never writes it back',()=>{
 const map=new Map([['shrigma_k_growth','synthetic-reader-key'],['shrigma_campaign_journal','retain-reservation']]);
 const c=vm.createContext({location:{search:''},URLSearchParams,localStorage:{getItem:k=>map.get(k),removeItem:k=>map.delete(k),setItem:()=>{throw Error('Credential persistence forbidden');}}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../config.js'),'utf8'),c);
 assert.equal(vm.runInContext("shrigmaChave('growth')",c),'synthetic-reader-key');assert(!map.has('shrigma_k_growth'));
 assert.equal(vm.runInContext("shrigmaChave('growth')",c),'synthetic-reader-key');
 vm.runInContext("shrigmaMarcaMestra('fake','todos');shrigmaEsqueceChave('growth')",c);
 assert.equal(vm.runInContext("shrigmaChave('growth')",c),'');assert.equal(map.get('shrigma_campaign_journal'),'retain-reservation');
});
test('manager entry documents contain no cross-area navigation and strict script policies',()=>{
 for(const dir of ['cx','crm','organico','creators','gestao']){
  const s=fs.readFileSync(path.join(__dirname,'..',dir,'index.html'),'utf8');
  assert.match(s,/id="entry-nav"[^>]*hidden><\/nav>/);assert.match(s,/script-src 'self';/);assert(!s.includes('unsafe-inline'));assert(!s.includes('localStorage.setItem'));
 }
 for(const page of ['index','growth','organico','influs']){
  const s=fs.readFileSync(path.join(__dirname,'..',page+'.html'),'utf8');
  assert(!s.includes('class="workspace-links"'));assert.match(s,/script-src 'self' 'sha256-/);assert(!/script-src[^;]*unsafe-inline/.test(s));assert.match(s,/name="referrer" content="no-referrer"/);
 }
});
test('fresh reader patches leave business queries and write authorization logic intact',()=>{
 for(const area of ['shared','cache','influs','tts']){
  const authName=area==='shared'?'Busca painel':area==='cache'?'Chave':'Painel da chave';
  const fresh={id:P.IDS[area],versionId:'fresh',settings:{timezone:'America/Sao_Paulo'},nodes:[{id:'v',name:'Valida chave',type:'n8n-nodes-base.code',parameters:{jsCode:"const ESCRITA = 'synthetic-write-key';"}},{id:'a',name:authName,type:'n8n-nodes-base.postgres',parameters:{query:'SELECT painel FROM crm_dash_chave',options:{}}},{id:'payload',name:'Consulta payload',type:'n8n-nodes-base.postgres',parameters:{query:'SELECT business_facts'}},{id:'write',name:'Decide acesso',parameters:{jsCode:'original writer guard'}}],connections:{'Autorizado?':{main:[[{node:'Consulta payload',type:'main',index:0}],[{node:'deny',type:'main',index:0}]]}}};
  const out=P.patchWorkflow(fresh,{expectedVersionId:'fresh',area});
  for(const id of ['payload','write'])assert.deepEqual(out.nodes.find(n=>n.id===id),fresh.nodes.find(n=>n.id===id));
  assert.equal(out.nodes.find(n=>n.id==='a').parameters.options.queryReplacement,'={{ [$json.k, $json.pedido, $json.transport] }}');
  assert.equal(out.settings.saveDataErrorExecution,'none');assert.equal(out.settings.saveDataSuccessExecution,'none');
  assert.throws(()=>P.patchWorkflow(fresh,{expectedVersionId:'stale',area}));
 }
});
test('cache builder cannot select hashed user records or put its service key in a URL',()=>{
 const w={id:P.IDS.builder,versionId:'fresh',nodes:[{name:'Chave do CX',parameters:{query:"SELECT chave FROM crm_dash_chave WHERE painel = 'cx' AND ativo ORDER BY ultimo_uso DESC NULLS LAST LIMIT 1"}},{name:'API de leitura (painel=cx)',parameters:{url:'=https://example.invalid/read?k={{ $json.chave }}&painel=cx'}}],settings:{timezone:'America/Sao_Paulo'}};
 const result=P.patchWorkflow(w,{expectedVersionId:'fresh',area:'builder',serviceCredential:{id:'synthetic-vault-id',name:'Synthetic service credential'}});
 assert(!result.nodes[0].parameters.query.includes('crm_dash_chave'));assert(!result.nodes[0].parameters.query.includes('SELECT chave'));
 assert(!result.nodes[1].parameters.url.includes('?k='));assert.equal(result.nodes[1].credentials.httpHeaderAuth.id,'synthetic-vault-id');assert.equal(result.nodes[1].parameters.genericAuthType,'httpHeaderAuth');assert.equal(result.settings.timezone,w.settings.timezone);
});
test('campaign header authentication preserves the request and body-write guards',()=>{
 const A=require('../n8n/access/aux-read-auth-patch.cjs');
 const w={id:A.IDS.campaign,versionId:'fresh',nodes:[{name:'Entrada',type:'n8n-nodes-base.code',parameters:{jsCode:'const req=$json.request,method=$json.method,commandSource=method==="GET"?req.query:req.body;const key=commandSource.k;return [{json:{key,commandSource}}];'}},{name:'business',parameters:{jsCode:'immutable receipt and send guard'}}],settings:{},connections:{}};
 const result=A.patchWorkflow(w,{expectedVersionId:'fresh',area:'campaign'});
 const run=input=>vm.runInNewContext('(function(){'+result.nodes[0].parameters.jsCode+'})()',{$json:input})[0].json;
 assert.equal(run({method:'GET',request:{headers:{authorization:'Bearer synthetic-reader-key'},query:{acao:'campanha_listar'}}}).key,'synthetic-reader-key');
 assert.equal(run({method:'GET',request:{headers:{authorization:'Basic bad'},query:{k:'legacy-reader'}}}).key,'');
 assert.equal(run({method:'POST',request:{body:{k:'original-writer'},headers:{authorization:'Bearer different-key'}}}).key,'original-writer');
 assert.deepEqual(result.nodes[1],w.nodes[1]);assert.throws(()=>A.patchWorkflow(w,{expectedVersionId:'stale',area:'campaign'}));
});
