'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {createProtocol,...AB}=require('../n8n/growth/ab-registry.cjs'),{patchWorkflow,AUTH_TAIL}=require('../n8n/growth/ab-registry-workflow.cjs');
const {input}=require('./ab-registry-postgres.cjs');
const principal='a'.repeat(64),ids={get:'00000000-0000-4000-8000-000000000011',options:'00000000-0000-4000-8000-000000000012'};
const body=()=>{const p=input(1);return {operation_id:p.operation_id,...p.request_payload,k:'synthetic-write'};};
function fixture(){
 const node=(name,type,parameters={})=>({name,type:'n8n-nodes-base.'+type,typeVersion:2,id:name,parameters});
 return {versionId:'fresh',settings:{timezone:'America/Sao_Paulo'},connections:{'POST teste':{main:[[{node:'Valida chave',type:'main',index:0}]]},'Valida chave':{main:[[{node:'Autorizado?',type:'main',index:0}]]},'Autorizado?':{main:[[{node:'Monta SQL',type:'main',index:0}],[{node:'401',type:'main',index:0}]]},'Monta SQL':{main:[[{node:'Grava',type:'main',index:0}],[{node:'400',type:'main',index:0}]]},'Resposta':{main:[[{node:'200',type:'main',index:0}]]}},nodes:[
 node('POST teste','webhook',{httpMethod:'POST',path:'fixture-ab',responseMode:'responseNode',options:{}}),node('Valida chave','code',{jsCode:"const CHAVE = 'synthetic-write';\n"+AUTH_TAIL}),node('Autorizado?','if'),node('Monta SQL','code',{jsCode:'DELETE FROM crm_teste_braco'}),node('Grava','postgres',{query:'={{ $json.sql }}',options:{}}),node('Resposta','code',{jsCode:'return [{ json: { ok: true, gravado_em: new Date().toISOString() } }];'}),...['200','400','401'].map(n=>node(n,'respondToWebhook',{options:{}}))]};
}
const execute=(code,json,items=[{json}])=>vm.runInNewContext(`(()=>{${code}\n})()`,{$json:json,$input:{all:()=>items}});
test('registry request is strict and frozen without access keys or supplied authorship',()=>{
 const p=AB.request({...body(),actor_sha256:'b'.repeat(64)},principal);assert.equal(p.actor_sha256,principal);assert.doesNotMatch(JSON.stringify(p),/synthetic-write/);
 for(const delta of [{expected_version:'0'},{operation_id:'bad'},{teste:{...body().teste,efeito_minimo:'1'}},{bracos:[{...body().bracos[0],campanha_id:true},body().bracos[1]]}])assert.throws(()=>AB.request({...body(),...delta},principal),/AB_INVALID/);
 assert.equal(AB.query('write',p).sql,'SELECT public.crm_ab_registry_v1($1::text,$2::jsonb) AS result');
});
test('only exact receipt identity queries and record/capability reads are supported',()=>{
 assert.equal(AB.read({acao:'operacao',operation_id:body().operation_id,operacao:'criar',teste_id:'fixture-1'},principal).mode,'operation');
 assert.equal(AB.read({acao:'registro',teste_id:'fixture-1'},principal).mode,'record');assert.equal(AB.read({acao:'capacidades'},principal).mode,'capabilities');
 for(const q of [{acao:'criar'}, {acao:'operacao',operation_id:'bad',operacao:'criar',teste_id:'x'}])assert.throws(()=>AB.read(q,principal),/AB_INVALID/);
});
test('native sandbox works without imports or network',()=>{
 const protocol=vm.runInNewContext(`(${createProtocol.toString()})()`);assert.deepEqual(JSON.parse(JSON.stringify(protocol.request(body(),principal))),AB.request(body(),principal));
});
test('workflow preserves credential reference and failure path, with parameterized SQL and exact GET authentication',()=>{
 const fresh=fixture();fresh.nodes.find(n=>n.name==='Grava').credentials={postgres:{id:'fixture-id',name:'fixture'}};
 const {workflow:w}=patchWorkflow(fresh,{expectedVersion:'fresh',ids});
 const n=name=>w.nodes.find(n=>n.name===name);
 assert.deepEqual(n('Grava').credentials,fresh.nodes.find(n=>n.name==='Grava').credentials);assert.equal(n('Grava').parameters.options.queryReplacement,'={{ $json.parameters }}');assert.equal(n('Grava').retryOnFail,false);
 assert.equal(w.connections.Grava.main[1][0].node,'Falha de recibo AB');assert.equal(n('GET cadastro AB').parameters.path,'fixture-ab');assert.equal(n('GET cadastro AB').webhookId,ids.get);
 const verified=execute(n('Valida chave').parameters.jsCode,{body:body()})[0].json;assert.equal(verified.ok,true);assert.match(verified.actor_sha256,/^[a-f0-9]{64}$/);
 const plan=execute(n('Monta SQL').parameters.jsCode,verified)[0].json;assert.equal(plan.parameters[0],'write');assert.doesNotMatch(plan.parameters[1],/synthetic-write/);
 const refused=execute(n('Valida consulta AB').parameters.jsCode,{query:{acao:'capacidades'},headers:{'x-ab-write-key':'wrong'}})[0].json;assert.equal(refused.ok,false);assert.equal(refused.actor_sha256,null);
 const get=execute(n('Valida consulta AB').parameters.jsCode,{query:{acao:'registro',teste_id:'x'},headers:{'x-ab-write-key':'synthetic-write'}})[0].json;assert.equal(get.actor_sha256,verified.actor_sha256);assert.equal(execute(n('Monta SQL').parameters.jsCode,get)[0].json.parameters[0],'record');
 assert.equal(execute(n('Resposta').parameters.jsCode,{})[0].json.status,503);assert.equal(execute(n('Falha de recibo AB').parameters.jsCode,{error:'private raw value'})[0].json.status,503);
 assert.equal(w.settings.saveDataErrorExecution,'none');assert.equal(w.settings.saveDataSuccessExecution,'none');assert.equal(fresh.nodes.length,9);
});
test('fresh-version, authentication and existing-contract drift block patching',()=>{
 assert.throws(()=>patchWorkflow(fixture(),{expectedVersion:'old',ids}));const f=fixture();f.nodes.find(n=>n.name==='Valida chave').parameters.jsCode+='\n// changed';assert.throws(()=>patchWorkflow(f,{expectedVersion:'fresh',ids}),/drift/);
 const f2=fixture();f2.nodes.find(n=>n.name==='Resposta').parameters.jsCode='return []';assert.throws(()=>patchWorkflow(f2,{expectedVersion:'fresh',ids}),/differs/);
 const active=fixture();active.active=true;active.activeVersionId='other';assert.throws(()=>patchWorkflow(active,{expectedVersion:'fresh',ids}),/active workflow differ/);active.activeVersionId='fresh';active.activeVersion={versionId:'fresh',nodes:[],connections:active.connections};assert.throws(()=>patchWorkflow(active,{expectedVersion:'fresh',ids}),/active workflow differ/);
});
test('SQL and controller integration suite runs in isolated PostgreSQL only',async()=>{const {PGlite}=require('@electric-sql/pglite'),{suite}=require('./ab-registry-postgres.cjs');const db=new PGlite();try{await suite(db);}finally{await db.close();}});

