'use strict';
// Disposable PGlite only. Uses real auth, writer component, campaign SQL and
// gateway migration. All issuer/principal/key/media rows are synthetic.
// Native HTTP is replaced with local fixture inserts; no socket is opened.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {PGlite}=require('@electric-sql/pglite');
const W=require('../tools/crm-manager-writer-review/writer-provision.test.cjs');
const Transport=require('../services/crm-campaign/transport.cjs');
const Media=require('../services/crm-campaign/media.cjs');
const root=path.resolve(__dirname,'..'),read=f=>fs.readFileSync(path.join(root,f),'utf8');
const sha=s=>createHash('sha256').update(s).digest('hex');
const CAPS=['read_content','draft','validate','submit'];
const KEY='synthetic-brand-writer-key',MASTER_KEY='synthetic-brand-master-key',LEGACY_KEY='synthetic-brand-template-key';
const MASTER_ID='synthetic-master-principal',LEGACY_ACTOR='synthetic-template-admin';
let serial=0;
async function setup(t){
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`CREATE TABLE public.crm_dash_chave(chave text PRIMARY KEY,painel text NOT NULL,dono text,ativo boolean DEFAULT true,revogada_em timestamptz,ultimo_uso timestamptz,usos integer DEFAULT 0);
  CREATE TABLE public.shrigma_template_key_v2(key_hash text,active boolean,actor text,capabilities jsonb);`);
 for(const name of ['n8n/access/panel-auth.sql','n8n/access/panel-operator.sql','n8n/access/panel-short-keys.sql','tests/campaign-provider-schema.sql'])await db.exec(read(name));
 for(const name of ['n8n/growth/campaign-store.sql','n8n/growth/campaign-recovery.sql','n8n/growth/campaign-template-ownership.sql','n8n/growth/campaign-provider.sql','n8n/growth/campaign-write-guard.sql'])await db.exec(read(name));
 // Original writer fixture's known default ACL. Only disposable fixture DDL.
 await db.exec('CREATE ROLE central_leitor NOLOGIN;ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO central_leitor;');
 await db.exec(read('tools/crm-manager-writer-review/writer-provision-v1.sql'));
 await db.exec('CREATE ROLE crm_manager_fixture_a LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;GRANT EXECUTE ON FUNCTION public.crm_manager_writer_prepare_v1(jsonb),public.crm_manager_writer_commit_v1(jsonb),public.crm_manager_writer_revoke_v1(jsonb) TO crm_manager_fixture_a;');
 await db.query('INSERT INTO public.crm_manager_writer_issuer_v1(issuer_id,namespace_id,login_role,allowed_email_domains,active) VALUES($1,$2,$3,ARRAY[$4],true)',[W.A.issuerId,W.A.namespaceId,W.A.login,'example.test']);
 const gatewaySQL=read('n8n/growth/crm-campaign-gateway-role.sql');await db.exec(gatewaySQL);
 const rpc=async q=>{const name={prepare_writer:'prepare',renew_writer:'prepare',commit_writer:'commit',revoke_writer:'revoke'}[q.action];assert.ok(name);await db.exec('SET SESSION AUTHORIZATION crm_manager_fixture_a');try{return(await db.query('SELECT public.crm_manager_writer_'+name+'_v1($1::jsonb) AS r',[W.canonical(q)])).rows[0].r;}finally{await db.exec('SET SESSION AUTHORIZATION postgres');}};
 const api=async(sql,args=[])=>{await db.exec('SET ROLE crm_campaign_api');try{return await db.query(sql,args);}finally{await db.exec('RESET ROLE');}};
 const auth=async(key=KEY)=>(await api(Transport.AUTH_SQL,[key])).rows[0].auth;
 const effect=async(key,command,value,operation=null,actor)=>(await api(Transport.EFFECT_SQL,[key,JSON.stringify({command,actor:actor||(await auth(key))?.actor,operation}),JSON.stringify(value)])).rows[0].result;
 const q=W.prepare({brand:'fish',keySha256:sha(KEY)}),prepared=await rpc(q);assert.equal(prepared.state,'prepared',JSON.stringify(prepared));
 const activate=async()=>{const receipt=await rpc(W.commit(q,prepared));assert.equal(receipt.state,'committed',JSON.stringify(receipt));return receipt;};
 await db.query("INSERT INTO public.crm_dash_chave(chave,painel,dono,chave_hash) VALUES($1,'todos','synthetic-master@example.test',$2),('synthetic-unbound','growth','synthetic-manager@example.test',$3)",[MASTER_ID,sha(MASTER_KEY),sha('synthetic-unbound-key')]);
 await db.query("INSERT INTO public.shrigma_panel_permission_v1 VALUES($1,'growth',$2::jsonb),('synthetic-unbound','growth',$2::jsonb)",[MASTER_ID,JSON.stringify([...CAPS,'edit_content'])]);
 await db.query('INSERT INTO public.shrigma_template_key_v2 VALUES($1,true,$2,$3::jsonb)',[sha(LEGACY_KEY),LEGACY_ACTOR,JSON.stringify([...CAPS,'edit_content'])]);
 const count=async(table)=>(await db.query('SELECT count(*)::int AS n FROM public.'+table)).rows[0].n;
 return {db,q,prepared,rpc,api,auth,effect,activate,count,pool:{query:api}};
}
const command=(acao,brand='fish',extra={})=>({acao,brand,...extra});
const catalog=brand=>({kind:'provider',action:'catalog',payload:{brand}});
const definition=brand=>{const domain=brand==='fish'?'fishermans.com.br':'oaristocrata.com';return {schema_version:'crm-campaign-v1',brand,channel:'email',initiative:{key:'brand-directed',name:'Brand directed'},utm_campaign:'brand-directed',name:'Synthetic draft',subject:'Synthetic subject',from_email:'contato@'+domain,reply_to:'contato@'+domain,list_ids:[brand==='fish'?3:7],template_id:brand==='fish'?1:3,html:'<a href="https://'+domain+'/products/synthetic">Synthetic</a>{{ UnsubscribeURL }}',text:'https://'+domain+'/products/synthetic {{ UnsubscribeURL }}',tags:[],send_at:null};};

