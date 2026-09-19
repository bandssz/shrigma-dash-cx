'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const p=require('../n8n/tiktok/regra-action-patch.cjs');
const code=name=>fs.readFileSync(path.join(__dirname,'../n8n/tiktok',name),'utf8');
const json=x=>JSON.parse(JSON.stringify(x));
function validate(rule,extra={}){
 const source=code('acao_valida.js').replaceAll('__SERVER_ONLY_TIKTOK_WRITE_KEY__','synthetic-test-key');
 return json(vm.runInNewContext('(function(){'+source+'})()',{$json:{body:{k:'synthetic-test-key',acao:'regra',marca:'fish',regra:rule,...extra}}})[0].json);
}
test('strict JSON inputs reject coercion, arrays, unknown fields and fractional integer limits',()=>{
 for(const rule of [null,[],{}, {gmv_auto:null},{gmv_auto:true},{gmv_auto:'100'},{teto_mensal:2.2},{unknown:1}])assert.throws(()=>validate(rule));
 assert.deepEqual(validate({gmv_manual:101}).regra,{gmv_manual:101},'comparison deferred to current SQL rule');
 assert.equal(validate({modo:'ativo'}).regra.modo,'ativo','activation rejected by SQL with current rule in response');
});
test('rule action emits only fixed parameterized SQL and zero HTTP transport',async()=>{
 const author="fixture', modo='ativo'; --",a=validate({gmv_auto:100},{autor:author,esperado_atualizado_em:'2026-01-01T00:00:00.123456Z'});let http=0;
 const source=code('acao_exec.js').replaceAll('__SERVER_ONLY_TIKTOK_SHOP_SECRET__','synthetic-shop-secret');
 const out=json(await vm.runInNewContext('(async function(){'+source+'}).call(ctx)',{ctx:{helpers:{httpRequest:()=>{http++;throw Error('unexpected transport');}}},$:()=>({first:()=>({json:a})}),$input:{all:()=>[]}}));
 assert.equal(http,0);assert.equal(out[0].json.acao,'regra');assert.equal(out[0].json.ok,undefined,'cannot report success before SQL');
 assert.deepEqual(out[0].json.sqlParameters,['fish','{"gmv_auto":100}',author,'2026-01-01T00:00:00.123456Z']);assert.equal(out[0].json.sql.includes(author),false);
});
test('HTTP response uses SQL refusal, missing receipt fails closed, legacy review response remains intact',()=>{
 function response(sql,exec){const context={$:()=>({first:()=>({json:exec})}),$input:{first:()=>({json:sql}),all:()=>[{json:sql}]}};const body=vm.runInNewContext(p.RESPONSE_BODY.slice(3,-2),context),status=vm.runInNewContext(p.RESPONSE_CODE.slice(3,-2),context);return {body:JSON.parse(body),status};}
 const fresh={marca:'fish',gmv_auto:50,gmv_manual:10};const r={ok:false,codigo:'gmv_incompativel',mensagem:'Recusada',erro:'Recusada',regra_atual:fresh,linhas:[fresh]};
 assert.deepEqual(response({regra_result:r},{acao:'regra'}),{body:r,status:400});
 assert.equal(response({},{acao:'regra'}).status,500);
 assert.equal(response({regra_result:{ok:true}},{acao:'regra'}).status,200);
 assert.deepEqual(response({application_id:'synthetic'},{ok:true,mensagem:'Reviewed'}),{status:200,body:{ok:true,mensagem:'Reviewed',linhas:[{application_id:'synthetic'}]}});
});
test('fresh patch preserves authentication, transport, connections and credential references; idempotent and version checked',()=>{
 const sourceV=code('acao_valida.js'),sourceE=code('acao_exec.js');
 const input={versionId:'fixture-v1',nodes:[{name:'Valida',parameters:{jsCode:sourceV}},{name:'Executa acao',parameters:{jsCode:sourceE}},{name:'Grava',type:'n8n-nodes-base.postgres',credentials:{postgres:{id:'fixture'}},parameters:{query:'={{ $json.sql }}',options:{}}},{name:'Resposta',parameters:{responseBody:'old',options:{responseCode:200,responseHeaders:{entries:[]}}}}],connections:{fixture:{main:[]}}};
 const patched=p.patchWorkflow(input,{expectedVersion:'fixture-v1'}).workflow;
 assert.equal(patched.nodes[0].parameters.jsCode,sourceV);assert.equal(patched.nodes[1].parameters.jsCode,sourceE);assert.deepEqual(patched.connections,input.connections);
 assert.deepEqual(patched.nodes[2].credentials,input.nodes[2].credentials);assert.equal(input.nodes[2].parameters.options.queryReplacement,undefined);
 assert.deepEqual(p.patchWorkflow(patched,{expectedVersion:'fixture-v1'}).changes,[]);assert.throws(()=>p.patchWorkflow(input,{expectedVersion:'stale'}));
});

test('UI sends exact snapshot timestamp and changed fields, preserving unchanged active state',()=>{
 const TTS=require('../influs-tts.js');const base={marca:'fish',atualizado_em:'2026-01-01T00:00:00.123456+00:00',modo:'ativo',gmv_auto:100};
 assert.deepEqual(TTS.pedidoRegra(base,{modo:'ativo',gmv_auto:110}),{acao:'regra',marca:'fish',regra:{gmv_auto:110},esperado_atualizado_em:base.atualizado_em});
 assert.throws(()=>TTS.pedidoRegra(null,{modo:'pausado'}),/Recarregue/);
 assert.throws(()=>TTS.pedidoRegra(base,{modo:'ativo',gmv_auto:100}),/Nenhuma/);
 const current={...base,gmv_auto:90,atualizado_em:'2026-01-01T00:00:01.654321Z'};
 const old={regra:[base],cobranca_regra:[{marca:'fish',cobranca_modo:'pausado'}],fila:[{fixture:true}]};
 const merged=TTS.regraRecebida(old,current);assert.deepEqual(merged.regra,[current]);assert.equal(merged.cobranca_regra[0].atualizado_em,current.atualizado_em);assert.equal(merged.cobranca_regra[0].cobranca_modo,'pausado');assert.equal(merged.fila,old.fila);assert.equal(old.regra[0].gmv_auto,100);
});

test('fresh patch refuses unreviewed rule code drift even when version was supplied',()=>{
 assert.throws(()=>p.patchValidate(code('acao_valida.js').replace('const r = b.regra;','const r = b.regra; /* concurrent rule change */')),/divergiu/);
 assert.throws(()=>p.patchExecute(code('acao_exec.js').replace("acao:'regra', sql:","acao:'regra', fixture:true, sql:")),/divergiu/);
});
