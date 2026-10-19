'use strict';
// Synthetic facts + installed SQL bodies on isolated PG17.10. The HTTP handler
// uses independent CTE ordering as v6.1; it is not a binary/production proof.
const fs=require('node:fs'),http=require('node:http'),crypto=require('node:crypto'),a=require('node:assert/strict');
const {Client,Pool}=require('./pg-driver.cjs');
const {setup,Source}=require('/freeze/local17-current-source-fixture.cjs');
const {createTransaction}=require('/current-source/services/crm-audience/transaction.cjs');
const {createInternalFreeze,digest,ACTION}=require('/freeze/freeze-internal17.cjs');
const T=require('./campaign-candidate/services/crm-campaign/transport.cjs');
const sql=p=>fs.readFileSync('/source/'+p,'utf8');
const resources=[];async function closeAll(){for(const close of resources.splice(0).reverse())await close();}
async function createFixture(database){
 if(!/^native17_test\d+$/.test(database||''))throw Error('ISOLATED_DATABASE_REQUIRED');
 const admin=new Client({host:'127.0.0.1',user:'postgres',database});await admin.connect();resources.push(()=>admin.end());a.match((await admin.query('SHOW server_version')).rows[0].server_version,/^17\.10/);
 const sourcePool=new Pool({host:'127.0.0.1',user:'crm_audience_api',database,max:3}),transaction=createTransaction({pool:sourcePool,statementTimeoutMs:8000}),entries=await setup(admin,transaction);
 resources.push(()=>sourcePool.end());
 await admin.query(`ALTER TABLE public.lists ALTER COLUMN tags TYPE varchar(100)[];
 ALTER TABLE public.campaigns ADD COLUMN uuid uuid DEFAULT gen_random_uuid(),ADD COLUMN created_at timestamptz DEFAULT clock_timestamp(),ADD COLUMN name text,ADD COLUMN subject text,ADD COLUMN from_email text,ADD COLUMN body text,ADD COLUMN altbody text,ADD COLUMN body_source text,ADD COLUMN content_type text DEFAULT 'html',ADD COLUMN send_at timestamptz,ADD COLUMN headers jsonb DEFAULT '[]',ADD COLUMN status text DEFAULT 'draft',ADD COLUMN tags varchar(100)[],ADD COLUMN template_id integer,ADD COLUMN sent integer DEFAULT 0,ADD COLUMN to_send integer DEFAULT 0,ADD COLUMN last_subscriber_id integer DEFAULT 0,ADD COLUMN max_subscriber_id integer DEFAULT 0,ADD COLUMN started_at timestamptz,ADD COLUMN updated_at timestamptz DEFAULT clock_timestamp(),ADD COLUMN archive boolean DEFAULT false;
 CREATE SEQUENCE qa_campaign_id START 501;
 CREATE TABLE public.templates(id integer PRIMARY KEY,name text,type text,body text,updated_at timestamptz DEFAULT clock_timestamp());
 CREATE TABLE public.shrigma_template_email_registry(template_id integer,brand text);
 CREATE TABLE public.campaign_lists(id bigserial PRIMARY KEY,campaign_id integer,list_id integer,list_name text NOT NULL DEFAULT '',UNIQUE(campaign_id,list_id));
 CREATE TABLE public.media(id integer PRIMARY KEY,filename text);
 CREATE TABLE public.campaign_media(campaign_id integer,media_id integer,filename text,UNIQUE(campaign_id,media_id));
 CREATE TABLE public.crm_familia_campanha(marca text,utm_campaign text,familia text,criado_em timestamptz DEFAULT clock_timestamp(),PRIMARY KEY(marca,utm_campaign));
 INSERT INTO public.templates VALUES(1,'Synthetic Fish','campaign','{{ template "content" . }}'),(3,'Synthetic Aristo','campaign','{{ template "content" . }}');
 INSERT INTO public.shrigma_template_email_registry VALUES(1,'fish'),(3,'aristo');
 CREATE TABLE public.crm_dash_chave(chave text PRIMARY KEY,painel text NOT NULL,dono text,ativo boolean DEFAULT true,revogada_em timestamptz,ultimo_uso timestamptz,usos integer DEFAULT 0);
 CREATE TABLE public.shrigma_template_key_v2(key_hash text,active boolean,actor text,capabilities jsonb);
 DO $role$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='crm_campaign_api') THEN CREATE ROLE crm_campaign_api LOGIN;END IF;END $role$;`);
 for(const p of ['n8n/access/panel-auth.sql','n8n/access/panel-operator.sql','n8n/access/panel-short-keys.sql','n8n/growth/campaign-store.sql','n8n/growth/campaign-recovery.sql','n8n/growth/campaign-template-ownership.sql','n8n/growth/campaign-provider.sql','n8n/growth/campaign-write-guard.sql'])await admin.query(sql(p));
 const custody=JSON.parse(fs.readFileSync('/custody/custody.json','utf8'));
 for(const f of custody.functions.filter(f=>f.requested.startsWith('public.'))){await admin.query(f.definition);await admin.query('REVOKE ALL ON FUNCTION '+f.requested+' FROM PUBLIC,crm_campaign_api,crm_audience_api');if(f.acl?.includes('crm_campaign_api=X/'))await admin.query('GRANT EXECUTE ON FUNCTION '+f.requested+' TO crm_campaign_api');if(f.acl?.includes('crm_audience_api=X/'))await admin.query('GRANT EXECUTE ON FUNCTION '+f.requested+' TO crm_audience_api');}
 await admin.query("INSERT INTO public.crm_dash_chave(chave,painel,dono,chave_hash,expira_em) VALUES('synthetic-native-owner','growth','QA synthetic',$1,clock_timestamp()+interval '1 hour')",[crypto.createHash('sha256').update('synthetic-native-owner').digest('hex')]);
 await admin.query("INSERT INTO public.shrigma_panel_permission_v1 VALUES('synthetic-native-owner','growth','[\"read_content\",\"draft\",\"validate\",\"submit\"]')");
 await admin.query(fs.readFileSync(__dirname+'/catalog-snapshot-original.sql','utf8'));await admin.query('REVOKE ALL ON FUNCTION crm_audience_v2.catalog_lists(text) FROM PUBLIC;GRANT EXECUTE ON FUNCTION crm_audience_v2.catalog_lists(text) TO crm_audience_api');await admin.query(fs.readFileSync(__dirname+'/catalog-snapshot-fix.prepared.sql','utf8'));
 for(const brand of ['aristo','fish']){const e=entries[brand],id=brand==='aristo'?'23b3132a-a00b-41d3-ac31-0216a37f6100':'6b034a75-a02f-4a0e-9b18-43c4be87881b',definition={schema_version:'crm-audience-v2',brand,name:'[QA SAB17] Agenda nativa '+brand,rule:{op:'in_list',list_id:brand==='aristo'?176:175}},current=await transaction(async tx=>{await tx.query(Source.SQL.setup);return Source.readCatalog(tx.query,brand);}),context=Source.pins(definition,current);await admin.query('UPDATE crm_audience_v2.audience SET id=$2,name=$3,definition=$4,definition_hash=$5,context=$6,context_hash=$7 WHERE id=$1',[e.id,id,definition.name,definition,digest(definition),context,digest(context)]);entries[brand]={id,definition,context};}
 await admin.query(fs.readFileSync(__dirname+'/native-transition-install.prepared.sql','utf8'));
 const nativePool=new Pool({host:'127.0.0.1',user:'postgres',database,max:4}),effectPool=new Pool({host:'127.0.0.1',user:'crm_campaign_api',database,max:4});resources.push(()=>nativePool.end(),()=>effectPool.end());let apiOrigin;
 const events=[];let statusHook=null,afterCommitHook=null,beforeCommitHook=null,abortStatusMs=0,clearOrder='independent',clearFault='none';
 const effectQuery=effectPool.query.bind(effectPool);effectPool.query=async(text,args)=>{try{return await effectQuery(text,args);}catch(e){let descriptor;try{descriptor=JSON.parse(args?.[2]||'null');}catch{}events.push({sqlstate:e.code,error:e.message,kind:descriptor?.kind,action:descriptor?.action});throw e;}};
 async function currentNative(id){const c=(await nativePool.query('SELECT * FROM public.campaigns WHERE id=$1',[id])).rows[0];if(!c)return null;const lists=(await nativePool.query('SELECT l.id,l.name FROM public.campaign_lists cl JOIN public.lists l ON l.id=cl.list_id WHERE cl.campaign_id=$1 ORDER BY l.id',[id])).rows;return{...c,lists};}
 const nativeServer=http.createServer(async(req,res)=>{let client;try{
  a.equal(req.headers.authorization,'Basic '+Buffer.from('crm-campaign-gateway:synthetic-api16').toString('base64'));let body='';for await(const b of req)body+=b;let input;try{input=body?JSON.parse(body):null;}catch{input=Object.fromEntries(new URLSearchParams(body));}
  const m=/^\/api\/campaigns\/(\d+)(\/status|\/preview)?$/.exec(req.url),id=m?Number(m[1]):null;events.push({method:req.method,path:req.url,status:input?.status,send_at:input?.send_at});
  const send=(status,value,type='application/json')=>{res.writeHead(status,{'Content-Type':type});res.end(type==='application/json'?JSON.stringify(value):value);};
  if(req.method==='GET'&&m&&!m[2])return send(200,{data:await currentNative(id)});
  if(req.method==='POST'&&m?.[2]==='/preview')return send(200,'<p>Synthetic compilation only</p>','text/html');
  client=await nativePool.connect();await client.query('BEGIN');
  if(req.method==='POST'&&req.url==='/api/campaigns'){
   const row=(await client.query("INSERT INTO public.campaigns(id,name,subject,from_email,body,altbody,body_source,send_at,headers,status,tags,type,messenger,template_id,content_type,sent,attribs) VALUES(nextval('qa_campaign_id'),$1,$2,$3,$4,$5,$6,$7,$8,'draft',$9,$10,$11,$12,$13,0,$14) RETURNING id",[input.name,input.subject,input.from_email,input.body,input.altbody,input.body_source,input.send_at,JSON.stringify(input.headers),input.tags,input.type,input.messenger,input.template_id,input.content_type,input.attribs])).rows[0];await client.query('INSERT INTO public.campaign_lists(campaign_id,list_id,list_name) SELECT $1,id,name FROM public.lists WHERE id=ANY($2)',[row.id,input.lists]);await client.query('COMMIT');return send(200,{data:await currentNative(row.id)});
  }
  if(req.method==='PUT'&&m?.[2]==='/status'){
   if(statusHook)await statusHook({id,input,client});
   await client.query('UPDATE public.campaigns SET status=$2,updated_at=NOW() WHERE id=$1',[id,input.status]);if(beforeCommitHook)await beforeCommitHook({id,input,client,res});await client.query('COMMIT');if(afterCommitHook)await afterCommitHook({id,input,res});if(res.destroyed)return;return send(200,{data:await currentNative(id)});
  }
  if(req.method==='PUT'&&m&&!m[2]){
   a.deepEqual(Object.keys(input).sort(),['attribs','lists','send_at']);
   // The v6.1 UPDATE and list/media CTEs share one native SQL statement.
   const parent=clearOrder==='update-first'?'(SELECT id FROM c)':'$1';events.push({nativeClearOrder:clearOrder});
   await client.query(`WITH c AS(UPDATE public.campaigns SET send_at=$2,attribs=$4,tags=CASE WHEN ${clearFault==='null-tags'?'true':'false'} OR cardinality(tags)=0 THEN NULL ELSE tags END,body=CASE WHEN ${clearFault==='body'?'true':'false'} THEN body||'synthetic-tamper' ELSE body END,updated_at=NOW(),status=CASE WHEN status='scheduled' AND $2::timestamptz IS NULL THEN 'draft' ELSE status END WHERE id=$1 RETURNING id),clists AS(DELETE FROM public.campaign_lists WHERE campaign_id=${parent} AND list_id NOT IN(SELECT UNNEST($3::integer[]))),med AS(DELETE FROM public.campaign_media WHERE campaign_id=${parent}) INSERT INTO public.campaign_lists(campaign_id,list_id,list_name) SELECT ${parent},id,name FROM public.lists WHERE id=ANY($3::integer[]) ON CONFLICT(campaign_id,list_id) DO UPDATE SET list_name=EXCLUDED.list_name`,[id,input.send_at,input.lists,input.attribs]);
   await client.query('COMMIT');if(afterCommitHook)await afterCommitHook({id,input,res});if(res.destroyed)return;return send(200,{data:await currentNative(id)});
  }
  throw Error('SYNTHETIC_NATIVE_ROUTE_REFUSED');
 }catch(e){events.push({method:req.method,path:req.url,error:e.message,sqlstate:e.code});if(client)await client.query('ROLLBACK').catch(()=>{});res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message,sqlstate:e.code}));}finally{client?.release();}});
 await new Promise(r=>nativeServer.listen(0,'127.0.0.1',r));resources.push(()=>new Promise(r=>nativeServer.close(r)));apiOrigin='http://127.0.0.1:'+nativeServer.address().port;
 const native=T.nativeTransport({origin:'https://native.example.invalid',username:'crm-campaign-gateway',token:'synthetic-api16',fetchFn:(url,options)=>{const u=new URL(url);a.equal(u.origin,'https://native.example.invalid');if(abortStatusMs&&options.method==='PUT'&&u.pathname.endsWith('/status'))options={...options,signal:AbortSignal.any([options.signal,AbortSignal.timeout(abortStatusMs)])};return fetch(apiOrigin+u.pathname,options);}});
 const execute=T.createExecutor({pool:effectPool,native,nativeInternalEnabled:true});
 const freeze=createInternalFreeze({transaction,source:Source});
 async function freezeRequest(brand,key){const e=entries[brand],v=await transaction(async tx=>{await tx.query(Source.SQL.setup);return Source.readCatalog(tx.query,brand);});return{acao:ACTION,brand,id:e.id,expected_version:1,expected_definition_hash:digest(e.definition),expected_context_hash:digest(e.context),expected_catalog_hash:v.catalog.catalog_hash,idempotency_key:key};}
 async function freezeBrand(brand,key){return(await freeze.execute({key:'synthetic-native-owner',request:await freezeRequest(brand,key)}))._body;}
 const run=command=>execute({key:'synthetic-native-owner',command});
 return{admin,nativePool,effectPool,run,freezeBrand,freezeRequest,freeze,events,currentNative,setStatusHook:f=>statusHook=f,setBeforeCommitHook:f=>beforeCommitHook=f,setAfterCommitHook:f=>afterCommitHook=f,setAbortStatusMs:n=>abortStatusMs=n,setClearFault:x=>{a(['none','null-tags','body'].includes(x));clearFault=x;},setClearOrder:x=>{a(['independent','update-first'].includes(x));clearOrder=x;},close:closeAll};
}
module.exports={createFixture,closeAll};
