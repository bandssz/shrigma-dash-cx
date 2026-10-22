'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8'),hash=s=>createHash('sha256').update(s).digest('hex');

async function setup(){
 const db=new PGlite();
 await db.exec(`CREATE TABLE crm_dash_chave(chave text PRIMARY KEY,painel text NOT NULL,dono text,ativo boolean DEFAULT true,revogada_em timestamptz,ultimo_uso timestamptz,usos integer DEFAULT 0);
  CREATE TABLE shrigma_template_key_v2(key_hash text,active boolean,actor text,capabilities jsonb);`);
 for(const f of ['n8n/access/panel-auth.sql','n8n/access/panel-operator.sql','n8n/access/panel-short-keys.sql','tests/campaign-provider-schema.sql','n8n/growth/campaign-store.sql','n8n/growth/campaign-recovery.sql','n8n/growth/campaign-template-ownership.sql','n8n/growth/campaign-provider.sql'])await db.exec(read(f));
 await db.query('INSERT INTO crm_dash_chave(chave,painel,dono,chave_hash,chave_hash_curta) VALUES($1,\'todos\',\'Manager\',$2,$3)',
  ['synthetic-manager-id',hash('synthetic-manager-key'),hash('synthetic-short-key')]);
 await db.query("INSERT INTO shrigma_panel_permission_v1 VALUES('synthetic-manager-id','growth',$1::jsonb)",[JSON.stringify(['read_content','draft','validate','submit'])]);
 const migration=read('n8n/growth/crm-campaign-gateway-role.sql');
 assert.match(migration,/6f15c1643c303c8c1eee99f57bc65c66/,'production auth pin remains explicit');
 await db.exec(migration);
 return db;
}
const auth=(db,key='synthetic-manager-key')=>db.query('SELECT public.shrigma_crm_campaign_auth_v1($1) a',[key]).then(r=>r.rows[0].a);
const effect=(db,key,envelope,value)=>db.query('SELECT public.shrigma_crm_campaign_effect_v1($1,$2::jsonb,$3::jsonb) result',[key,JSON.stringify(envelope),JSON.stringify(value)]).then(r=>r.rows[0].result);
const command=(acao,extra={})=>({acao,brand:'fish',...extra});
const envelope=(command,operation=null)=>({command,actor:'panel:synthetic-manager-id',operation});

test('gateway role authenticates current operator and restricts direct database access',async t=>{
 const db=await setup();t.after(()=>db.close());
 assert.deepEqual(await auth(db),{actor:'panel:synthetic-manager-id',caps:['read_content','draft','validate','submit']});
 assert.equal(await auth(db,'wrong-key'),null);assert.equal((await auth(db,'synthetic-short-key')).actor,'panel:synthetic-manager-id');
 await db.exec('SET ROLE crm_campaign_api');
 for(const cmd of [{brand:'fish'},{acao:'campanha_catalogo'},{acao:null,brand:'fish'}])await assert.rejects(effect(db,'synthetic-manager-key',envelope(cmd),{kind:'provider',action:'catalog',payload:{brand:'fish'}}),/CRM_CAMPAIGN_GATEWAY_COMMAND/);
 await assert.rejects(effect(db,'synthetic-manager-key',envelope(command('campanha_catalogo')),{kind:null,payload:{}}),/CRM_CAMPAIGN_GATEWAY_EFFECT/);
 for(const sql of ['SELECT * FROM campaigns','SELECT * FROM shrigma_campaign_operation','SELECT public.shrigma_campaign_store(\'get\',\'{}\'::jsonb)',"SELECT public.shrigma_crm_operator_auth_v1('synthetic-manager-key')","UPDATE campaigns SET subject='x' WHERE id=100","GRANT SELECT ON campaigns TO crm_campaign_api"])
  await assert.rejects(db.query(sql),e=>e.code==='42501',sql);
 await db.exec('RESET ROLE');
 const role=(await db.query("SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls,rolconnlimit FROM pg_roles WHERE rolname='crm_campaign_api'")).rows[0];
 assert.deepEqual(role,{rolcanlogin:false,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolinherit:false,rolreplication:false,rolbypassrls:false,rolconnlimit:4});
});

