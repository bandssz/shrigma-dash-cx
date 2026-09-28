'use strict';
// New operational snapshot. Historical installation plans/receipts and their
// original normalizer stay immutable in tools/graph-install/deploy.cjs.
const {sha,canonical,WORKFLOWS}=require('../graph-install/deploy.cjs');
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const same=(a,b)=>canonical(a)===canonical(b);
function check(ok,code){if(!ok)throw Error('GRAPH_WORKER_SNAPSHOT_'+code);}
function normalizedWorkflow(workflow){
 if(!Array.isArray(workflow?.shared))return workflow;
 return {...workflow,shared:workflow.shared.map(shared=>{
  if(!record(shared)||!record(shared.project)||!Array.isArray(shared.project.projectRelations))return shared;
  return {...shared,project:{...shared.project,projectRelations:shared.project.projectRelations.map(relation=>{
   if(!record(relation)||!record(relation.user))return relation;
   const user={...relation.user};
   if(Object.hasOwn(user,'updatedAt')){
    const value=user.updatedAt;
    check(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value,'USER_UPDATED_AT');
    user.updatedAt='1970-01-01T00:00:00.000Z';
   }
   if(Object.hasOwn(user,'lastActiveAt')){
    const value=user.lastActiveAt;
    check(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00.000Z'))&&new Date(value+'T00:00:00.000Z').toISOString().slice(0,10)===value,'USER_LAST_ACTIVE_AT');
    user.lastActiveAt='1970-01-01';
   }
   return {...relation,user};
  })}};
 })};
}
function workflowSnapshot(workflow){
 check(WORKFLOWS.includes(workflow?.id),'WORKFLOW_ID');
 check(workflow.active===true&&typeof workflow.versionId==='string'&&workflow.versionId.length>0&&workflow.activeVersionId===workflow.versionId&&workflow.activeVersion?.versionId===workflow.versionId&&Array.isArray(workflow.nodes)&&record(workflow.connections)&&same(workflow.nodes,workflow.activeVersion.nodes)&&same(workflow.connections,workflow.activeVersion.connections),'WORKFLOW_UNPUBLISHED');
 const pg_ids=[...new Set(workflow.nodes.filter(n=>n.credentials?.postgres).map(n=>n.credentials.postgres.id))].sort();
 check(pg_ids.length===1&&typeof pg_ids[0]==='string'&&pg_ids[0].length>0,'WORKFLOW_PG');
 return {id:workflow.id,version:workflow.versionId,hash:sha(normalizedWorkflow(workflow)),pg_ids};
}
async function captureWorkflows(io){
 const utility=await io.utilityPG();check(record(utility)&&Array.isArray(utility.ids)&&utility.ids.length===1&&typeof utility.ids[0]==='string'&&utility.ids[0].length>0,'UTILITY_PG');
 const workflows=[];
 for(const id of WORKFLOWS){const raw=await io.getWorkflow(id);check(raw?.id===id,'WORKFLOW_ID');const snapshot=workflowSnapshot(raw);check(same(snapshot.pg_ids,utility.ids),'PG_REFERENCE');workflows.push(snapshot);}
 return {workflows,utility};
}
module.exports={normalizedWorkflow,workflowSnapshot,captureWorkflows};
