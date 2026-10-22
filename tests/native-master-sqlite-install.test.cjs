'use strict';
// Original Auth/SQLite/HMAC/attestor and original IAM SQL fixtures; no remote
// execution, listener, production credentials or manufactured user context.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite'),{fixture,pending,CAPS}=require('./corporate-writer-fixture.cjs');
const OWNER='felipebandeira@oaristocrata.com',KEY='synthetic-native-own-master-key',PRINCIPAL='synthetic-native-own-master-principal',PROGRAM='a'.repeat(64);
async function setup(t,{full=true}={}){
 const f=await fixture(t),pg=new PGlite();t.after(()=>pg.close());
 await pg.exec('CREATE TABLE public.crm_dash_chave(chave text PRIMARY KEY,painel text NOT NULL,dono text NOT NULL,ativo boolean NOT NULL DEFAULT true,revogada_em timestamptz,ultimo_uso timestamptz,usos integer NOT NULL DEFAULT 0);CREATE TABLE public.shrigma_template_key_v2(actor text,capabilities jsonb,key_hash text,active boolean);CREATE TABLE public.dash_payload_cache(painel text PRIMARY KEY,payload jsonb NOT NULL,gerado_em timestamptz NOT NULL,bytes bigint,origem_ms bigint);');
 for(const name of ['n8n/access/panel-auth.sql','n8n/access/panel-operator.sql','n8n/access/panel-short-keys.sql','n8n/growth/crm-read-fast.sql'])await pg.exec(fs.readFileSync(path.join(__dirname,'..',name),'utf8'));
 await pg.query("INSERT INTO crm_dash_chave(chave,painel,dono,chave_hash) VALUES($1,'todos',$2,encode(sha256(convert_to($3,'UTF8')),'hex'))",[PRINCIPAL,OWNER,KEY]);await pg.query("INSERT INTO shrigma_panel_permission_v1 VALUES($1,'growth',$2::jsonb)",[PRINCIPAL,JSON.stringify(full?CAPS:['read_content','list_history','submission'])]);
 f.auth.setUpstreamCredential({context:f.context,userId:f.master.user.id,slot:'growth-read',bearer:KEY});
 let calls=0,during=()=>{};
 const fetchImpl=async(url,o)=>{calls++;assert.equal(o.method,'GET');assert.equal(o.redirect,'manual');assert.equal(f.db.isTransaction,false);assert.equal(o.headers.Authorization,'Bearer '+KEY);const r=(await pg.query('SELECT * FROM shrigma_crm_read_fast_v1($1,NULL,$2::jsonb)',['Bearer '+KEY,JSON.stringify({action:'identity',painel:'growth'})])).rows[0];await during();const response=new Response(JSON.stringify(r.body),{status:r.status_code,headers:{'content-type':'application/json'}});Object.defineProperty(response,'url',{value:url});return response;};
 const options=()=>{const operationId=crypto.randomUUID(),expiresAt=f.now+300000,scope=JSON.stringify({schema:'CRM_NATIVE_OWN_MASTER_SQLITE_WRITER_V1',operationId,owner:OWNER,action:'install-own-master-campaign-writer',programSha256:PROGRAM,expiresAt});return{operationId,programSha256:PROGRAM,expiresAt,authorizationMac:crypto.createHmac('sha256',f.config.encryptionKey).update('native-own-master-sqlite-writer-v1:'+scope).digest('hex'),fetchImpl};};
 const run=extra=>f.auth.activateNativeOwnMasterCampaignWriter({...options(),...extra});
 const edited=()=>f.db.prepare("SELECT can_edit FROM grants WHERE user_id=? AND area='growth'").get(f.master.user.id).can_edit;
 return{f,pg,run,options,edited,get calls(){return calls;},set during(v){during=v;}};
}
test('legitimate native authority installs only own Growth writer after original actual four-cap GET, preserving password/session/other areas',async t=>{
 const a=await setup(t),before=a.f.masterBaseline(),sessions=a.f.db.prepare('SELECT * FROM sessions ORDER BY token_hash').all();
 assert.deepEqual(await a.run(),{ok:true,ready:true,actor:'native-integrator',attemptMustRemainConsumed:true});assert.equal(a.calls,1);assert.equal(a.edited(),1);assert.deepEqual(a.f.masterBaseline().user,before.user);assert.deepEqual(a.f.db.prepare('SELECT * FROM sessions ORDER BY token_hash').all(),sessions);
 for(const area of ['organico','influs'])assert.deepEqual(a.f.masterBaseline().grants.find(x=>x.area===area),before.grants.find(x=>x.area===area));assert.equal(a.f.auth.campaignWriterReady(a.f.context),true);assert.equal(a.f.events.length,0);
 const dump=a.f.db.prepare('SELECT * FROM identity_metadata').all();assert.equal(JSON.stringify(dump).includes(KEY),false);assert.equal(JSON.stringify(dump).includes(PRINCIPAL),false);
 await assert.rejects(a.run(),e=>e.code==='NATIVE_MASTER_ATTEMPT_CONSUMED');assert.equal(a.calls,1);
});
test('missing signed scope or tampered action fields cannot reserve a marker or perform GET; original session is not used as authority',async t=>{
 const a=await setup(t);for(const extra of [{authorizationMac:'0'.repeat(64)},{programSha256:'b'.repeat(64)},{expiresAt:a.f.now-1},{operationId:crypto.randomUUID()}])await assert.rejects(a.run(extra),e=>e.code==='NATIVE_MASTER_AUTHORIZATION_REQUIRED');assert.equal(a.calls,0);assert.equal(a.edited(),0);assert.equal(a.f.db.prepare("SELECT 1 FROM identity_metadata WHERE key='native_master_campaign_writer_once_v1'").get(),undefined);
 a.f.auth.logout(a.f.context);assert.deepEqual(await a.run(),{ok:true,ready:true,actor:'native-integrator',attemptMustRemainConsumed:true});assert.equal(a.calls,1);assert.equal(a.edited(),1);
});
test('READ-only backend consumes the native attempt without a grant, proof or replay even after restart/new UUID',async t=>{
 const a=await setup(t,{full:false});await assert.rejects(a.run(),e=>e.code==='CREDENTIAL_ATTESTATION_FAILED');assert.equal(a.calls,1);assert.equal(a.edited(),0);assert.equal(a.f.db.prepare('SELECT 1 FROM campaign_writer_attestation_v1').get(),undefined);a.f.restart();await assert.rejects(a.run(),e=>e.code==='NATIVE_MASTER_ATTEMPT_CONSUMED');assert.equal(a.calls,1);
});
test('current own snapshot, original all-brand MAC, no shared key and pending journals stay required',async t=>{
 for(const mode of ['bad-mac','shared','pending','drift']){const a=await setup(t);if(mode==='bad-mac')a.f.db.prepare("UPDATE upstream_brand_bindings_v1 SET binding_mac=? WHERE user_id=?").run('0'.repeat(64),a.f.master.user.id);if(mode==='shared'){const u=a.f.invite('synthetic-other@fishermans.com.br');a.f.db.prepare('INSERT INTO upstream_credentials VALUES(?,?,?,?,?)').run(u.userId,'growth-read',a.f.encrypt(KEY),a.f.digest(KEY),a.f.now);}if(mode==='pending')pending(a.f,a.f.master.user.id,'campaign_draft_operations','uncertain');if(mode==='drift')a.during=()=>a.f.db.prepare("UPDATE upstream_credentials SET updated_at=updated_at+1 WHERE slot='growth-read'").run();await assert.rejects(a.run());assert.equal(a.edited(),0);assert.equal(a.f.db.prepare('SELECT 1 FROM campaign_writer_attestation_v1').get(),undefined);assert.equal(a.calls,mode==='drift'?1:0);}
});
test('failed original proof persistence rolls back Growth promotion but keeps the consumed attempt',async t=>{
 const a=await setup(t);a.f.db.exec("CREATE TRIGGER native_fixture_failure BEFORE INSERT ON campaign_writer_attestation_v1 BEGIN SELECT RAISE(ABORT,'synthetic-proof-failure'); END;");await assert.rejects(a.run());assert.equal(a.edited(),0);assert.equal(a.f.db.prepare("SELECT 1 FROM upstream_credentials WHERE slot='growth-campaign'").get(),undefined);assert.equal(a.f.db.prepare("SELECT 1 FROM identity_metadata WHERE key='native_master_campaign_writer_once_v1'").get()!==undefined,true);await assert.rejects(a.run(),e=>e.code==='NATIVE_MASTER_ATTEMPT_CONSUMED');assert.equal(a.calls,1);
});