test('gateway definer reads current generation without granting API access to writer tables',async t=>{
 const f=await setup(t);assert.equal(await f.auth(),null);await f.activate();
 assert.deepEqual(await f.auth(),{actor:'panel:'+f.q.principalId,caps:CAPS,brand:'fish'});
 assert.equal(await f.auth('synthetic-unbound-key'),null);assert.equal(await f.auth('synthetic-wrong-key'),null);
 const functions=(await f.db.query("SELECT proname,proowner::regrole::text AS owner,prosecdef FROM pg_proc WHERE proname IN ('shrigma_crm_campaign_auth_v1','shrigma_crm_campaign_effect_v1') ORDER BY proname")).rows;
 assert.equal(functions.length,2);for(const fn of functions){assert.equal(fn.owner,'postgres');assert.equal(fn.prosecdef,true);}
 for(const suffix of ['issuer','subject','operation','generation']){
  const table='crm_manager_writer_'+suffix+'_v1';
  assert.equal((await f.db.query("SELECT has_table_privilege('crm_campaign_api',$1,'SELECT') AS allowed",['public.'+table])).rows[0].allowed,false);
  await assert.rejects(f.api('SELECT * FROM public.'+table),e=>e.code==='42501');
 }
 const own=await f.effect(KEY,command('campanha_catalogo'),catalog('fish'));assert.equal(own.brand,'fish');assert.deepEqual(own.templates.map(x=>x.id),[1]);
});

