'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {buildCampaignUi}=require('../tools/dashboard-campaign-ui-build.cjs');
const source=path.resolve(__dirname,'../services/dashboard-operational');
test('locked compiler reproduces the committed campaign assets and --check does not repair drift',t=>{
 assert.deepEqual(buildCampaignUi({check:true}),{check:true,assets:4,esbuildVersion:'0.28.2'});
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'shrigma-campaign-ui-check-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const file of ['crm-campaign-bff-client.cjs','public/campaign-edit.js','public/entry.js','public/guard.js']){fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.copyFileSync(path.join(source,file),path.join(root,file));}
 buildCampaignUi({root});
 for(const file of ['campaign-ui-assets.json','public/campaign-bff-client.js','public/campaign-edit.compiled.js','public/entry.compiled.js','public/guard.compiled.js'])assert.deepEqual(fs.readFileSync(path.join(root,file)),fs.readFileSync(path.join(source,file)),file);
 const compiled=path.join(root,'public/campaign-edit.compiled.js');fs.appendFileSync(compiled,'/* drift */');const before=fs.readFileSync(compiled);
 assert.throws(()=>buildCampaignUi({root,check:true}),/need regeneration/);assert.deepEqual(fs.readFileSync(compiled),before);
});
