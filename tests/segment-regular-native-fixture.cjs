'use strict';

// Synthetic fixture for the disposable native Listmonk worker proof. It never
// grants a production role and deliberately has no scheduling/admission API.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {Pool}=require('pg');
const A=require('../n8n/growth/segment-audience-contract.js');
const S=require('../n8n/growth/segment-audience-store.cjs');
const H=require('../n8n/growth/segment-audience-review.cjs');
const B=require('../n8n/growth/segment-campaign-binding.cjs');
const Counter=require('../n8n/growth/segment-audience-listmonk.cjs');
const Campaign=require('../n8n/growth/campaign-contract.js');
const Tracking=require('../n8n/growth/campaign-tracking.js');
const root=path.resolve(__dirname,'..'),read=f=>fs.readFileSync(path.join(root,f),'utf8');
const uri=process.env.TEST_DATABASE_URL,u=new URL(uri||'http://invalid');
if(process.env.CRM_AUDIENCE_TEST_ISOLATED!=='1'||u.protocol!=='postgresql:'||u.hostname!=='127.0.0.1'||u.pathname!=='/listmonk'||!u.port||u.port==='5432')throw Error('ISOLATED_DATABASE_REQUIRED');
const pool=new Pool({connectionString:uri,max:2,statement_timeout:15000});
const exec=sql=>pool.query(sql);
const catalog=brand=>({currency:null,timezone:null,shop_id:null,fields:[
 {key:'purchase.count',available:false,source_hash:null},{key:'purchase.last_date',available:false,source_hash:null},
 {key:'purchase.amount',available:false,source_hash:null},{key:'purchase.product',available:false,source_hash:null},
 {key:'signup.origin',available:false,source_hash:null},
 {key:'email.opened',available:true,source_hash:Counter.engagementSourceHash(brand,'email.opened')},
 {key:'email.clicked',available:true,source_hash:Counter.engagementSourceHash(brand,'email.clicked')}
],products:[],origins:[]});
const ids={fish:'00000000-0000-4000-8000-000000000101',aristo:'00000000-0000-4000-8000-000000000201'};

