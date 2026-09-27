'use strict';
const D=require('./deploy.cjs');
function createAPIAdapter({api,sql}){
 const id=x=>{if(typeof x!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(x))throw Error('TX_DEPLOY_API_ID');return x;};
 const one=async query=>{const rows=await sql(query);if(!Array.isArray(rows)||rows.length!==1||!rows[0]||typeof rows[0]!=='object')throw Error('TX_DEPLOY_SQL_SHAPE');return rows[0];};
 return {
  getWorkflow:wid=>api('workflows/'+id(wid)),
  async utilityPG(){const w=await api('workflows/ygVyBPjJqGqt2V5E'),nodes=w.nodes.filter(n=>n.type==='n8n-nodes-base.postgres');if(nodes.length!==1||!nodes[0].credentials?.postgres?.id)throw Error('TX_DEPLOY_UTILITY_PG');return {ids:[nodes[0].credentials.postgres.id],version:w.versionId,node_hash:D.sha(nodes[0])};},
  metadata:()=>one(D.METADATA_SQL),state:()=>one(D.STATE_SQL),sql,
  createWorkflow:body=>api('workflows',body,'POST'),
  putWorkflow:(wid,body)=>api('workflows/'+id(wid),body,'PUT'),
  activateWorkflow:(wid,versionId)=>api('workflows/'+id(wid)+'/activate',{versionId},'POST'),
  deactivateWorkflow:wid=>api('workflows/'+id(wid)+'/deactivate',{},'POST')
 };
}
module.exports={createAPIAdapter};
