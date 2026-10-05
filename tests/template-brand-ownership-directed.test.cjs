'use strict';
// Disposable PGlite only. Reuses the EfC campaign-provider schema and real
// provider/store/service; native CREATE/compiler are synthetic, with no HTTP.
// Does not claim PostgreSQL multi-session or TABLE SHARE concurrency evidence.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const root=path.resolve(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const {createService}=require('../n8n/growth/campaign-service.js');
const {createStore}=require('../n8n/growth/campaign-store.js');
const {createProvider}=require('../n8n/growth/campaign-provider.js');
async function setup(t,{firstMapping='owned',stateDependencies=false}={}){
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(read('tests/campaign-provider-schema.sql'));
 // Extend the original disposable fixture with invalid and unused ownership mappings.
 await db.exec(`ALTER TABLE public.shrigma_template_email_registry ADD COLUMN draft_id text;
  UPDATE shrigma_template_email_registry SET draft_id='synthetic-existing';
  INSERT INTO templates(id,name,type,body) VALUES
   (4,'Synthetic unregistered','campaign','{{ template "content" . }}'),
   (5,'Synthetic ambiguous','campaign','{{ template "content" . }}'),
   (6,'Synthetic NULL scope','campaign','{{ template "content" . }}'),
   (7,'Synthetic repeated same brand','campaign','{{ template "content" . }}'),
   (8,'Synthetic registered TX','tx','body'),(9,'Synthetic unused','campaign','wrapper');
  INSERT INTO shrigma_template_email_registry VALUES
   (5,'fish','draft-multi-fish'),(5,'aristo','draft-multi-aristo'),
   (6,'fish','draft-null-fish'),(6,NULL,'draft-null-other'),
   (7,'fish','draft-repeat-a'),(7,'fish','draft-repeat-b'),
   (8,'fish','draft-tx'),(9,'fish','draft-unused');`);
 if(firstMapping!=='owned'){
  await db.exec('DELETE FROM shrigma_template_email_registry WHERE template_id=1');
  if(firstMapping==='foreign')await db.exec("INSERT INTO shrigma_template_email_registry VALUES(1,'aristo','draft-foreign')");
  if(firstMapping==='ambiguous')await db.exec("INSERT INTO shrigma_template_email_registry VALUES(1,'fish','draft-fish'),(1,'aristo','draft-foreign')");
  if(firstMapping==='null')await db.exec("INSERT INTO shrigma_template_email_registry VALUES(1,'fish','draft-fish'),(1,NULL,'draft-null')");
 }
 if(stateDependencies){
  for(const [index,status]of ['draft','scheduled','running','paused','finished','cancelled'].entries()){
   const tid=10+index,id=600+index;
   await db.query("INSERT INTO templates(id,name,type,body) VALUES($1,'Synthetic frozen dependency','campaign','wrapper')",[tid]);
   await db.query("INSERT INTO shrigma_template_email_registry VALUES($1,'fish','draft-frozen')",[tid]);
   await db.query(`INSERT INTO campaigns SELECT $1,name,subject,from_email,body,altbody,body_source,content_type,send_at,headers,$2,tags,type,messenger,$3,sent,started_at,updated_at,attribs,archive FROM campaigns WHERE id=100`,[id,status,tid]);
  }
 }
 await db.exec(read('n8n/growth/campaign-store.sql'));
 for(const name of ['campaign-template-ownership.sql','campaign-provider.sql','campaign-write-guard.sql'])await db.exec(read('n8n/growth/'+name));
 let seq=0;
 const one=async(sql,p=[])=>(await db.query(sql,p)).rows[0];
 const current=async(id=100)=>(await one('SELECT public.shrigma_campaign_current($1) AS c',[id])).c;
 const provider=async(action,p)=>(await one('SELECT public.shrigma_campaign_provider($1::text,$2::jsonb) AS r',[action,JSON.stringify(p)])).r;
 const claim=async(action='salvar',brand='fish')=>(await one("SELECT public.shrigma_campaign_store('claim',$1::jsonb) AS o",[JSON.stringify({actor:'synthetic-template-owner',key:'template-owned-attempt-'+(++seq),hash:'a'.repeat(64),brand,action})])).o;
 return {db,one,current,provider,claim};
}
const attrs=brand=>({crm:{policy:'crm-campaign-v1',brand,initiative_key:'synthetic',initiative_name:'Synthetic',utm_campaign:'synthetic'}});
const nativeSQL=`INSERT INTO campaigns(id,name,subject,from_email,body,altbody,content_type,headers,status,tags,type,messenger,template_id,sent,attribs,send_at)
 VALUES($1,'Synthetic native draft','Synthetic subject',$2,'<p>Synthetic</p>','Synthetic','html','[]','draft','{}','regular','email',$3,0,$4::jsonb,NULL)`;