async function prepare(){
 await exec(`
  CREATE TABLE crm_dash_chave(chave text PRIMARY KEY,painel text,ativo boolean DEFAULT true,revogada_em timestamptz,expira_em timestamptz,chave_hash text,chave_hash_curta text);
  CREATE TABLE shrigma_panel_permission_v1(principal_id text,area text,caps jsonb,PRIMARY KEY(principal_id,area));
  CREATE FUNCTION public.shrigma_panel_operator_v1(text,text) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
  CREATE FUNCTION public.shrigma_campaign_list_brand(l public.lists) RETURNS text LANGUAGE sql STABLE AS $$
   SELECT CASE WHEN l.id IN(16,31) OR coalesce(l.tags,'{}')&&ARRAY['aristo']::varchar[] THEN 'aristo'
    WHEN l.id IN(17,21) OR coalesce(l.tags,'{}')&&ARRAY['fish']::varchar[] THEN 'fish' END $$;
 `);
 await exec(read('n8n/growth/segment-audience-store.sql'));
 await exec(`
  CREATE TABLE crm_audience_v2.campaign_binding(
   campaign_id integer PRIMARY KEY,brand text,binding_version integer,campaign_version text,audience_id uuid,audience_revision integer,
   definition_hash text,context_hash text,base_list_id integer,catalog_hash text,binding jsonb,binding_hash text);
  CREATE TABLE crm_audience_v2.campaign_binding_revision(campaign_id integer,binding_version integer,binding jsonb,binding_hash text,PRIMARY KEY(campaign_id,binding_version));
  CREATE TABLE public.shrigma_email_dispatch(dispatch_id uuid PRIMARY KEY,brand text,flow text,piece text,dedupe_key text,payload_sha256 text,
   account_id text,region text,configuration_set text,recipient_key text,recipient_key_version text,is_test boolean,transport_state text,
   reserved_at timestamptz DEFAULT clock_timestamp(),started_at timestamptz,accepted_at timestamptz,outcome_at timestamptz,claim_token uuid,
   error_code text,send_log_id bigint,UNIQUE(brand,flow,piece,dedupe_key));
  CREATE FUNCTION public.shrigma_email_recipient_key(email text) RETURNS TABLE(recipient_key text,key_version text)
   LANGUAGE sql IMMUTABLE AS $$SELECT md5(lower(email)),'native-fixture'$$;
  INSERT INTO templates(id,name,type,subject,body,is_default) VALUES
   (1,'Native fixture','campaign','','{{ template "content" . }}',true);
  INSERT INTO lists(id,uuid,name,type,optin,status,tags) VALUES
   (17,gen_random_uuid(),'Base Fish','private','single','active',ARRAY['fish']),
   (21,gen_random_uuid(),'Leaf Fish','private','single','active',ARRAY['fish']),
   (16,gen_random_uuid(),'Base Aristo','private','single','active',ARRAY['aristo']),
   (31,gen_random_uuid(),'Leaf Aristo','private','single','active',ARRAY['aristo']),
   (40,gen_random_uuid(),'Legacy unbound','private','single','active',ARRAY['legacy']);
  INSERT INTO subscribers(id,uuid,email,name,attribs,status) VALUES
   (1,gen_random_uuid(),'fish@example.invalid','Fish synthetic','{}','enabled'),
   (2,gen_random_uuid(),'aristo@example.invalid','Aristo synthetic','{}','enabled'),
   (3,gen_random_uuid(),'legacy@example.invalid','Legacy synthetic','{}','enabled');
  INSERT INTO subscriber_lists(subscriber_id,list_id,status) VALUES(1,17,'confirmed'),(1,21,'confirmed'),(2,16,'confirmed'),(2,31,'confirmed'),(3,40,'confirmed');
  INSERT INTO campaigns(id,uuid,name,subject,from_email,body,altbody,content_type,send_at,headers,attribs,status,type,messenger,template_id)
   VALUES
   (100,gen_random_uuid(),'Native Fish','Native Fish','Smoke <smoke@example.invalid>','<p>Fish {{ .Subscriber.Email }}</p>','Fish','html',clock_timestamp()-interval '1 minute','[]',
    '{"crm":{"policy":"crm-campaign-v1","brand":"fish"}}','draft','regular','email',1),
   (200,gen_random_uuid(),'Native Aristo','Native Aristo','Smoke <smoke@example.invalid>','<p>Aristo {{ .Subscriber.Email }}</p>','Aristo','html',clock_timestamp()-interval '1 minute','[]',
    '{"crm":{"policy":"crm-campaign-v1","brand":"aristo"}}','draft','regular','email',1),
   (300,gen_random_uuid(),'Native Legacy','Native Legacy','Smoke <smoke@example.invalid>','<p>Legacy {{ .Subscriber.Email }}</p>','Legacy','html',clock_timestamp()-interval '1 minute','[]',
    '{}','scheduled','regular','email',1),
   (400,gen_random_uuid(),'Native Quarantine','Native Quarantine','Smoke <smoke@example.invalid>','<p>Must not send</p>','Must not send','html',clock_timestamp()-interval '1 minute','[]',
    '{"crm":{"policy":"crm-campaign-v1","brand":"fish"}}','draft','regular','email',1);
  INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES(100,17,'Base Fish'),(200,16,'Base Aristo'),(300,40,'Legacy unbound'),(400,17,'Base Fish');
 `);
 // Exercise the same material builder used by the panel, including Listmonk's
 // supported per-subscriber @TrackLink expansion. The native worker must hash
 // and claim the final rendered bytes, rather than a reduced smoke body.
 for(const [brand,campaignID,base,domain] of [
  ['fish',100,17,'fishermans.com.br'],['aristo',200,16,'oaristocrata.com']]){
  const prepared=Campaign.prepare({schema_version:Campaign.VERSION,brand,channel:'email',
   initiative:{key:'native',name:'Native proof'},utm_campaign:'native-'+brand,
   name:'Native '+brand,subject:'Oferta '+brand,from_email:'contato@'+domain,reply_to:'contato@'+domain,
   list_ids:[base],template_id:1,
   html:`<p><a href="https://${domain}/collections/all@TrackLink">Loja</a> {{ UnsubscribeURL }}</p>`,
   text:`Loja https://${domain}/collections/all@TrackLink {{ UnsubscribeURL }}`,tags:['native']},
   {catalog:{brand,current:true,lists:[{id:base,brand,available:true}],
    templates:[{id:1,type:'campaign',available:true}],initiatives:[]},tracking:Tracking,trackingId:campaignID,now:1774790840000});
  assert.match(prepared.payload.body,/@TrackLink/);
  await pool.query(`UPDATE campaigns SET name=$2,subject=$3,from_email=$4,body=$5,altbody=$6,headers=$7::jsonb,attribs=$8::jsonb WHERE id=$1`,
   [campaignID,prepared.payload.name,prepared.payload.subject,prepared.payload.from_email,prepared.payload.body,
    prepared.payload.altbody,JSON.stringify(prepared.payload.headers),JSON.stringify(prepared.payload.attribs)]);
 }
 const definitions={
  fish:A.normalize({schema_version:A.VERSION,brand:'fish',name:'Native Fish',rule:{op:'in_list',list_id:21}}),
  aristo:A.normalize({schema_version:A.VERSION,brand:'aristo',name:'Native Aristo',rule:{op:'in_list',list_id:31}})
 };
 for(const [brand,base] of [['fish',17],['aristo',16]]){
  await pool.query(`UPDATE crm_audience_v2.config SET enabled=true,base_list_id=$2,catalog=$3::jsonb,
   checked_at=clock_timestamp(),expires_at=clock_timestamp()+interval '4 minutes' WHERE brand=$1`,[brand,base,JSON.stringify(catalog(brand))]);
  const current=await S.readCatalog(pool.query.bind(pool),brand),definition=definitions[brand],context=S.pins(definition,current);
  const definitionHash=H.digest(definition),contextHash=H.digest(context),campaignID=brand==='fish'?100:200;
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   await client.query(`INSERT INTO crm_audience_v2.audience(id,brand,name,definition,definition_hash,context,context_hash,created_by,updated_by)
    VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,'panel:native','panel:native')`,
    [ids[brand],brand,definition.name,JSON.stringify(definition),definitionHash,JSON.stringify(context),contextHash]);
   await client.query(`INSERT INTO crm_audience_v2.revision(audience_id,version,definition,definition_hash,context,context_hash,archived,actor)
    VALUES($1,1,$2::jsonb,$3,$4::jsonb,$5,false,'panel:native')`,[ids[brand],JSON.stringify(definition),definitionHash,JSON.stringify(context),contextHash]);
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  const binding={contract:B.VERSION,brand,campaign_id:campaignID,campaign_version:'native-fixture-v1',binding_version:1,audience_id:ids[brand],audience_revision:1,
   definition_hash:definitionHash,context_hash:contextHash,base_list_id:base,definition,context,catalog_hash:current.catalog.catalog_hash,
   authorizes_selection:false,authorizes_send:false},bindingHash=H.digest(binding);
  await pool.query(`INSERT INTO crm_audience_v2.campaign_binding VALUES($1,$2,1,$3,$4,1,$5,$6,$7,$8,$9::jsonb,$10)`,
   [campaignID,brand,binding.campaign_version,ids[brand],definitionHash,contextHash,base,binding.catalog_hash,JSON.stringify(binding),bindingHash]);
  await pool.query('INSERT INTO crm_audience_v2.campaign_binding_revision VALUES($1,1,$2::jsonb,$3)',[campaignID,JSON.stringify(binding),bindingHash]);
  if(brand==='fish'){
   const quarantine={...binding,campaign_id:400,campaign_version:'native-quarantine-v1'},quarantineHash=H.digest(quarantine);
   await pool.query(`INSERT INTO crm_audience_v2.campaign_binding VALUES(400,$1,1,$2,$3,1,$4,$5,$6,$7,$8::jsonb,$9)`,
    [brand,quarantine.campaign_version,ids[brand],definitionHash,contextHash,base,quarantine.catalog_hash,JSON.stringify(quarantine),quarantineHash]);
   await pool.query('INSERT INTO crm_audience_v2.campaign_binding_revision VALUES(400,1,$1::jsonb,$2)',[JSON.stringify(quarantine),quarantineHash]);
  }
 }
 const draftGuard=read('n8n/growth/segment-campaign-binding.sql').match(/EXECUTE \$ddl\$(CREATE FUNCTION crm_audience_v2\.campaign_send_guard\(\)[\s\S]*?)\$ddl\$;/);
 assert.ok(draftGuard&&draftGuard[1]);await exec(draftGuard[1]);
 await exec(`CREATE TRIGGER shrigma_audience_campaign_send_guard_v1 BEFORE UPDATE OR DELETE ON public.campaigns
  FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.campaign_send_guard()`);
 await exec(read('n8n/growth/segment-listmonk-selection.sql'));
 await exec(read('n8n/growth/segment-regular-readiness.sql'));
 await exec(read('n8n/growth/segment-regular-delivery.sql'));
 const refresh=read('n8n/growth/segment-runtime-access.sql').match(/EXECUTE \$ddl\$(CREATE FUNCTION crm_audience_v2\.refresh_native_catalog[\s\S]*?)\$ddl\$;/);
 assert.ok(refresh&&refresh[1]);await exec(refresh[1]);
 await exec(read('n8n/growth/segment-regular-worker-lease.sql'));
 await exec(read('n8n/growth/segment-regular-operation-guard.sql'));
}