test('crossed manager commands fail at SQL boundary before operation lookup, claim or native preflight',async t=>{
 const f=await setup(t);await f.activate();const before=await f.count('shrigma_campaign_operation'),campaigns=await f.count('campaigns');
 const invalidOp={id:'not-an-operation',lease:'not-a-lease'};
 for(const [cmd,value]of [
  [command('campanha_catalogo','aristo'),catalog('aristo')],
  [command('campanha_obter','aristo',{id:200}),{kind:'provider',action:'get',payload:{id:200}}],
  [command('campanha_salvar','aristo',{idempotency_key:'crossed-manager-claim-01'}),{kind:'store',action:'claim',payload:{actor:'panel:'+f.q.principalId,key:'crossed-manager-claim-01',hash:'a'.repeat(64),brand:'aristo',action:'salvar'}}],
  [command('campanha_salvar','aristo'),{kind:'nativeCreate',payload:{}}],
  [command('campanha_salvar','aristo'),{kind:'preview',idCampaign:200,payload:{}}]
 ])await assert.rejects(f.effect(KEY,cmd,value,cmd.acao==='campanha_catalogo'?null:invalidOp),/CRM_CAMPAIGN_GATEWAY_FORBIDDEN/);
 assert.equal(await f.count('shrigma_campaign_operation'),before);assert.equal(await f.count('campaigns'),campaigns);
});

test('transport denies crossed manager brand before effects and fresh SQL reauthentication denies disabled issuer',async t=>{
 const f=await setup(t);await f.activate();let effects=0,native=0,queries=0;
 const pool={query:async(sql,args)=>{queries++;if(sql===Transport.EFFECT_SQL)effects++;return f.api(sql,args);}};
 const execute=Transport.createExecutor({pool,native:async()=>{native++;throw Error('Synthetic native must not execute');}});
 const crossed=await execute({key:KEY,command:command('campanha_catalogo','aristo')});assert.equal(crossed.status,403);assert.equal(crossed.body.error,'BRAND_DENIED');assert.equal(queries,1);assert.equal(effects,0);assert.equal(native,0);
 const refreshedPool={query:async(sql,args)=>{const result=await f.api(sql,args);if(sql===Transport.AUTH_SQL)await f.db.query('UPDATE crm_manager_writer_issuer_v1 SET active=false');return result;}};
 const refreshed=await Transport.createExecutor({pool:refreshedPool,native:async()=>{native++;throw Error('Synthetic native must not execute');}})({key:KEY,command:command('campanha_catalogo')});
 assert.equal(refreshed.status,503);assert.equal(native,0);assert.equal(await f.count('shrigma_campaign_operation'),0);
});

test('generation, subject, issuer and principal state remain current; renewal retains immutable brand',async t=>{
 const f=await setup(t);await f.activate();
 const cases=[
  ["UPDATE crm_manager_writer_issuer_v1 SET active=false","UPDATE crm_manager_writer_issuer_v1 SET active=true"],
  ["UPDATE crm_manager_writer_subject_v1 SET brand='aristo'","UPDATE crm_manager_writer_subject_v1 SET brand='fish'"],
  ["UPDATE crm_manager_writer_subject_v1 SET active_generation=0","UPDATE crm_manager_writer_subject_v1 SET active_generation=1"],
  ["UPDATE crm_manager_writer_subject_v1 SET state='revoked'","UPDATE crm_manager_writer_subject_v1 SET state='active'"],
  ["UPDATE crm_manager_writer_generation_v1 SET state='revoked'","UPDATE crm_manager_writer_generation_v1 SET state='active'"],
  ["UPDATE crm_dash_chave SET ativo=false WHERE chave=$1","UPDATE crm_dash_chave SET ativo=true WHERE chave=$1"]
 ];
 for(const [change,restore]of cases){await f.db.query(change,change.includes('$1')?[f.q.principalId]:[]);assert.equal(await f.auth(),null,change);await f.db.query(restore,restore.includes('$1')?[f.q.principalId]:[]);assert.equal((await f.auth()).brand,'fish');}
 const wrong=W.renew(f.q,{brand:'aristo',keySha256:sha('synthetic-wrong-renew-key')});assert.equal((await f.rpc(wrong)).code,'CREDENTIAL_CONFLICT');
 const key='synthetic-brand-renew-key',next=W.renew(f.q,{brand:'fish',keySha256:sha(key)}),r=await f.rpc(next);assert.equal(r.brand,'fish');assert.equal(r.state,'prepared');assert.equal(await f.auth(key),null);
 const c=await f.rpc(W.commit(next,r));assert.equal(c.brand,'fish');assert.equal(c.state,'committed');assert.equal(await f.auth(KEY),null);assert.equal((await f.auth(key)).brand,'fish');
 const revoked=await f.rpc(W.revoke(next));assert.equal(revoked.state,'revoked');assert.equal(Object.hasOwn(revoked,'brand'),false);assert.equal(await f.auth(key),null);
});