const nativeInsert=(db,id,tid,brand)=>db.query(nativeSQL,[id,'contato@'+(brand==='fish'?'fishermans.com.br':'oaristocrata.com'),tid,JSON.stringify(attrs(brand))]);
const scopeError=e=>e.code==='P0001'&&e.message==='TEMPLATE_SCOPE';
const dependencyError=e=>e.code==='P0001'&&e.message==='CAMPAIGN_DEPENDENCY_IN_USE';

test('catalog exposes only exclusively registered campaign templates of the requested brand',async t=>{
 const f=await setup(t);
 for(const [brand,ids]of [['fish',[1,7,9]],['aristo',[3]]]){
  const c=(await f.one('SELECT shrigma_campaign_catalog($1) AS c',[brand])).c;
  assert.deepEqual(c.templates.map(x=>x.id),ids);assert.ok(c.templates.every(x=>x.brand===brand&&x.type==='campaign'));
  assert.equal(c.template_ownership_contract,'crm-campaign-template-brand-v1');
 }
 assert.equal((await f.one("SELECT shrigma_campaign_catalog('olivas') AS c")).c,null);
});

test('native INSERT admits owned wrappers and atomically rejects foreign/missing/ambiguous/NULL/TX',async t=>{
 const f=await setup(t);await nativeInsert(f.db,1000,1,'fish');await nativeInsert(f.db,1001,3,'aristo');
 for(const [index,tid]of [3,4,5,6,8].entries()){
  await assert.rejects(nativeInsert(f.db,1100+index,tid,'fish'),scopeError);
  assert.equal((await f.one('SELECT count(*)::int AS n FROM campaigns WHERE id=$1',[1100+index])).n,0);
 }
 assert.equal((await f.current(1000)).status,'draft');assert.equal((await f.current(1001)).sent,0);
});

test('real provider UPDATE denies every invalid template scope without changing campaign or validation',async t=>{
 const f=await setup(t),before=await f.current();
 for(const tid of [3,4,5,6,8]){
  const op=await f.claim(),templateVersion=(await f.one('SELECT md5(to_jsonb(t)::text) AS v FROM templates t WHERE id=$1',[tid])).v;
  await assert.rejects(f.provider('update',{id:100,operationId:op.id,expectedVersion:before.version,definition:{...before.definition,template_id:tid,name:'Rejected update'},templateVersion,contentValidated:true}),scopeError);
  assert.deepEqual(await f.current(),before);
 }
 assert.equal((await f.one('SELECT count(*)::int AS n FROM shrigma_campaign_validation')).n,0);
});

test('real provider REVIEW and SCHEDULE refuse legacy draft mapping drift before recording review or scheduling',async t=>{
 for(const firstMapping of ['missing','foreign','ambiguous','null']){
  const f=await setup(t,{firstMapping}),c=await f.current();
  for(const [action,claimAction]of [['review','validar'],['schedule','agendar']]){
   const op=await f.claim(claimAction);
   await assert.rejects(f.provider(action,{id:100,operationId:op.id,expectedVersion:c.version}),scopeError);
   assert.deepEqual(await f.current(),c);
  }
  assert.equal((await f.one('SELECT count(*)::int AS n FROM shrigma_campaign_validation')).n,0);
 }
});