test('fixed read effects preserve brand scope and fresh revocation',async t=>{
 const db=await setup();t.after(()=>db.close());
 await db.exec('SET ROLE crm_campaign_api');
 const catalog=await effect(db,'synthetic-manager-key',envelope(command('campanha_catalogo')),{kind:'provider',action:'catalog',payload:{brand:'fish'}});
 assert.equal(catalog.brand,'fish');assert.equal(catalog.current,true);
 const current=await effect(db,'synthetic-manager-key',envelope(command('campanha_obter',{id:100})),{kind:'provider',action:'get',payload:{id:100}});
 assert.equal(current.id,100);assert.equal(current.definition.brand,'fish');
 await assert.rejects(effect(db,'synthetic-manager-key',envelope(command('campanha_obter',{id:200})),{kind:'provider',action:'get',payload:{id:200}}),/CRM_CAMPAIGN_GATEWAY_SCOPE/);
 await db.exec('RESET ROLE');await db.query("UPDATE crm_dash_chave SET revogada_em=clock_timestamp() WHERE chave='synthetic-manager-id'");await db.exec('SET ROLE crm_campaign_api');
 await assert.rejects(effect(db,'synthetic-manager-key',envelope(command('campanha_catalogo')),{kind:'provider',action:'catalog',payload:{brand:'fish'}}),/CRM_CAMPAIGN_GATEWAY_UNAUTHORIZED/);
 await db.exec('RESET ROLE');
});

test('claim binds actor, operation and guarded native effects without performing HTTP',async t=>{
 const db=await setup();t.after(()=>db.close());const definition={schema_version:'crm-campaign-v1',brand:'fish',channel:'email',template_id:1,list_ids:[3]};
 const cmd=command('campanha_salvar',{definition,idempotency_key:'gateway-save-operation-001'}),base=envelope(cmd);
 await db.exec('SET ROLE crm_campaign_api');
 const claim=await effect(db,'synthetic-manager-key',base,{kind:'store',action:'claim',payload:{actor:base.actor,key:cmd.idempotency_key,hash:'a'.repeat(64),brand:'fish',action:'salvar'}});
 assert.equal(claim.acquired,true);const op={id:claim.id,lease:claim.lease};
 await assert.rejects(effect(db,'synthetic-manager-key',envelope(cmd,op),{kind:'store',action:'validation_invalidate',payload:{providerId:100}}),/CRM_CAMPAIGN_GATEWAY_PROVIDER/);
 const native={name:'Draft',subject:'Subject',from_email:'contato@fishermans.com.br',body:'<p>Body</p>',altbody:'Body',body_source:null,send_at:null,headers:[{'Reply-To':'contato@fishermans.com.br'}],lists:[3],template_id:1,tags:[],type:'regular',content_type:'html',messenger:'email',attribs:{crm:{policy:'crm-campaign-v1',brand:'fish',created_operation_id:claim.id}}};
 const guard=await effect(db,'synthetic-manager-key',envelope(cmd,op),{kind:'nativeCreate',payload:native});assert.equal(guard.ok,true);assert.equal(guard.operation_id,claim.id);
 await assert.rejects(effect(db,'synthetic-manager-key',envelope(cmd,op),{kind:'nativeCreate',payload:{...native,send_at:new Date().toISOString()}}),/CRM_CAMPAIGN_GATEWAY_NATIVE_CREATE/);
 await assert.rejects(effect(db,'synthetic-manager-key',base,{kind:'store',action:'validation_invalidate',payload:{providerId:100}}),/CRM_CAMPAIGN_GATEWAY_OPERATION/);
 await db.exec('RESET ROLE');
 assert.equal(Number((await db.query('SELECT count(*) n FROM campaigns WHERE id>200')).rows[0].n),0,'guard performs no native create');
 await db.query(`INSERT INTO campaigns(id,name,subject,from_email,body,altbody,body_source,content_type,send_at,headers,status,tags,type,messenger,template_id,sent,attribs)
  VALUES(300,'Draft','Subject','contato@fishermans.com.br','<p>Body</p>','Body',NULL,'html',NULL,'[]','draft','{}','regular','email',1,0,$1::jsonb)`,[JSON.stringify(native.attribs)]);
 await db.query("INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES(300,3,'Fish')");
 await db.exec('SET ROLE crm_campaign_api');
 await assert.rejects(effect(db,'synthetic-manager-key',envelope(cmd,op),{kind:'store',action:'provider',payload:{id:claim.id,lease:claim.lease,providerId:200}}),/CRM_CAMPAIGN_GATEWAY_PROVIDER/);
 await effect(db,'synthetic-manager-key',envelope(cmd,op),{kind:'store',action:'provider',payload:{id:claim.id,lease:claim.lease,providerId:300}});
 for(const body of ['<p>Body</p>','Subject','Body']){const preview=await effect(db,'synthetic-manager-key',envelope(cmd,op),{kind:'preview',idCampaign:300,payload:{content_type:'html',template_id:'1',body}});assert.equal(preview.campaign_id,300);}
 await assert.rejects(effect(db,'synthetic-manager-key',envelope(cmd,op),{kind:'preview',idCampaign:200,payload:{content_type:'html',template_id:'1',body:'x'}}),/CRM_CAMPAIGN_GATEWAY_PREVIEW/);
 await db.exec('RESET ROLE');
});