test('real Master and active legacy template credentials preserve old auth shape and both brands',async t=>{
 const f=await setup(t);
 for(const [key,actor]of [[MASTER_KEY,'panel:'+MASTER_ID],[LEGACY_KEY,LEGACY_ACTOR]]){
  assert.deepEqual(await f.auth(key),{actor,caps:[...CAPS,'edit_content']});
  for(const brand of ['fish','aristo'])assert.equal((await f.effect(key,command('campanha_catalogo',brand),catalog(brand))).brand,brand);
 }
 await f.db.query('UPDATE shrigma_template_key_v2 SET active=false');assert.equal(await f.auth(LEGACY_KEY),null);assert.ok(await f.auth(MASTER_KEY));
 await f.db.query('UPDATE crm_dash_chave SET revogada_em=clock_timestamp() WHERE chave=$1',[MASTER_ID]);assert.equal(await f.auth(MASTER_KEY),null);
});

test('the existing exact READ principal stays readable but never obtains a writer effect; a shared legacy alias cannot erase WRITER brand',async t=>{
 const f=await setup(t),readKey='synthetic-original-read-only-key',readId='synthetic-original-reader';
 await f.db.query("INSERT INTO crm_dash_chave(chave,painel,dono,chave_hash) VALUES($1,'growth','reader@example.test',$2)",[readId,sha(readKey)]);
 await f.db.query("INSERT INTO shrigma_panel_permission_v1 VALUES($1,'growth',$2::jsonb)",[readId,JSON.stringify(['read_content','list_history','submission'])]);
 assert.deepEqual(await f.auth(readKey),{actor:'panel:'+readId,caps:['read_content','list_history','submission']});
 assert.equal((await f.effect(readKey,command('campanha_catalogo'),catalog('fish'))).brand,'fish');
 await assert.rejects(f.effect(readKey,command('campanha_salvar'),{kind:'store',action:'claim',payload:{}}),/CRM_CAMPAIGN_GATEWAY_FORBIDDEN/);
 assert.equal(await f.count('shrigma_campaign_operation'),0);
 await f.activate();
 await f.db.query('INSERT INTO shrigma_template_key_v2 VALUES($1,true,$2,$3::jsonb)',[sha(KEY),'panel:'+f.q.principalId,JSON.stringify(CAPS)]);
 assert.equal((await f.auth()).brand,'fish');
 await f.db.query('UPDATE crm_manager_writer_issuer_v1 SET active=false');assert.equal(await f.auth(),null);
});

