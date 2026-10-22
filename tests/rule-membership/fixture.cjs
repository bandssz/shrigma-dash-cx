'use strict';
// Public fixture setup copied from a pinned prior input; none of its closed proofs are invoked.
const assert=require('node:assert/strict');
exports.create=async function({db,composition}){
 const syntheticCardinality=32,result={};
 const exec=q=>db.exec(q);
const types={16:'boolean',19:'name',20:'bigint',23:'integer',25:'text',1184:'timestamptz',2950:'uuid',3802:'jsonb','1009|1015':'varchar(100)[]','string-array':'varchar(100)[]',enum:'text'};
function type(t){assert.ok(types[t],'closed fixture type '+t);return types[t];}
async function table(name,cols,primary=[]){await exec('CREATE TABLE '+name+'('+Object.entries(cols).map(([n,t])=>n+' '+type(t)).join(',')+(primary.length?',PRIMARY KEY('+primary.join(',')+')':'')+')');}
const f=composition.fixtureColumns;
async function fixture(){
 await exec("CREATE SCHEMA crm_audience_v2;SET search_path=public;SET TimeZone='UTC';");
 const columns=JSON.parse(JSON.stringify(f.columns));Object.assign(columns.subscribers,{uuid:2950,email:25,attribs:3802});Object.assign(columns.campaign_lists,{list_name:25});Object.assign(columns.campaign_media,{filename:25});
 for(const [name,cols] of Object.entries(columns))await table('public.'+name,cols,['campaigns','subscribers','lists','templates'].includes(name)?['id']:[]);
 for(const [relation,cols] of Object.entries(f.extra)){
  const name=relation.split('.')[1];if(!columns[name])await table(relation,cols);
  else for(const [n,t] of Object.entries(cols))if(!Object.hasOwn(columns[name],n))await exec('ALTER TABLE '+relation+' ADD COLUMN '+n+' '+type(t));
 }
 for(const [name,cols] of Object.entries(f.state)){
  const relation={deployment:'regular_worker_deployment',lease:'regular_worker_lease',selection:'selection_runtime'}[name];
  if(f.extra['crm_audience_v2.'+relation]){for(const [n,t] of Object.entries(cols))if(!Object.hasOwn(f.extra['crm_audience_v2.'+relation],n))await exec('ALTER TABLE crm_audience_v2.'+relation+' ADD COLUMN '+n+' '+type(t));}
  else await table('crm_audience_v2.'+relation,cols,['singleton']);
 }
 await table('crm_audience_v2.regular_delivery_campaign',f.control,['campaign_id']);
 await exec('CREATE TABLE public.media(id integer PRIMARY KEY,filename text);CREATE TABLE public.settings(key text PRIMARY KEY,value jsonb);');
 // Exact public transitive CREATE TABLE definitions, no migration DO/grants.
 for(const t of composition.sourceTables)await exec(t.definition);
 await exec('ALTER TABLE crm_audience_v2.shopify_customer_product DROP CONSTRAINT shopify_customer_product_check;ALTER TABLE crm_audience_v2.shopify_customer_product ADD CONSTRAINT shopify_customer_product_check CHECK(NOT history_complete OR unresolved_items=0)');
 for(const t of composition.v2Tables)await exec(t.definition);
 await table('crm_audience_v2.recorded_origin_source',{brand:25,canonical_origin:25,scope_id:2950,producer_id:25,producer_revision:25,coverage_started_at:1184,enabled:16});
 await table('crm_audience_v2.recorded_origin_receipt',{scope_id:2950,producer_id:25,subscriber_id:23,subscriber_uuid:2950,accepted_at:1184});
 await exec(`CREATE TABLE public.crm_ab_arm_v2(test_id uuid,campaign_id integer,arm text);
 CREATE TABLE public.crm_ab_experiment_v2(test_id uuid,state text,transport_bound boolean);
 CREATE TABLE crm_audience_v2.ab_scope(test_id uuid,scope_hash text,brand text);
 CREATE TABLE crm_audience_v2.ab_regular_pair(test_id uuid,brand text,campaign_a integer,campaign_b integer,scope_hash text,admitted_xid xid8);
 CREATE TABLE public.crm_ab_member_v2(test_id uuid,arm text,subscriber_id integer,revoked_at timestamptz);
 CREATE TABLE crm_audience_v2.ab_regular_lifecycle_intent(test_id uuid,version integer,action text,created_xid xid8);
 ALTER TABLE public.crm_ab_experiment_v2 ADD COLUMN version integer;
 CREATE TABLE public.shrigma_email_dispatch(flow text,piece text,transport_state text);`);
}
async function compoundSeed(){
 await exec(`ALTER TABLE public.subscriber_lists ADD PRIMARY KEY(subscriber_id,list_id);
 CREATE INDEX idx_views_subscriber_id ON public.campaign_views(subscriber_id);
 CREATE INDEX idx_clicks_sub_id ON public.link_clicks(subscriber_id);
 CREATE INDEX idx_sub_lists_list_id ON public.subscriber_lists(list_id);
 CREATE INDEX idx_subs_id_status ON public.subscribers(id,status);
 CREATE INDEX fact_native_lookup ON crm_audience_v2.shopify_customer_fact(brand,operation_id,subscriber_id);
 CREATE INDEX campaign_lists_campaign_id_list_id_idx ON public.campaign_lists(campaign_id,list_id);
 INSERT INTO crm_audience_v2.selection_timezone(name) VALUES('America/Sao_Paulo');
 UPDATE public.campaigns SET status='draft' WHERE id=175;`);
 const operation='gid://shopify/BulkOperation/1',shop='gid://shopify/Shop/1',workflow='synthetic-workflow',producer='synthetic-producer';
 const queryHash='bb89faf525f58f9c5075878888c1be6fcf4992200310a4867cdd2871fb570086';
 const provenance={source_sha256:'a'.repeat(64),query_sha256:queryHash,workflow_id:workflow,workflow_version:producer,counts:{customers:32,product_history_incomplete:0},bulk:{shop_gid:shop,shop_currency:'BRL',shop_timezone:'America/Sao_Paulo'},shop:'synthetic.myshopify.com'};
 const catalog={currency:'BRL',timezone:'America/Sao_Paulo',shop_id:shop,fields:[],products:[{id:'gid://shopify/Product/1',brand:'fish',name:'synthetic product',available:true}],origins:[],recorded_origins:[]};
 const hashes={};for(const field of ['purchase.product','purchase.last_date']){const pin=(await db.query("SELECT crm_audience_v2.shopify_source_hash('fish',$1,$2::jsonb) AS h",[field,JSON.stringify(catalog)])).rows[0].h;assert.match(pin,/^[a-f0-9]{64}$/);hashes[field]=pin;catalog.fields.push({key:field,available:true,source_hash:pin});}
 for(const field of ['email.opened','email.clicked']){const pin=(await db.query("SELECT crm_audience_v2.selection_engagement_source_hash('fish',$1) AS h",[field])).rows[0].h;catalog.fields.push({key:field,available:true,source_hash:pin});}
 await db.query("INSERT INTO crm_audience_v2.shopify_source(brand,shop_id,domain,currency,timezone,query_sha256,workflow_id,producer_revision,field_hashes,enabled,current_operation) VALUES('fish',$1,'synthetic.myshopify.com','BRL','America/Sao_Paulo',$2,$3,$4,$5::jsonb,true,$6)",[shop,queryHash,workflow,producer,JSON.stringify(hashes),operation]);
 await db.query("INSERT INTO crm_audience_v2.shopify_batch(brand,operation_id,provenance,provenance_sha256,expected_customers,expected_chunks,started_at,completed_at,observed_at,status,finalized_at,mapped_customers,unresolved_customers) VALUES('fish',$1,$2::jsonb,repeat('f',64),32,1,statement_timestamp()-interval'1 minute',statement_timestamp()-interval'1 minute',statement_timestamp()-interval'1 minute','ready',statement_timestamp(),32,0)",[operation,JSON.stringify(provenance)]);
 await db.query("INSERT INTO crm_audience_v2.shopify_product_batch(brand,operation_id,provenance,provenance_sha256,ready,catalog_products) VALUES('fish',$1,$2::jsonb,repeat('f',64),true,$3::jsonb)",[operation,JSON.stringify(provenance),JSON.stringify(catalog.products)]);
 await db.query("INSERT INTO crm_audience_v2.shopify_product_history_attestation(brand,operation_id,source_sha256,query_sha256,producer_revision,semantics,mode,customer_count,incomplete_count,proof_sha256,attestation_sha256) VALUES('fish',$1,repeat('a',64),$2,$3,'customer-order-parity-v2','native_v2',32,0,repeat('f',64),repeat('f',64))",[operation,queryHash,producer]);
 await exec(`INSERT INTO crm_audience_v2.shopify_identity(brand,customer_gid,subscriber_id,subscriber_uuid,email,first_operation) SELECT 'fish','gid://shopify/Customer/'||id,id,uuid,email,'gid://shopify/BulkOperation/1' FROM public.subscribers;
 INSERT INTO crm_audience_v2.shopify_customer_fact(brand,operation_id,customer_gid,email,orders_count,amount_spent,currency,last_order_at,customer_created_at,customer_updated_at,identity_ambiguous,identity_resolvable,subscriber_id,subscriber_uuid,identity_state) SELECT 'fish','gid://shopify/BulkOperation/1','gid://shopify/Customer/'||id,email,1,100,'BRL',statement_timestamp()-interval'1 day',statement_timestamp()-interval'2 days',statement_timestamp()-interval'1 day',false,true,id,uuid,'resolved' FROM public.subscribers;
 INSERT INTO crm_audience_v2.shopify_customer_product(brand,operation_id,customer_gid,products,history_complete,unresolved_items) SELECT 'fish','gid://shopify/BulkOperation/1','gid://shopify/Customer/'||id,CASE WHEN id%2=0 THEN '[{"id":"gid://shopify/Product/1"}]'::jsonb ELSE '[{"id":"gid://shopify/Product/2"}]'::jsonb END,true,0 FROM public.subscribers;
 INSERT INTO public.campaigns(id,status,type,messenger,attribs) VALUES(90001,'finished','regular','email','{"crm":{"brand":"fish","policy":"crm-campaign-v1"}}'::jsonb);
 INSERT INTO public.campaign_views(subscriber_id,campaign_id,created_at) SELECT id,90001,statement_timestamp()-interval'1 minute' FROM public.subscribers;
 INSERT INTO public.link_clicks(subscriber_id,campaign_id,created_at) SELECT id,90001,statement_timestamp()-interval'1 minute' FROM public.subscribers;`);
 await db.query("UPDATE crm_audience_v2.config SET catalog=$1::jsonb WHERE brand='fish'",[JSON.stringify(catalog)]);
 await exec('DELETE FROM crm_audience_v2.regular_delivery_campaign;DELETE FROM crm_audience_v2.campaign_binding_revision;DELETE FROM crm_audience_v2.campaign_binding;DELETE FROM crm_audience_v2.revision;DELETE FROM crm_audience_v2.audience');
 const base={op:'in_list',list_id:17},opened={op:'condition',field:'email.opened',operator:'within_last_days',value:30},clicked={op:'condition',field:'email.clicked',operator:'within_last_days',value:30};
 const rules={171:{op:'and',rules:[base,{op:'and',rules:[opened,clicked]},{op:'confirmed',rule:{op:'condition',field:'purchase.product',operator:'purchased',value:'gid://shopify/Product/1'}},{op:'or',rules:[base,base]}]},174:{op:'and',rules:[base,opened,clicked,{op:'confirmed',rule:{op:'condition',field:'purchase.last_date',operator:'on_or_after',value:'2020-01-01'}},base]}};
 const hash=async o=>(await db.query('SELECT crm_audience_v2.selection_hash($1::jsonb) AS v',[JSON.stringify(o)])).rows[0].v;
 for(const id of [171,174]){
  const definition={schema_version:'crm-audience-v2',brand:'fish',name:'synthetic compound '+id,rule:rules[id]};
  const evaluated=(await db.query("SELECT crm_audience_v2.selection_rule($1::jsonb,0,'fish',1,$2::jsonb) AS v",[JSON.stringify(rules[id]),JSON.stringify(catalog)])).rows[0].v;assert.ok(evaluated);
  const pins=(await db.query("SELECT jsonb_agg(p ORDER BY (p->>'rule_key') COLLATE \"C\") AS v FROM (SELECT DISTINCT value AS p FROM jsonb_array_elements($1::jsonb)) q",[JSON.stringify(evaluated.pins)])).rows[0].v;
  const context={contract:'crm-audience-context-v1',hash_contract:'canonical-json-sorted-keys-sha256-v1',brand:'fish',base:{id:17,brand:'fish',optin:'single'},rules:pins};
  const audience='00000000-0000-4000-8000-'+String(id).padStart(12,'0'),dh=await hash(definition),ch=await hash(context);
  const binding={contract:'crm-audience-campaign-binding-v1',brand:'fish',campaign_id:id,binding_version:1,audience_id:audience,audience_revision:1,definition,context,definition_hash:dh,context_hash:ch,base_list_id:17,campaign_version:'d'.repeat(64),catalog_hash:'e'.repeat(64),authorizes_selection:false,authorizes_send:false};const bh=await hash(binding);
  await db.query("INSERT INTO crm_audience_v2.audience(id,brand,archived) VALUES($1,'fish',false)",[audience]);
  await db.query('INSERT INTO crm_audience_v2.revision VALUES($1,1,false,$2::jsonb,$3::jsonb,$4,$5)',[audience,JSON.stringify(definition),JSON.stringify(context),dh,ch]);
  await db.query("INSERT INTO crm_audience_v2.campaign_binding VALUES($1,1,'fish',$2,1,$3,$4,17,$5,$6::jsonb,$7,$8)",[id,audience,dh,ch,'e'.repeat(64),JSON.stringify(binding),bh,'d'.repeat(64)]);
  await db.query('INSERT INTO crm_audience_v2.campaign_binding_revision VALUES($1,1,$2::jsonb,$3)',[id,JSON.stringify(binding),bh]);
  const material=(await db.query('SELECT crm_audience_v2.regular_delivery_material($1) AS v',[id])).rows[0].v;
  await db.query("INSERT INTO crm_audience_v2.regular_delivery_campaign VALUES($1,1,$2,$3::jsonb,repeat('a',64),repeat('b',64),0,0,true,false)",[id,bh,JSON.stringify(material)]);
  const ctx=(await db.query('SELECT crm_audience_v2.selection_worker_context($1) AS v',[id])).rows[0].v;assert.equal(ctx.bound,true);
 }
 assert.equal((await db.query("SELECT crm_audience_v2.shopify_product_history_attested('fish') AS v")).rows[0].v,true);
 result.fixture={subscribers:32,confirmedMemberships:32,eventsEach:32,boundCampaigns:2,mode:'native_v2',gapCount:0,snapshotCurrent:true,allPublicFunctionsRetained:true,allFkTriggersActive:true,customerDataCopied:false};
}
async function install(){
 const byName=new Map(composition.functions.map(f=>[f.name,f])),seen=new Set(),visiting=new Set();
 async function put(f){if(seen.has(f.name))return;if(visiting.has(f.name))return;visiting.add(f.name);
  for(const name of byName.keys())if(name!==f.name&&new RegExp(name.replaceAll('.','\\.')+'\\s*\\(').test(f.definition.slice(f.definition.indexOf(' AS ')+4)))await put(byName.get(name));
  await exec(f.definition.replace(/^CREATE FUNCTION/,'CREATE OR REPLACE FUNCTION'));visiting.delete(f.name);seen.add(f.name);
 }
 for(const fn of composition.functions)await put(fn);
 await exec('CREATE TRIGGER shrigma_audience_campaign_send_guard_v1 BEFORE UPDATE OR DELETE ON public.campaigns FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.campaign_send_guard()');
 const rows=(await db.query("SELECT n.nspname||'.'||p.proname AS name,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS hash,octet_length(convert_to(p.prosrc,'UTF8')) AS bytes FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('crm_audience_v2','public')")).rows;
 for(const fn of composition.functions){const row=rows.find(r=>r.name===fn.name);assert.ok(row,fn.name);assert.equal(row.hash,fn.bodySha256,fn.name);assert.equal(row.bytes,fn.bodyBytes,fn.name);}
 result.functionsExact=true;result.sevenOriginalHashesExact=true;result.installedFunctions=composition.functions.length;
}
async function data(){
 await exec(`INSERT INTO public.lists(id,name,optin,status,tags) VALUES(17,'synthetic Fish base','single','active',ARRAY['fish']::varchar[]);
 INSERT INTO public.templates(id,body,is_default) VALUES(1,'synthetic template',true);
 INSERT INTO public.subscribers(id,status,uuid,email,attribs) VALUES(1,'enabled','00000000-0000-4000-8000-000000000001','one@synthetic.invalid','{}'),(2,'enabled','00000000-0000-4000-8000-000000000002','two@synthetic.invalid','{}');
 INSERT INTO public.subscriber_lists(list_id,subscriber_id,status) VALUES(17,1,'confirmed'),(17,2,'confirmed');
 INSERT INTO crm_audience_v2.regular_worker_deployment(singleton,enabled,worker_sha256,runtime_sha256,query_sha256,database_role,approved_at,approved_by,topology_receipt_sha256) VALUES(true,true,repeat('a',64),repeat('b',64),'${f.expectedQuery}',current_user,statement_timestamp()-interval '1 second','synthetic-not-original-authority',repeat('c',64));
 INSERT INTO crm_audience_v2.regular_worker_lease(singleton,instance_id,worker_sha256,runtime_sha256,database_role,heartbeat_at,expires_at,suspended) VALUES(true,'00000000-0000-4000-8000-000000000003',repeat('a',64),repeat('b',64),current_user,statement_timestamp()-interval '1 second',statement_timestamp()+interval '1 minute',false);
 INSERT INTO crm_audience_v2.selection_runtime VALUES(true,true,'${f.expectedQuery}',statement_timestamp());
 INSERT INTO crm_audience_v2.config(brand,enabled,base_list_id,catalog,checked_at,expires_at) VALUES('fish',true,17,'{"currency":null,"timezone":null,"shop_id":null,"fields":[],"products":[],"origins":[],"recorded_origins":[]}',statement_timestamp(),statement_timestamp()+interval '4 minutes');
 INSERT INTO public.settings VALUES('privacy.disable_tracking','false'),('privacy.individual_tracking','true');`);
 if(syntheticCardinality===32)await exec(`INSERT INTO public.subscribers(id,status,uuid,email,attribs) SELECT g,'enabled',md5('synthetic-subscriber-'||g)::uuid,'synthetic-'||g||'@synthetic.invalid','{}'::jsonb FROM generate_series(3,32) g;INSERT INTO public.subscriber_lists(list_id,subscriber_id,status) SELECT 17,g,'confirmed' FROM generate_series(3,32) g;`);
 for(const id of [171,174,175]){
  const c={};for(const [name,t] of Object.entries(f.columns.campaigns)){c[name]=t===23?0:t===16?false:t==='string-array'?[]:t===3802?{}:t===1184?new Date(Date.now()-60000).toISOString():t===2950?'00000000-0000-4000-8000-'+String(id).padStart(12,'0'):'';}
  Object.assign(c,{id,name:'synthetic-'+id,status:'scheduled',type:'regular',messenger:'email',template_id:1,content_type:'html',body:'synthetic body',from_email:'synthetic@synthetic.invalid',headers:[],started_at:null,attribs:id===175?{}:{crm:{brand:'fish',policy:'crm-campaign-v1'}}});
  const keys=Object.keys(c);await db.query('INSERT INTO public.campaigns('+keys.join(',')+') VALUES('+keys.map((k,i)=>'$'+(i+1)).join(',')+')',keys.map(k=>typeof c[k]==='object'&&!Array.isArray(c[k])&&c[k]!==null?JSON.stringify(c[k]):c[k]));
  await db.query('INSERT INTO public.campaign_lists(campaign_id,list_id,list_name) VALUES($1,17,\'synthetic Fish base\')',[id]);
 }
 const rule={op:'in_list',list_id:17},definition={schema_version:'crm-audience-v2',brand:'fish',name:'synthetic audience',rule};
 const pins=(await db.query('SELECT crm_audience_v2.selection_rule($1::jsonb,1,\'fish\') AS v',[JSON.stringify(rule)])).rows[0].v;
 assert.ok(pins,'real composed list rule must succeed');
 const context={contract:'crm-audience-context-v1',hash_contract:'canonical-json-sorted-keys-sha256-v1',brand:'fish',base:{id:17,brand:'fish',optin:'single'},rules:pins.pins};
 const audience='00000000-0000-4000-8000-000000000017';
 const hash=async o=>(await db.query('SELECT crm_audience_v2.selection_hash($1::jsonb) AS v',[JSON.stringify(o)])).rows[0].v;
 const dh=await hash(definition),ch=await hash(context);assert.match(dh,/^[a-f0-9]{64}$/);assert.match(ch,/^[a-f0-9]{64}$/);
 await db.query('INSERT INTO crm_audience_v2.audience(id,brand,archived) VALUES($1,\'fish\',false)',[audience]);
 await db.query('INSERT INTO crm_audience_v2.revision VALUES($1,1,false,$2::jsonb,$3::jsonb,$4,$5)',[audience,JSON.stringify(definition),JSON.stringify(context),dh,ch]);
 for(const id of [171,174]){
  const binding={contract:'crm-audience-campaign-binding-v1',brand:'fish',campaign_id:id,binding_version:1,audience_id:audience,audience_revision:1,definition,context,definition_hash:dh,context_hash:ch,base_list_id:17,campaign_version:'d'.repeat(64),catalog_hash:'e'.repeat(64),authorizes_selection:false,authorizes_send:false};
  const bh=await hash(binding);
  await db.query('INSERT INTO crm_audience_v2.campaign_binding VALUES($1,1,\'fish\',$2,1,$3,$4,17,$5,$6::jsonb,$7,$8)',[id,audience,dh,ch,'e'.repeat(64),JSON.stringify(binding),bh,'d'.repeat(64)]);
  await db.query('INSERT INTO crm_audience_v2.campaign_binding_revision VALUES($1,1,$2::jsonb,$3)',[id,JSON.stringify(binding),bh]);
  const material=(await db.query('SELECT crm_audience_v2.regular_delivery_material($1) AS v',[id])).rows[0].v;
  await db.query('INSERT INTO crm_audience_v2.regular_delivery_campaign VALUES($1,1,$2,$3::jsonb,repeat(\'a\',64),repeat(\'b\',64),0,0,true,false)',[id,bh,JSON.stringify(material)]);
 }
}

 await fixture();await install();await data();await compoundSeed();return {db,result,f};
};
