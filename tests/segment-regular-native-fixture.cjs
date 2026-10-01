'use strict';

// Synthetic fixture for the disposable native Listmonk worker proof. It never
// grants a production role or contacts a remote transport. The A/B rows below
// start at the already-reviewed prepared boundary; the separate full A/B proof
// owns preparation, admission, the 15-minute guard and the real due wait.
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
const ab={
 fish:{test:'00000000-0000-4000-8000-000000000601',seed:'00000000-0000-4000-8000-000000000611',review:'00000000-0000-4000-8000-000000000621',regularReview:'00000000-0000-4000-8000-000000000631',campaigns:[100,101],members:[1,5,6,7]},
 aristo:{test:'00000000-0000-4000-8000-000000000701',seed:'00000000-0000-4000-8000-000000000711',review:'00000000-0000-4000-8000-000000000721',regularReview:'00000000-0000-4000-8000-000000000731',campaigns:[200,201],members:[2,8]}
};

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
   (40,gen_random_uuid(),'Legacy unbound','private','single','active',ARRAY['legacy']),
   (41,gen_random_uuid(),'Released campaign list','private','single','active',ARRAY['fish']);
  INSERT INTO subscribers(id,uuid,email,name,attribs,status) VALUES
   (1,gen_random_uuid(),'fish@example.invalid','Fish synthetic','{}','enabled'),
   (2,gen_random_uuid(),'aristo@example.invalid','Aristo synthetic','{}','enabled'),
   (3,gen_random_uuid(),'legacy@example.invalid','Legacy synthetic','{}','enabled'),
   (4,gen_random_uuid(),'released@example.invalid','Released synthetic','{}','enabled'),
   (5,gen_random_uuid(),'fishb@example.invalid','Fish B synthetic','{}','enabled'),
   (6,gen_random_uuid(),'revoked@example.invalid','Revoked synthetic','{}','enabled'),
   (7,gen_random_uuid(),'optout@example.invalid','Opt-out synthetic','{}','enabled'),
   (8,gen_random_uuid(),'aristob@example.invalid','Aristo B synthetic','{}','enabled');
  INSERT INTO subscriber_lists(subscriber_id,list_id,status) VALUES
   (1,17,'confirmed'),(1,21,'confirmed'),(5,17,'confirmed'),(5,21,'confirmed'),
   (6,17,'confirmed'),(6,21,'confirmed'),(7,17,'confirmed'),(7,21,'confirmed'),
   (2,16,'confirmed'),(2,31,'confirmed'),(8,16,'confirmed'),(8,31,'confirmed'),
   (3,40,'confirmed'),(4,41,'confirmed');
  INSERT INTO campaigns(id,uuid,name,subject,from_email,body,altbody,content_type,send_at,headers,attribs,status,type,messenger,template_id)
   VALUES
   (100,gen_random_uuid(),'Native Fish','Native Fish','Smoke <smoke@example.invalid>','<p>Fish {{ .Subscriber.Email }}</p>','Fish','html',clock_timestamp()-interval '1 minute','[]',
    '{"crm":{"policy":"crm-campaign-v1","brand":"fish"}}','draft','regular','email',1),
   (200,gen_random_uuid(),'Native Aristo','Native Aristo','Smoke <smoke@example.invalid>','<p>Aristo {{ .Subscriber.Email }}</p>','Aristo','html',clock_timestamp()-interval '1 minute','[]',
    '{"crm":{"policy":"crm-campaign-v1","brand":"aristo"}}','draft','regular','email',1),
   (300,gen_random_uuid(),'Native Legacy','Native Legacy','Smoke <smoke@example.invalid>','<p>Legacy {{ .Subscriber.Email }}</p>','Legacy','html',clock_timestamp()-interval '1 minute','[]',
    '{}','scheduled','regular','email',1),
   (400,gen_random_uuid(),'Native Quarantine','Native Quarantine','Smoke <smoke@example.invalid>','<p>Must not send</p>','Must not send','html',clock_timestamp()-interval '1 minute','[]',
    '{"crm":{"policy":"crm-campaign-v1","brand":"fish"}}','draft','regular','email',1),
   (500,gen_random_uuid(),'Native Released','Native Released','Smoke <smoke@example.invalid>','<p>Released {{ .Subscriber.Email }}</p>','Released','html',clock_timestamp()-interval '1 minute','[]',
    '{"crm":{"policy":"crm-campaign-v1","brand":"fish"}}','draft','regular','email',1);
  INSERT INTO campaigns SELECT (jsonb_populate_record(NULL::campaigns,to_jsonb(c)||jsonb_build_object('id',101,'uuid',gen_random_uuid(),'name','Native Fish B'))).* FROM campaigns c WHERE id=100;
  INSERT INTO campaigns SELECT (jsonb_populate_record(NULL::campaigns,to_jsonb(c)||jsonb_build_object('id',201,'uuid',gen_random_uuid(),'name','Native Aristo B'))).* FROM campaigns c WHERE id=200;
  INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES
   (100,17,'Base Fish'),(101,17,'Base Fish'),(200,16,'Base Aristo'),(201,16,'Base Aristo'),
   (300,40,'Legacy unbound'),(400,17,'Base Fish'),(500,41,'Released campaign list');
 INSERT INTO settings(key,value) VALUES('privacy.disable_tracking','false'),('privacy.individual_tracking','true')
   ON CONFLICT(key) DO UPDATE SET value=excluded.value;
 `);
 const providerSQL=read('n8n/growth/campaign-provider.sql');
 const currentStart=providerSQL.indexOf('CREATE OR REPLACE FUNCTION public.shrigma_campaign_current(pid integer)');
 const currentEnd=providerSQL.indexOf('\n$$;',currentStart)+4;
 assert.ok(currentStart>=0&&currentEnd>currentStart+4,'NATIVE_CAMPAIGN_CURRENT_SOURCE');
 await exec(providerSQL.slice(currentStart,currentEnd));
 // The worker reads the effective head, including a released historical head.
 // Reuse the real tombstone table/helper. This reader fixture seeds history
 // directly; the separate API/PG proof exercises the authorized release writer.
 const bindingSQL=read('n8n/growth/segment-campaign-binding.sql');
 const releaseStart=bindingSQL.indexOf(' CREATE TABLE crm_audience_v2.campaign_binding_release (');
 const releaseEnd=bindingSQL.indexOf(' EXECUTE $ddl$CREATE FUNCTION crm_audience_v2.campaign_binding_effective',releaseStart);
 const effective=bindingSQL.match(/ EXECUTE \$ddl\$(CREATE FUNCTION crm_audience_v2\.campaign_binding_effective\(cid integer\)[\s\S]*?)\$ddl\$;/);
 assert.ok(releaseStart>=0&&releaseEnd>releaseStart&&effective,'NATIVE_EFFECTIVE_BINDING_SOURCE');
 await exec(bindingSQL.slice(releaseStart,releaseEnd)+effective[1]+';\nREVOKE ALL ON crm_audience_v2.campaign_binding_release FROM PUBLIC;');
 // Exercise the same material builder used by the panel, including Listmonk's
 // supported per-subscriber @TrackLink expansion. The native worker must hash
 // and claim the final rendered bytes, rather than a reduced smoke body.
 for(const [brand,campaignID,base,domain] of [
  ['fish',100,17,'fishermans.com.br'],['fish',101,17,'fishermans.com.br'],
  ['aristo',200,16,'oaristocrata.com'],['aristo',201,16,'oaristocrata.com']]){
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
  const definitionHash=H.digest(definition),contextHash=H.digest(context);
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
  let binding;
  for(const campaignID of ab[brand].campaigns){
   const campaignVersion=(await pool.query('SELECT public.shrigma_campaign_current($1) current',[campaignID])).rows[0].current.version;
   binding={contract:B.VERSION,brand,campaign_id:campaignID,campaign_version:campaignVersion,binding_version:1,audience_id:ids[brand],audience_revision:1,
    definition_hash:definitionHash,context_hash:contextHash,base_list_id:base,definition,context,catalog_hash:current.catalog.catalog_hash,
    authorizes_selection:false,authorizes_send:false};
   const bindingHash=H.digest(binding);
   await pool.query(`INSERT INTO crm_audience_v2.campaign_binding VALUES($1,$2,1,$3,$4,1,$5,$6,$7,$8,$9::jsonb,$10)`,
    [campaignID,brand,binding.campaign_version,ids[brand],definitionHash,contextHash,base,binding.catalog_hash,JSON.stringify(binding),bindingHash]);
   await pool.query('INSERT INTO crm_audience_v2.campaign_binding_revision VALUES($1,1,$2::jsonb,$3)',[campaignID,JSON.stringify(binding),bindingHash]);
  }
  if(brand==='fish'){
   const quarantine={...binding,campaign_id:400,campaign_version:'native-quarantine-v1'},quarantineHash=H.digest(quarantine);
   await pool.query(`INSERT INTO crm_audience_v2.campaign_binding VALUES(400,$1,1,$2,$3,1,$4,$5,$6,$7,$8::jsonb,$9)`,
    [brand,quarantine.campaign_version,ids[brand],definitionHash,contextHash,base,quarantine.catalog_hash,JSON.stringify(quarantine),quarantineHash]);
   await pool.query('INSERT INTO crm_audience_v2.campaign_binding_revision VALUES(400,1,$1::jsonb,$2)',[JSON.stringify(quarantine),quarantineHash]);
   // The released campaign's old audience selects subscriber 1, while its
   // current native list selects only subscriber 4. Sending either the old
   // cohort or guarded metadata therefore fails the real binary proof.
   const historical={...binding,campaign_id:500,campaign_version:'5'.repeat(32)},historicalHash=H.digest(historical);
   await pool.query(`INSERT INTO crm_audience_v2.campaign_binding VALUES(500,$1,1,$2,$3,1,$4,$5,$6,$7,$8::jsonb,$9)`,
    [brand,historical.campaign_version,ids[brand],definitionHash,contextHash,base,historical.catalog_hash,JSON.stringify(historical),historicalHash]);
   await pool.query('INSERT INTO crm_audience_v2.campaign_binding_revision VALUES(500,1,$1::jsonb,$2)',[JSON.stringify(historical),historicalHash]);
   const released={contract:'crm-audience-campaign-binding-release-v1',brand,campaign_id:500,
    campaign_version:historical.campaign_version,binding_version:1,binding_hash:historicalHash};
   await pool.query(B.SQL.release,[500,1,brand,historicalHash,released.campaign_version,JSON.stringify(released),H.digest(released),'panel:native']);
  }
 }
 const draftGuard=read('n8n/growth/segment-campaign-binding.sql').match(/EXECUTE \$ddl\$(CREATE FUNCTION crm_audience_v2\.campaign_send_guard\(\)[\s\S]*?)\$ddl\$;/);
 assert.ok(draftGuard&&draftGuard[1]);await exec(draftGuard[1]);
 await exec(`CREATE TRIGGER shrigma_audience_campaign_send_guard_v1 BEFORE UPDATE OR DELETE ON public.campaigns
  FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.campaign_send_guard()`);
 await exec(read('n8n/growth/ab-experiment-core.sql'));
 await exec(read('n8n/growth/ab-experiment-selection.sql'));
 await exec(read('n8n/growth/ab-audience-prepare.sql'));
 // The delivery seam needs the immutable review identity referenced by the
 // admitted pair, but intentionally does not re-run review/admission. Their
 // complete service and wall-clock proof is composed separately from this CI
 // harness; no private receipt path is a versioned dependency.
 await exec(`CREATE TABLE crm_audience_v2.ab_review(
  review_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE NOT NULL,review_id uuid PRIMARY KEY,
  test_id uuid NOT NULL REFERENCES crm_audience_v2.ab_scope(test_id),brand text NOT NULL CHECK(brand IN('fish','aristo')),
  actor text NOT NULL,evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object'),
  evidence_hash text NOT NULL CHECK(evidence_hash~'^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  REVOKE ALL ON crm_audience_v2.ab_review FROM PUBLIC;`);
 await exec(read('n8n/growth/segment-listmonk-selection.sql'));
 await exec(read('n8n/growth/segment-regular-readiness.sql'));
 await exec(read('n8n/growth/segment-regular-delivery.sql'));
 const runtimeAccess=read('n8n/growth/segment-runtime-access.sql');
 const apiRole=runtimeAccess.match(/\n (CREATE ROLE crm_audience_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4;)/);
 const refresh=runtimeAccess.match(/EXECUTE \$ddl\$(CREATE FUNCTION crm_audience_v2\.refresh_native_catalog[\s\S]*?)\$ddl\$;/);
 assert.ok(apiRole&&apiRole[1]&&refresh&&refresh[1],'NATIVE_RUNTIME_ACCESS_SOURCE');
 await exec(apiRole[1]);await exec(refresh[1]);
 await exec(read('n8n/growth/segment-regular-recovery.sql'));
 await exec(read('n8n/growth/segment-regular-worker-lease.sql'));
 await exec(read('n8n/growth/segment-regular-operation-guard.sql'));
 await exec(read('n8n/growth/segment-regular-admission.sql'));
 await exec(read('n8n/growth/segment-shopify-facts.sql'));
 await exec(read('n8n/growth/segment-shopify-selection.sql'));
 await exec(read('n8n/growth/ab-audience-regular.sql'));
 await exec(`INSERT INTO crm_audience_v2.regular_sender_policy(brand,envelope_from,account_id,region,configuration_set,enabled) VALUES
  ('fish','contato@fishermans.com.br','000000000000','native-fixture','native-fixture',false),
  ('aristo','contato@oaristocrata.com','000000000000','native-fixture','native-fixture',false)`);

 // Seed only the immutable PREPARED boundary. Scope, arm and member rows pass
 // their real guards in one transaction. Scheduling remains a separate action
 // after the compiled worker has committed its first heartbeat.
 for(const [brand,base] of [['fish',17],['aristo',16]]){
  const spec=ab[brand],bindings=(await pool.query('SELECT * FROM crm_audience_v2.campaign_binding WHERE campaign_id=ANY($1) ORDER BY campaign_id',[spec.campaigns])).rows;
  assert.equal(bindings.length,2);
  const protocol={contract:'crm-ab-email-v2',test_id:spec.test,brand,channel:'email',name:'Synthetic native '+brand,
   hypothesis:'Exercise the already admitted pair in the compiled emitter',
   arms:bindings.map((b,i)=>({arm:['a','b'][i],campaign_id:b.campaign_id,expected_version:b.campaign_version})),
   allocation:{method:'random-permutation-v1',a_basis_points:5000},
   rule:{method:'fisher-two-sided-fixed-window-v1',metric:'unique_tracked_click_per_allocated',window_hours:24,minimum_per_arm:1,minimum_effect_pp:.1,alpha:.05}};
  const first=bindings[0],scope={contract:'crm-ab-audience-scope-v1',test_id:spec.test,brand,audience_id:first.audience_id,
   audience_revision:first.audience_revision,definition:first.binding.definition,definition_hash:first.definition_hash,
   context:first.binding.context,context_hash:first.context_hash,base_list_id:base,catalog_hash:first.catalog_hash,
   bindings:bindings.map((b,i)=>({arm:['a','b'][i],campaign_id:b.campaign_id,binding_version:b.binding_version,binding_hash:b.binding_hash,campaign_version:b.campaign_version}))};
  const assignments=(await pool.query(`SELECT subscriber_id,CASE WHEN row_number() OVER(ORDER BY sha256(convert_to($1::text||':'||subscriber_id::text,'UTF8')),subscriber_id)<=floor(count(*) OVER()/2.0) THEN 'a' ELSE 'b' END arm
   FROM unnest($2::integer[]) subscriber_id ORDER BY subscriber_id`,[spec.seed,spec.members])).rows;
  const client=await pool.connect();try{
   await client.query('BEGIN');
   await client.query(`INSERT INTO public.crm_ab_experiment_v2(test_id,brand,protocol,seed,source_list_ids,state,version,source_complete)
    VALUES($1,$2,$3::jsonb,$4,$5,'prepared',1,false)`,[spec.test,brand,JSON.stringify(protocol),spec.seed,[base]]);
   await client.query(`INSERT INTO crm_audience_v2.ab_scope(test_id,brand,scope,scope_hash,cohort_hash,actor)
    VALUES($1,$2,$3::jsonb,$4,$5,'panel:native')`,[spec.test,brand,JSON.stringify(scope),H.digest(scope),H.digest(spec.members)]);
   for(const [i,campaignID] of spec.campaigns.entries()){
    const arm=['a','b'][i],count=assignments.filter(x=>x.arm===arm).length;
    await client.query(`INSERT INTO public.crm_ab_arm_v2(test_id,arm,campaign_id,campaign_version,allocated_count)
     VALUES($1,$2,$3,$4,$5)`,[spec.test,arm,campaignID,bindings[i].campaign_version,count]);
   }
   for(const row of assignments)await client.query('INSERT INTO public.crm_ab_member_v2(test_id,subscriber_id,arm) VALUES($1,$2,$3)',[spec.test,row.subscriber_id,row.arm]);
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  const evidence={synthetic_boundary:'prepared',composes:'real-admission-proof-separately'};
  await pool.query(`INSERT INTO crm_audience_v2.ab_review(review_id,test_id,brand,actor,evidence,evidence_hash)
   VALUES($1,$2,$3,'panel:native',$4::jsonb,$5)`,[spec.review,spec.test,brand,JSON.stringify(evidence),H.digest(evidence)]);
  await pool.query(`INSERT INTO crm_audience_v2.ab_regular_review
   (id,actor,brand,test_id,experiment_version,scope_hash,audience_review_id,inspection,materials,runtime,checked_at,expires_at)
   SELECT $1,'panel:native',$2,$3,1,$4,$5,'{"synthetic_boundary":"prepared"}'::jsonb,'[{},{}]'::jsonb,'{}'::jsonb,t,t+interval '60 seconds'
   FROM (SELECT clock_timestamp() t) observed`,
   [spec.regularReview,brand,spec.test,H.digest(scope),spec.review]);
 }
 const fishMembers=(await pool.query('SELECT subscriber_id,arm FROM public.crm_ab_member_v2 WHERE test_id=$1 ORDER BY arm,subscriber_id',[ab.fish.test])).rows;
 const revoked=fishMembers.find(x=>x.arm==='a'),optout=fishMembers.find(x=>x.arm==='b');assert.ok(revoked&&optout);
 await pool.query("UPDATE public.crm_ab_member_v2 SET revoked_at=clock_timestamp(),revoked_reason='native-proof' WHERE test_id=$1 AND subscriber_id=$2",[ab.fish.test,revoked.subscriber_id]);
 await pool.query("UPDATE public.subscriber_lists SET status='unsubscribed' WHERE subscriber_id=$1 AND list_id=17",[optout.subscriber_id]);
}

async function activate(){
 const worker=process.env.REGULAR_NATIVE_WORKER_SHA,runtime=process.env.REGULAR_NATIVE_RUNTIME_SHA;
 assert.match(worker||'',/^[0-9a-f]{64}$/);assert.match(runtime||'',/^[0-9a-f]{64}$/);
 await pool.query(`INSERT INTO crm_audience_v2.regular_delivery_campaign(campaign_id,binding_version,binding_hash,material,worker_sha256,runtime_sha256,envelope_from,account_id,region,configuration_set,enabled)
  SELECT c.id,b.binding_version,b.binding_hash,crm_audience_v2.regular_delivery_material(c.id),$1,$2,
   CASE b.brand WHEN 'fish' THEN 'contato@fishermans.com.br' ELSE 'contato@oaristocrata.com' END,
   '000000000000','native-fixture','native-fixture',true
  FROM campaigns c JOIN crm_audience_v2.campaign_binding_effective(c.id) b ON true WHERE c.id IN(100,101,200,201,400)`,[worker,runtime]);
 await pool.query(`UPDATE crm_audience_v2.regular_worker_deployment SET enabled=true,worker_sha256=$1,runtime_sha256=$2,
  query_sha256='084a9493713b21b618d24daae98b38db59fb84febf0c367914bea1ed7aa84c2d',database_role=session_user,
  approved_at=clock_timestamp(),approved_by='synthetic-native-fixture',topology_receipt_sha256=$3 WHERE singleton`,
  [worker,runtime,'f'.repeat(64)]);
 await pool.query('UPDATE crm_audience_v2.regular_sender_policy SET enabled=true');
 // Force the first real heartbeat to refresh both native catalogs. The
 // deployment approval above is synthetic and exists only in this database.
 await pool.query("UPDATE crm_audience_v2.config SET checked_at=clock_timestamp()-interval '5 minutes',expires_at=clock_timestamp()-interval '1 second'");
}

async function schedule(){
 const client=await pool.connect();try{
  await client.query('BEGIN');
  for(const [brand,spec] of Object.entries(ab))await client.query(`INSERT INTO crm_audience_v2.ab_regular_pair(test_id,brand,campaign_a,campaign_b,scope_hash,review_id)
   SELECT $1,$2,$3,$4,s.scope_hash,$5 FROM crm_audience_v2.ab_scope s WHERE s.test_id=$1`,
   [spec.test,brand,spec.campaigns[0],spec.campaigns[1],spec.regularReview]);
  await client.query("UPDATE campaigns SET status='scheduled',updated_at=clock_timestamp() WHERE id IN(100,101,200,201,400,500) AND status='draft'");
  await client.query(`UPDATE public.crm_ab_experiment_v2 e SET state='scheduled',version=version+1,transport_bound=true,
   tracking_continuous=true,source_complete=true,window_start=c.send_at,window_end=c.send_at+interval '24 hours'
   FROM public.campaigns c JOIN public.crm_ab_arm_v2 a ON a.campaign_id=c.id AND a.arm='a' WHERE a.test_id=e.test_id`);
  await client.query('UPDATE crm_audience_v2.regular_delivery_campaign SET enabled=false WHERE campaign_id=400');
  const boundary=(await client.query(`SELECT jsonb_build_object(
   'synthetic_boundary','scheduled','pairs',(SELECT count(*)::integer FROM crm_audience_v2.ab_regular_pair),
   'scheduled_campaigns',(SELECT count(*)::integer FROM public.campaigns WHERE id IN(100,101,200,201) AND status='scheduled'),
   'scheduled_experiments',(SELECT count(*)::integer FROM public.crm_ab_experiment_v2 WHERE state='scheduled' AND transport_bound AND tracking_continuous AND source_complete),
   'active_controls',(SELECT count(*)::integer FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id IN(100,101,200,201) AND enabled AND NOT suspended)) boundary`)).rows[0].boundary;
  assert.deepEqual(boundary,{synthetic_boundary:'scheduled',pairs:2,scheduled_campaigns:4,scheduled_experiments:2,active_controls:4});
  await client.query('COMMIT');
  return boundary;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

(async()=>{try{let result;if(process.argv[2]==='prepare')result=await prepare();else if(process.argv[2]==='activate')result=await activate();else if(process.argv[2]==='schedule')result=await schedule();else throw Error('MODE_REQUIRED');console.log(JSON.stringify({mode:process.argv[2],ok:true,...result}));}finally{await pool.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
