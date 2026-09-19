'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {OLD_CLASSIFICATION,OLD_BRANCH,patchCode,patchWorkflow}=require('../n8n/growth/whatsapp-uncertain-patch.cjs');
// Minimal synthetic interpreter fixture, with the exact vulnerable live branch.
// Never export a live workflow or customer payload into the repository.
const original=`const TRANSITORIOS=[1,2,4,17,80007,130429,131048,131056,131000];
const esc=v=>"'"+String(v).replace(/'/g,"''")+"'";
const saida={log_id:42,ok:false,terminal:true};
const status=$json.statusCode??null,body=$json.body||{},wamid=body.messages?.[0]?.id||null;
let sql;
if(status>=200&&status<300&&wamid){saida.ok=true;saida.wamid=wamid;saida.motivo='enviado';sql='accepted';}
else {const err=body.error||{};saida.erro_code=err.code??status;saida.erro_msg=String(err.message||'');
  ${OLD_CLASSIFICATION}
  if(transitorio){
${OLD_BRANCH}
  }else{saida.motivo='meta_erro';sql='permanent';}}
return {sql,saida};`;
const run=(code,input)=>vm.runInNewContext('(function(){'+code+'})()',{ $json:input });
const updated=patchCode(original);
test('reproduces the former 503 deletion and preserves the same reservation after the patch',()=>{
 const input={statusCode:503,body:{error:{code:2,message:'unavailable'}}};
 assert.match(run(original,input).sql,/delete from shrigma_send_log/);
 const result=run(updated,input);
 assert.match(result.sql,/update shrigma_send_log/);assert.match(result.sql,/where id = 42 and wamid is null/);
 assert.doesNotMatch(result.sql,/delete/i);assert.equal(result.saida.incerto,true);assert.equal(result.saida.ok,false);
 assert.equal(result.saida.terminal,true);assert.match(result.sql,/UNCERTAIN_META/);
});
test('all ambiguous outcomes stop automatic attempts without inventing a provider receipt',()=>{
 for(const input of [{},{statusCode:null},{statusCode:500},{statusCode:502},{statusCode:504},{statusCode:408},{statusCode:429},{statusCode:200,body:{}},{statusCode:302},{statusCode:400,body:{error:{code:130429}}},{statusCode:400,body:{error:{code:131000}}}]){
  const r=run(updated,input);assert.equal(r.saida.incerto,true,JSON.stringify(input));assert.equal(r.saida.terminal,true);
  assert.equal(r.saida.ok,false);assert.equal(r.saida.wamid,undefined);assert.doesNotMatch(r.sql,/delete/i);
 }
});
test('accepted receipt and explicit permanent rejection retain their original branches',()=>{
 const accepted=run(updated,{statusCode:200,body:{messages:[{id:'synthetic-wamid'}]}});
 assert.equal(accepted.saida.ok,true);assert.equal(accepted.saida.incerto,undefined);assert.equal(accepted.sql,'accepted');
 const rejected=run(updated,{statusCode:400,body:{error:{code:100,message:'invalid parameter'}}});
 assert.equal(rejected.sql,'permanent');assert.equal(rejected.saida.incerto,undefined);assert.equal(rejected.saida.terminal,true);
});
test('fresh version binding and shape checks prevent overwriting unrelated changes',()=>{
 const w={versionId:'fresh',active:true,nodes:[{name:'Interpreta resposta',type:'n8n-nodes-base.code',parameters:{jsCode:original}},{name:'Guardas',parameters:{query:'unchanged'}}],connections:{same:true},settings:{same:true}};
 const copy=structuredClone(w),r=patchWorkflow(w,{expectedVersionId:'fresh'});
 assert.deepEqual(w,copy);assert.deepEqual(r.workflow.nodes[1],w.nodes[1]);assert.deepEqual(r.workflow.connections,w.connections);assert.deepEqual(r.workflow.settings,w.settings);
 assert.equal(r.changes.length,1);assert.deepEqual(patchWorkflow(r.workflow,{expectedVersionId:'fresh'}).changes,[]);
 assert.throws(()=>patchWorkflow(w,{expectedVersionId:'stale'}),/matching/);
 assert.throws(()=>patchWorkflow(w),/matching/);
 assert.throws(()=>patchCode(original.replace(OLD_CLASSIFICATION,'changed')),/changed/);
 assert.throws(()=>patchCode(updated+'\ndelete from shrigma_send_log'),/Unrecognized/);
});
test('retained reservation and charge evidence block the same logical send after a retry',async()=>{
 const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'../../growth-test-tools/node_modules/@electric-sql/pglite'),db=new PGlite();
 try{
  await db.exec("CREATE TABLE shrigma_send_log(id bigint primary key,ref text unique,wamid text,erro text); CREATE TABLE charge_evidence(log_id bigint references shrigma_send_log(id) ON DELETE CASCADE); INSERT INTO shrigma_send_log VALUES(42,'synthetic-order',NULL,NULL); INSERT INTO charge_evidence VALUES(42);");
  await db.exec(run(original,{statusCode:503}).sql);
  assert.equal((await db.query("INSERT INTO shrigma_send_log VALUES(43,'synthetic-order',NULL,NULL) ON CONFLICT(ref) DO NOTHING RETURNING id")).rows.length,1,'old ambiguous response reopened the same logical send');
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM charge_evidence')).rows[0].n),0,'old deletion cascaded into payment evidence');
  await db.exec("DELETE FROM shrigma_send_log; INSERT INTO shrigma_send_log VALUES(42,'synthetic-order',NULL,NULL); INSERT INTO charge_evidence VALUES(42)");
  await db.exec(run(updated,{statusCode:503}).sql);
  const retry=await db.query("INSERT INTO shrigma_send_log VALUES(43,'synthetic-order',NULL,NULL) ON CONFLICT(ref) DO NOTHING RETURNING id");
  assert.equal(retry.rows.length,0);
  const row=(await db.query('SELECT l.id,l.erro,(SELECT count(*) FROM charge_evidence) AS evidence FROM shrigma_send_log l')).rows[0];
  assert.equal(Number(row.id),42);assert.equal(Number(row.evidence),1);assert.match(row.erro,/UNCERTAIN_META/);
  await db.exec("UPDATE shrigma_send_log SET wamid='synthetic-later-receipt',erro=NULL WHERE id=42");
  await db.exec(run(updated,{statusCode:503}).sql);
  assert.equal((await db.query('SELECT erro FROM shrigma_send_log')).rows[0].erro,null,'late acceptance must not be overwritten by an ambiguous result');
 }finally{await db.close();}
});
