'use strict';
// The provider has already allocated this exact native Listmonk ID.
function campaignValue(id){if(!Number.isSafeInteger(id)||id<1||id>2147483647)throw Object.assign(Error('CAMPAIGN_ID_REQUIRED'),{code:'CAMPAIGN_ID_REQUIRED'});return 'lm-'+id;}
const CampaignIdentity=Object.freeze({campaignValue});if(typeof module==='object'&&module.exports)module.exports=CampaignIdentity;
