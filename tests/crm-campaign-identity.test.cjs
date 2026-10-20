'use strict';
const {test}=require('node:test'),a=require('node:assert/strict'),M=require('../campaign-identity.js');
test('one canonical value contains only the exact real native campaign ID',()=>{for(const id of [1,267,268,2147483647])a.equal(M.campaignValue(id),'lm-'+id);for(const id of [0,-1,1.1,'267','001',null,undefined,NaN,Infinity,2147483648])a.throws(()=>M.campaignValue(id),{code:'CAMPAIGN_ID_REQUIRED'});});
