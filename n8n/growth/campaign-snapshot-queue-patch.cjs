'use strict';
// Pure, version-bound patch: no network, credentials, installation or execution.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ID='RvXBh2GKPX91VfRx',NODE='1 · crm_campanha';
const SOURCE_SHA='e6ffab5981bd048e2f114a56399725cd2d763192a756ff75e6d8211677ec67e5';
const TYPES="('agendada','rascunho','pausada','cancelada','indisponivel')";
const CLASSIFY="    WHEN c.started_at IS NULL AND c.status IN ('scheduled','paused') THEN 'agendada'";
const FREEZE='WHERE crm_campanha.congelado IS NOT TRUE';
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
function one(source,anchor,replacement){
 if(source.split(anchor).length!==2)throw Error('SNAPSHOT_ANCHOR_MISMATCH');
 return source.replace(anchor,replacement);
}
function brandExpression(source){
 const matches=[...source.matchAll(/(CASE\n\s+WHEN c\.from_email[\s\S]*?END) AS marca\n  FROM campaigns c/g)];
 if(matches.length!==1)throw Error('SNAPSHOT_BRAND_MISMATCH');
 return matches[0][1];
}
function reconcileSql(source){
 if(sha(source)!==SOURCE_SHA)throw Error('SNAPSHOT_SOURCE_MISMATCH');
 return one(fs.readFileSync(path.join(__dirname,'campaign-snapshot-queue.sql'),'utf8'),
  '/* CURRENT_BRAND_EXPRESSION */',brandExpression(source));
}
function patch(workflow,{expectedVersion}={}){
 if(!expectedVersion||workflow?.id!==ID||workflow.versionId!==expectedVersion)throw Error('SNAPSHOT_VERSION_MISMATCH');
 if(workflow.active===true&&workflow.activeVersionId!==expectedVersion)throw Error('SNAPSHOT_PUBLISHED_VERSION_MISMATCH');
 const result=JSON.parse(JSON.stringify(workflow));
 const nodes=result.nodes?.filter(n=>n.name===NODE);
 if(nodes?.length!==1||nodes[0].type!=='n8n-nodes-base.postgres'||nodes[0].parameters?.operation!=='executeQuery')throw Error('SNAPSHOT_NODE_MISMATCH');
 const source=nodes[0].parameters.query;
 if(typeof source!=='string'||sha(source)!==SOURCE_SHA)throw Error('SNAPSHOT_SOURCE_MISMATCH');
 // Only Fish/Aristo gain explicit never-started pause/cancellation states.
 // Existing classifications of other brands and all sent history stay unchanged.
 let query=one(source,CLASSIFY,
  "    WHEN c.marca IN ('fish','aristo') AND c.started_at IS NULL AND c.sent=0\n"+
  "      AND c.status::text IN ('paused','cancelled','canceled') THEN\n"+
  "      CASE WHEN c.status::text='paused' THEN 'pausada' ELSE 'cancelada' END\n"+CLASSIFY);
 // A pending snapshot can age beyond the normal seven-day metrics freeze. It must
 // still follow a reschedule or a real start, instead of remaining a phantom queue.
 query=one(query,FREEZE,FREEZE+"\n   OR (crm_campanha.marca IN ('fish','aristo') AND crm_campanha.canal='email'\n"+
  `       AND crm_campanha.tipo IN ${TYPES} AND crm_campanha.enviados=0)`);
 // One PostgreSQL command yields one node result. A DO block makes both writes
 // atomic without emitting BEGIN/INSERT/UPDATE/COMMIT as separate n8n items.
 nodes[0].parameters.query='DO $crm22_snapshot$\nBEGIN\n'+query+';\n\n'+reconcileSql(source)+'\nEND\n$crm22_snapshot$;';
 return result;
}
module.exports={patch,reconcileSql,brandExpression,ID,NODE,SOURCE_SHA};