test('existing draft preview works without provider_id while wrong actor, lease and capability fail closed',async t=>{
 const db=await setup();t.after(()=>db.close());const definition={schema_version:'crm-campaign-v1',brand:'fish',channel:'email',template_id:1,list_ids:[3]};
 const cmd=command('campanha_salvar',{id:100,definition,idempotency_key:'gateway-edit-operation-001'}),base=envelope(cmd);
 await db.exec('SET ROLE crm_campaign_api');
 const claim=await effect(db,'synthetic-manager-key',base,{kind:'store',action:'claim',payload:{actor:base.actor,key:cmd.idempotency_key,hash:'b'.repeat(64),brand:'fish',action:'salvar'}}),op={id:claim.id,lease:claim.lease};
 assert.equal((await effect(db,'synthetic-manager-key',envelope(cmd,op),{kind:'preview',idCampaign:100,payload:{content_type:'html',template_id:'1',body:'Subject'}})).ok,true);
 await assert.rejects(effect(db,'synthetic-manager-key',envelope(cmd,op),{kind:'provider',action:'update',payload:{id:100,expectedVersion:'wrong',operationId:claim.id,definition,templateVersion:'x',contentValidated:true}}),/CRM_CAMPAIGN_GATEWAY_SCOPE/);
 await assert.rejects(effect(db,'synthetic-manager-key',{...envelope(cmd,op),actor:'panel:other'}, {kind:'preview',idCampaign:100,payload:{content_type:'html',template_id:'1',body:'Subject'}}),/CRM_CAMPAIGN_GATEWAY_ENVELOPE/);
 await assert.rejects(effect(db,'synthetic-manager-key',envelope(cmd,{...op,lease:'00000000-0000-4000-8000-000000000001'}),{kind:'preview',idCampaign:100,payload:{content_type:'html',template_id:'1',body:'Subject'}}),/CRM_CAMPAIGN_GATEWAY_OPERATION/);
 await db.exec('RESET ROLE');await db.query("UPDATE shrigma_panel_permission_v1 SET caps='[\"read_content\"]' WHERE principal_id='synthetic-manager-id' AND area='growth'");await db.exec('SET ROLE crm_campaign_api');
 await assert.rejects(effect(db,'synthetic-manager-key',envelope(cmd,op),{kind:'preview',idCampaign:100,payload:{content_type:'html',template_id:'1',body:'Subject'}}),/CRM_CAMPAIGN_GATEWAY_FORBIDDEN/);
 await db.exec('RESET ROLE');
});
