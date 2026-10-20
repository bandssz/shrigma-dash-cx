'use strict';
const manifest=require('/app/native-backend/manifest.json');
const driver=require('/app/native-backend/runtime/native-pg-driver.cjs');
driver.verifyDriver(manifest.pgDriverManifestSha256);
module.exports=require(driver.ROOT+'/node_modules/pg');
