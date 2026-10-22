'use strict';
// Disposable PG17 only. Synthetic people; no production connection or key.
const {test,after}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs');
const {createFixture,closeAll}=require('/delta/native-transition-fixture.cjs'),{Pool}=require('/v3/pg-driver.cjs');
const Source=require('/current-source/n8n/growth/segment-audience-store.cjs'),{createTransaction}=require('/current-source/services/crm-audience/transaction.cjs'),Freeze=require(process.env.SCALE_FREEZE_MODULE||'/scale/gateway/tests/consent19/audience-freeze.cjs'),Audience=require('/current-source/n8n/growth/segment-audience-contract.js');
after(closeAll);let pool;after(async()=>pool?.end());
test('one SQL copy freezes110000+ people and exact metadata on both brands; receipt only and no new relation/function',async t=>{
 const f=await createFixture(process.env.SHRIGMA_LOCAL_TEST_DB);
 await f.admin.query(fs.readFileSync('/delta/native-recovery-install.prepared.sql','utf8'));
 await f.admin.query("ALTER TABLE public.subscriber_lists ADD COLUMN meta jsonb NOT NULL DEFAULT '{}',ADD COLUMN created_at timestamptz,ADD COLUMN updated_at timestamptz;CREATE INDEX fixture_members_by_list ON public.subscriber_lists(list_id,subscriber_id)");
 await f.admin.query(fs.readFileSync('/v3/install.owner.sql','utf8'));
 const countSql="SELECT (SELECT count(*) FROM pg_proc WHERE pronamespace='crm_audience_v2'::regnamespace)::integer functions,(SELECT count(*) FROM pg_class WHERE relnamespace IN('public'::regnamespace,'crm_audience_v2'::regnamespace) AND relkind='r')::integer tables";
 const before=(await f.admin.query(countSql)).rows;
 await f.admin.query(fs.readFileSync('/scale/freeze.bulk.sql','utf8'));
 const effectDDL=fs.readFileSync('/scale/effect.compact.sql','utf8');try{await f.admin.query(effectDDL);}catch(e){console.log(JSON.stringify({sqlstate:e.code,position:e.position,near:effectDDL.slice(Number(e.position)-120,Number(e.position)+80),where:e.where}));throw e;}
 a.deepEqual((await f.admin.query(countSql)).rows,before);
 pool=new Pool({host:'127.0.0.1',user:'crm_audience_api',database:process.env.SHRIGMA_LOCAL_TEST_DB,max:2});
 const transaction=createTransaction({pool,statementTimeoutMs:30000}),freeze=Freeze.createInternalFreeze({transaction,source:Source}),saved=[];
 for(const brand of ['aristo','fish'])await t.test(brand+' bulk110000 with exact one receipt and source preservation',async()=>{
  const base=brand==='aristo'?16:17,start=brand==='aristo'?60000000:61000000;
  await f.admin.query("INSERT INTO public.subscribers(id,uuid,email,status) SELECT $1+i,gen_random_uuid(),'scale-fixture-'||($1+i)::text||'@example.invalid','enabled' FROM generate_series(1,110000)i",[start]);
  await f.admin.query("INSERT INTO public.subscriber_lists(subscriber_id,list_id,status,meta) SELECT id,$1,'confirmed',jsonb_build_object('test',true,'value',id%3) FROM public.subscribers WHERE id>$2 AND id<=$2+110000",[base,start]);
  await f.admin.query('ANALYZE public.subscribers;ANALYZE public.subscriber_lists');
  const d=Audience.normalize({schema_version:'crm-audience-v2',brand,name:'Synthetic mass '+brand,rule:{op:'in_list',list_id:base}}),id=brand==='aristo'?'40000000-0000-4000-8000-000000000001':'40000000-0000-4000-8000-000000000002';
  const current=await transaction(async tx=>{await tx.query(Source.SQL.setup);return Source.readCatalog(tx.query,brand);}),context=Source.pins(d,current);
  await f.admin.query('INSERT INTO crm_audience_v2.audience(id,brand,version,definition,definition_hash,context,context_hash,archived,name) VALUES($1,$2,1,$3,$4,$5,$6,false,$7)',[id,brand,d,Freeze.digest(d),context,Freeze.digest(context),d.name]);
  const q={acao:Freeze.ACTION,brand,id,expected_version:1,expected_definition_hash:Freeze.digest(d),expected_context_hash:Freeze.digest(context),expected_catalog_hash:current.catalog.catalog_hash,idempotency_key:brand==='aristo'?'40000000-0000-4000-8000-000000000011':'40000000-0000-4000-8000-000000000012'};
  const sourceHash=()=>f.admin.query("SELECT count(*)::integer n,encode(sha256(convert_to(jsonb_agg(to_jsonb(sl) ORDER BY sl.subscriber_id)::text,'UTF8')),'hex') hash FROM public.subscriber_lists sl WHERE list_id=$1",[base]);
  const old=(await sourceHash()).rows;const started=performance.now();let r;
  const recovery={...q,acao:Freeze.RECONCILE,confirm:'reconciliar_intencao_original'};
  a.equal((await freeze.recover({key:'synthetic-native-owner',request:{acao:Freeze.RECOVER,brand,idempotency_key:q.idempotency_key}}))._http,404);
  try{r=brand==='aristo'?await freeze.reconcile({key:'synthetic-native-owner',request:recovery}):await freeze.execute({key:'synthetic-native-owner',request:q});}catch(e){console.log(JSON.stringify({sqlstate:e.code,where:e.where,message:e.message,position:e.position,internalPosition:e.internalPosition,internalQuery:e.internalQuery}));throw e;}
  const b=r._body;a(b.eligible_count>=110000);a(Buffer.byteLength(JSON.stringify(r))<3000);a(!Object.hasOwn(b,'members'));a(!Object.hasOwn(b,'member_ids'));
  const copy=(await f.admin.query("SELECT count(*)::integer n,encode(sha256(convert_to('['||string_agg(sl.subscriber_id::text,',' ORDER BY sl.subscriber_id)||']','UTF8')),'hex') ids,encode(sha256(convert_to(jsonb_agg(jsonb_build_array(sl.subscriber_id,sl.meta) ORDER BY sl.subscriber_id)::text,'UTF8')),'hex') meta FROM public.subscriber_lists sl WHERE list_id=$1",[b.list_id])).rows[0];
  a.equal(copy.n,b.eligible_count);a.equal(copy.ids,b.members_sha256);a.equal(copy.meta,b.members_meta_sha256);a.deepEqual((await sourceHash()).rows,old);
  a.deepEqual(await freeze.recover({key:'synthetic-native-owner',request:{acao:Freeze.RECOVER,brand,idempotency_key:q.idempotency_key}}),r);
  a.deepEqual(await freeze.reconcile({key:'synthetic-native-owner',request:recovery}),r,'same existing receipt; never another cohort');
  await a.rejects(freeze.reconcile({key:'synthetic-native-owner',request:{...recovery,expected_definition_hash:'e'.repeat(64)}}),e=>e.code==='NATIVE_FREEZE_REQUEST_CONFLICT');
  a.equal((await f.admin.query('SELECT count(*)::integer n FROM crm_audience_v2.request WHERE operation_key=$1',[q.idempotency_key])).rows[0].n,1);
  saved.push({q,result:r});
  const domain=brand==='aristo'?'oaristocrata.com':'fishermans.com.br',createKey='bff-'+(brand==='aristo'?'a':'b').repeat(64),definition={schema_version:'crm-campaign-v1',brand,channel:'email',name:'Synthetic mass campaign '+brand,subject:'Synthetic mass subject',from_email:'avisos@'+domain,reply_to:'contato@'+domain,initiative:{key:'synthetic-mass-'+brand,name:'Synthetic mass'},utm_campaign:'synthetic-mass-'+brand,list_ids:[b.list_id],template_id:brand==='aristo'?3:1,html:'<a href="https://'+domain+'/products/qa">QA</a> {{ UnsubscribeURL }}',text:'https://'+domain+'/products/qa {{ UnsubscribeURL }}',tags:['qa-scale20'],send_at:null};
  const created=await f.run({acao:'campanha_salvar',brand,idempotency_key:createKey,definition});a.equal(created.status,201,JSON.stringify(created));const cid=created.body.campaign.id;
  const auth=(await f.admin.query('SELECT public.shrigma_crm_campaign_auth_v1($1) a',['synthetic-native-owner'])).rows[0].a;
  const scope=async(extra={})=>(await f.effectPool.query('SELECT public.shrigma_crm_campaign_effect_v1($1,$2::jsonb,$3::jsonb) r',['synthetic-native-owner',JSON.stringify({command:{acao:'campanha_nativa_contexto',brand,id:cid},actor:auth.actor,operation:null}),JSON.stringify({kind:'nativeContext',payload:{id:cid,purpose:'consent_scope',createKey,freezeKey:q.idempotency_key,...extra}})])).rows[0].r;
  const initialScope=await scope();a.equal(initialScope.confirmed,true);a.equal(initialScope.eligible_count,b.eligible_count);for(const k of ['members_sha256','members_identity_sha256','members_state_sha256','members_meta_sha256'])a.equal(initialScope[k],b[k]);a.equal(Object.hasOwn(initialScope,'members'),false);a(Buffer.byteLength(JSON.stringify(initialScope))<1500);
  let currentCampaign=created.body.campaign;
  for(let cycle=0;cycle<2;cycle++){
   let answer=await f.run({acao:'campanha_salvar',brand,id:cid,expected_version:currentCampaign.version,idempotency_key:'scale-date-'+brand+'-'+cycle,definition:{...currentCampaign.definition,send_at:'2026-10-20T13:00:00.000Z'}});a.equal(answer.status,200,JSON.stringify(answer));currentCampaign=answer.body.campaign;
   answer=await f.run({acao:'campanha_validar',brand,id:cid,expected_version:currentCampaign.version,idempotency_key:'scale-review-'+brand+'-'+cycle});a.equal(answer.status,200,JSON.stringify(answer));a.equal(answer.body.validation.audience.eligible_count,b.eligible_count);
   answer=await f.run({acao:'campanha_agendar',brand,id:cid,expected_version:currentCampaign.version,idempotency_key:'scale-schedule-'+brand+'-'+cycle,confirm:'agendar',audience_review_id:answer.body.validation.audience.review_id});a.equal(answer.status,200,JSON.stringify(answer));a.equal(answer.body.campaign.status,'scheduled');currentCampaign=answer.body.campaign;
   answer=await f.run({acao:'campanha_cancelar',brand,id:cid,expected_version:currentCampaign.version,idempotency_key:'scale-cancel-'+brand+'-'+cycle,confirm:'cancelar'});a.equal(answer.status,200,JSON.stringify(answer));a.equal(answer.body.campaign.status,'draft');a.equal(answer.body.campaign.send_at,null);a.equal(answer.body.campaign.sent,0);currentCampaign=answer.body.campaign;
  }
  await f.admin.query("UPDATE public.subscriber_lists SET status='unsubscribed' WHERE list_id=$1 AND subscriber_id=$2",[b.list_id,start+1]);
  const withdrawn=await scope({subscriberId:start+1});a.equal(withdrawn.confirmed,true);a.notEqual(withdrawn.members_state_sha256,b.members_state_sha256);a.equal(withdrawn.members_identity_sha256,b.members_identity_sha256);a.match(withdrawn.member_uuid,/^[a-f0-9-]{36}$/);
  // Simulate an external Listmonk start in this disposable fixture only.
  // Campaign mutation guards are covered by the unchanged native suites.
  await f.admin.query("SET session_replication_role='replica'");try{await f.admin.query('UPDATE public.campaigns SET sent=1,started_at=clock_timestamp() WHERE id=$1',[cid]);}finally{await f.admin.query("SET session_replication_role='origin'");}a.equal((await scope()).confirmed,true,'existing consent read remains available after the native send starts');
  await a.rejects(scope({subscriberId:2147483646}),e=>e.code==='P0001'&&e.message==='CONSENT_MEMBER_SCOPE');await a.rejects(scope({createKey:'bff-'+'c'.repeat(64)}));
  console.log(JSON.stringify({brand,recipients:b.eligible_count,elapsedMs:Math.round(performance.now()-started),receiptBytes:Buffer.byteLength(JSON.stringify(r)),originalSourceUnchanged:true}));
 });
 await t.test('compatible return preserves original receipts and closes new large freezes',async()=>{
  const returnPath=fs.existsSync('/scale/return.freeze.sql')?'/scale/return.freeze.sql':'/scale/gateway/ops/releases/freeze-scale20/return.freeze.sql';await f.admin.query(fs.readFileSync(returnPath,'utf8'));
  for(const {q,result}of saved){a.deepEqual(await freeze.recover({key:'synthetic-native-owner',request:{acao:Freeze.RECOVER,brand:q.brand,idempotency_key:q.idempotency_key}}),result);await a.rejects(freeze.execute({key:'synthetic-native-owner',request:{...q,idempotency_key:'scale-return-closed-'+q.brand}}),e=>e.message==='NATIVE_NEW_FREEZE_CLOSED');}
 });
});
