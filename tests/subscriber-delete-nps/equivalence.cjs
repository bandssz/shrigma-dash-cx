'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const OUT=path.join(__dirname,'contract'),BASE=__dirname;
const {plan,snapshotSQL}=require(path.join(OUT,'prepare.cjs'));
const {syncNpsVote}=require(path.resolve(__dirname,'../../n8n/growth/nps-vote-sync.js'));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
let passed=0,db,ended=false,rollback=false,phase='bootstrap';
const q=async(text,values=[])=>{if(!values.length&&db.exec)return(await db.exec(text)).at(-1);const r=await db.query(text,values);return Array.isArray(r)?r.at(-1):r;};
const rows=async(text,values)=>(await q(text,values)).rows;
const count=async(text,values)=>Number((await rows(text,values))[0].n);
const checkpoint=async()=>{await q('BEGIN READ ONLY');try{await q("SET LOCAL search_path=pg_catalog");const s=(await rows(snapshotSQL))[0].snapshot;await q('ROLLBACK');return s;}catch(e){await q('ROLLBACK');throw e;}};
const refusal=async(fn,code)=>{let e;try{await fn();}catch(x){e=x;}assert.ok(e);if(e.code!==code)throw e;};
async function migration(action,expected){const p=plan({action,expectedSnapshot:expected||await checkpoint()});try{for(const s of p.steps)await q(s.text,s.values);await q(p.commit);}catch(e){await q(p.rollback);throw e;}}
async function test(name,fn){phase=name;await fn();passed++;}
const jobId=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
async function sub(id){await q("INSERT INTO public.subscribers(id,email,attribs)VALUES($1,$2,'{}')",[id,`synthetic-${id}@example.invalid`]);}
async function job(id,sid,state='pending'){await q("INSERT INTO public.shrigma_nps_vote_sync(id,subscriber_id,brand,order_ref,vote_date,payload,state,task_id)VALUES($1,$2,'fish','synthetic-order','2026-10-10T00:00:00Z',$3,$4,'synthetic-task')",[jobId(id),sid,{brand:'fish',email:'synthetic@example.invalid',order:'synthetic-order',date:'2026-10-10T00:00:00Z',score:10,bucket:'promotor',task_id:'synthetic-task'},state]);}
async function main(){
 const inputs=JSON.parse(fs.readFileSync(path.join(BASE,'INPUT-PINS.json'),'utf8'));
 const workspace=path.resolve(BASE,'../..');
 for(const p of inputs.pins){const b=fs.readFileSync(path.join(workspace,p.path));assert.equal(b.length,p.bytes);assert.equal(sha(b),p.sha256);}
 if(process.env.NPS_FIXTURE_URL){
  assert.equal(process.env.NPS_FIXTURE_ISOLATED,'1');const u=new URL(process.env.NPS_FIXTURE_URL);assert.equal(u.hostname,'127.0.0.1');assert.notEqual(u.port,'5432');assert.equal(u.pathname,'/nps_delete_fixture');
  const {Client}=require('pg');db=new Client({connectionString:u.href});await db.connect();
 }else{
  const pkg=process.env.PGLITE_PACKAGE;if(!pkg)throw Error('NPS_PGLITE_PACKAGE_REQUIRED');assert.equal(JSON.parse(fs.readFileSync(path.join(pkg,'package.json'),'utf8')).version,'0.3.14');
  const {PGlite}=require(pkg);db=new PGlite();await db.waitReady;
 }
 const version=(await rows('SHOW server_version'))[0].server_version;assert.match(version,/^17\.10(?:\D|$)/);assert.equal(process.version,'v22.23.3');assert.equal(process.getuid(),1000);assert.equal(require('pg/package.json').version,'8.23.1');
 await q("SET search_path=public,pg_catalog");
 await q(`CREATE TABLE public.subscribers(id integer PRIMARY KEY,email text,attribs jsonb,updated_at timestamptz DEFAULT now());
 CREATE TABLE public.subscriber_lists(subscriber_id integer REFERENCES public.subscribers(id) ON DELETE CASCADE);
 CREATE TABLE public.bounces(subscriber_id integer REFERENCES public.subscribers(id) ON DELETE CASCADE);
 CREATE TABLE public.campaign_views(subscriber_id integer REFERENCES public.subscribers(id) ON DELETE SET NULL);
 CREATE TABLE public.link_clicks(subscriber_id integer REFERENCES public.subscribers(id) ON DELETE SET NULL);
 CREATE FUNCTION public.synthetic_third_party_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN OLD;END$$;
 CREATE TRIGGER synthetic_third_party_delete_guard BEFORE DELETE ON public.subscribers FOR EACH ROW EXECUTE FUNCTION public.synthetic_third_party_guard();`);
 // PGlite bundle has no pgcrypto. Preserve the exact public SQL sign definition by
 // deferring its body validation; signing/record_vote are NOT invoked in this proof.
 await q('SET check_function_bodies=off');
 await q(fs.readFileSync(path.join(BASE,'source-inputs/nps-native.sql'),'utf8'));
 await q('SET check_function_bodies=on');
 const baseline=await checkpoint();
 const defs=Object.fromEntries(baseline.functions.filter(f=>['shrigma_nps_claim_vote_sync','shrigma_nps_finish_vote_sync'].includes(f.name)).map(f=>[f.name,{bodySha256:f.bodySha256,bodyBytes:f.bodyBytes,definitionSha256:f.definitionSha256,pgMajor:17,deparserVersion:version}]));
 const pins=JSON.parse(fs.readFileSync(path.join(OUT,'FUNCTION-PINS.json'),'utf8'));assert.equal(defs.shrigma_nps_claim_vote_sync.bodySha256,pins.claimOriginal.sha256);assert.equal(defs.shrigma_nps_finish_vote_sync.bodySha256,pins.finishOriginal.sha256);
 fs.writeFileSync(path.join(OUT,'EXPECTED-DEFINITION-PINS.json'),JSON.stringify(defs,null,2)+'\n');
 await test('before-delete-fk-23503',async()=>{await sub(1);await job(1,1);await refusal(()=>q('DELETE FROM public.subscribers WHERE id=1'),'23503');});
 await test('catalog-cas-drift-refused',async()=>{const wrong=structuredClone(baseline);wrong.tables.subscribers.ownerOid++;await refusal(()=>migration('apply',wrong),'P0001');assert.equal((await checkpoint()).tables.shrigma_nps_vote_sync.columns[1].notNull,true);});
 await test('function-body-drift-refused',async()=>{await q((fs.readFileSync(path.join(OUT,'CLAIM.original.sql'),'utf8')).replace('BEGIN','BEGIN\n -- synthetic drift'));await refusal(()=>migration('apply'),'P0001');await q(fs.readFileSync(path.join(OUT,'CLAIM.original.sql'),'utf8'));});
 await test('own-trigger-collision-refused',async()=>{await q('CREATE TRIGGER shrigma_nps_subscriber_delete_detach BEFORE DELETE ON public.subscribers FOR EACH ROW EXECUTE FUNCTION public.synthetic_third_party_guard()');await refusal(()=>migration('apply'),'P0001');await q('DROP TRIGGER shrigma_nps_subscriber_delete_detach ON public.subscribers');});
 await test('apply-and-third-party-preservation',async()=>{const before=await checkpoint();await migration('apply');const after=await checkpoint();assert.deepEqual(after.triggers.filter(t=>t.name==='synthetic_third_party_delete_guard'),before.triggers.filter(t=>t.name==='synthetic_third_party_delete_guard'));assert.deepEqual(after.constraints.filter(c=>c.referenceOid===before.tables.subscribers.oid&&c.relationOid!==before.tables.shrigma_nps_vote_sync.oid),before.constraints.filter(c=>c.referenceOid===before.tables.subscribers.oid&&c.relationOid!==before.tables.shrigma_nps_vote_sync.oid));assert.equal(after.functions.find(f=>f.name==='shrigma_nps_claim_vote_sync').bodySha256,pins.claimProposed.sha256);});
 await test('structural-restore-before-erasure',async()=>{await migration('restore');assert.equal((await checkpoint()).tables.shrigma_nps_vote_sync.columns[1].notNull,true);await migration('apply');});
 for(const [i,state]of ['pending','in_flight','synced','outcome_unknown','superseded'].entries()){
  await test(`delete-${state}-purges-and-preserves-state`,async()=>{let sid=10+i;await sub(sid);await job(sid,sid,state);const before=(await rows('SELECT id,brand,state,created_at FROM public.shrigma_nps_vote_sync WHERE id=$1',[jobId(sid)]))[0];await q('DELETE FROM public.subscribers WHERE id=$1',[sid]);const after=(await rows('SELECT * FROM public.shrigma_nps_vote_sync WHERE id=$1',[jobId(sid)]))[0];for(const k of ['id','brand','state','created_at'])assert.deepEqual(after[k],before[k]);for(const k of ['subscriber_id','order_ref','vote_date','payload','task_id'])assert.equal(after[k],null);assert.equal(await count('SELECT count(*) n FROM public.shrigma_nps_claim_vote_sync($1)',[jobId(sid)]),0);assert.equal((await rows('SELECT public.shrigma_nps_finish_vote_sync($1,$2) AS ok',[jobId(sid),{ok:true,task_id:'must-never-return'}]))[0].ok,false);assert.equal((await rows('SELECT task_id FROM public.shrigma_nps_vote_sync WHERE id=$1',[jobId(sid)]))[0].task_id,null);});
 }
 await test('claim-before-delete-late-finish-blocked',async()=>{await sub(30);await job(30,30);assert.equal(await count('SELECT count(*) n FROM public.shrigma_nps_claim_vote_sync($1)',[jobId(30)]),1);await q('DELETE FROM public.subscribers WHERE id=30');assert.equal((await rows('SELECT public.shrigma_nps_finish_vote_sync($1,$2) ok',[jobId(30),{ok:true,task_id:'late'}]))[0].ok,false);assert.equal((await rows('SELECT state FROM public.shrigma_nps_vote_sync WHERE id=$1',[jobId(30)]))[0].state,'in_flight');});
 await test('finish-before-delete-purges-synced-data',async()=>{await sub(31);await job(31,31);await q('SELECT * FROM public.shrigma_nps_claim_vote_sync($1)',[jobId(31)]);assert.equal((await rows('SELECT public.shrigma_nps_finish_vote_sync($1,$2) ok',[jobId(31),{ok:true,task_id:'completed'}]))[0].ok,true);await q('DELETE FROM public.subscribers WHERE id=31');assert.equal((await rows('SELECT state,task_id FROM public.shrigma_nps_vote_sync WHERE id=$1',[jobId(31)]))[0].state,'synced');});
 await test('tombstone-check-blocks-repopulation',async()=>{await refusal(()=>q("UPDATE public.shrigma_nps_vote_sync SET payload='{}' WHERE id=$1",[jobId(10)]),'23514');await refusal(()=>q("UPDATE public.shrigma_nps_vote_sync SET task_id='restored' WHERE id=$1",[jobId(10)]),'23514');});
 await test('subscriber-without-nps-and-other-fks',async()=>{await sub(50);for(const name of ['subscriber_lists','bounces','campaign_views','link_clicks'])await q(`INSERT INTO public.${name}(subscriber_id)VALUES(50)`);await q('DELETE FROM public.subscribers WHERE id=50');assert.equal(await count('SELECT count(*) n FROM public.subscriber_lists'),0);assert.equal(await count('SELECT count(*) n FROM public.bounces'),0);assert.equal((await rows('SELECT subscriber_id FROM public.campaign_views'))[0].subscriber_id,null);assert.equal((await rows('SELECT subscriber_id FROM public.link_clicks'))[0].subscriber_id,null);});
 await test('restore-after-erasure-refused',async()=>{await refusal(()=>migration('restore'),'P0001');assert.equal((await checkpoint()).tables.shrigma_nps_vote_sync.columns[1].notNull,false);});
 await test('js-purged-missing-and-malformed-no-http',async()=>{let calls=0;const http=()=>{calls++;throw Error('must not execute');};for(const payload of [null,undefined,{},[],{brand:'fish'}]){const r=await syncNpsVote({sync_id:jobId(10),payload},null,http);assert.equal(r.ok,false);assert.equal(r.task_id,null);assert.equal(r.refusal_code,'NPS_PAYLOAD_UNAVAILABLE');}assert.equal(calls,0);});
 await test('js-live-payload-preserved',async()=>{let calls=0;const r=await syncNpsVote({sync_id:jobId(99),payload:{brand:'fish',order:'synthetic',email:'synthetic@example.invalid',date:'2026-10-10',score:10,bucket:'promotor',task_id:'synthetic-task'}},{CU_TOKEN:'synthetic-unused-token',LISTS:{fish:'synthetic-list'}},async()=>{calls++;return{};});assert.equal(calls,2);assert.equal(r.ok,true);assert.equal(r.task_id,'synthetic-task');});
 // Real rollback and connection close. No persistence or original calls.
 await q('BEGIN');await q("UPDATE public.shrigma_nps_vote_sync SET state='pending' WHERE id=$1",[jobId(14)]);await q('ROLLBACK');rollback=true;assert.equal((await rows('SELECT state FROM public.shrigma_nps_vote_sync WHERE id=$1',[jobId(14)]))[0].state,'superseded');
 return {schema:'nps-delete-focal-proof-v1',ok:true,testsPassed:passed,serverVersion:version,nodeVersion:process.version,uid:process.getuid?.(),runtime:process.env.NPS_FIXTURE_URL?'native-pg':'pglite-0.3.14',persistentDatabase:false,originalCalls:0,httpCallsOriginal:0,rollbackConfirmed:rollback,multiSessionConcurrencyExecuted:false,signingExecuted:false,pgcryptoAvailable:false};
}
(async()=>{let report;try{report=await main();}catch(e){report={schema:'nps-delete-focal-proof-v1',ok:false,testsPassed:passed,phase,sqlstate:typeof e.code==='string'&&/^[A-Z0-9]{5}$/.test(e.code)?e.code:null,exceptionType:e.constructor.name,refusalCode:/^[A-Z0-9_]{1,80}$/.test(e.message||'')?e.message:null,originalCalls:0};process.exitCode=1;}finally{if(db){try{if(db.close)await db.close();else await db.end();ended=true;}catch{process.exitCode=1;}}}report.connectionEnded=ended;fs.writeFileSync(path.join(OUT,'RESULT.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));})();