test('owned create/save/review/schedule uses real SQL and same-key journal replay creates no second draft',async t=>{
 const f=await setup(t);let creations=0;
 const query=(sql,p)=>f.db.query(sql,p);
 const provider=createProvider({query,validateContent:async({templateVersion})=>({ok:true,templateVersion}),nativeCreate:async p=>{
  const id=1300+(creations++);
  await f.db.transaction(async tx=>{
   await tx.query(`INSERT INTO campaigns(id,name,subject,from_email,body,altbody,content_type,headers,status,tags,type,messenger,template_id,sent,attribs)
    VALUES($1,$2,$3,$4,$5,$6,'html',$7::jsonb,'draft','{}','regular','email',$8,0,$9::jsonb)`,[id,p.name,p.subject,p.from_email,p.body,p.altbody,JSON.stringify(p.headers),p.template_id,JSON.stringify(p.attribs)]);
   for(const listId of p.lists)await tx.query('INSERT INTO campaign_lists(campaign_id,list_id,list_name) SELECT $1,id,name FROM lists WHERE id=$2',[id,listId]);
  });return {id};
 }});
 const service=createService({store:createStore({query}),provider});
 const auth={actor:'synthetic-pipeline',caps:['read_content','draft','validate','submit']};
 const definition={schema_version:'crm-campaign-v1',brand:'fish',channel:'email',initiative:{key:'owned-proof',name:'Owned proof'},utm_campaign:'owned-proof',name:'Synthetic owned pipeline',subject:'Synthetic subject',from_email:'contato@fishermans.com.br',reply_to:'contato@fishermans.com.br',list_ids:[3],template_id:1,html:'<a href="https://fishermans.com.br/products/synthetic">Synthetic</a>{{ UnsubscribeURL }}',text:'https://fishermans.com.br/products/synthetic {{ UnsubscribeURL }}',tags:[],send_at:new Date(Date.now()+86400000).toISOString()};
 const save={acao:'campanha_salvar',brand:'fish',definition,idempotency_key:'owned-pipeline-save-0001'};
 const saved=await service.handle(auth,save);assert.equal(saved.status,201,JSON.stringify(saved));assert.equal(creations,1);
 assert.deepEqual(await service.handle(auth,save),saved);assert.equal(creations,1);
 const {id,version}=saved.body.campaign;
 const reviewed=await service.handle(auth,{acao:'campanha_validar',brand:'fish',id,expected_version:version,idempotency_key:'owned-pipeline-review-001'});
 assert.equal(reviewed.status,200,JSON.stringify(reviewed));
 const schedule={acao:'campanha_agendar',brand:'fish',id,expected_version:version,confirm:'agendar',audience_review_id:reviewed.body.validation.audience.review_id,idempotency_key:'owned-pipeline-schedule-1'};
 const scheduled=await service.handle(auth,schedule);assert.equal(scheduled.status,200,JSON.stringify(scheduled));assert.equal(scheduled.body.campaign.status,'scheduled');
 assert.deepEqual(await service.handle(auth,schedule),scheduled);
 assert.equal((await f.current(id)).sent,0);assert.equal(creations,1);
 assert.equal((await f.one("SELECT count(*)::int AS n FROM shrigma_campaign_operation WHERE actor='synthetic-pipeline'")).n,3);
});

test('registry mapping is frozen for every managed campaign state; unchanged mapping metadata and unused mapping remain writable',async t=>{
 const f=await setup(t,{stateDependencies:true});
 for(let tid=10;tid<=15;tid++){
  await assert.rejects(f.db.query("UPDATE shrigma_template_email_registry SET brand='aristo' WHERE template_id=$1",[tid]),dependencyError);
  await assert.rejects(f.db.query('DELETE FROM shrigma_template_email_registry WHERE template_id=$1',[tid]),dependencyError);
  await assert.rejects(f.db.query("INSERT INTO shrigma_template_email_registry VALUES($1,'aristo','synthetic-conflict')",[tid]),dependencyError);
  await assert.rejects(f.db.query('UPDATE shrigma_template_email_registry SET template_id=4 WHERE template_id=$1',[tid]),dependencyError);
  await f.db.query("UPDATE shrigma_template_email_registry SET draft_id='synthetic-metadata-only' WHERE template_id=$1",[tid]);
 }
 await assert.rejects(f.db.exec("UPDATE shrigma_template_email_registry SET template_id=10 WHERE template_id=9"),dependencyError);
 await assert.rejects(f.db.exec('TRUNCATE shrigma_template_email_registry'),dependencyError);
 await f.db.exec("UPDATE shrigma_template_email_registry SET brand='aristo' WHERE template_id=9");
 assert.equal((await f.one("SELECT count(*)::int AS n FROM shrigma_template_email_registry WHERE template_id BETWEEN 10 AND 15 AND brand='fish' AND draft_id='synthetic-metadata-only'")).n,6);
});

test('native ownership trigger works without a new registry SELECT or helper EXECUTE grant to the native role',async t=>{
 const f=await setup(t);
 await f.db.exec(`CREATE ROLE synthetic_native_template_role NOLOGIN;
  GRANT INSERT ON public.campaigns TO synthetic_native_template_role;
  GRANT EXECUTE ON FUNCTION public.shrigma_campaign_is_managed(public.campaigns) TO synthetic_native_template_role;`);
 const access=await f.one("SELECT has_table_privilege('synthetic_native_template_role','public.shrigma_template_email_registry','SELECT') AS registry_select");
 assert.equal(access.registry_select,false);
 await f.db.exec('SET ROLE synthetic_native_template_role');
 try{await nativeInsert(f.db,1500,1,'fish');await assert.rejects(nativeInsert(f.db,1501,3,'fish'),scopeError);}
 finally{await f.db.exec('RESET ROLE');}
 assert.equal((await f.current(1500)).status,'draft');
});
