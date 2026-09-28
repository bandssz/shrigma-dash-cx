'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const S=require('../tools/graph-worker-access/snapshot.cjs');
const {WORKFLOWS}=require('../tools/graph-install/deploy.cjs');
const clone=x=>JSON.parse(JSON.stringify(x));
function fixture(id=WORKFLOWS[0]){
 const nodes=[{id:'node',type:'postgres',credentials:{postgres:{id:'synthetic-pg'}},parameters:{query:'SELECT 1'}}],connections={};
 return {id,active:true,versionId:'version',activeVersionId:'version',nodes,connections,activeVersion:{versionId:'version',nodes:clone(nodes),connections:{}},settings:{timeSavedMode:'fixed'},staticData:null,updatedAt:'2026-09-27T00:00:00.000Z',shared:[{role:'workflow:owner',project:{id:'project',projectRelations:[{role:'project:admin',user:{id:'user',updatedAt:'2026-09-27T01:02:03.456Z',lastActiveAt:'2026-09-27',disabled:false}}]}}]};
}
const user=w=>w.shared[0].project.projectRelations[0].user;
test('only valid user audit values are normalized without mutating the original export',()=>{
 const a=fixture(),original=clone(a),b=clone(a);user(b).updatedAt='2026-09-28T23:59:59.999Z';user(b).lastActiveAt='2026-09-28';
 assert.deepEqual(S.workflowSnapshot(a),S.workflowSnapshot(b));assert.deepEqual(a,original);assert.notEqual(user(a).updatedAt,user(S.normalizedWorkflow(a)).updatedAt);
 user(b).lastActiveAt='2024-02-29';assert.doesNotThrow(()=>S.workflowSnapshot(b));
});
test('malformed or replaced audit timestamps fail rather than disappear from the guard',()=>{
 for(const [key,values] of [['updatedAt',[null,4,{},'2026-09-28','2026-02-30T00:00:00.000Z','2026-09-28T00:00:00Z','2026-09-28T00:00:00.000+00:00']],['lastActiveAt',[null,4,{},'2026-09-28T00:00:00.000Z','2026-02-29','2026-02-30','2026-13-01']]])for(const value of values){const w=fixture();user(w)[key]=value;assert.throws(()=>S.workflowSnapshot(w),/USER_/);}
});
test('presence and all non-audit fields remain protected, including nested lookalike dates',()=>{
 const a=fixture(),hash=S.workflowSnapshot(a).hash;
 const changes=[w=>delete user(w).updatedAt,w=>delete user(w).lastActiveAt,w=>delete w.shared,w=>{w.shared=[];},w=>{w.shared[0].project.projectRelations=[];},w=>{user(w).disabled=true;},w=>{user(w).id='another';},w=>{w.shared[0].role='workflow:reader';},w=>{w.shared[0].project.id='other';},w=>{w.shared[0].project.projectRelations[0].role='project:viewer';},w=>{w.updatedAt='2026-09-28T00:00:00.000Z';},w=>{w.settings.timeSavedMode='other';},w=>{w.staticData={x:1};},w=>{w.activeVersion.lastActiveAt='2026-09-28';},w=>{user(w).profile={updatedAt:'different'};}];
 for(const change of changes){const b=clone(a);change(b);assert.notEqual(S.workflowSnapshot(b).hash,hash);}
});
test('runtime publication, credentials and content cannot be hidden by audit normalization',()=>{
 for(const change of [w=>{w.active=false;},w=>{w.activeVersionId='other';},w=>{w.activeVersion.nodes=[];},w=>{w.nodes[0].parameters.query='SELECT 2';},w=>{w.id='unapproved';},w=>{w.nodes[0].credentials.postgres.id='other';}]){const w=fixture();change(w);assert.throws(()=>S.workflowSnapshot(w),/WORKFLOW_/);}
 const w=fixture();w.nodes[0].credentials.postgres.id='other';w.activeVersion.nodes=clone(w.nodes);assert.notEqual(S.workflowSnapshot(w).hash,S.workflowSnapshot(fixture()).hash);
});
test('capture checks each protected workflow identity and one unchanged PostgreSQL credential reference',async()=>{
 const io={utilityPG:async()=>({ids:['synthetic-pg'],hash:'utility'}),getWorkflow:async id=>fixture(id)};
 const result=await S.captureWorkflows(io);assert.deepEqual(result.workflows.map(w=>w.id),WORKFLOWS);
 await assert.rejects(S.captureWorkflows({...io,getWorkflow:async()=>fixture(WORKFLOWS[1])}),/WORKFLOW_ID/);
 await assert.rejects(S.captureWorkflows({...io,utilityPG:async()=>({ids:['other']})}),/PG_REFERENCE/);
 await assert.rejects(S.captureWorkflows({...io,utilityPG:async()=>({ids:['synthetic-pg','other']})}),/UTILITY_PG/);
});
