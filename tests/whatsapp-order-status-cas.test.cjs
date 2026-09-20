'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'../../growth-test-tools/node_modules/@electric-sql/pglite');
const M=require('../n8n/growth/whatsapp-order-status-proposal.cjs'),I=require('../n8n/growth/whatsapp-order-status-integration.cjs'),A=require('../n8n/growth/whatsapp-order-status-activation.cjs');
const read=file=>fs.readFileSync(path.join(__dirname,file),'utf8'),clone=structuredClone;
const SQL=read('../n8n/growth/whatsapp-order-status-cas.sql');
test('installation source cannot be reinterpreted as a maintenance-node expression',()=>{
 // The existing Postgres node evaluates these delimiters even inside SQL
 // quoted literals. The provider placeholder must still match in the CAS
 // success test below, but must not occur verbatim in transported SQL source.
 assert.doesNotMatch(SQL,/\{\{[\s\S]*?\}\}/);
});
async function seed(db){
 await db.exec('TRUNCATE shrigma_flow_definition,shrigma_flow_template,shrigma_flow_request,shrigma_flow_revision,shrigma_flow_audit;');
 const byBrand=require('./whatsapp-order-status-fixture.cjs').catalogs(),proposals=M.buildProposal(byBrand),catalog=Object.values(byBrand).flat();
 for(const t of catalog)await db.query('INSERT INTO shrigma_flow_template VALUES($1,$2,$3)',[t.brand,t.id,t]);
 proposals.forEach((p,i)=>catalog.push({brand:p.brand,id:String(99000+i),status:'APPROVED',...clone(p.provider_payload)}));
 for(const key of [...new Set(proposals.map(p=>p.flow_key))]){
  const ps=proposals.filter(p=>p.flow_key===key),steps=[];
  for(const p of ps){
   const src=catalog.find(x=>x.id===p.source_template_id),signature=(await db.query('SELECT shrigma_wa_signature($1::jsonb) AS s',[src.components])).rows[0].s;
   steps.push({key:p.step_key,name:'Synthetic stage',channel:'whatsapp',flow:'transacional',piece:p.draft.peca,enabled:true,wait_min:0,template_id:p.source_template_id,template_name:p.source_template_name,category:'UTILITY',signature});
  }
  steps.push({key:'interactive:unchanged',channel:'whatsapp',piece:'unchanged',kind:'interactive',enabled:false,wait_min:12,body:'Preserved synthetic stage'});
  const binding={brand:ps[0].brand,steps:steps.map(s=>({...clone(s),min_wait:0,max_wait:30,...(ps.find(p=>p.step_key===s.key)?{source_template_id:ps.find(p=>p.step_key===s.key).caller_template_id}:{})}))};
  const definition={name:'Synthetic flow',steps};
  await db.query("INSERT INTO shrigma_flow_definition VALUES($1,'Synthetic flow',$2,$3,$4,$5,'existing-event',3,$3,'2026-09-19T00:00:00Z','synthetic-original',true,3)",[key,ps[0].brand,definition,binding,key!=='fish:rastreio']);
 }
 const flows=(await db.query('SELECT to_jsonb(f) AS f FROM shrigma_flow_definition f ORDER BY key')).rows.map(x=>x.f),contracts=I.buildContracts(proposals,catalog,flows),now=new Date().toISOString();
 const runtime=Object.entries(A.RUNTIMES).map(([role,workflow_id])=>({role,workflow_id,active:true,readback_exact:true,version_id:'00000000-0000-0000-0000-000000000001',active_version_id:'00000000-0000-0000-0000-000000000001',expected_code_sha256:'a'.repeat(64),code_sha256:'a'.repeat(64),checked_at:now,...(role==='motor'?{contracts}:{} )}));
 return {proposals,catalog,flows,runtime,request:A.buildActivationRequest({operationKey:'synthetic-rollout-0001',proposals,catalog,flows,runtimeReceipts:runtime,catalogCheckedAt:now})};
}
async function snapshot(db){
 const out={};for(const table of ['shrigma_flow_definition','shrigma_flow_template','shrigma_flow_request','shrigma_flow_revision','shrigma_flow_audit','shrigma_send_log'])out[table]=(await db.query(`SELECT to_jsonb(x) AS row FROM ${table} x ORDER BY to_jsonb(x)::text`)).rows.map(x=>x.row);return out;
}
async function call(db,p,key='publisher-A'){return (await db.query(A.QUERY,[key,p])).rows[0].result;}
async function rejected(db,p,error,key){const before=await snapshot(db),r=await call(db,p,key);assert.equal(r._body.error,error);assert.equal(r._body.nothing_changed,true);assert.deepEqual(await snapshot(db),before);return r;}

