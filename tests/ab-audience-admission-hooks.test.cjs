'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{PGlite}=require('@electric-sql/pglite');
const F=require('./ab-audience-admission-fixture.cjs'),I=require('../n8n/growth/ab-audience-admission-inspect.cjs');
const authorize=who=>{if(!who.caps.includes('submit'))throw Object.assign(Error('SEGMENT_ACCESS_DENIED'),{code:'SEGMENT_ACCESS_DENIED'});};
async function setup(t){const db=new PGlite();t.after(()=>db.close());const x=await F.setup(db),p=await x.prepared();return {x,p,request:x.admissionRequest(p)};}
test('pair admission authorization composes with validation before any hook or private material',async t=>{
 const {x,request}=await setup(t);let called=false;const before=await x.snapshot();
 const s=I.createAdmissionInspection({transaction:x.transaction,inspectionHooks:{authorize,before(){called=true;}}});
 const out=await s.execute({key:'synthetic-manager-key',request});assert.equal(out._http,403);assert.equal(called,false);assert.deepEqual(await x.snapshot(),before);
});
test('the pair hook receives verified materials in the same transaction, and lost submit permission rolls back its writes',async t=>{
 const {x,request}=await setup(t);await x.db.query("UPDATE shrigma_panel_permission_v1 SET caps='[\"draft\",\"validate\",\"read_content\",\"submit\"]' WHERE principal_id='manager'");
 await x.db.exec('CREATE TABLE synthetic_pair_hook(value integer)');let materials=false;
 const s=I.createAdmissionInspection({transaction:x.transaction,inspectionHooks:{authorize,async after(ctx){
  materials=ctx.materials.length===2&&ctx.materials.every(m=>m.snapshot?.campaign&&m.material_hash);assert.equal(ctx.bindings.length,2);assert.equal(ctx.experiment.state,'prepared');
  await ctx.query('INSERT INTO synthetic_pair_hook VALUES(1)');await ctx.query("UPDATE shrigma_panel_permission_v1 SET caps='[\"draft\",\"validate\",\"read_content\"]' WHERE principal_id='manager'");return {_http:200,_body:{synthetic:true}};
 }}});
 const out=await s.execute({key:'synthetic-manager-key',request});assert.equal(out._http,403);assert.equal(materials,true);assert.equal((await x.db.query('SELECT count(*)::int n FROM synthetic_pair_hook')).rows[0].n,0);
});
test('an authenticated receipt can return before draft-only inspection, with fresh authorization after the hook',async t=>{
 const {x,request}=await setup(t);await x.db.query("UPDATE shrigma_panel_permission_v1 SET caps='[\"draft\",\"validate\",\"read_content\",\"submit\"]' WHERE principal_id='manager'");
 const receipt={_http:200,_body:{synthetic_receipt:true}};let after=false;x.trace.length=0;
 const s=I.createAdmissionInspection({transaction:x.transaction,inspectionHooks:{authorize,before:async()=>receipt,after(){after=true;}}});
 assert.deepEqual(await s.execute({key:'synthetic-manager-key',request}),receipt);assert.equal(after,false);assert.equal(x.trace.some(q=>q.text.includes('FROM public.crm_ab_experiment_v2')),false);
});
