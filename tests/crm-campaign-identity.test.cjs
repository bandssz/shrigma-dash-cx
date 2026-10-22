'use strict';
const {test}=require('node:test'),a=require('node:assert/strict'),M=require('../campaign-identity.js');
test('one canonical value contains only the exact real native campaign ID',()=>{for(const id of [1,267,268,2147483647])a.equal(M.campaignValue(id),'lm-'+id);for(const id of [0,-1,1.1,'267','001',null,undefined,NaN,Infinity,2147483648])a.throws(()=>M.campaignValue(id),{code:'CAMPAIGN_ID_REQUIRED'});});
test('the actual compiled CRM exposes the same canonical identity after the provider assigns the ID',()=>{
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),runtime=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational'),browser={window:{},URL,TextEncoder,TextDecoder,Uint8Array};vm.runInNewContext(fs.readFileSync(runtime+'/public/crm-preview/analytics.compiled.js','utf8'),browser);
 const compiled=browser.window.ShrigmaCrmCampaignIdentity;a(compiled);for(const id of [1,267,268,2147483647])a.equal(compiled.campaignValue(id),M.campaignValue(id));for(const id of [0,'267',null,2147483648])a.throws(()=>compiled.campaignValue(id),{code:'CAMPAIGN_ID_REQUIRED'});
});
