'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const Install=require('../n8n/growth/segment-shopify-rfm-install.cjs');
const RAW=fs.readFileSync(path.join(__dirname,'../n8n/growth/segment-shopify-rfm.sql'),'utf8');

// PGlite exercises component behavior, not the PostgreSQL installation
// boundary. Remove only this exact guard; PG17 tests use a compiled plan.
function componentSql(){
 const start='DO $sealed_only$\n',end='END $sealed_only$;',a=RAW.indexOf(start),b=RAW.indexOf(end,a+start.length);
 assert.ok(a>=0&&b>a&&RAW.indexOf(start,a+1)<0&&RAW.indexOf(end,b+end.length)<0,'RFM_COMPONENT_BOUNDARY');
 return RAW.slice(0,a)+RAW.slice(b+end.length);
}
async function buildNativePlan(db){
 const snapshot=(await db.query(Install.snapshotSQL())).rows[0].snapshot,now=Date.now();
 return Install.compile({
  expectedSnapshot:snapshot,expectedSnapshotSha256:Install.sha(Install.canonical(snapshot)),
  pins:Install.sourcePins(),reviewSha256:Install.sha('SYNTHETIC_RFM_INSTALL_REVIEW_ONLY'),
  notBefore:new Date(now-1000).toISOString(),expiresAt:new Date(now+5*60*1000).toISOString()
 });
}
async function installNative(db){
 const plan=await buildNativePlan(db);
 await db.exec(plan.sql);
 const readback=(await db.query(Install.readbackSQL())).rows[0].readback;
 assert.deepEqual(Install.reconcileReadback(plan,readback),{state:'committed_off',authorizes_send:false});
 return plan;
}
module.exports={componentSql,buildNativePlan,installNative};
