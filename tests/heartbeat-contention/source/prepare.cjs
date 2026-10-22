"use strict";
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const ASSETS=Object.freeze({
  "APPLY.atomic.sql": "d778e1cb98cfc7794d874ed95be360dc4c03061a9fc7cbf9171c6268376f7d97",
  "RESTORE.atomic.sql": "28444a8628b3dd50e13089719ff3c927a18b43cf73ca337d8e889a8f777cb141",
  "snapshot.private-read.sql": "ee6d941acd6f4c7dc090955fd08f750f2fe0f0a5163c6bc647c86879d35f02a5"
});
function prepare(stage){if(!["apply","restore"].includes(stage))throw Error("HEARTBEAT_CONTENTION_STAGE_REFUSED");
 const load=n=>{const p=path.join(__dirname,n);if(fs.lstatSync(p).isSymbolicLink())throw Error("HEARTBEAT_CONTENTION_SOURCE_DRIFT");const b=fs.readFileSync(p);if(crypto.createHash("sha256").update(b).digest("hex")!==ASSETS[n])throw Error("HEARTBEAT_CONTENTION_SOURCE_DRIFT");return b.toString("utf8");};
 return Object.freeze({schema:"heartbeat-contention-prepared-v1",stage,executionAvailable:false,authorityCreated:false,snapshotReadSQL:load("snapshot.private-read.sql"),
 statements:Object.freeze(["BEGIN ISOLATION LEVEL READ COMMITTED;","SET LOCAL statement_timeout='5s';","SET LOCAL lock_timeout='500ms';","SET LOCAL search_path=pg_catalog;",
 "SELECT pg_catalog.set_config('shrigma.heartbeat_contention_expected',$1::text,true) IS NOT NULL AS expected_metadata_bound;",load(stage.toUpperCase()+".atomic.sql"),
 "SELECT pg_catalog.set_config('shrigma.heartbeat_contention_expected','',true) IS NOT NULL AS expected_metadata_cleared;","COMMIT;"])});}
function executeOriginal(){throw Error("HEARTBEAT_CONTENTION_ORIGINAL_EXECUTION_NOT_ADMITTED");}
module.exports=Object.freeze({prepare,executeOriginal,ASSETS});
