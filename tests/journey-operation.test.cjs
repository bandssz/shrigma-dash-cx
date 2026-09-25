'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'../../growth-test-tools/node_modules/@electric-sql/pglite');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8'),patcher=require('../n8n/growth/journey-operation-workflow-patch.cjs');
test('real SQL records defined rejection atomically, supports legacy success, and GET never mutates or clears a missing receipt',async()=>{
 const db=new PGlite();try{
  await db.exec(read('tests/sql/whatsapp-order-status-cas-fixture.sql'));
  await db.exec(read('n8n/growth/engagement-editor-validation.sql'));
  await db.exec(read('n8n/growth/journey-api.sql'));await db.exec(read('n8n/growth/journey-operation.sql'));
  const slot={key:'synthetic',channel:'whatsapp',piece:'synthetic',kind:'interactive',enabled:true,wait_min:0,min_wait:0,max_wait:5,body:'Fixture'},draft={name:'Fixture',steps:[slot]};
  for(const brand of ['fish','aristo'])await db.query('INSERT INTO shrigma_flow_definition(key,name,brand,draft,binding,enabled,trigger,version,published,updated_at,updated_by,runtime_ready,published_version) VALUES($1,$2,$3,$4,$5,true,\'fixture\',2,$4,now(),\'fixture\',true,2)',[brand+':carrinho','Fixture',brand,draft,{brand,steps:[slot]}]);
  const caps=['read_content','draft','submit'];
  const call=async(p,actor='fixture')=>(await db.query('SELECT shrigma_flow_api($1,$2::jsonb,$3::jsonb) r',[actor,caps,p])).rows[0].r;
  const lookup=async(p,actor='fixture',c=caps)=>(await db.query('SELECT shrigma_flow_operation_v1($1,$2::jsonb,$3::jsonb) r',[actor,c,p])).rows[0].r;
  const count=async()=>(await db.query('SELECT count(*)::int n FROM shrigma_flow_request')).rows[0].n;
  const p={acao:'fluxo_salvar',key:'fish:carrinho',expected_version:1,definition:draft,idempotency_key:'synthetic-conflict'};
  assert.equal((await call(p))._http,409);assert.equal(await count(),1);
  let r=await lookup({operation_action:p.acao,idempotency_key:p.idempotency_key});assert.equal(r._body.operation.response._http,409);assert.deepEqual(r._body.operation.request_payload,p);
  await db.query('UPDATE shrigma_flow_definition SET version=1 WHERE key=$1',[p.key]);assert.equal((await call(p))._http,409);assert.equal((await db.query('SELECT version FROM shrigma_flow_definition WHERE key=$1',[p.key])).rows[0].version,1);
  const invalid={...p,definition:{name:'',steps:[]},idempotency_key:'synthetic-invalid'};assert.equal((await call(invalid))._http,422);assert.equal((await lookup({operation_action:p.acao,idempotency_key:invalid.idempotency_key}))._body.operation.response._http,422);
  const save={...p,idempotency_key:'synthetic-save'};const saved=await call(save);assert.equal(saved._http,200);assert.equal(saved._body.flow.version,2);
  assert.deepEqual(await call(save),saved);assert.equal(await count(),3);
  assert.equal((await lookup({operation_action:p.acao,idempotency_key:save.idempotency_key},'other'))._http,409);
  assert.equal((await lookup({operation_action:p.acao,idempotency_key:save.idempotency_key},'fixture',[]))._http,403);
  assert.equal((await lookup({operation_action:'fluxo_estado',idempotency_key:save.idempotency_key}))._http,409);
  r=await lookup({operation_action:'fluxo_salvar',idempotency_key:'synthetic-missing'});assert.equal(r._body.operation.state,'missing');assert.equal(await count(),3);
  const before=(await db.query('SELECT count(*)::int n FROM shrigma_flow_audit')).rows[0].n;
  for(const enabled of [false,true]){
   const version=(await db.query('SELECT version FROM shrigma_flow_definition WHERE key=\'aristo:carrinho\'')).rows[0].version;
   const state={acao:'fluxo_estado',key:'aristo:carrinho',expected_version:version,enabled,idempotency_key:'synthetic-no-confirm-'+enabled};
   assert.equal((await call(state))._http,400);
   assert.equal((await call({...state,confirm:enabled?'retomar':'pausar',idempotency_key:'synthetic-state-'+enabled}))._body.flow.enabled,enabled);
  }
  assert.equal((await db.query('SELECT count(*)::int n FROM shrigma_flow_audit')).rows[0].n,before+2);
  const legacy={...saved,_body:{...saved._body,legacy_fixture:true}};await db.query('INSERT INTO shrigma_flow_request VALUES($1,$2,$3,$4)',['legacy-success','fixture',{...save,idempotency_key:'legacy-success'},legacy]);
  assert.deepEqual((await lookup({operation_action:save.acao,idempotency_key:'legacy-success'}))._body.operation.response,legacy);
 }finally{await db.close();}
});
test('workflow patch changes only exact journey anchors and GET uses parameterized read-only SQL',()=>{
 const w={id:'y6qJRcWcSfEZzwgZ',versionId:'fixture',nodes:[{name:'Prepara',parameters:{jsCode:patcher.ANCHOR+'\nconst p={'+patcher.STATE+'};\n}'}},{name:'PG leitura',parameters:{options:{queryReplacement:'={{ $json.sqlParameters || [] }}'}}}],connections:{},settings:{fixture:true}};
 const p=patcher.patch(w,{expectedVersion:'fixture'});assert.deepEqual(p.nodes[1],w.nodes[1]);assert.deepEqual(p.connections,w.connections);assert.deepEqual(p.settings,w.settings);assert.match(p.nodes[0].parameters.jsCode,/confirm:b.confirm/);
 assert.throws(()=>patcher.patch(w,{expectedVersion:'different'}));assert.throws(()=>patcher.patch(p,{expectedVersion:'fixture'}));
 const run=method=>vm.runInNewContext('(function(){'+patcher.READ+'})()',{acao:'fluxo_operacao',method,q:{idempotency_key:'fixture-identity',operation_action:'fluxo_estado'},auth:{who:'fixture',caps:['submit']},out:(status,body)=>({json:{_http:status,_body:body}})});
 assert.equal(run('POST')[0].json._http,405);const r=run('GET')[0].json;assert.match(r.sql,/^SELECT public.shrigma_flow_operation_v1/);assert.equal(r.sqlParameters[0],'fixture');assert.doesNotMatch(r.sql,/INSERT|UPDATE|DELETE|shrigma_flow_api\(/);
});