test('migration rejects schema, ledger constraints and trigger shape drift without silently repairing it',async()=>{
 const {PGlite}=require('@electric-sql/pglite'),{SCHEMA,SQL}=require('./ab-registry-postgres.cjs');
 for(const change of ["ALTER TABLE crm_ab_operation_v1 ADD COLUMN unexpected text", "ALTER TABLE crm_ab_operation_v1 DROP CONSTRAINT crm_ab_operation_v1_state_check", "ALTER TABLE crm_ab_operation_v1 ADD CONSTRAINT duplicate_state CHECK(state IN ('running','completed'))", "ALTER TABLE crm_ab_operation_v1 DROP CONSTRAINT crm_ab_operation_v1_state_check; ALTER TABLE crm_ab_operation_v1 ADD CONSTRAINT changed_state CHECK(state IN ('running','completed','other'))", "GRANT SELECT ON crm_ab_operation_v1 TO PUBLIC", "DROP TRIGGER crm_ab_registry_guard_v1 ON crm_teste; CREATE TRIGGER crm_ab_registry_guard_v1 BEFORE UPDATE ON crm_teste FOR EACH ROW EXECUTE FUNCTION crm_ab_registry_guard_v1()"]){
  const db=new PGlite();try{await db.exec(SCHEMA);await db.exec(SQL);await db.exec(change);await assert.rejects(db.exec(SQL),/AB_(LEDGER|REGISTRY_GUARD).*DRIFT/);await db.exec('ROLLBACK');}finally{await db.close();}
 }
 const db=new PGlite();try{await db.exec(SCHEMA);await db.exec('ALTER TABLE crm_teste ALTER COLUMN nome DROP NOT NULL');await assert.rejects(db.exec(SQL),/AB_SCHEMA_DRIFT/);await db.exec('ROLLBACK');assert.equal((await db.query("SELECT to_regclass('crm_ab_operation_v1') AS id")).rows[0].id,null);}finally{await db.close();}
});

// PostgreSQL locales need not sort textual CHECK definitions like PGlite.
test('migration compares the exact constraint set without depending on array order',async()=>{
 const {PGlite}=require('@electric-sql/pglite'),{SCHEMA,SQL}=require('./ab-registry-postgres.cjs');
 const matched=SQL.match(/\$constraints\$(.*?)\$constraints\$/s);assert.ok(matched);
 const reversed=SQL.replace(matched[0],()=>'$constraints$'+JSON.stringify(JSON.parse(matched[1]).reverse())+'$constraints$');
 const db=new PGlite();try{await db.exec(SCHEMA);await db.exec(reversed);await db.exec(SQL);
  const r=await db.query("SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid='crm_ab_operation_v1'::regclass");assert.equal(r.rows[0].n,5);
 }finally{await db.close();}
});

test('migration canonicalizes constraint rendering locally without changing caller session settings',async()=>{
 const {PGlite}=require('@electric-sql/pglite'),{SCHEMA,SQL}=require('./ab-registry-postgres.cjs');
 const db=new PGlite();try{await db.exec(SCHEMA);await db.exec('SET search_path=pg_catalog; SET quote_all_identifiers=on');
  await db.exec(SQL);await db.exec(SQL);
  assert.equal((await db.query('SHOW search_path')).rows[0].search_path,'pg_catalog');
  assert.equal((await db.query('SHOW quote_all_identifiers')).rows[0].quote_all_identifiers,'on');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM public.crm_teste')).rows[0].n,1);
 }finally{await db.close();}
});
