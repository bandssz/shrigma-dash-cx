'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const P=require('../n8n/access/panel-operator-patch.cjs');
test('Influs scoped operators retain legacy authority and cannot forge author or cross-area grants',()=>{
 const w={id:P.IDS.influs,versionId:'fresh',nodes:[{name:'Painel da chave',parameters:{query:'SELECT * FROM public.shrigma_panel_auth_v1($1,$2,$3)'}},{name:'Decide acesso',parameters:{jsCode:"const ok = v.acao === 'listar' ? true : false;"}},{name:'Monta SQL',parameters:{jsCode:'business SQL unchanged'}}]};
 const p=P.patchWorkflow(w,{expectedVersionId:'fresh',area:'influs'});assert.deepEqual(p.nodes[2],w.nodes[2]);assert.throws(()=>P.patchWorkflow(w,{expectedVersionId:'stale',area:'influs'}));
 const run=(v,a)=>vm.runInNewContext('(function(){'+p.nodes[1].parameters.jsCode+'})()',{$:()=>({first:()=>({json:v})}),$input:{first:()=>({json:a})}})[0].json;
 const v={acao:'salvar_custo',body:{autor:'spoof',valor:123},originOK:true,ehEscrita:false};
 assert.equal(run(v,{}).ok,false);assert.equal(run(v,{operator:{caps:['draft'],label:'CRM'}}).ok,false);
 const r=run(v,{operator:{caps:['creators_edit'],label:'Gestor Influs'}});assert.equal(r.ok,true);assert.equal(r.body.autor,'Gestor Influs');assert.equal(r.body.valor,123);
 assert.equal(run({...v,originOK:false},{operator:{caps:['creators_edit']}}).ok,false);assert.equal(run({...v,ehEscrita:true},{}).ok,true);
});
test('write session requires explicit capability and logout clears it without persisting secrets',()=>{
 const c=vm.createContext({location:{search:''},URLSearchParams,localStorage:{getItem:()=>'',removeItem:()=>{},setItem:()=>{throw Error('No secrets in storage');}}});vm.runInContext(fs.readFileSync(require.resolve('../config.js'),'utf8'),c);
 vm.runInContext("shrigmaGuardaChave('growth','synthetic-key')",c);assert.equal(vm.runInContext("shrigmaChaveOperador('growth','draft')",c),'');
 vm.runInContext("SHRIGMA_OPERATOR_SESSION.growth={caps:['draft'],label:'CRM'}",c);assert.equal(vm.runInContext("shrigmaChaveOperador('growth','draft')",c),'synthetic-key');assert.equal(vm.runInContext("shrigmaChaveOperador('growth','submit')",c),'');assert.equal(vm.runInContext("shrigmaChaveOperador('influs','creators_edit')",c),'');
 vm.runInContext("shrigmaEsqueceChave('growth')",c);assert.equal(vm.runInContext("shrigmaChaveOperador('growth','draft')",c),'');
});
