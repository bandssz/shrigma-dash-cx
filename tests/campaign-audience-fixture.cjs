'use strict';
// Non-PII unit fixture. Real SQL tests obtain reviews from the provider instead.
module.exports=(c,now,patch={})=>({policy:'listmonk-6.1-regular-v1',review_id:'00000000-0000-4000-8000-000000000001',campaign_id:c.id,campaign_version:c.version,brand:c.definition.brand,list_ids:c.definition.list_ids,eligible_count:2,unique_members_count:2,excluded_blocklisted_count:0,excluded_subscription_count:0,native_disabled_count:0,frozen:false,checked_at:new Date(now).toISOString(),expires_at:new Date(now+300000).toISOString(),...patch});
