'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {PGlite}=require('@electric-sql/pglite');
const {SCHEMA,SQL,input}=require('./ab-registry-postgres.cjs');
const {patchWorkflow,currentBuilder,authTail}=require('../n8n/growth/ab-operator-workflow-patch.cjs');
const {sha256Bytes,stable,canonical,digest}=require('../n8n/growth/template-operation-receipt.cjs');
const bridge=fs.readFileSync(require.resolve('../n8n/growth/ab-operator.sql'),'utf8');
const auth=`CREATE FUNCTION shrigma_crm_operator_auth_v1(k text) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN k IN ('manager','rotated') THEN '{"who":"panel:synthetic-manager","label":"Synthetic manager","caps":["draft","read_content"]}'::jsonb
 WHEN k='other' THEN '{"who":"panel:other-manager","label":"Synthetic manager","caps":["draft","read_content"]}'::jsonb
 WHEN k='reader' THEN '{"who":"panel:synthetic-reader","label":"Synthetic reader","caps":["read_content"]}'::jsonb ELSE NULL END $$;`;
const runCode=(code,json)=>JSON.parse(JSON.stringify(vm.runInNewContext(`(()=>{${code}\n})()`,{$json:json,$input:{all:()=>[{json}]}})));
function fixture(){
 const names=['POST teste','Valida chave','Autorizado?','Monta SQL','Grava','Resposta','200','401','400','GET cadastro AB','OPTIONS cadastro AB','Valida consulta AB','204 cadastro AB','Falha de recibo AB'];
 const w={versionId:'fresh',active:true,activeVersionId:'fresh',nodes:names.map(name=>({name,id:name,parameters:{}})),connections:{original:true},settings:{timezone:'America/Sao_Paulo'}};
 for(const [name,read] of [['Valida chave',false],['Valida consulta AB',true]])w.nodes.find(n=>n.name===name).parameters.jsCode="const CHAVE = 'legacy-synthetic';\n"+[sha256Bytes,stable,canonical,digest].map(f=>f.toString()).join('\n')+'\n'+authTail(read);
 w.nodes.find(n=>n.name==='Monta SQL').parameters.jsCode=currentBuilder;
 Object.assign(w.nodes.find(n=>n.name==='Grava'),{credentials:{postgres:{id:'synthetic',name:'synthetic'}},parameters:{query:'={{ $json.sql }}',options:{queryReplacement:'={{ $json.parameters }}'}}});return w;
}
test('manager uses existing auth with stable authorship; legacy receipts remain isolated and unchanged',async()=>{
 const db=new PGlite();try{
  await db.exec(SCHEMA+auth);await db.exec(SQL);await db.exec(bridge);
  const run=async(k,mode,p)=>(await db.query('SELECT crm_ab_operator_registry_v1($1,$2,$3) AS v',[k,mode,JSON.stringify(p)])).rows[0].v;
  const p=input(1),saved=await run('manager','write',p);assert.equal(saved.status,200);
  const op=(await run('rotated','operation',p)).body.operation;assert.equal(op.state,'completed');assert.deepEqual(op.response,saved);assert.notEqual(op.actor_sha256,p.actor_sha256);
  assert.deepEqual(await run('rotated','write',p),saved);assert.equal((await run('other','write',p)).body.code,'operation_identity_conflict');
  assert.equal((await db.query('SELECT crm_ab_registry_v1($1,$2) AS v',['operation',JSON.stringify(p)])).rows[0].v.body.operation.state,'missing');
  const q=input(2);await db.query('SELECT crm_ab_registry_v1($1,$2)',['write',JSON.stringify(q)]);
  assert.equal((await run('manager','operation',q)).body.operation.state,'missing');
  assert.equal((await db.query('SELECT crm_ab_registry_v1($1,$2) AS v',['operation',JSON.stringify(q)])).rows[0].v.body.operation.state,'completed');
  const caps=(await run('manager','capabilities',{})).body;assert.equal(caps.access,'crm_operator');assert.equal(caps.write,true);assert.deepEqual(caps.brands,['fish','aristo']);
  assert.equal((await run('reader','capabilities',{})).body.write,false);
  assert.equal((await run('reader','write',input(3))).status,403);assert.equal((await run('invalid','write',input(3))).status,401);
  const outside=input(4);outside.request_payload.teste.marca='olivas';assert.equal((await run('manager','write',outside)).body.code,'brand_scope');
  await db.query('SELECT crm_ab_registry_v1($1,$2)',['write',JSON.stringify(outside)]);assert.equal((await run('manager','record',outside)).status,403);
  assert.equal((await db.query('SELECT count(*)::int n FROM crm_ab_operation_v1')).rows[0].n,3);
  assert.doesNotMatch(JSON.stringify((await db.query('SELECT request_payload,response FROM crm_ab_operation_v1')).rows),/"manager"|"rotated"|legacy-synthetic/);
 }finally{await db.close();}
});
test('pure workflow patch binds manager auth to parameterized SQL and preserves legacy hash/transport',()=>{
 const f=fixture(),{workflow:w}=patchWorkflow(f,{expectedVersion:'fresh'}),n=name=>w.nodes.find(n=>n.name===name);
 const legacy=runCode(n('Valida chave').parameters.jsCode,{body:{k:'legacy-synthetic',...input(1).request_payload,operation_id:input(1).operation_id}})[0].json;
 assert.equal(legacy.actor_sha256,digest({scope:'ab-registry-v1',credential:'legacy-synthetic'}));assert.equal(legacy.operator_key,null);assert.equal(legacy.data.k,undefined);
 assert.equal(runCode(n('Monta SQL').parameters.jsCode,legacy)[0].json.parameters[0],'write');
 const ctx=runCode(n('Valida consulta AB').parameters.jsCode,{query:{acao:'capacidades'},headers:{'x-ab-write-key':'manager'}})[0].json;
 const plan=runCode(n('Monta SQL').parameters.jsCode,ctx)[0].json;assert.deepEqual(plan.parameters,['manager','capabilities',JSON.stringify({actor_sha256:'0'.repeat(64)})]);assert.match(plan.sql,/crm_ab_operator_registry_v1\(\$1/);
 assert.equal(runCode(n('Valida consulta AB').parameters.jsCode,{query:{acao:'capacidades'},headers:{}})[0].json.ok,false);
 assert.deepEqual(w.connections,f.connections);assert.deepEqual(n('Grava'),f.nodes.find(n=>n.name==='Grava'));
 for(const original of f.nodes)if(!['Valida chave','Valida consulta AB','Monta SQL'].includes(original.name))assert.deepEqual(n(original.name),original);
 assert.equal(w.settings.saveExecutionProgress,false);assert.equal(w.settings.saveDataErrorExecution,'none');assert.notDeepEqual(f,w);
 for(const mutate of [x=>x.versionId='old',x=>x.activeVersionId='other',x=>x.nodes[1].parameters.jsCode+='\n// drift',x=>x.nodes.find(n=>n.name==='Monta SQL').parameters.jsCode+='\n// drift']){const drift=fixture();mutate(drift);assert.throws(()=>patchWorkflow(drift,{expectedVersion:'fresh'}));}
});