test('four-flow CAS PostgreSQL transaction',async t=>{
 const db=new PGlite();
 try{
  await db.exec(read('sql/whatsapp-order-status-cas-fixture.sql'));
  const review=read('../n8n/growth/whatsapp-approved-rollout.sql');
  await db.exec(review.slice(review.indexOf('CREATE OR REPLACE FUNCTION public.shrigma_wa_review_content'),review.indexOf('CREATE OR REPLACE FUNCTION public.shrigma_wa_review_activate')));
  // Real repository validator; only the signature/catalog boundary is synthetic.
  await db.exec(read('../n8n/growth/engagement-editor-validation.sql'));
  await db.exec(SQL);
  await t.test('all four switch once, validate against new registry, and preserve other stages/reservations',async()=>{
   const {request}=await seed(db),before=await snapshot(db),r=await call(db,request),after=await snapshot(db);
   assert.equal(r._http,200);assert.equal(r._body.state,'activated');assert.equal(r._body.recipients,0);assert.equal(r._body.messages,0);
   assert.equal(after.shrigma_flow_template.length,12);assert.equal(after.shrigma_flow_revision.length,4);assert.equal(after.shrigma_flow_audit.length,4);assert.equal(after.shrigma_flow_request.length,1);
   for(const u of request.updates){
    const f=after.shrigma_flow_definition.find(x=>x.key===u.key),expected={...clone(u.next),updated_by:'synthetic-A',updated_at:f.updated_at};
    assert.deepEqual(f,expected);assert.equal(f.version,4);assert.deepEqual(f.draft,f.published);
    assert.deepEqual((await db.query('SELECT shrigma_flow_validate($1::jsonb,$2::jsonb) AS errors',[f.published,f.binding])).rows[0].errors,[]);
   }
   assert.deepEqual(after.shrigma_send_log,before.shrigma_send_log);
   assert.equal(after.shrigma_flow_definition.find(x=>x.key==='fish:rastreio').enabled,false,'never unpause an existing flow');
   assert.deepEqual(await call(db,request),r,'lost response can be recovered with original intent');
   assert.deepEqual(await snapshot(db),after,'same-key replay produces no second revision/audit');
   await rejected(db,request,'idempotency_replay_mismatch','publisher-B');
   const changed=clone(request);changed.catalog_checked_at=new Date(Date.now()+1000).toISOString();await rejected(db,changed,'idempotency_replay_mismatch');
   await rejected(db,{...request,idempotency_key:'synthetic-rollout-0002'},'snapshot_conflict');
  });
  await t.test('one concurrent row change, even outside a selected stage, rejects every change',async()=>{
   const {request}=await seed(db);await db.exec("UPDATE shrigma_flow_definition SET updated_by='another-editor' WHERE key='fish:rastreio'");
   await rejected(db,request,'snapshot_conflict');
  });
  await t.test('fresh snapshot containing an unpublished draft or version split still fails closed',async()=>{
   for(const field of ['draft','version','runtime_ready']){
    const {request}=await seed(db),u=request.updates[0],next=field==='draft'?{...u.expected.draft,name:'Unpublished'}:field==='version'?5:false;
    await db.query(`UPDATE shrigma_flow_definition SET ${field}=$1 WHERE key=$2`,[next,u.key]);
    u.expected=(await db.query('SELECT to_jsonb(f) AS f FROM shrigma_flow_definition f WHERE key=$1',[u.key])).rows[0].f;
    await rejected(db,request,'unpublished_or_unready_flow');
   }
  });
  await t.test('APPROVED, language/category/content, original template and exact order button are required',async()=>{
   const mutations=[p=>p.catalog.at(-1).status='PENDING',p=>p.catalog.at(-1).language='en_US',p=>p.catalog.at(-1).category='MARKETING',p=>p.catalog.at(-1).components.find(x=>x.type==='BODY').text+=' altered',p=>p.catalog[0].status='PAUSED'];
   for(const mutate of mutations){const {request}=await seed(db);mutate(request);await rejected(db,request,'provider_approval_or_content_changed');}
   const {request}=await seed(db),target=request.catalog.at(-1),c=request.contracts.find(c=>c.target.id===target.id);
   target.components.find(x=>x.type==='BUTTONS').buttons[1].url='https://example.invalid/other-support';c.target.components=clone(target.components);request.runtime.find(x=>x.role==='motor').contracts=clone(request.contracts);
   await rejected(db,request,'only_order_url_may_change');
  });
  await t.test('changed cadence, flags, source selector, unselected stages and audit step scope cannot be smuggled',async()=>{
   const changes=[p=>p.updates[0].next.enabled=false,p=>p.updates[0].next.published.steps[0].wait_min=1,p=>p.updates[0].next.binding.steps[0].source_template_id='999',p=>p.updates[0].next.draft.steps.at(-1).body='changed'];
   for(const mutate of changes){const {request}=await seed(db);mutate(request);await rejected(db,request,'unexpected_stage_change');}
   const {request}=await seed(db);request.updates[0].steps.push('other');await rejected(db,request,'audit_steps_mismatch');
  });
  await t.test('runtime proof binds all three active versions and compiled motor contract to this intent',async()=>{
   for(const mutate of [p=>p.runtime[0].active=false,p=>p.runtime[0].active_version_id='stale',p=>p.runtime[0].code_sha256='b'.repeat(64),p=>p.runtime[0].workflow_id='another',p=>p.runtime[0].role=null,p=>p.runtime[1]=clone(p.runtime[0])]){
    const {request}=await seed(db);mutate(request);await rejected(db,request,'runtime_proof_incomplete');
   }
   const {request}=await seed(db);request.runtime.find(x=>x.role==='motor').contracts=[];await rejected(db,request,'active_motor_contract_differs');
  });
  await t.test('missing scope, stale readings, a read-only actor and request SQL are rejected without writes',async()=>{
   const {request}=await seed(db);
   await rejected(db,request,'publish_capability_required','reader');await rejected(db,request,'publish_capability_required','bad-key');
   await rejected(db,{...request,sql:'SELECT 1'},'unexpected_request_field');await rejected(db,{...request,updates:request.updates.slice(1)},'exact_rollout_scope_required');
   await rejected(db,{...request,catalog_checked_at:'2020-01-01T00:00:00Z'},'catalog_proof_not_current');
   const stale=clone(request);stale.runtime[0].checked_at='2020-01-01T00:00:00Z';await rejected(db,stale,'runtime_proof_not_current');
  });
  await t.test('existing validator rejection rolls back registry upserts and all other writes',async()=>{
   const {request}=await seed(db),u=request.updates[0];
   // A pre-existing invalid stage is untouched by the patch, but must still block.
   await db.query("UPDATE shrigma_flow_definition SET draft=jsonb_set(draft,'{steps,1,wait_min}','999'),published=jsonb_set(published,'{steps,1,wait_min}','999') WHERE key=$1",[u.key]);
   u.expected=(await db.query('SELECT to_jsonb(f) AS f FROM shrigma_flow_definition f WHERE key=$1',[u.key])).rows[0].f;
   u.next.draft.steps[1].wait_min=999;u.next.published.steps[1].wait_min=999;
   await rejected(db,request,'stage_validation_failed');
  });
  await t.test('a failure after earlier rows changed rolls back registry, rows, revisions, audit and receipt',async()=>{
   const {request}=await seed(db),before=await snapshot(db);
   await db.exec("CREATE FUNCTION synthetic_late_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.flow_key='fish:rastreio' THEN RAISE EXCEPTION 'synthetic late audit failure'; END IF; RETURN NEW; END$$; CREATE TRIGGER synthetic_late_failure BEFORE INSERT ON shrigma_flow_audit FOR EACH ROW EXECUTE FUNCTION synthetic_late_failure();");
   try{await assert.rejects(call(db,request),/synthetic late audit failure/);assert.deepEqual(await snapshot(db),before);}
   finally{await db.exec('DROP TRIGGER synthetic_late_failure ON shrigma_flow_audit; DROP FUNCTION synthetic_late_failure()');}
   assert.equal((await call(db,request))._http,200,'same exact intent can succeed only after a proved full rollback');
  });
  await t.test('reserved next revision and missing target row block the entire change',async()=>{
   let {request}=await seed(db);await db.query('INSERT INTO shrigma_flow_revision VALUES($1,4,$2,$3)',[request.updates[0].key,{},'another']);await rejected(db,request,'revision_already_exists');
   ({request}=await seed(db));await db.query('DELETE FROM shrigma_flow_definition WHERE key=$1',[request.updates[0].key]);await rejected(db,request,'rollout_targets_missing');
  });
  await t.test('new function does not gain definer privileges or public execute grants',async()=>{
   const p=(await db.query("SELECT prosecdef,proacl::text AS acl FROM pg_proc WHERE proname='shrigma_wa_order_status_activate_v1'")).rows[0];assert.equal(p.prosecdef,false);assert.ok(p.acl&&!p.acl.includes('{=X')&&!p.acl.includes(',=X'));
  });
 }finally{await db.close();}
});

