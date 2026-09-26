'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const P=require('../n8n/influs/api-conciliacao-patch.cjs');
// Trecho mínimo com as mesmas linhas de validação e âncora do nó "Monta SQL" de produção.
const CODE=`const q = s => (s === null || s === undefined || s === '') ? 'NULL'
  : "'" + String(s).split("'").join("''") + "'";
const b = $json.body || {};
const acao = String(b.acao || '');
const MARCAS = ['aristo','fish','olivas'];
if (acao === 'listar') {
  const DATA = /^\\d{4}-\\d{2}-\\d{2}$/;
  const ini = DATA.test(String(b.ini||'')) ? b.ini : '2026-06-01';
  const fim = DATA.test(String(b.fim||'')) ? b.fim : '2026-09-01';
  return [{ json: { sql: \`
SELECT jsonb_build_object(
  'gerado_em', now(),
${P.ANCORA.replace(/\n$/,'')}
  'afiliados', '[]'::jsonb
) AS payload\` }}];
}`;
const fresh=()=>({id:P.WORKFLOW_ID,versionId:'v9',activeVersionId:'v9',nodes:[{name:'Monta SQL',parameters:{jsCode:CODE}},{name:'Executa',parameters:{query:'={{ $json.sql }}'}}],connections:{x:1}});
const run=(w,body)=>vm.runInNewContext(`(()=>{${w.nodes[0].parameters.jsCode}})()`,{$json:{body},String})[0].json.sql;

test('listar ganha conferência, saúde e coleta sem mudar a janela nem o resto do payload',()=>{
 const w=P.patchWorkflow(fresh(),{expectedVersionId:'v9'});
 const sql=run(w,{acao:'listar',ini:'2026-09-01',fim:'2026-09-25'});
 assert.match(sql,/'janela', jsonb_build_object\('ini','2026-09-01','fim','2026-09-25'\)/);
 assert.match(sql,/crm_influ_conciliacao_v1\('2026-09-01'::date,'2026-09-25'::date\)/);
 assert.match(sql,/FROM public\.crm_influ_saude s/);assert.match(sql,/'coleta'/);
 assert.match(sql,/'conciliacao_pedidos', NULL/,'pedidos só quando pedidos');
 assert.match(sql,/'afiliados', '\[\]'::jsonb/);
 assert.deepEqual(w.connections,{x:1});assert.equal(w.nodes[1].parameters.query,'={{ $json.sql }}');
});

test('exportação por pedido vem só com a flag e a marca é validada contra a lista',()=>{
 const w=P.patchWorkflow(fresh(),{expectedVersionId:'v9'});
 assert.match(run(w,{acao:'listar',ini:'2026-09-01',fim:'2026-09-25',conciliacao_pedidos:true,marca:'fish'}),/crm_influ_conciliacao_pedidos_v1\('2026-09-01'::date,'2026-09-25'::date,'fish'\)/);
 const injetado=run(w,{acao:'listar',ini:'2026-09-01',fim:'2026-09-25',conciliacao_pedidos:true,marca:"fish'); DROP TABLE x; --"});
 assert.match(injetado,/crm_influ_conciliacao_pedidos_v1\('2026-09-01'::date,'2026-09-25'::date,'todas'\)/);
 assert.doesNotMatch(injetado,/DROP/);
 assert.match(run(w,{acao:'listar',conciliacao_pedidos:'true'}),/'conciliacao_pedidos', NULL/,'só o booleano true liga a exportação');
 const datas=run(w,{acao:'listar',ini:"2026-09-01'--",fim:'2026-09-25',conciliacao_pedidos:true});
 assert.doesNotMatch(datas,/'--/,'data fora do formato cai no padrão, não entra no SQL');
});

test('patch recusa versão diferente, âncora ausente e segunda aplicação',()=>{
 assert.throws(()=>P.patchWorkflow(fresh(),{expectedVersionId:'v8'}),/Versao/);
 const semAncora=fresh();semAncora.nodes[0].parameters.jsCode=CODE.replace(P.ANCORA.replace(/\n$/,''),'');
 assert.throws(()=>P.patchWorkflow(semAncora,{expectedVersionId:'v9'}),/Ancora/);
 const w=P.patchWorkflow(fresh(),{expectedVersionId:'v9'});w.versionId=w.activeVersionId='v10';
 assert.throws(()=>P.patchWorkflow(w,{expectedVersionId:'v10'}),/Ancora|aplicado/);
});