async function activate(){
 const worker=process.env.REGULAR_NATIVE_WORKER_SHA,runtime=process.env.REGULAR_NATIVE_RUNTIME_SHA;
 assert.match(worker||'',/^[0-9a-f]{64}$/);assert.match(runtime||'',/^[0-9a-f]{64}$/);
 await pool.query(`INSERT INTO crm_audience_v2.regular_delivery_campaign(campaign_id,binding_version,binding_hash,material,worker_sha256,runtime_sha256,envelope_from,account_id,region,configuration_set,enabled)
  SELECT c.id,b.binding_version,b.binding_hash,crm_audience_v2.regular_delivery_material(c.id),$1,$2,
   CASE c.id WHEN 100 THEN 'contato@fishermans.com.br' WHEN 200 THEN 'contato@oaristocrata.com' ELSE 'smoke@example.invalid' END,
   '000000000000','native-fixture','native-fixture',true
  FROM campaigns c JOIN crm_audience_v2.campaign_binding b ON b.campaign_id=c.id WHERE c.id IN(100,200,400)`,[worker,runtime]);
 await pool.query(`UPDATE crm_audience_v2.regular_worker_deployment SET enabled=true,worker_sha256=$1,runtime_sha256=$2,
  query_sha256='3dc9433187c4ee16f0516503c6cc3efae63e9a607f9a15748e52a43217c6f7de',database_role=session_user,
  approved_at=clock_timestamp(),approved_by='synthetic-native-fixture',topology_receipt_sha256=$3 WHERE singleton`,
  [worker,runtime,'f'.repeat(64)]);
 // Force the first real heartbeat to refresh both native catalogs. The
 // deployment approval above is synthetic and exists only in this database.
 await pool.query("UPDATE crm_audience_v2.config SET checked_at=clock_timestamp()-interval '5 minutes',expires_at=clock_timestamp()-interval '1 second'");
}

async function schedule(){
 const client=await pool.connect();try{
  await client.query('BEGIN');
  await client.query("UPDATE campaigns SET status='scheduled',updated_at=clock_timestamp() WHERE id IN(100,200,400) AND status='draft'");
  await client.query('UPDATE crm_audience_v2.regular_delivery_campaign SET enabled=false WHERE campaign_id=400');
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

(async()=>{try{if(process.argv[2]==='prepare')await prepare();else if(process.argv[2]==='activate')await activate();else if(process.argv[2]==='schedule')await schedule();else throw Error('MODE_REQUIRED');console.log(JSON.stringify({mode:process.argv[2],ok:true}));}finally{await pool.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
