'use strict';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const positive=n=>Number.isSafeInteger(n)&&n>0;
const closed=reason=>Object.freeze({state:'closed',reason,authorizesSend:false,operational:false});
// Pure evaluation: all time and evidence supplied as data; no adapter callbacks.
function createDecision({kernel,deliverability}={}) {
  function decide(input) {
    try {
      const now=input.now;
      if(!Number.isSafeInteger(now)||now<0||!UUID.test(input.operationId))return closed('clock_unavailable');
      const current=kernel.select({...input.selection,now});
      const campaign=kernel.campaign(input.campaign,current);
      const gate=kernel.readmit({before:input.before,current,before_campaign:input.beforeCampaign,current_campaign:campaign,guards:input.guards,now});
      if(gate.state!=='prepared-for-atomic-claim')return closed(gate.reason);
      if(current.selected_count===0)return closed('empty_selection');
      const e=input.evidence;
      if(!e || e.brand!==current.brand || e.membersHash!==current.members_hash || e.campaignId!==campaign.campaign_id || e.campaignVersion!==campaign.campaign_version || e.ledgerRevision!==current.ledger_revision || !Number.isSafeInteger(e.observedAt) || !Number.isSafeInteger(e.expiresAt) || e.observedAt<0 || e.observedAt>now || e.expiresAt<=now || e.expiresAt-e.observedAt>60000 || !positive(e.revision) || e.authority!== 'admitted' || e.suspension!== 'clear' || !Array.isArray(e.members) || e.members.length!==current.member_ids.length)return closed('evidence_unavailable');
      const seen=new Set(),selectedIds=new Set(current.member_ids);
      for(const member of e.members) {
        if(!selectedIds.has(member.subjectId)||seen.has(member.subjectId)||member.consent!=='current'||member.capping!=='clear'||member.bounce!=='current'||!positive(member.consentRevision)||!positive(member.cappingRevision)||member.policyState?.brand!==current.brand||member.policyState.revision!==member.policyRevision||!/^[a-f0-9]{64}$/.test(member.recipientRef))return closed('member_veto_unavailable');
        seen.add(member.subjectId);
        const policy=deliverability.createPolicy({brand:current.brand,softBounceAttempts:member.policyState.initialSoftBounceAttempts,providers:['synthetic'],verifyClassifiedEvent:()=>{throw Error('read-only');},clock:()=>now});
        const veto=policy.inspect(member.policyState,member.recipientRef);
        if(veto.houseSuppressed)return closed('bounce_veto');
      }
      return Object.freeze({state:'eligible-for-reservation',scope:Object.freeze({brand:current.brand,operationId:input.operationId,distributionId:current.distribution_id,selectionHash:current.selection_hash,membersHash:current.members_hash,memberCount:current.selected_count,campaignId:campaign.campaign_id,campaignVersion:campaign.campaign_version,ledgerRevision:current.ledger_revision,evidenceRevision:e.revision,evidenceHash:kernel.digest(e),expiresAt:Math.min(e.expiresAt,Date.parse(current.expires_at),Date.parse(input.guards.expires_at))}),authorizesSend:false,operational:false});
    } catch {return closed('decision_unconfirmed');}
  }
  return decide;
}
module.exports=Object.freeze({createDecision});
