'use strict';
// Transport functions come from the existing private driver. No credentials here.
const D=require('./deploy.cjs');
const ID=/^[A-Za-z0-9_-]{1,80}$/;
function createAPIAdapter({api,sql}){
 const id=x=>{if(!ID.test(x))throw Error('CART_DEPLOY_API_ID');return x;};
 const one=async query=>{const rows=await sql(query);if(!Array.isArray(rows)||rows.length!==1||!rows[0]||typeof rows[0]!=='object')throw Error('CART_DEPLOY_SQL_SHAPE');return rows[0];};
 return {
  getWorkflow:wid=>api('workflows/'+id(wid)),
  async utilityPG(){const w=await api('workflows/ygVyBPjJqGqt2V5E');const nodes=w.nodes.filter(n=>n.type==='n8n-nodes-base.postgres');if(nodes.length!==1||!nodes[0].credentials?.postgres?.id)throw Error('CART_DEPLOY_UTILITY_PG');
   // Store only the database node fingerprint/reference, never the shared auth code/key.
   return {ids:[nodes[0].credentials.postgres.id],version:w.versionId,node_hash:D.sha(nodes[0])};},
  metadata:()=>one(D.METADATA_SQL),state:()=>one(D.STATE_SQL),sql,
  async controlOperation(op){if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(op))throw Error('CART_DEPLOY_OPERATION');const rows=await sql(`SELECT request,response FROM crm_maintenance_candidate.operation WHERE id='${op}'::uuid`);if(!Array.isArray(rows)||rows.length!==1)throw Error('CART_DEPLOY_OPERATION_UNCONFIRMED');return rows[0];},
  createWorkflow:body=>api('workflows',body,'POST'),
  putWorkflow:(wid,body)=>api('workflows/'+id(wid),body,'PUT'),
  activateWorkflow:(wid,versionId)=>api('workflows/'+id(wid)+'/activate',{versionId},'POST'),
  deactivateWorkflow:wid=>api('workflows/'+id(wid)+'/deactivate',{},'POST')
 };
}
module.exports={createAPIAdapter};
