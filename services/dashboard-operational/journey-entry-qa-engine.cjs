'use strict';
// Synthetic entry conditions. No provider, scheduler, customer or transport.
const crypto=require('node:crypto'),Lab=require('./public/crm-preview/journey-engine.js');
const SCHEMA='shrigma-entry-definition-qa-v1',DAY=86400000,HASH=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const clone=x=>JSON.parse(JSON.stringify(x)),same=(x,y)=>JSON.stringify(x)===JSON.stringify(y);
const exact=(x,keys)=>!!x&&Object.getPrototypeOf(x)===Object.prototype&&Object.keys(x).sort().join(',')===keys.split(',').sort().join(',');
const fail=code=>{throw Object.assign(Error(code),{code,status:400});};
const integer=(n,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
const digest=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
function validateDefinition(d){
 if(!exact(d,'schema,draft,entrySpec')||d.schema!==SCHEMA)fail('ENTRY_QA_DEFINITION_INVALID');Lab.validateDraft(d.draft);
 if(d.draft.trigger!=='manual_event'||d.draft.exitOnPurchase!==true)fail('ENTRY_QA_DEFINITION_INVALID');
 const e=d.entrySpec;if(!e||e.entryPolicy!=='once_per_journey_person')fail('ENTRY_QA_DEFINITION_INVALID');
 if(e.kind==='audience_entry'){
  if(!exact(e,'kind,audienceRef,rollingDays,cadence,timeZone,entryPolicy')||!integer(e.rollingDays,1,365)||e.cadence!=='daily'||e.timeZone!=='America/Sao_Paulo')fail('ENTRY_QA_DEFINITION_INVALID');
  const r=e.audienceRef;if(!exact(r,'id,version,name,definitionHash,hashContract,readAt')||!UUID.test(r.id||'')||!integer(r.version,1,999999999)||typeof r.name!=='string'||!r.name||r.name.length>180||!HASH.test(r.definitionHash||'')||r.hashContract!=='canonical-json-sorted-keys-sha256-v1'||!integer(r.readAt))fail('ENTRY_QA_AUDIENCE_INVALID');
 }else if(e.kind==='after_purchase'){
  if(!exact(e,'kind,delayDays,anchor,duration,resetOnLaterPaid,entryPolicy')||!integer(e.delayDays,0,365)||e.anchor!=='lastPaidAt'||e.duration!=='elapsed_24h'||e.resetOnLaterPaid!==true)fail('ENTRY_QA_DEFINITION_INVALID');
 }else fail('ENTRY_QA_TRIGGER_INVALID');return d;
}
function newRound(definition,{id,person,now,purchaseAgeDays=0}){
 validateDefinition(definition);if(!UUID.test(id||'')||!/^synthetic:[a-zA-Z0-9:_-]{1,180}$/.test(person||'')||!integer(now)||!integer(purchaseAgeDays,0,365)||now-purchaseAgeDays*DAY<0)fail('ENTRY_QA_ROUND_INVALID');
 return {id,person,definition:clone(definition),createdAt:now,now,purchase:{orderId:'synthetic-order:'+id+':0',paidAt:now-purchaseAgeDays*DAY,sequence:0},entry:null,run:null,checks:[],receipts:[],decisions:[],mode:'synthetic',realSends:0};
}
function validateRound(r){
 if(!exact(r,'id,person,definition,createdAt,now,purchase,entry,run,checks,receipts,decisions,mode,realSends')||!UUID.test(r.id||'')||!/^synthetic:[a-zA-Z0-9:_-]{1,180}$/.test(r.person||'')||!integer(r.createdAt)||!integer(r.now,r.createdAt)||r.mode!=='synthetic'||r.realSends!==0||!Array.isArray(r.checks)||r.checks.length>100||!Array.isArray(r.receipts)||r.receipts.length>100||!Array.isArray(r.decisions)||r.decisions.length>200)fail('ENTRY_QA_ROUND_INVALID');validateDefinition(r.definition);
 if(!exact(r.purchase,'orderId,paidAt,sequence')||!r.purchase.orderId.startsWith('synthetic-order:'+r.id+':')||!integer(r.purchase.paidAt,0,r.now)||!integer(r.purchase.sequence,0,100))fail('ENTRY_QA_ROUND_INVALID');
 if(r.entry===null){if(r.run!==null)fail('ENTRY_QA_ROUND_INVALID');}else{
  if(!exact(r.entry,'at,sourceId,anchorAt')||!integer(r.entry.at,r.createdAt,r.now)||typeof r.entry.sourceId!=='string'||!r.entry.sourceId||r.entry.anchorAt!==null&&!integer(r.entry.anchorAt,0,r.entry.at)||!r.run)fail('ENTRY_QA_ROUND_INVALID');Lab.validateRun(r.run);
  if(!same(r.run.draft,r.definition.draft)||r.run.startedAt!==r.entry.at||r.run.now!==r.now||r.run.eventId!=='synthetic:entry:'+r.id)fail('ENTRY_QA_ROUND_INVALID');
 }
 let previous=r.createdAt;for(const c of r.checks){if(!exact(c,'at,decision,evidence')||!integer(c.at,previous,r.now)||!exact(c.decision,'code,day,evaluated,sourceId,anchorAt,dueAt,windowFrom,windowTo,previousWindowFrom,previousWindowTo')||typeof c.decision.code!=='string'||c.decision.day!==Lab.paidDay(c.at)||typeof c.decision.evaluated!=='boolean'||c.evidence?.mode!=='synthetic'||c.evidence.person!==r.person||c.evidence.brand!==r.definition.draft.brand)fail('ENTRY_QA_ROUND_INVALID');previous=c.at;}
 for(const d of r.decisions)if(!d||typeof d.code!=='string'||!integer(d.at,r.createdAt,r.now)||d.mode!=='synthetic'||d.realSends!==0)fail('ENTRY_QA_ROUND_INVALID');
 for(const x of r.receipts)if(!exact(x,'id,person,at,kind')||!x.id.startsWith('synthetic-message:')||x.person!==r.person||!integer(x.at,0,r.now)||!['campaign','journey','ses'].includes(x.kind))fail('ENTRY_QA_ROUND_INVALID');return r;
}
function capRound(r){validateRound(r);const run=r.run?clone(r.run):Lab.newRun(r.definition.draft,{eventId:'synthetic:pending:'+r.id,startedAt:r.createdAt});run.now=r.now;return {person:r.person,run,receipts:clone(r.receipts)};}
function snapshot(ref,brand,person,at,days,member){
 const v={mode:'synthetic',brand,person,audience:{id:ref.id,version:ref.version,definitionHash:ref.definitionHash},evaluationDay:Lab.paidDay(at),evaluatedAt:at,windowFrom:at-days*DAY,windowTo:at,complete:true,member};return {...v,snapshotHash:digest(v)};
}
function scenario(input,{now,membership='entered',payment='paid',mailEvidence='empty',afterEntry='none'}={}){
 validateRound(input);if(!integer(now,input.now)||!['entered','unchanged','outside','unknown','baseline','gap','version','stale'].includes(membership)||!['paid','unknown','refunded','missing-anchor','new-paid'].includes(payment)||!['empty','campaign','journey','ses','unknown','incomplete','stale'].includes(mailEvidence)||!['none','purchase','optout','unknown'].includes(afterEntry))fail('ENTRY_QA_SCENARIO_INVALID');
 const r=clone(input);r.now=now;if(r.run)r.run.now=now;if(payment==='new-paid'){r.purchase.sequence++;r.purchase.orderId='synthetic-order:'+r.id+':'+r.purchase.sequence;r.purchase.paidAt=now;}
 const spec=r.definition.entrySpec;let previous=null,current=null;
 if(spec.kind==='audience_entry'){
  previous=snapshot(spec.audienceRef,r.definition.draft.brand,r.person,now-(membership==='gap'?2:1)*DAY,spec.rollingDays,membership==='unchanged');
  current=snapshot(spec.audienceRef,r.definition.draft.brand,r.person,now,spec.rollingDays,!['outside','unknown'].includes(membership));
  if(membership==='unknown')current={...current,complete:false,member:null};if(membership==='baseline')previous=null;
  if(membership==='version')current.audience.version++;if(membership==='stale'){current.evaluatedAt-=300001;current.windowFrom-=300001;current.windowTo-=300001;current.evaluationDay=Lab.paidDay(current.evaluatedAt);}
  for(const x of [previous,current].filter(Boolean)){const v={...x};delete v.snapshotHash;x.snapshotHash=digest(v);}
  if(r.checks.length&&!['baseline','gap'].includes(membership)){
   const day=Lab.paidDay(now-DAY),matches=x=>x?.complete===true&&x.evaluationDay===day&&same(x.audience,{id:spec.audienceRef.id,version:spec.audienceRef.version,definitionHash:spec.audienceRef.definitionHash});
   const recorded=r.checks.map(c=>c.evidence.current).find(matches),initialBaseline=r.checks.filter(c=>c.decision.day===Lab.paidDay(now)).map(c=>c.evidence.previous).find(matches);
   previous=clone(recorded||initialBaseline||null);
  }
 }
 const e={mode:'synthetic',brand:r.definition.draft.brand,person:r.person,previous,current,purchase:{orderId:r.purchase.orderId,lastPaidAt:payment==='missing-anchor'?null:r.purchase.paidAt,state:payment==='unknown'?'unknown':payment==='refunded'?'refunded':'paid',observedAt:now,complete:payment!=='unknown'},observedAt:mailEvidence==='stale'?now-300001:now,coverage:{day:Lab.paidDay(now),complete:!['unknown','incomplete'].includes(mailEvidence),campaigns:true,journeys:true,ses:true,brands:['aristo','fish']},receipts:[],afterEntryPurchase:afterEntry==='unknown'?null:Lab.fact(afterEntry==='purchase'||!!r.entry&&payment==='new-paid',now),emailAllowed:afterEntry==='unknown'?null:Lab.fact(afterEntry!=='optout',now)};
 if(['campaign','journey','ses'].includes(mailEvidence)){const id='synthetic-message:'+r.id+':'+mailEvidence+':'+Lab.paidDay(now);if(!r.receipts.some(x=>x.id===id))r.receipts.push({id,person:r.person,at:now,kind:mailEvidence});}
 return {round:r,evidence:e};
}
function entryDecision(r,e,rounds,now){
 const out=(code,extra={})=>({code,day:Lab.paidDay(now),evaluated:false,sourceId:null,anchorAt:null,dueAt:null,windowFrom:null,windowTo:null,previousWindowFrom:null,previousWindowTo:null,...extra}),spec=r.definition.entrySpec;
 if(e?.mode!=='synthetic'||e.person!==r.person||e.brand!==r.definition.draft.brand)return out('identity-unknown');
 const consent=Lab.observation(e.emailAllowed,now);if(consent!==true)return out(consent===false?'opt-out':'conditions-unknown');
 if(rounds.some(x=>x.id!==r.id&&x.person===r.person&&x.definition.draft.id===r.definition.draft.id&&x.entry))return out('entry-already-recorded');
 if(spec.kind==='after_purchase'){
  const p=e.purchase;if(!p?.complete||p.state!=='paid'||!integer(p.lastPaidAt,0,now)||!integer(p.observedAt,0,now)||now-p.observedAt>300000||!/^synthetic-order:[a-zA-Z0-9:_-]+$/.test(p.orderId||''))return out(p?.state==='refunded'?'payment-not-paid':'payment-unknown');
  const dueAt=p.lastPaidAt+spec.delayDays*DAY;return out(now<dueAt?'waiting-entry-time':'eligible-entry',{evaluated:true,sourceId:p.orderId,anchorAt:p.lastPaidAt,dueAt});
 }
 const valid=s=>{if(!s||s.mode!=='synthetic'||s.brand!==e.brand||s.person!==e.person||s.complete!==true||typeof s.member!=='boolean'||!integer(s.evaluatedAt,0,now)||s.evaluationDay!==Lab.paidDay(s.evaluatedAt)||s.windowTo!==s.evaluatedAt||s.windowFrom!==s.evaluatedAt-spec.rollingDays*DAY||!same(s.audience,{id:spec.audienceRef.id,version:spec.audienceRef.version,definitionHash:spec.audienceRef.definitionHash}))return false;const v={...s};delete v.snapshotHash;return s.snapshotHash===digest(v);};
 if(!valid(e.current)||!valid(e.previous))return out('membership-incomplete');
 if(now-e.current.evaluatedAt>300000)return out('membership-stale');
 if(e.current.evaluationDay!==Lab.paidDay(now)||e.previous.evaluationDay!==Lab.paidDay(now-DAY))return out('membership-day-gap');
 const recorded=r.checks.map(c=>c.evidence.current).find(s=>valid(s)&&s.evaluationDay===Lab.paidDay(now-DAY)),initialBaseline=r.checks.filter(c=>c.decision.day===Lab.paidDay(now)).map(c=>c.evidence.previous).find(valid);
 if(recorded&&!same(recorded,e.previous)||!recorded&&r.checks.length&&(!initialBaseline||!same(initialBaseline,e.previous)))return out('membership-history-changed');
 if(r.checks.some(c=>c.decision.evaluated&&c.decision.day===Lab.paidDay(now)))return out('already-evaluated-day');
 const extra={evaluated:true,sourceId:e.current.snapshotHash,windowFrom:e.current.windowFrom,windowTo:e.current.windowTo,previousWindowFrom:e.previous.windowFrom,previousWindowTo:e.previous.windowTo};
 return out(e.current.member&&!e.previous.member?'eligible-entry':e.current.member?'already-member':'outside-audience',extra);
}
function advance(input,{now,evidence,entryRounds=[],capRounds=[],result='simulated'}={}){
 validateRound(input);if(!integer(now,input.now)||!Array.isArray(entryRounds)||entryRounds.length>40||!Array.isArray(capRounds)||capRounds.length>80)fail('ENTRY_QA_SCENARIO_INVALID');const r=clone(input);r.now=now;
 if(!r.run){const d=entryDecision(r,evidence,entryRounds,now);r.checks.push({at:now,decision:d,evidence:clone(evidence)});r.decisions.push({...d,at:now,mode:'synthetic',realSends:0});if(d.code!=='eligible-entry')return validateRound(r);r.entry={at:now,sourceId:d.sourceId,anchorAt:d.anchorAt};r.run=Lab.newRun(r.definition.draft,{eventId:'synthetic:entry:'+r.id,startedAt:now});}
 const decisions=[],admit=current=>{let d=Lab.messageCapDecision(current,evidence,capRounds,now);const p=evidence.purchase;if(r.definition.entrySpec.kind==='after_purchase'&&(!p?.complete||p.state!=='paid'||!integer(p.lastPaidAt,0,now)||!integer(p.observedAt,0,now)||now-p.observedAt>300000))d={...d,code:p?.state==='refunded'?'payment-not-paid':'payment-unknown'};decisions.push({...d,at:now});return d.code==='eligible';};
 r.run=Lab.advance(r.run,{now,purchase:evidence.afterEntryPurchase,emailAllowed:evidence.emailAllowed,result,admit});
 if(!decisions.length){const last=r.run.trace.at(-1);decisions.push({code:r.run.status==='excluded'?last?.reason==='opt_out'?'opt-out':'purchase-after-entry':r.run.status==='uncertain'?'uncertain-message':r.run.status==='finished'?'finished':'waiting-time',day:Lab.paidDay(now),count:null,mode:'synthetic',realSends:0,at:now});}
 r.decisions.push(...decisions);return validateRound(r);
}
module.exports={SCHEMA,DAY,validateDefinition,newRound,validateRound,capRound,scenario,entryDecision,advance};
