'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const ASSETS=JSON.parse(fs.readFileSync(path.join(__dirname,'ASSETS.json'),'utf8'));
const text=name=>{const b=fs.readFileSync(path.join(__dirname,name));const p=ASSETS[name];if(!p||b.length!==p.bytes||sha(b)!==p.sha256)throw Error('NPS_SOURCE_PIN_REFUSED');return b.toString('utf8');};
const snapshotSQL=text('SNAPSHOT.catalog-read.sql');
const applySQL=text('APPLY.atomic.sql'),restoreSQL=text('RESTORE.structural.sql');
function plan({action,expectedSnapshot}){
 if(!['apply','restore'].includes(action))throw Error('NPS_ACTION_REFUSED');
 if(!expectedSnapshot||expectedSnapshot.schema!=='nps-delete-catalog-v1'||expectedSnapshot.serverMajor!==17||!expectedSnapshot.tables||!Array.isArray(expectedSnapshot.functions)||!Array.isArray(expectedSnapshot.triggers)||!Array.isArray(expectedSnapshot.constraints))throw Error('NPS_EXPECTED_CHECKPOINT_REQUIRED');
 const checkpoint=JSON.stringify(expectedSnapshot);
 if(Buffer.byteLength(checkpoint)>131072)throw Error('NPS_CHECKPOINT_BOUND_REFUSED');
 // This is an inert plan. JSON is an extended-query parameter, never SQL/argv/log text.
 // Root must separately admit CURRENT role/owner/private binding, backups, COMMIT and readback.
 return Object.freeze({schema:'nps-delete-source-plan-v1',action,sourceOnly:true,requiresOriginalAdmission:true,
  steps:Object.freeze([
   {text:'BEGIN',values:[]},
   {text:"SELECT set_config('search_path','pg_catalog',true),set_config('lock_timeout','500ms',true),set_config('statement_timeout','5s',true),set_config('idle_in_transaction_session_timeout','10s',true)",values:[]},
   {text:'LOCK TABLE public.subscribers IN SHARE ROW EXCLUSIVE MODE',values:[]},
   {text:'LOCK TABLE public.shrigma_nps_vote_sync IN ACCESS EXCLUSIVE MODE',values:[]},
   {text:"SELECT set_config('shrigma.nps.expected',$1,true) IS NOT NULL AS checkpoint_bound",values:[checkpoint]},
   {text:action==='apply'?applySQL:restoreSQL,values:[]}
  ]),commit:'COMMIT',rollback:'ROLLBACK',catalogReadSQL:snapshotSQL,
  originalCalls:0,structuralRestoreCannotRecoverErasedData:true});
}
const catalogReadSteps=Object.freeze(['BEGIN READ ONLY','SET LOCAL search_path=pg_catalog',snapshotSQL,'ROLLBACK']);
module.exports=Object.freeze({plan,snapshotSQL,catalogReadSteps,assets:ASSETS});