test('own manager and both-brand Master CREATE traverse real SQL/native guard and durable same-key replay',async t=>{
 const f=await setup(t);await f.activate();let creates=0,previews=0;
 const native=async effect=>{
  if(effect.kind==='preview'){previews++;return {status:200,body:'Synthetic compiler output'};}
  assert.equal(effect.kind,'nativeCreate');const p=effect.payload,id=800+(creates++);
  // Native Listmonk CREATE uses a single transaction for its draft and initial
  // relations. Retain that boundary so the existing relation guard is exercised.
  await f.db.transaction(async tx=>{
   await tx.query(`INSERT INTO campaigns(id,name,subject,from_email,body,altbody,body_source,content_type,send_at,headers,status,tags,type,messenger,template_id,sent,started_at,attribs)
    VALUES($1,$2,$3,$4,$5,$6,NULL,'html',NULL,$7::jsonb,'draft',$8::varchar[],'regular','email',$9,0,NULL,$10::jsonb)`,[id,p.name,p.subject,p.from_email,p.body,p.altbody,JSON.stringify(p.headers),p.tags,p.template_id,JSON.stringify(p.attribs)]);
   for(const listId of p.lists)await tx.query('INSERT INTO campaign_lists(campaign_id,list_id,list_name) SELECT $1,id,name FROM lists WHERE id=$2',[id,listId]);
  });
  return {status:201,body:{data:{id}}};
 };
 const failures=[],pool={query:async(sql,args)=>{try{return await f.api(sql,args);}catch(e){const value=args?.[2]&&JSON.parse(args[2]);failures.push({kind:value?.kind,action:value?.action,code:e.code,message:e.message});throw e;}}};
 const execute=Transport.createExecutor({pool,native:async value=>{try{return await native(value);}catch(e){failures.push({kind:value.kind,code:e.code,message:e.message});throw e;}}});
 for(const [key,brand]of [[KEY,'fish'],[MASTER_KEY,'fish'],[MASTER_KEY,'aristo']]){
  const cmd=command('campanha_salvar',brand,{definition:definition(brand),idempotency_key:'writer-brand-save-'+(++serial)}),result=await execute({key,command:cmd});
  assert.equal(result.status,201,JSON.stringify({result,failures,creates,previews}));assert.equal(result.body.campaign.definition.brand,brand);assert.equal(result.body.campaign.status,'draft');assert.equal(result.body.campaign.sent,0);
  const count=creates;assert.deepEqual(await execute({key,command:cmd}),result);assert.equal(creates,count);
 }
 assert.equal(creates,3);assert.equal(previews,9);
});

test('legacy media and Master list/upload remain usable; manager media cannot cross bound brand',async t=>{
 const f=await setup(t);await f.activate();let lists=0,uploads=0;
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1sAAAAASUVORK5CYII=','base64'),hash=sha(bytes),operation='e1111111-1234-4234-8234-123456789abc';
 const item=filename=>({id:1,filename,url:'https://synthetic.example.test/uploads/'+filename,content_type:'image/png',meta:{width:1,height:1}});
 const native={origin:'https://synthetic.example.test',list:async()=>{lists++;return {status:200,body:{data:{results:[item('unattributed-legacy.png')],page:1,per_page:24,total:1}}};},upload:async p=>{uploads++;return {status:201,body:{data:item(p.filename)}};}};
 const execute=Media.createMediaExecutor({pool:f.pool,native});
 for(const key of [MASTER_KEY,LEGACY_KEY])for(const brand of ['fish','aristo']){
  const listed=await execute({key,method:'GET',input:{brand,page:1,per_page:24}});assert.equal(listed.status,200);assert.equal(listed.body.items[0].filename,'unattributed-legacy.png');
  assert.equal((await execute({key,method:'POST',input:{brand,bytes,sha256:hash,operation_id:operation,content_type:'image/png'}})).status,201);
 }
 assert.equal(uploads,4);
 const before=lists;const crossed=await execute({key:KEY,method:'GET',input:{brand:'aristo',page:1,per_page:24}});assert.equal(crossed.status,403);assert.equal(crossed.body.error,'BRAND_DENIED');assert.equal(lists,before);
 const own=await execute({key:KEY,method:'GET',input:{brand:'fish',page:1,per_page:24}});assert.equal(own.status,200);assert.equal(own.body.items[0].filename,'unattributed-legacy.png');
 const noEdit=await execute({key:KEY,method:'POST',input:{brand:'fish',bytes,sha256:hash,operation_id:operation,content_type:'image/png'}});assert.equal(noEdit.status,403);assert.equal(noEdit.body.error,'CAPABILITY_MISSING');assert.equal(uploads,4);
});
