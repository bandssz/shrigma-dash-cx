'use strict';
const contracts=require('./behavior-contracts.cjs');
const fail=code=>{throw Object.assign(Error(code),{code,status:503});};
const integer=value=>Number.isSafeInteger(value)&&value>=0&&value<=2147483647;
function create({query,filterEligible,maxMembers=500000}){
 if(typeof query!=='function'||typeof filterEligible!=='function'||!integer(maxMembers)||maxMembers<1||maxMembers>500000)fail('BEHAVIOR_CONFIGURATION_INVALID');
 return async function readBehavior(context,leaf,{brand,snapshot,leafHash}){
  if(leaf.kind!=='behavior'||!['open','click'].includes(leaf.event)||snapshot?.brand!==brand||snapshot.consistent!==true)fail('BEHAVIOR_SCOPE_INVALID');
  const base={brand,snapshotId:snapshot.id,leafHash},unknown=()=>({...base,confirmed:false,count:null,ids:null});
  const params=[brand,leaf.campaignId,leaf.campaignUuid,leaf.from,leaf.to];
  async function read(suffix,extra=[]){
   const contract=contracts['behavior-'+leaf.event+'-'+suffix+'-v2'];if(!contract)fail('BEHAVIOR_CONTRACT_INVALID');const result=await query(contract.sql,[...params,...extra],snapshot);const value=result?.rows?.[0]?.[suffix==='counts'?'behavior_counts':'behavior_page'];
   if(result?.rows?.length!==1||!value||value.brand!==brand||value.campaignId!==leaf.campaignId||value.campaignUuid!==leaf.campaignUuid||value.from!==leaf.from||value.to!==leaf.to||value.kind!==leaf.event||value.timeRange!=='[from,to)'||value.sourceMutations!==0||value.received!==null||value.notOpened!==null||value.notClicked!==null)fail('BEHAVIOR_SOURCE_INVALID');
   if(value.validInput!==true||value.campaignMatched!==true||value.status!=='observed')return null;
   return value;
  }
  const counts=await read('counts');if(!counts)return unknown();const count=counts.nativeUniqueSubscribers;
  if(!integer(count)||count>maxMembers||!integer(counts.unresolvedUniqueSubscribers))fail('BEHAVIOR_SOURCE_INVALID');if(counts.unresolvedUniqueSubscribers!==0)return unknown();
  const ids=[];let after=0;
  for(let pages=0;pages<=Math.ceil(maxMembers/1000);pages++){
   const page=await read('page',[after,1000]);if(!page)return unknown();
   if(page.afterSubscriberId!==after||page.pageSize!==1000||typeof page.more!=='boolean'||!Array.isArray(page.rows)||page.rows.length>1000||page.pageDistinctSubscriberCount!==page.rows.length||page.pageUnresolvedSubscriberCount!==0||page.more&&page.rows.length!==1000)fail('BEHAVIOR_SOURCE_INVALID');
   for(const row of page.rows){if(row.brand!==brand||row.campaignId!==leaf.campaignId||row.campaignUuid!==leaf.campaignUuid||row.kind!==leaf.event||!integer(row.subscriberId)||row.subscriberId<=after||typeof row.subscriberUuid!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(row.subscriberUuid)||!Number.isFinite(Date.parse(row.at))||Date.parse(row.at)<Date.parse(leaf.from)||Date.parse(row.at)>=Date.parse(leaf.to))fail('BEHAVIOR_SOURCE_INVALID');after=row.subscriberId;ids.push(String(after));if(ids.length>count)fail('BEHAVIOR_COUNT_PAGE_DIVERGED');}
   if(page.nextAfterSubscriberId!==(page.rows.length?after:null))fail('BEHAVIOR_SOURCE_INVALID');if(!page.more)break;if(pages===Math.ceil(maxMembers/1000))fail('BEHAVIOR_LIMIT_EXCEEDED');
  }
  if(ids.length!==count)fail('BEHAVIOR_COUNT_PAGE_DIVERGED');
  const eligible=await filterEligible(context,{brand,snapshot,ids});if(!eligible||eligible.confirmed!==true)return unknown();
  if(eligible.brand!==brand||eligible.snapshotId!==snapshot.id||!Array.isArray(eligible.ids))fail('BEHAVIOR_ELIGIBILITY_INVALID');let previous=0n;const candidates=new Set(ids);for(const id of eligible.ids){if(typeof id!=='string'||!candidates.has(id)||BigInt(id)<=previous)fail('BEHAVIOR_ELIGIBILITY_INVALID');previous=BigInt(id);}
  return {...base,confirmed:true,count:eligible.ids.length,ids:eligible.ids,positiveOnly:true,eligibleOnly:true};
 };
}
module.exports={create};
