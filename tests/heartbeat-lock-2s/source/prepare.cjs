"use strict";
// SOURCE only; execution/admission remain exclusively Root-owned.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const ASSETS=Object.freeze({
  "APPLY.atomic.sql": "3700e61a80b21bae4b93f34584423a7e2a289ca0a66af3f1a8ff9c71403fb90e",
  "RESTORE.atomic.sql": "64360a9b9f53d09fe9960a4203731b978c02df3ed402346f1b780a46f3dec972",
  "snapshot.private-read.sql": "ee6d941acd6f4c7dc090955fd08f750f2fe0f0a5163c6bc647c86879d35f02a5"
});
const fail=c=>{const e=new Error(c);e.code=c;throw e;};
const sha=b=>crypto.createHash("sha256").update(b).digest("hex");
function prepare(stage){
 if(!["apply","restore"].includes(stage))fail("HEARTBEAT_LOCK_STAGE_REFUSED");
 const load=name=>{let b;try{b=fs.readFileSync(path.join(__dirname,name));}catch{fail("HEARTBEAT_LOCK_SOURCE_DRIFT");}if(sha(b)!==ASSETS[name])fail("HEARTBEAT_LOCK_SOURCE_DRIFT");return b.toString("utf8");};
 return Object.freeze({schema:"heartbeat-lock-2s-prepared-v1",stage,executionAvailable:false,authorityCreated:false,
  snapshotReadSQL:load("snapshot.private-read.sql"),sourceSha256:ASSETS[stage.toUpperCase()+".atomic.sql"],
  statements:Object.freeze(["BEGIN ISOLATION LEVEL READ COMMITTED;","SET LOCAL statement_timeout='5s';","SET LOCAL lock_timeout='500ms';","SET LOCAL search_path=pg_catalog;",
   "SELECT pg_catalog.set_config('shrigma.heartbeat_lock_2s_expected',$1::text,true) IS NOT NULL AS expected_metadata_bound;",load(stage.toUpperCase()+".atomic.sql"),
   "SELECT pg_catalog.set_config('shrigma.heartbeat_lock_2s_expected','',true) IS NOT NULL AS expected_metadata_cleared;","COMMIT;"])});
}
function executeOriginal(){fail("HEARTBEAT_LOCK_ORIGINAL_EXECUTION_NOT_ADMITTED");}
module.exports=Object.freeze({prepare,executeOriginal,ASSETS});