test('runtime receipts prove active code, not only a matching active-version label',()=>{
 const contracts=[{target:{id:'99901',name:'synthetic',status:'APPROVED'}}],declaration='const ORDER_STATUS_CONTRACTS='+JSON.stringify(contracts)+';\n';
 const expected={id:A.RUNTIMES.motor,nodes:[{name:'Aplica fluxo publicado',parameters:{jsCode:'// '+I.MOTOR_MARKER+'\n'+declaration+'const HOSTS={};'}},{name:'Valida template UTILITY',parameters:{jsCode:'// '+I.GUARD_MARKER+'\n'+declaration}},{name:'Interpreta resposta',parameters:{jsCode:'// WA_UNCERTAIN_RESERVATION_V1'}}],connections:{existing:true},settings:{existing:true}},version='00000000-0000-0000-0000-000000000001';
 const readback={...clone(expected),active:true,versionId:version,activeVersionId:version,activeVersion:{workflowId:expected.id,versionId:version,nodes:clone(expected.nodes),connections:clone(expected.connections)}};
 const receipt=A.runtimeReceipt('motor',expected,readback);assert.deepEqual(receipt.contracts,contracts);assert.equal(receipt.code_sha256,receipt.expected_code_sha256);
 for(const mutate of [x=>x.activeVersion.nodes[0].parameters.jsCode+=' changed',x=>x.activeVersion.versionId='stale',x=>x.active=false,x=>x.activeVersionId='stale',x=>x.connections.extra=true,x=>x.settings.extra=true]){
  const stale=clone(readback);mutate(stale);assert.throws(()=>A.runtimeReceipt('motor',expected,stale),/Active|readback/);
 }
 const changed=clone(readback);changed.nodes[1].parameters.jsCode=changed.nodes[1].parameters.jsCode.replace('99901','99902');changed.activeVersion.nodes=clone(changed.nodes);
 assert.throws(()=>A.runtimeReceipt('motor',changed,changed),/different contracts/);
});

