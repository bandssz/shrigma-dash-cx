'use strict';
// Pure composition of already admitted codecs/kernels and in-transaction rows.
// No store API, lease, transaction, transport, actor or default facts are created.
async function read({request:i,brandRevision,heads,at,F,kernel,deliverability}){
 const distribution=kernel.distribution(i.selection.distribution);F.assert(distribution.brand===i.brand);
 const capacityKey=JSON.stringify([distribution.id,distribution.revision,i.campaign.campaign_id,i.campaign.campaign_version]),ledgerKey=JSON.stringify([distribution.id,distribution.revision]);
 const used=[],first=await heads(i.brand,[{kind:'policy',key:'brand'},{kind:'suspension',key:'brand'},{kind:'claims',key:ledgerKey},{kind:'capacity',key:capacityKey}]);
 function get(rows,kind,key){const r=rows.get(kind+':'+key);F.assert(r&&r.brand_revision<=brandRevision&&r.observed_at<=at&&r.expires_at>at);used.push(r);return r.body;}
 const policy=get(first,'policy','brand'),suspension=get(first,'suspension','brand'),claims=get(first,'claims',ledgerKey),capacity=get(first,'capacity',capacityKey);
 const selection={...i.selection,claims,now:at},selected=kernel.select(selection);F.assert(selected.state==='prepared'&&selected.selected_count>0&&selected.selected_count<=9998&&suspension.suspension==='clear'&&capacity.limit-capacity.acceptedCount-capacity.reservedCount>=selected.selected_count);
 const recipients=new Map(i.memberBindings.map(b=>[b.subjectId,b.recipientRef])),keys=[];
 for(const subject of selected.member_ids){const recipient=recipients.get(subject);F.assert(recipient&&!claims.claims.some(c=>c.subject_id===subject));keys.push({kind:'consent',key:JSON.stringify([subject,recipient])},{kind:'capping',key:JSON.stringify([subject,recipient])});}
 const second=await heads(i.brand,keys),members=[],cappings=[];
 for(const subject of selected.member_ids){const recipient=recipients.get(subject),key=JSON.stringify([subject,recipient]),consent=get(second,'consent',key),capping=get(second,'capping',key);F.assert(consent.consent==='current'&&at>=capping.windowStart&&at<capping.windowEnd&&capping.limit-capping.acceptedCount-capping.reservedCount>0);
 const veto=deliverability.createPolicy({brand:i.brand,softBounceAttempts:policy.initialSoftBounceAttempts,providers:['synthetic'],verifyClassifiedEvent:()=>{throw Error('read-only');},clock:()=>at}).inspect(policy,recipient);F.assert(!veto.houseSuppressed);
 members.push({subjectId:subject,recipientRef:recipient,consent:'current',consentRevision:consent.consentRevision,capping:'clear',cappingRevision:capping.cappingRevision,bounce:'current',policyState:policy,policyRevision:policy.revision});cappings.push(capping);}
 const observedAt=used.reduce((n,r)=>Math.min(n,r.observed_at),F.MAX),expiresAt=used.reduce((n,r)=>Math.min(n,r.expires_at),F.MAX);F.assert(expiresAt-observedAt<=60000);
 const evidence={brand:i.brand,membersHash:selected.members_hash,campaignId:i.campaign.campaign_id,campaignVersion:i.campaign.campaign_version,ledgerRevision:claims.revision,revision:brandRevision,observedAt,expiresAt,authority:'admitted',suspension:'clear',members};
 const campaign=kernel.campaign(i.campaign,selected);F.assert(kernel.readmit({before:i.before,current:selected,before_campaign:i.beforeCampaign,current_campaign:campaign,guards:i.contentGuards,now:at}).state==='prepared-for-atomic-claim');
 const live=F.capture({operationId:i.operationId,selection,before:i.before,campaign:i.campaign,beforeCampaign:i.beforeCampaign,guards:i.contentGuards,evidence,now:at});
 const scope={brand:i.brand,operationId:i.operationId,distributionId:distribution.id,selectionHash:selected.selection_hash,membersHash:selected.members_hash,memberCount:selected.selected_count,campaignId:campaign.campaign_id,campaignVersion:campaign.campaign_version,ledgerRevision:claims.revision,evidenceRevision:brandRevision,evidenceHash:kernel.digest(live.evidence),expiresAt:Math.min(expiresAt,Date.parse(selected.expires_at),Date.parse(i.contentGuards.expires_at))};
 return {live,scope:F.capture(scope),claims,capacity,cappings,used,observedAt,expiresAt,selected};
}
module.exports=Object.freeze({read});
