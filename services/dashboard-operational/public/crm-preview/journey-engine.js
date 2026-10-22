/* Local journey laboratory. No network, provider, recipient or production writes. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.ShrigmaJourneyLab=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){'use strict';
 const SCHEMA='shrigma-journey-lab-v1',MAX_BYTES=100000,MAX_WAIT=43200;
 const clone=x=>JSON.parse(JSON.stringify(x));
 const fail=code=>{throw Object.assign(new Error(code),{code});};
 const text=(v,n)=>typeof v==='string'&&v.trim().length>0&&v.length<=n;
 const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
 function validateDraft(d){
  if(!exact(d,['schema','id','brand','name','revision','mode','productionEnabled','source','audience','exitOnPurchase','exitOnOptOut','steps',...(Object.hasOwn(d||{},'trigger')?['trigger']:[]),...(Object.hasOwn(d||{},'audienceRef')?['audienceRef']:[])])||!exact(d.source,['key','version']))fail('LAB_DRAFT_INVALID');
  if(!d||d.schema!==SCHEMA||!['fish','aristo'].includes(d.brand)||!text(d.id,80)||!text(d.name,120)||!Number.isSafeInteger(d.revision)||d.revision<1||d.mode!=='test'||d.productionEnabled!==false||!d.source||![d.brand+':carrinho',d.brand+':test'].includes(d.source.key)||!Number.isSafeInteger(d.source.version)||d.source.version<1||!text(d.audience,180)||typeof d.exitOnPurchase!=='boolean'||d.exitOnOptOut!==true||!Array.isArray(d.steps)||d.steps.length<1||d.steps.length>5)fail('LAB_DRAFT_INVALID');
  if(d.trigger!==undefined&&!['checkout_abandoned','order_paid','manual_event'].includes(d.trigger))fail('LAB_TRIGGER_INVALID');
  if(d.audienceRef!==undefined&&d.audienceRef!==null&&(!exact(d.audienceRef,['id','version','name'])||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(d.audienceRef.id||'')||!Number.isSafeInteger(d.audienceRef.version)||d.audienceRef.version<1||!text(d.audienceRef.name,180)))fail('LAB_AUDIENCE_INVALID');
  const ids=new Set();let before=-1;
  for(const s of d.steps){if(!exact(s,['id','channel','waitMinutes','enabled','templateName','subject','text'])||!text(s.id,80)||ids.has(s.id)||s.channel!=='email'||!Number.isSafeInteger(s.waitMinutes)||s.waitMinutes<0||s.waitMinutes>MAX_WAIT||s.waitMinutes<before||typeof s.enabled!=='boolean'||!text(s.templateName,200)||!text(s.subject,250)||!s.subject.startsWith('[TESTE] ')||!text(s.text,5000))fail('LAB_STEP_INVALID');ids.add(s.id);before=s.waitMinutes;}
  if(JSON.stringify(d).length>MAX_BYTES)fail('LAB_DRAFT_TOO_LARGE');return d;
 }
 function duplicate(flow,{brand,id}={}){
  if(!['fish','aristo'].includes(brand)||flow?.brand!==brand||flow.key!==brand+':carrinho'||!text(id,80)||!Number.isSafeInteger(flow.published_version)||flow.published_version<1||!Array.isArray(flow.published?.steps))fail('LAB_SOURCE_UNSUPPORTED');
  const email=flow.published.steps.filter(s=>s.channel==='email'&&Number.isSafeInteger(s.wait_min)&&s.wait_min>=0&&text(s.template_name,200)).sort((a,b)=>a.wait_min-b.wait_min);
  if(email.length<2)fail('LAB_SOURCE_UNSUPPORTED');const preferred=[email.find(s=>s.wait_min===60),email.find(s=>s.wait_min===1440)];const selected=preferred.every(Boolean)?preferred:email.slice(0,2);
  return validateDraft({schema:SCHEMA,id,brand,name:flow.name+' · cópia de teste',revision:1,mode:'test',productionEnabled:false,source:{key:flow.key,version:flow.published_version},audience:'Checkout abandonado desta marca · participante sintético',exitOnPurchase:true,exitOnOptOut:true,
   steps:selected.map((s,i)=>({id:'step-'+(i+1),channel:'email',waitMinutes:s.wait_min,enabled:s.enabled===true,templateName:s.template_name,subject:'[TESTE] '+flow.name+' · etapa '+(i+1),text:'[TESTE] Mensagem sintética para conferir esta etapa. Template de referência: '+s.template_name}))});
 }
 function createDraft({brand,id,name='Nova jornada de teste'}={}){
  return validateDraft({schema:SCHEMA,id,brand,name,revision:1,mode:'test',productionEnabled:false,source:{key:brand+':test',version:1},trigger:'manual_event',audience:'Participante sintético desta marca',audienceRef:null,exitOnPurchase:true,exitOnOptOut:true,steps:[{id:'step-1',channel:'email',waitMinutes:1,enabled:true,templateName:'Mensagem de teste',subject:'[TESTE] Nova jornada',text:'[TESTE] Mensagem interna para conferir esta etapa.'}]});
 }
 function duplicateDraft(d,{id}={}){validateDraft(d);const next=clone(d);next.id=id;next.revision=1;next.name=(d.name.slice(0,95)+' · cópia de teste');return validateDraft(next);}
 function saveDraft(previous,input){
  validateDraft(previous);const d=clone(input);if(d.id!==previous.id||d.brand!==previous.brand||JSON.stringify(d.source)!==JSON.stringify(previous.source))fail('LAB_DRAFT_ID_CHANGED');d.revision=previous.revision+1;return validateDraft(d);
 }
 function newRun(d,{eventId,startedAt}={}){
  validateDraft(d);if(!text(eventId,100)||!Number.isSafeInteger(startedAt)||startedAt<0)fail('LAB_EVENT_INVALID');
  return {schema:SCHEMA,mode:'test',draft:clone(d),eventId,startedAt,now:startedAt,cursor:0,status:'waiting',paused:false,attempts:[],trace:[],realSends:0};
 }
 function validateRun(r){
  if(!exact(r,['schema','mode','draft','eventId','startedAt','now','cursor','status','paused','attempts','trace','realSends']))fail('LAB_RUN_INVALID');
  if(!r||r.schema!==SCHEMA||r.mode!=='test'||r.realSends!==0||!text(r.eventId,100)||!Number.isSafeInteger(r.startedAt)||r.startedAt<0||!Number.isSafeInteger(r.now)||r.now<r.startedAt||!Number.isSafeInteger(r.cursor)||r.cursor<0||r.cursor>r.draft.steps.length||typeof r.paused!=='boolean'||!['waiting','paused','finished','excluded','uncertain'].includes(r.status)||!Array.isArray(r.attempts)||r.attempts.length>5||!Array.isArray(r.trace)||r.trace.length>200)fail('LAB_RUN_INVALID');validateDraft(r.draft);
  if(r.paused!==(r.status==='paused')||r.status==='finished'&&r.cursor!==r.draft.steps.length)fail('LAB_RUN_INVALID');
  const ids=new Set();for(const a of r.attempts){
   if(!exact(a,['key','stepId','dueAt','at','result']))fail('LAB_ATTEMPT_INVALID');
   const index=r.draft.steps.findIndex(s=>s.id===a.stepId),step=r.draft.steps[index],expected=[r.draft.brand,r.draft.id,r.draft.revision,r.eventId,a.stepId].join(':');
   if(index<0||!step.enabled||a.key!==expected||ids.has(a.stepId)||!['reserved','simulated','uncertain','failed'].includes(a.result)||!Number.isSafeInteger(a.dueAt)||a.dueAt!==r.startedAt+step.waitMinutes*60000||!Number.isSafeInteger(a.at)||a.at<a.dueAt||a.at>r.now||index>r.cursor||index===r.cursor&&!['reserved','uncertain'].includes(a.result)||index<r.cursor&&!['simulated','failed'].includes(a.result))fail('LAB_ATTEMPT_INVALID');ids.add(a.stepId);
  }
  for(let i=0;i<r.cursor;i++)if(r.draft.steps[i].enabled&&!ids.has(r.draft.steps[i].id))fail('LAB_ATTEMPT_INVALID');
  if(r.status==='uncertain'&&!r.attempts.some(a=>['reserved','uncertain'].includes(a.result)))fail('LAB_ATTEMPT_INVALID');
  let previousAt=r.startedAt;for(const t of r.trace){
   const keys=t.kind==='exit'?['at','kind','reason']:t.kind==='wait_data'?['at','kind']:t.kind==='skipped'?['at','stepId','kind','reason']:['at','stepId','kind'];if(!exact(t,keys))fail('LAB_TRACE_INVALID');
   if(!Number.isSafeInteger(t.at)||t.at<previousAt||t.at>r.now||!['exit','wait_data','skipped','simulated','failed','uncertain','reserved'].includes(t.kind))fail('LAB_TRACE_INVALID');previousAt=t.at;
   if(['simulated','failed','uncertain','reserved'].includes(t.kind)&&!r.attempts.some(a=>a.stepId===t.stepId&&a.at===t.at&&a.result===t.kind))fail('LAB_TRACE_INVALID');
   if(t.kind==='skipped'&&!r.draft.steps.some((s,i)=>s.id===t.stepId&&!s.enabled&&i<r.cursor))fail('LAB_TRACE_INVALID');
   if(t.kind==='exit'&&(r.status!=='excluded'||!['purchase','opt_out'].includes(t.reason)))fail('LAB_TRACE_INVALID');
  }
  for(const a of r.attempts)if(!r.trace.some(t=>t.kind===a.result&&t.at===a.at&&t.stepId===a.stepId))fail('LAB_TRACE_INVALID');
  if(r.status==='excluded'&&!r.trace.some(t=>t.kind==='exit'))fail('LAB_TRACE_INVALID');return r;
 }
 function fact(value,now){return {value,observedAt:now,complete:true};}
 function observation(f,now){if(!f||f.complete!==true||typeof f.value!=='boolean'||!Number.isSafeInteger(f.observedAt)||f.observedAt>now||now-f.observedAt>300000)return null;return f.value;}
 function advance(input,{now,purchase,emailAllowed,result='simulated'}={}){
  validateRun(input);const r=clone(input);if(!Number.isSafeInteger(now)||now<r.now||!['simulated','uncertain','failed'].includes(result))fail('LAB_CLOCK_INVALID');r.now=now;
  if(['finished','excluded','uncertain'].includes(r.status))return r;
  if(r.attempts.some(a=>a.result==='reserved'||a.result==='uncertain')){r.status='uncertain';r.paused=false;return r;}
  const bought=observation(purchase,now),allowed=observation(emailAllowed,now);
  if(allowed===false||r.draft.exitOnPurchase&&bought===true){r.status='excluded';r.paused=false;r.trace.push({at:now,kind:'exit',reason:allowed===false?'opt_out':'purchase'});return r;}
  if(r.paused){r.status='paused';return r;}
  if(allowed===null||r.draft.exitOnPurchase&&bought===null){r.status='waiting';r.trace.push({at:now,kind:'wait_data'});return r;}
  while(r.cursor<r.draft.steps.length){
   const s=r.draft.steps[r.cursor],dueAt=r.startedAt+s.waitMinutes*60000;
   if(!s.enabled){r.trace.push({at:now,stepId:s.id,kind:'skipped',reason:'step_disabled'});r.cursor++;continue;}
   if(now<dueAt){r.status='waiting';return r;}
   const key=[r.draft.brand,r.draft.id,r.draft.revision,r.eventId,s.id].join(':');
   if(r.attempts.some(a=>a.key===key)){r.status='uncertain';return r;}
   // This local journal contains synthetic results only. It never grants transport.
   r.attempts.push({key,stepId:s.id,dueAt,at:now,result});r.trace.push({at:now,stepId:s.id,kind:result});
   if(result==='uncertain'){r.status='uncertain';return r;}
   r.cursor++;if(result==='failed'){r.paused=true;r.status='paused';return r;}
  }
  r.status='finished';return r;
 }
 function togglePause(input,paused){validateRun(input);if(typeof paused!=='boolean')fail('LAB_PAUSE_INVALID');const r=clone(input);if(['finished','excluded','uncertain'].includes(r.status))return r;r.paused=paused;r.status=paused?'paused':'waiting';return r;}
 function startOnce(journal,d,options){
  const runs=Array.isArray(journal)?journal:[],same=runs.find(r=>r.draft.id===d.id&&r.draft.brand===d.brand&&r.eventId===options.eventId);
  if(same){validateRun(same);return {runs:clone(runs),run:clone(same),duplicate:true};}if(runs.length>=20)fail('LAB_HISTORY_LIMIT');const run=newRun(d,options);return {runs:[...clone(runs),run],run,duplicate:false};
 }
 function readStore(raw){
  if(raw===null)return {schema:SCHEMA,drafts:[],runs:[]};if(typeof raw!=='string'||raw.length>1000000)fail('LAB_STORAGE_INVALID');let value;try{value=JSON.parse(raw);}catch{fail('LAB_STORAGE_INVALID');}
  if(!exact(value,['schema','drafts','runs'])||value?.schema!==SCHEMA||!Array.isArray(value.drafts)||value.drafts.length>20||!Array.isArray(value.runs)||value.runs.length>20)fail('LAB_STORAGE_INVALID');
  const ids=new Set(),events=new Set();for(const d of value.drafts){validateDraft(d);if(ids.has(d.id))fail('LAB_STORAGE_INVALID');ids.add(d.id);}for(const r of value.runs){validateRun(r);const d=value.drafts.find(d=>d.id===r.draft.id&&d.brand===r.draft.brand),event=JSON.stringify([r.draft.brand,r.draft.id,r.eventId]);if(!d||r.draft.revision>d.revision||JSON.stringify(r.draft.source)!==JSON.stringify(d.source)||r.draft.revision===d.revision&&JSON.stringify(r.draft)!==JSON.stringify(d)||events.has(event))fail('LAB_STORAGE_INVALID');events.add(event);}return value;
 }
 return Object.freeze({SCHEMA,validateDraft,duplicate,createDraft,duplicateDraft,saveDraft,newRun,validateRun,fact,advance,togglePause,startOnce,readStore});
});
