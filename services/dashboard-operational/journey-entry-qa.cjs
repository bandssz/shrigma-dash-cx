'use strict';
const crypto=require('node:crypto'),E=require('./journey-entry-qa-engine.cjs'),Lab=require('./public/crm-preview/journey-engine.js');
const SCHEMA='shrigma-entry-journey-qa-v1',TABLE='simple_journey_entry_qa_v1',UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const exact=(x,keys)=>!!x&&Object.getPrototypeOf(x)===Object.prototype&&Object.keys(x).sort().join(',')===keys.split(',').sort().join(',');
const fail=(code,status=400)=>{throw Object.assign(Error(code),{code,status});},clone=x=>JSON.parse(JSON.stringify(x));
const LIMITS=Object.freeze({definitions:20,rounds:20});
const POLICY=Object.freeze({mode:'synthetic',maxEmailsPerPersonDay:1,timeZone:'America/Sao_Paulo',purchaseDuration:'elapsed_24h',entryPolicy:'once_per_journey_person',executes:false,sends:0});
function scopeCapRounds(rounds,person,at){return rounds.filter(r=>r.person===person&&r.run.attempts.some(a=>['reserved','uncertain'].includes(a.result)||Lab.paidDay(a.at)===Lab.paidDay(at)));}
function create({db,authorize,transaction,now=Date.now,paidRounds=()=>[]}){
 if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(TABLE)){
  const main=db.prepare('PRAGMA database_list').all().find(r=>r.name==='main');if(main?.file){const fs=require('node:fs'),path=require('node:path'),dir=path.join(path.dirname(main.file),'entry-qa-backups');fs.mkdirSync(dir,{recursive:true,mode:0o700});if(fs.lstatSync(dir).isSymbolicLink()||!fs.lstatSync(dir).isDirectory())fail('ENTRY_QA_BACKUP_REQUIRED',503);const file=path.join(dir,'before-entry-qa-'+crypto.randomUUID()+'.sqlite');db.exec("VACUUM INTO '"+file.replaceAll("'","''")+"'");fs.chmodSync(file,0o600);if(fs.statSync(file).size<1)fail('ENTRY_QA_BACKUP_REQUIRED',503);}
  db.exec('CREATE TABLE '+TABLE+"(user_id TEXT NOT NULL REFERENCES users(id),brand TEXT NOT NULL CHECK(brand IN ('aristo','fish')),revision INTEGER NOT NULL CHECK(revision>0),qa_json TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,brand,revision))");
 }
 const empty=()=>({schema:SCHEMA,definitions:[],rounds:[],lastMutationId:null});
 function head(userId,brand){
  const row=db.prepare('SELECT revision,qa_json FROM '+TABLE+' WHERE user_id=? AND brand=? ORDER BY revision DESC LIMIT 1').get(userId,brand),qa=row?JSON.parse(row.qa_json):empty();
  if(!exact(qa,'schema,definitions,rounds,lastMutationId')||qa.schema!==SCHEMA||!Array.isArray(qa.definitions)||qa.definitions.length>LIMITS.definitions||!Array.isArray(qa.rounds)||qa.rounds.length>LIMITS.rounds||qa.lastMutationId!==null&&!UUID.test(qa.lastMutationId)||JSON.stringify(qa).length>500000)fail('ENTRY_QA_STORAGE_INVALID',503);
  const ids=new Set(),roundIds=new Set();for(const d of qa.definitions){E.validateDefinition(d);if(d.draft.brand!==brand||ids.has(d.draft.id))fail('ENTRY_QA_STORAGE_INVALID',503);ids.add(d.draft.id);}
  for(const r of qa.rounds){E.validateRound(r);const d=qa.definitions.find(x=>x.draft.id===r.definition.draft.id);if(!d||r.definition.draft.brand!==brand||r.definition.draft.revision>d.draft.revision||!r.person.startsWith('synthetic:'+userId+':')||roundIds.has(r.id))fail('ENTRY_QA_STORAGE_INVALID',503);roundIds.add(r.id);}
  return {revision:row?.revision||0,qa};
 }
 function receipt(userId,brand,id){if(!UUID.test(id||''))fail('ENTRY_QA_ARGUMENTS');const r=db.prepare("SELECT revision FROM "+TABLE+" WHERE user_id=? AND brand=? AND json_extract(qa_json,'$.lastMutationId')=? ORDER BY revision DESC LIMIT 1").get(userId,brand,id);return {mutationId:id,confirmed:!!r,revision:r?.revision||null};}
 function read({context,brand,mutationId}){const u=authorize(context,brand),h=head(u.id,brand);return {persistence:'server',userId:u.id,brand,...h,...(mutationId?{mutationReceipt:receipt(u.id,brand,mutationId)}:{}),capacity:Object.fromEntries(Object.entries(LIMITS).map(([key,limit])=>[key,{limit,used:h.qa[key].length,available:limit-h.qa[key].length}])),policy:POLICY,executes:false,sends:0};}
 const historicalEntries=new Map();
 function allEntries(userId){return ['aristo','fish'].flatMap(brand=>{
  const current=head(userId,brand),key=userId+':'+brand,cached=historicalEntries.get(key);if(cached?.revision===current.revision)return cached.rounds;
  const rows=db.prepare("SELECT value FROM (SELECT j.value,row_number() OVER(PARTITION BY json_extract(j.value,'$.id') ORDER BY q.revision DESC) position FROM "+TABLE+" q,json_each(q.qa_json,'$.rounds') j WHERE q.user_id=? AND q.brand=?) WHERE position=1").all(userId,brand),rounds=rows.map(row=>JSON.parse(row.value));
  for(const r of rounds){E.validateRound(r);if(r.definition.draft.brand!==brand||!r.person.startsWith('synthetic:'+userId+':'))fail('ENTRY_QA_STORAGE_INVALID',503);}
  historicalEntries.set(key,{revision:current.revision,rounds});return rounds;
 });}
 function capRounds(userId){return allEntries(userId).map(E.capRound);}
 function prepare({context,...body}){
  const {brand,expected_revision,mutationId,action,...args}=body,u=authorize(context,brand,true),keys={create:'name,kind,days,waitMinutes,audienceId,audienceVersion',update:'definitionId,name,kind,days,waitMinutes,audienceId,audienceVersion',start:'definitionId,personId,purchaseAgeDays',advance:'roundId,minutes,membership,payment,mailEvidence,afterEntry,result',resolve:'originalMutationId',archive_ci:'runName'};
  if(!Number.isSafeInteger(expected_revision)||expected_revision<0||expected_revision>=2147483647||!UUID.test(mutationId||'')||!keys[action]||!exact(args,keys[action]))fail('ENTRY_QA_ARGUMENTS');
  const h=head(u.id,brand);if(h.revision!==expected_revision)fail('ENTRY_QA_VERSION_CHANGED',409);if(receipt(u.id,brand,mutationId).confirmed)fail('ENTRY_QA_MUTATION_REUSED',409);
  if(action==='create'||action==='update'){
   if(typeof args.name!=='string'||!args.name.trim()||args.name.length>100||/[\x00-\x1f\x7f]/.test(args.name)||!['audience_entry','after_purchase'].includes(args.kind)||!Number.isSafeInteger(args.days)||args.days<(args.kind==='audience_entry'?1:0)||args.days>365||!Array.isArray(args.waitMinutes)||!args.waitMinutes.length||args.waitMinutes.length>5||args.waitMinutes.some((n,i)=>!Number.isSafeInteger(n)||n<0||n>43200||i>0&&n<args.waitMinutes[i-1]))fail('ENTRY_QA_DEFINITION_INVALID');
   if(action==='update'&&!h.qa.definitions.some(d=>d.draft.id===args.definitionId))fail('ENTRY_QA_NOT_FOUND',404);
   if(args.kind==='audience_entry'){if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(args.audienceId||'')||!Number.isSafeInteger(args.audienceVersion)||args.audienceVersion<1||args.audienceVersion>999999999)fail('ENTRY_QA_AUDIENCE_INVALID');return {userId:u.id,audienceLookup:{id:args.audienceId,version:args.audienceVersion}};}
   if(args.audienceId!==null||args.audienceVersion!==null)fail('ENTRY_QA_AUDIENCE_INVALID');
  }else if(action==='start'){
   if(!h.qa.definitions.some(d=>d.draft.id===args.definitionId)||!/^[a-z0-9_-]{1,40}$/.test(args.personId||'')||!Number.isSafeInteger(args.purchaseAgeDays)||args.purchaseAgeDays<0||args.purchaseAgeDays>365)fail('ENTRY_QA_SCENARIO_INVALID');
  }else if(action==='advance'){
   if(!h.qa.rounds.some(r=>r.id===args.roundId)||![0,60,1440,4320,128160,129600,525600].includes(args.minutes)||!['entered','unchanged','outside','unknown','baseline','gap','version','stale'].includes(args.membership)||!['paid','unknown','refunded','missing-anchor','new-paid'].includes(args.payment)||!['empty','campaign','journey','ses','unknown','incomplete','stale'].includes(args.mailEvidence)||!['none','purchase','optout','unknown'].includes(args.afterEntry)||!['simulated','uncertain'].includes(args.result))fail('ENTRY_QA_SCENARIO_INVALID');
  }else if(action==='archive_ci'){if(!/^ci-[0-9]{1,20}-[0-9]{1,6}$/.test(args.runName||''))fail('ENTRY_QA_ARGUMENTS');}
  else if(!UUID.test(args.originalMutationId||''))fail('ENTRY_QA_ARGUMENTS');
  return {userId:u.id,audienceLookup:null};
 }
 function mutate({context,body,audienceRef=null}){
  if(!body||Object.getPrototypeOf(body)!==Object.prototype||Object.hasOwn(body,'context'))fail('ENTRY_QA_ARGUMENTS');
  const prepared=prepare({...body,context}),{brand,expected_revision,mutationId,action,...args}=body;
  if(prepared.audienceLookup){const r=audienceRef;if(!r||r.id!==prepared.audienceLookup.id||r.version!==prepared.audienceLookup.version)fail('ENTRY_QA_AUDIENCE_UNCONFIRMED',409);}
  else if(audienceRef!==null)fail('ENTRY_QA_ARGUMENTS');
  return transaction(()=>{
   const u=authorize(context,brand,true);if(u.id!==prepared.userId)fail('ENTRY_QA_ACCESS_CHANGED',403);const h=head(u.id,brand);if(h.revision!==expected_revision)fail('ENTRY_QA_VERSION_CHANGED',409);if(receipt(u.id,brand,mutationId).confirmed)fail('ENTRY_QA_MUTATION_REUSED',409);const q=h.qa;
   let retention;
   if(action==='archive_ci'){
    const activePrefix='[QA] Entradas CI '+args.runName+' '+brand+' ·',eligible=new Set(q.definitions.filter(d=>{
     if(!/^\[QA\] Entradas CI ci-[0-9]+-[0-9]+ (aristo|fish) ·/.test(d.draft.name)||d.draft.name.startsWith(activePrefix))return false;
     return q.rounds.filter(r=>r.definition.draft.id===d.draft.id).every(r=>r.person.startsWith('synthetic:'+u.id+':ci-ci-'));
    }).map(d=>d.draft.id));
    const oldDefinitions=q.definitions.length,oldRounds=q.rounds.length;
    q.rounds=q.rounds.filter(r=>!eligible.has(r.definition.draft.id));q.definitions=q.definitions.filter(d=>!eligible.has(d.draft.id));
    retention={previousRevision:h.revision,archivedDefinitions:oldDefinitions-q.definitions.length,archivedRounds:oldRounds-q.rounds.length,preservedImmutableRevision:h.revision,customerData:false,executes:false,sends:0};
   }
   else if(action==='resolve'){if(receipt(u.id,brand,args.originalMutationId).confirmed)return read({context,brand,mutationId:args.originalMutationId});}
   else if(action==='create'||action==='update'){
    const old=action==='update'?q.definitions.find(d=>d.draft.id===args.definitionId):null;if(!old&&q.definitions.length>=LIMITS.definitions)fail('ENTRY_QA_LIMIT',409);
    const draft=old?clone(old.draft):Lab.createDraft({brand,id:crypto.randomUUID()});draft.name=args.name.trim();draft.trigger='manual_event';draft.audience='Pessoa sintética · referência sem leitura de membros';draft.steps=args.waitMinutes.map((waitMinutes,i)=>({id:'step-'+(i+1),channel:'email',waitMinutes,enabled:true,templateName:'Mensagem QA '+(i+1),subject:'[TESTE] Entradas · '+(i+1),text:'[TESTE] Ensaio sintético sem transporte.'}));
    const entrySpec=args.kind==='audience_entry'?{kind:args.kind,audienceRef:clone(audienceRef),rollingDays:args.days,cadence:'daily',timeZone:'America/Sao_Paulo',entryPolicy:'once_per_journey_person'}:{kind:args.kind,delayDays:args.days,anchor:'lastPaidAt',duration:'elapsed_24h',resetOnLaterPaid:true,entryPolicy:'once_per_journey_person'};
    const saved=E.validateDefinition({schema:E.SCHEMA,draft:old?Lab.saveDraft(old.draft,draft):Lab.validateDraft(draft),entrySpec});q.definitions=old?q.definitions.map(d=>d.draft.id===old.draft.id?saved:d):[...q.definitions,saved];
   }else{
    const entries=allEntries(u.id),all=[...paidRounds(u.id),...entries.map(E.capRound)],globalNow=Math.max(now(),...all.map(x=>x.run.now));
    if(action==='start'){if(q.rounds.length>=LIMITS.rounds)fail('ENTRY_QA_LIMIT',409);q.rounds.push(E.newRound(q.definitions.find(d=>d.draft.id===args.definitionId),{id:crypto.randomUUID(),person:'synthetic:'+u.id+':'+args.personId,now:globalNow,purchaseAgeDays:args.purchaseAgeDays}));}
    else{
     const r=q.rounds.find(r=>r.id===args.roundId);if(r.checks.length>=95||r.decisions.length>=190)fail('ENTRY_QA_LIMIT',409);const at=Math.max(globalNow,r.now+args.minutes*60000),scenario=E.scenario(r,{now:at,membership:args.membership,payment:args.payment,mailEvidence:args.mailEvidence,afterEntry:args.afterEntry});
     scenario.evidence.receipts=[...all.flatMap(x=>x.receipts||[]),...scenario.round.receipts].filter(x=>x.person===r.person&&Lab.paidDay(x.at)===Lab.paidDay(at));const prior=entries.find(x=>x.id!==r.id&&x.person===r.person&&x.definition.draft.id===r.definition.draft.id&&x.entry),advanced=E.advance(scenario.round,{now:at,evidence:scenario.evidence,entryRounds:prior?[prior]:[],capRounds:scopeCapRounds(all,r.person,at),result:args.result});q.rounds=q.rounds.map(x=>x.id===r.id?advanced:x);
    }
   }
   q.lastMutationId=mutationId;const serialized=JSON.stringify(q);if(serialized.length>500000)fail('ENTRY_QA_LIMIT',409);db.prepare('INSERT INTO '+TABLE+'(user_id,brand,revision,qa_json,created_at) VALUES(?,?,?,?,?)').run(u.id,brand,expected_revision+1,serialized,now());return {...read({context,brand,...(action==='resolve'?{mutationId:args.originalMutationId}:{})}),...(retention?{ciRetention:retention}:{})};
  });
 }
 return Object.freeze({read,prepare,mutate,capRounds,scopeCapRounds});
}
module.exports={create,SCHEMA,POLICY};
