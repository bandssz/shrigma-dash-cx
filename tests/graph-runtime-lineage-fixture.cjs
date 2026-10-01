'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const C=require('./graph-worker-credential-fixture.cjs'),L=require('../tools/graph-runtime-lineage/deploy.cjs'),A=require('../tools/graph-worker-access/contract.cjs');
const {F,D,copy,ROOT}=C;
function fixture(t){
 const c=C.fixture(t);c.change(m=>({...m,graph:{...m.graph,graph_shape:F.m('b'),public_shape:F.m('c')}}));
 const source='n8n/growth/journey-graph-lifecycle-publication.sql',sourcePins={[source]:D.sha(fs.readFileSync(path.join(ROOT,source),'utf8'))};
 const before=c.metadata(),review={contract:L.REVIEW,observed_metadata_hash:D.sha(before),historical_state_hash:D.sha(L.state(before)),catalog_evidence_hash:F.h(1),effective_privilege_review_hash:F.h(2),native_stack_proof_hash:F.h(3),approved_migrations:[{id:'synthetic-installed-runtime',sources:sourcePins,terminal_receipt_hash:F.h(4)}],sources:sourcePins};
 const inputs={predecessor:copy(c.inputs.predecessor),scopeReview:copy(c.inputs.scopeReview),adoptionReview:review};
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'crm-runtime-lineage-'));t?.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const store=new L.FileStore(directory);let writes=0,lose=false,effect=true,samePid=false,scope=copy(inputs.scopeReview);
 const io={snapshot:c.io.snapshot,scopeAudit:async()=>copy(scope),sql:async sql=>{
  writes++;const p=store.read('plan');if(!store.has('adopt-intent')||sql!==p.migration.runtimePlan.migration.sql)throw Error('INTENT_REQUIRED');
  if(effect)c.change(()=>copy(p.migration.expected_metadata));if(lose)throw Error('PRIVATE RAW ERROR MUST NOT BE RECORDED');
 },independentReadback:async()=>{const v=await c.io.snapshot();v.session_pid=samePid?v.session_pid:v.session_pid+1;return v;}};
 const adopter=new L.Adopter({root:ROOT,io,store});
 return {c,inputs,store,io,adopter,writes:()=>writes,lose:hasEffect=>{lose=true;effect=hasEffect;},sameSession:()=>{samePid=true;},scopeChange:fn=>{scope=fn(scope);},prepare:async()=>adopter.prepare({snapshot_sha256:D.sha(await io.snapshot()),...inputs})};
}
module.exports={fixture,L,A,D,F,ROOT,copy};