test('request builder refuses unsupported catalog/runtime evidence and strips example payloads',async()=>{
 const db=new PGlite();try{
  await db.exec(read('sql/whatsapp-order-status-cas-fixture.sql'));
  const fixture=await seed(db),args={operationKey:'synthetic-prepared-001',proposals:fixture.proposals,catalog:fixture.catalog,flows:fixture.flows,runtimeReceipts:fixture.runtime,catalogCheckedAt:new Date().toISOString()};
  const request=A.buildActivationRequest(args);assert.equal(request.catalog.length,12);assert.ok(!JSON.stringify(request.catalog).includes('body_text'));assert.equal(request.updates.length,4);
  for(const mutate of [x=>x.catalog.at(-1).status='PENDING',x=>x.runtimeReceipts.pop(),x=>x.runtimeReceipts[0].active=false,x=>x.runtimeReceipts.find(r=>r.role==='motor').contracts=[],x=>x.catalogCheckedAt='2020-01-01T00:00:00Z',x=>x.operationKey='']){
   const bad=clone(args);mutate(bad);assert.throws(()=>A.buildActivationRequest(bad));
  }
 }finally{await db.close();}
});


test('migration failure during ACL restriction rolls CREATE back in the same explicit transaction',async()=>{
 const db=new PGlite();try{
  await db.exec(read('sql/whatsapp-order-status-cas-fixture.sql'));
  assert.match(SQL,/\nBEGIN;\nCREATE OR REPLACE FUNCTION/);assert.match(SQL,/REVOKE ALL[^;]+;\nCOMMIT;\s*$/);
  const broken=SQL.replace('FROM PUBLIC;','FROM synthetic_role_does_not_exist;');
  await assert.rejects(db.exec(broken),/synthetic_role_does_not_exist/);
  await db.exec('ROLLBACK');
  const row=(await db.query("SELECT to_regprocedure('public.shrigma_wa_order_status_activate_v1(text,jsonb)') AS installed")).rows[0];
  assert.equal(row.installed,null,'failed privilege restriction cannot leave a newly created callable function');
 }finally{await db.close();}
});
